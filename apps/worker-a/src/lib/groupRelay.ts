// M16-2 / M-RT-2：正向 relay fanout（owner → seed；树内节点 → children）。
// M-RT-2：单跳短超时 + 快重试；落库后异步 fanout（waitUntil），避免子树串行拖死 p95。
// M16-RELAY-PIGGYBACK：8 叉树正向自包含路由（Header Piggybacking），打破 15min D1 慢同步脱节。

import type { GroupMessageEnvelope, GroupRelayPayload, OwnerReceiptV1 } from '@hailuo/shared-types';
import type { Env } from '../env';
import { fetchOutboundPeer } from './fetchOutboundPeer';
import { normalizeGroupMemberUrl } from './groupMemberUrl';
import { messagingDb } from './messagingDb';
import { resolveGroupMessagesDb } from './messagingShard';
import { fanoutGroupRelayToPending } from './groupRelayTree';

/** 与 m16-group-chat-plan.md §2bis.2 hop_count≤10 一致。 */
export const GROUP_RELAY_MAX_HOP = 10;
// M16-SLA-2：双父拓扑 — PRIMARY_FANOUT = 8（每人向 8 人发送）。
/** 单次 fanout 并发上限（对齐 PRIMARY_FANOUT = 8；owner/seed 每轮最多发 8 条）。 */
export const GROUP_RELAY_FANOUT_BATCH = 8;
/** M-RT-2：单跳 HTTP 超时；并行 fanout 墙钟≈此值，禁止无超时挂死。 */
export const GROUP_RELAY_FETCH_TIMEOUT_MS = 2_500;
/** M-RT-2：首次失败后再试次数（不含首次）。 */
export const GROUP_RELAY_FETCH_RETRIES = 1;
/** M-RT-2：A 段目标 p95（毫秒）— 文档/契约对齐用。 */
export const GROUP_RELAY_TARGET_P95_MS = 5_000;

export type GroupRelaySchedule = (promise: Promise<unknown>) => void;

export interface RelayEdgeRecord {
  parent_worker_b_url: string;
  child_worker_b_url: string;
}

export interface FanoutPiggybackOptions {
  readonly next_hops?: readonly string[];
  readonly route_slice?: readonly RelayEdgeRecord[];
  /** GRP-RELAY-AUTH-2：向下透传群主副签回执（AUTH-3 前不强制校验） */
  readonly owner_receipt?: OwnerReceiptV1;
}

/** M16-RELAY-PIGGYBACK-B1B2：单包 route_slice 上限 8KB；超限只发 next_hops，子节点回退查 D1。 */
export const RELAY_PIGGYBACK_SLICE_MAX_BYTES = 8 * 1024;
/** M16-RELAY-PIGGYBACK-B1B2：群主全边查询防御性上限，防单群无界增长撑爆 D1 读。 */
export const RELAY_TREE_EDGES_FETCH_LIMIT = 5_000;

/** M16-RELAY-PIGGYBACK-B1B2：邻接表（parent → 去重后 children），一次建表后面全 O(1)。 */
export type RelayChildrenMap = Map<string, string[]>;

/**
 * M16-RELAY-PIGGYBACK-B1B2：一次扫描建邻接表（O(E)）。
 * 自环直接丢弃；同 parent 下去重；读时再按 GROUP_RELAY_FANOUT_BATCH 截断。
 */
export function buildRelayChildrenMap(edges: readonly RelayEdgeRecord[]): RelayChildrenMap {
  const map: RelayChildrenMap = new Map();
  for (const e of edges) {
    const p = normalizeGroupMemberUrl(e.parent_worker_b_url);
    const c = normalizeGroupMemberUrl(e.child_worker_b_url);
    if (!p || !c || p === c) continue;
    let arr = map.get(p);
    if (!arr) {
      arr = [];
      map.set(p, arr);
    }
    if (!arr.includes(c)) arr.push(c);
  }
  return map;
}

/** M16-RELAY-PIGGYBACK-B1B2：从邻接表取直接孩子（O(1)，出度 ≤ GROUP_RELAY_FANOUT_BATCH）。 */
export function findDirectChildrenFromMap(
  childrenMap: RelayChildrenMap,
  parentWorkerBUrl: string,
): string[] {
  return (childrenMap.get(normalizeGroupMemberUrl(parentWorkerBUrl)) ?? []).slice(
    0,
    GROUP_RELAY_FANOUT_BATCH,
  );
}

/**
 * M16-RELAY-PIGGYBACK-B1B2：从邻接表提取以 root 为根的子树边（BFS，O(V+E)）。
 * 用下标指针代替 queue.shift()，避免 O(n) 移位。
 */
export function extractSubtreeSliceFromMap(
  childrenMap: RelayChildrenMap,
  rootWorkerBUrl: string,
): RelayEdgeRecord[] {
  const normalizedRoot = normalizeGroupMemberUrl(rootWorkerBUrl);
  const result: RelayEdgeRecord[] = [];
  const queue: string[] = [normalizedRoot];
  const visited = new Set<string>([normalizedRoot]);
  for (let head = 0; head < queue.length; head++) {
    const parent = queue[head];
    const kids = childrenMap.get(parent) ?? [];
    for (const c of kids) {
      result.push({ parent_worker_b_url: parent, child_worker_b_url: c });
      if (!visited.has(c)) {
        visited.add(c);
        queue.push(c);
      }
    }
  }
  return result;
}

/** M16-RELAY-PIGGYBACK-B1B2：route_slice 是否超 8KB 预算（超则只发 next_hops）。 */
export function isRouteSliceOverBudget(slice: readonly RelayEdgeRecord[]): boolean {
  try {
    return JSON.stringify(slice).length > RELAY_PIGGYBACK_SLICE_MAX_BYTES;
  } catch {
    return true;
  }
}

/** M16-RELAY-PIGGYBACK-B1B2：入站 next_hops 解析模式（可观测打点用）。 */
export type PiggybackResolutionMode =
  | 'local-only'
  | 'piggyback-only'
  | 'intersect'
  | 'authority-fallback';

/** M16-RELAY-PIGGYBACK 可观测：单次 fanout 的 piggyback 生效快照（纯数据，打日志/断言两用）。 */
export interface PiggybackFanoutStats {
  readonly mode: PiggybackResolutionMode;
  /** 本跳实际发出数 */
  readonly childCount: number;
  /** 有入站 next_hops（上游给了路由） */
  readonly piggybackHit: boolean;
  /** 无入站 next_hops，被迫回退查本地 D1 */
  readonly d1Fallback: boolean;
  /** 发出的包里带了 next_hops（下游可免查 D1） */
  readonly withNextHops: number;
  /** 发出的包里带了 route_slice（下游可免查 D1 且免算切片） */
  readonly withSlice: number;
  /** 发出的包里 slice 超 8KB 被降载（只发 next_hops） */
  readonly sliceTrimmed: number;
}

/**
 * M16-RELAY-PIGGYBACK 可观测：从 fanout 结果汇总计数（纯函数，可单测）。
 * Wave1"破除脱节"证伪口径：piggybackHit 高 = 上游路由在生效；d1Fallback 高 = 仍在靠慢同步；
 * withSlice 高 = 自包含透传成立；sliceTrimmed 高 = 大群在降载，需看群规模分布。
 */
export function summarizePiggybackStats(
  mode: PiggybackResolutionMode,
  childPayloadFlags: ReadonlyArray<{ withNextHops: boolean; withSlice: boolean; sliceTrimmed: boolean }>,
): PiggybackFanoutStats {
  let withNextHops = 0;
  let withSlice = 0;
  let sliceTrimmed = 0;
  for (const f of childPayloadFlags) {
    if (f.withNextHops) withNextHops++;
    if (f.withSlice) withSlice++;
    if (f.sliceTrimmed) sliceTrimmed++;
  }
  const piggybackHit = mode === 'piggyback-only' || mode === 'intersect' || mode === 'authority-fallback';
  return {
    mode,
    childCount: childPayloadFlags.length,
    piggybackHit,
    d1Fallback: mode === 'local-only',
    withNextHops,
    withSlice,
    sliceTrimmed,
  };
}

/**
 * M16-RELAY-PIGGYBACK-B1：入站 next_hops 交集校验（纯函数，可单测）。
 * - 无 piggyback → 用本地 D1（local-only）。
 * - 本地 D1 为空 / 不可用（null）→ 全信 piggyback（piggyback-only）：
 *   含「信封 tree_id 领先本机」时由 fanout 主动传 null 跳过 D1。
 * - 本地非空且同 tree → 与本地取交集；交集非空用交集（intersect）；
 *   交集为空说明同树下 piggyback 被篡改，回本地权威（authority-fallback）。
 * 注意：树重建脱节不得走 authority-fallback——应由调用方在 tree 不一致时传 localChildren=null。
 */
export function resolveFanoutChildren(
  piggybackNextHops: readonly string[] | undefined,
  localChildren: readonly string[] | null,
): { children: string[]; mode: PiggybackResolutionMode } {
  const normalizedPiggy =
    piggybackNextHops && piggybackNextHops.length > 0
      ? Array.from(new Set(piggybackNextHops.map(normalizeGroupMemberUrl))).slice(
          0,
          GROUP_RELAY_FANOUT_BATCH,
        )
      : [];
  if (normalizedPiggy.length === 0) {
    return { children: (localChildren ?? []).slice(0, GROUP_RELAY_FANOUT_BATCH), mode: 'local-only' };
  }
  if (!localChildren || localChildren.length === 0) {
    return { children: normalizedPiggy, mode: 'piggyback-only' };
  }
  const allow = new Set(localChildren.map(normalizeGroupMemberUrl));
  const filtered = normalizedPiggy.filter((u) => allow.has(u));
  if (filtered.length > 0) {
    return { children: filtered, mode: 'intersect' };
  }
  return {
    children: localChildren.map(normalizeGroupMemberUrl).slice(0, GROUP_RELAY_FANOUT_BATCH),
    mode: 'authority-fallback',
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * M16-RELAY-PIGGYBACK：从切片中找出指定 parent 的直接孩子列表（去重并限制出度 ≤ GROUP_RELAY_FANOUT_BATCH）。
 * B1B2 后为兼容壳：内部走 buildRelayChildrenMap + findDirectChildrenFromMap（O(E) 建表 + O(1) 查）。
 * 热路径（fanoutGroupRelay）直接用 Map 版，避免每 child 重建表。
 */
export function findDirectChildrenFromSlice(
  slice: readonly RelayEdgeRecord[],
  parentWorkerBUrl: string,
): string[] {
  return findDirectChildrenFromMap(buildRelayChildrenMap(slice), parentWorkerBUrl);
}

/**
 * M16-RELAY-PIGGYBACK：从一组边中提取以 rootWorkerBUrl 为根的子树边切片（BFS 遍历向下可达的所有边）。
 * B1B2 后为兼容壳：内部走 buildRelayChildrenMap + extractSubtreeSliceFromMap（O(V+E)，下标指针无 shift）。
 */
export function extractSubtreeSlice(
  allEdges: readonly RelayEdgeRecord[],
  rootWorkerBUrl: string,
): RelayEdgeRecord[] {
  return extractSubtreeSliceFromMap(buildRelayChildrenMap(allEdges), rootWorkerBUrl);
}

/**
 * M16-RELAY-PIGGYBACK：群主查询当前 treeId 的全部边（单次 D1 查询，避免按节点多次读）。
 * B1B2：加防御性 LIMIT（RELAY_TREE_EDGES_FETCH_LIMIT），防单群无界增长撑爆 D1 读。
 */
export async function fetchAllTreeEdges(
  env: Env,
  groupId: string,
  treeId: number,
): Promise<RelayEdgeRecord[]> {
  const { results } = await messagingDb(env)
    .prepare(
      `SELECT parent_worker_b_url, child_worker_b_url FROM group_relay_edges
        WHERE group_id = ? AND tree_id = ?
        LIMIT ?`,
    )
    .bind(groupId, treeId, RELAY_TREE_EDGES_FETCH_LIMIT)
    .all<{ parent_worker_b_url: string; child_worker_b_url: string }>();

  return (results ?? []).map((r) => ({
    parent_worker_b_url: normalizeGroupMemberUrl(r.parent_worker_b_url),
    child_worker_b_url: normalizeGroupMemberUrl(r.child_worker_b_url),
  }));
}

async function fetchRelayChildren(
  env: Env,
  groupId: string,
  treeId: number,
  parentWorkerBUrl: string,
): Promise<string[]> {
  const parentUrl = normalizeGroupMemberUrl(parentWorkerBUrl);
  const { results } = await messagingDb(env)
    .prepare(
      `SELECT child_worker_b_url FROM group_relay_edges
        WHERE group_id = ? AND tree_id = ? AND parent_worker_b_url = ?
        LIMIT ?`,
    )
    .bind(groupId, treeId, parentUrl, GROUP_RELAY_FANOUT_BATCH)
    .all<{ child_worker_b_url: string }>();
  return (results ?? []).map((r) => normalizeGroupMemberUrl(r.child_worker_b_url));
}

/** 单跳 POST /groups/relay：SSRF 门禁 + redirect:manual + 超时 fail-soft + 可选快重试。 */
export async function postRelayToPeer(
  env: Env,
  childWorkerBUrl: string,
  payload: GroupRelayPayload,
): Promise<'ok' | 'failed'> {
  const base = normalizeGroupMemberUrl(childWorkerBUrl);
  const url = `${base}/groups/relay`;
  const attempts = 1 + GROUP_RELAY_FETCH_RETRIES;
  for (let i = 0; i < attempts; i++) {
    const result = await fetchOutboundPeer(env, url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      timeoutMs: GROUP_RELAY_FETCH_TIMEOUT_MS,
    });
    if (!result.ok) {
      // unsafe_url：不再重试（0 连接）
      if (result.reason === 'unsafe_url') return 'failed';
    } else if (result.response.ok) {
      return 'ok';
    } else {
      console.warn('[group/relay] fanout non-ok', result.host ?? '(peer)', result.response.status);
    }
    if (i + 1 < attempts) await sleep(150);
  }
  return 'failed';
}

/** 向 relay_tree 子节点 fanout（并发 ≤GROUP_RELAY_FANOUT_BATCH，优先 Header Piggyback，回退 D1，fail-soft）。
 * B1：同 tree 时入站 next_hops 与本地 D1 取交集（防篡改）；信封 tree 领先本机时信 piggyback 并跳过 D1。
 * B2：route_slice 只建一次邻接表（O(E)），每 child 查表 O(1)；不再每 child 全表扫。
 */
export async function fanoutGroupRelay(
  env: Env,
  groupId: string,
  treeId: number,
  parentWorkerBUrl: string,
  envelope: GroupMessageEnvelope,
  hopCount: number,
  piggyback?: FanoutPiggybackOptions,
  opts?: { localTreeId?: number },
): Promise<void> {
  if (hopCount >= GROUP_RELAY_MAX_HOP) return;

  const hasPiggy =
    Array.isArray(piggyback?.next_hops) && piggyback!.next_hops!.length > 0;
  const localTreeId = opts?.localTreeId;
  const treeMismatch =
    typeof localTreeId === 'number' && Number.isFinite(localTreeId) && localTreeId !== treeId;

  // 1. B1：信封 tree 领先 → 跳过 D1、全信 piggyback（破 15min 脱节 + 省读配额）
  //    同 tree → 读本地边做交集；无 piggyback → 读本地边 local-only
  let localChildren: string[] | null;
  if (hasPiggy && treeMismatch) {
    localChildren = null;
  } else {
    localChildren = await fetchRelayChildren(env, groupId, treeId, parentWorkerBUrl);
  }
  const resolution = resolveFanoutChildren(piggyback?.next_hops, localChildren);
  const children = resolution.children;
  if (resolution.mode !== 'local-only' || treeMismatch) {
    console.warn('[group/relay] piggyback resolve', {
      group_id: groupId,
      mode: resolution.mode,
      tree_mismatch: treeMismatch ? 1 : 0,
      child_count: children.length,
    });
  }

  if (children.length === 0) return;

  // 2. B2：route_slice 只建一次邻接表；为每个 child 查表取 next_hops + 子树 slice，超 8KB 只发 next_hops
  const currentSliceMap =
    piggyback?.route_slice && piggyback.route_slice.length > 0
      ? buildRelayChildrenMap(piggyback.route_slice)
      : null;

  const statsFlags: Array<{ withNextHops: boolean; withSlice: boolean; sliceTrimmed: boolean }> = [];
  const tasks = children.map((childUrl) => {
    let childNextHops: string[] | undefined = undefined;
    let childSlice: RelayEdgeRecord[] | undefined = undefined;
    let trimmed = false;

    if (currentSliceMap) {
      childNextHops = findDirectChildrenFromMap(currentSliceMap, childUrl);
      const fullSlice = extractSubtreeSliceFromMap(currentSliceMap, childUrl);
      // 8KB 降载：大群只发 next_hops，子节点回退查本地 D1，避免 waitUntil 出口流量与 CPU 双爆
      if (fullSlice.length > 0) {
        if (isRouteSliceOverBudget(fullSlice)) {
          trimmed = true;
        } else {
          childSlice = fullSlice;
        }
      }
    }

    const payload: GroupRelayPayload = {
      envelope,
      hop_count: hopCount + 1,
      tree_id: treeId,
      ...(childNextHops && childNextHops.length > 0 ? { next_hops: childNextHops } : {}),
      ...(childSlice && childSlice.length > 0 ? { route_slice: childSlice } : {}),
      ...(piggyback?.owner_receipt ? { owner_receipt: piggyback.owner_receipt } : {}),
    };
    statsFlags.push({
      withNextHops: Boolean(childNextHops && childNextHops.length > 0),
      withSlice: Boolean(childSlice && childSlice.length > 0),
      sliceTrimmed: trimmed,
    });

    return postRelayToPeer(env, childUrl, payload);
  });

  // 可观测：单次 fanout 打一条结构化日志（零 KV 写；wrangler tail 按 mode 聚合即得 Wave1 生效比）
  const stats = summarizePiggybackStats(resolution.mode, statsFlags);
  console.warn('[group/relay] piggyback fanout', {
    group_id: groupId,
    tree_id: treeId,
    hop: hopCount + 1,
    mode: stats.mode,
    child_count: stats.childCount,
    piggyback_hit: stats.piggybackHit ? 1 : 0,
    d1_fallback: stats.d1Fallback ? 1 : 0,
    with_next_hops: stats.withNextHops,
    with_slice: stats.withSlice,
    slice_trimmed: stats.sliceTrimmed,
  });

  await Promise.allSettled(tasks);
}

function scheduleOrAwait(
  work: Promise<unknown>,
  schedule?: GroupRelaySchedule,
): Promise<void> {
  if (schedule) {
    schedule(work);
    return Promise.resolve();
  }
  return work.then(() => undefined);
}

/** 群主节点：新消息写入后向各 seed fanout（自包含拓扑切片，可 waitUntil 不挡 HTTP）。
 * M16-SLA-3：同时向 pending 成员 POST 副本（冷却期内实时覆盖路径）。
 * GRP-RELAY-AUTH-2：可选携带 owner_receipt 向下透传。 */
export async function relayGroupMessageFromOwner(
  env: Env,
  groupId: string,
  ownerWorkerBUrl: string,
  treeId: number,
  envelope: GroupMessageEnvelope,
  opts?: { schedule?: GroupRelaySchedule; ownerReceipt?: OwnerReceiptV1 },
): Promise<void> {
  const receiptOpts = opts?.ownerReceipt ? { owner_receipt: opts.ownerReceipt } : {};
  await scheduleOrAwait(
    (async () => {
      // 权威群主查询当前树的全部边，提取种子节点及其自包含子树切片
      const allEdges = await fetchAllTreeEdges(env, groupId, treeId);
      const seedUrls = findDirectChildrenFromSlice(allEdges, ownerWorkerBUrl);

      if (seedUrls.length > 0) {
        // 群主向各个 seed 发送，带上 seed 的 next_hops 与子树切片
        await fanoutGroupRelay(env, groupId, treeId, ownerWorkerBUrl, envelope, 0, {
          next_hops: seedUrls,
          route_slice: allEdges,
          ...receiptOpts,
        });
      } else {
        // 兜底：若全边表查询为空（如建树初期或单节点），调用回退路径
        await fanoutGroupRelay(env, groupId, treeId, ownerWorkerBUrl, envelope, 0, receiptOpts);
      }

      // M16-SLA-4 实时覆盖（v1.1 强化版）：冷却期内向 pending 成员 POST 副本；
      // 内部自检 last_rebuilt_at + HARD_INVOKE_LIMIT，冷却期外自动跳过；fail-soft。
      await fanoutGroupRelayToPending(env, groupId, envelope, opts?.ownerReceipt);
    })(),
    opts?.schedule,
  );
}

/** 成员节点收到 relay 后：seen 去重、写本地副本、向下游 children 转发。 */
export async function handleLocalGroupRelay(
  env: Env,
  payload: GroupRelayPayload,
  localWorkerBUrl: string,
  opts?: { schedule?: GroupRelaySchedule },
): Promise<'forwarded' | 'duplicate' | 'stored'> {
  const envelope = payload.envelope;
  const hopCount = payload.hop_count;
  const metaDb = messagingDb(env);
  const seenAt = nowIso();

  const existingSeen = await metaDb
    .prepare(`SELECT message_id FROM group_relay_seen WHERE message_id = ? LIMIT 1`)
    .bind(envelope.message_id)
    .first<{ message_id: string }>();
  if (existingSeen) {
    return 'duplicate';
  }

  const group = await metaDb
    .prepare(`SELECT group_id, tree_id FROM groups WHERE group_id = ? LIMIT 1`)
    .bind(envelope.group_id)
    .first<{ group_id: string; tree_id: number }>();
  if (!group) {
    throw new Error('GROUP_NOT_FOUND');
  }

  const msgDb = await resolveGroupMessagesDb(env, envelope.group_id);
  await metaDb
    .prepare(`INSERT INTO group_relay_seen (message_id, group_id, seen_at) VALUES (?, ?, ?)`)
    .bind(envelope.message_id, envelope.group_id, seenAt)
    .run();
  // MSG-FIX-5：relay 落库复制**群主签名回执里的** recv_seq（权威背书）。
  // 中继不得自造序号——无回执 / 回执无 seq 时写 NULL，由后续 sync 下行补齐。
  const relayedRecvSeq =
    typeof payload.owner_receipt?.recv_seq === 'number' ? payload.owner_receipt.recv_seq : null;
  // REL-FIX-13：发信方本机**已存在**该消息行（本地发信先落库、此时 recv_seq 仍为 NULL），
  // 原先的 `INSERT OR IGNORE` 会因主键冲突整条跳过 → 本机序号一直补不上，
  // 只能等下一次 sync 才刷入。改为 upsert：仅在本地缺失时补齐序号/时间戳，
  // **已有值一律保留**（本地行内容才是本机权威，中继不得覆盖）。
  await msgDb
    .prepare(
      `INSERT INTO member_group_messages
       (message_id, group_id, epoch, sender_worker_b_url, sender_handle, msg_kind, ciphertext, created_at, envelope_json, recv_seq, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(message_id) DO UPDATE SET
         recv_seq = COALESCE(member_group_messages.recv_seq, excluded.recv_seq),
         received_at = COALESCE(member_group_messages.received_at, excluded.received_at)`,
    )
    .bind(
      envelope.message_id,
      envelope.group_id,
      envelope.epoch,
      envelope.sender_worker_b_url,
      envelope.sender_handle,
      envelope.msg_kind,
      envelope.ciphertext,
      envelope.created_at,
      JSON.stringify(envelope),
      relayedRecvSeq,
      seenAt,
    )
    .run();

  // M7-30-GROUP-URL：system 换域载荷验签后立即改址
  try {
    const { maybeApplyGroupUrlChangeFromSystemCiphertext } = await import('./groupUrlChangeAnnounce');
    await maybeApplyGroupUrlChangeFromSystemCiphertext(env, envelope.msg_kind, envelope.ciphertext);
  } catch (err) {
    console.warn('[group/relay] groupUrlChange apply 失败', err);
  }

  if (hopCount < GROUP_RELAY_MAX_HOP) {
    // M-RT-2：先落库再异步 fanout，避免父节点等整棵子树
    // M16-RELAY-PIGGYBACK：优先使用本包传递的 next_hops 与 route_slice
    // GRP-RELAY-AUTH-2：透传 owner_receipt
    // tree_id：信封领先本机时 fanout 跳过 D1、信 piggyback（防重建脱节误走 authority-fallback）
    const envelopeTreeId = payload.tree_id ?? group.tree_id;
    await scheduleOrAwait(
      fanoutGroupRelay(
        env,
        envelope.group_id,
        envelopeTreeId,
        localWorkerBUrl,
        envelope,
        hopCount,
        {
          next_hops: payload.next_hops,
          route_slice: payload.route_slice,
          ...(payload.owner_receipt ? { owner_receipt: payload.owner_receipt } : {}),
        },
        { localTreeId: group.tree_id },
      ),
      opts?.schedule,
    );
    return 'forwarded';
  }

  return 'stored';
}