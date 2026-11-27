// M16-SLA-2：双父拓扑 — 每人恰好 2 个父节点。
// 与 m16-sla-all-members-5s-plan.md §10-16 一致：PRIMARY_FANOUT = min(SEED×5, ⌊N/2⌋)，强制交集发言人∈T_owner、群主∈T_speaker。

import type { Env } from '../env';
import type { GroupMessageEnvelope, GroupRelayPayload, OwnerReceiptV1 } from '@hailuo/shared-types';
import { messagingDb } from './messagingDb';
import { normalizeGroupMemberUrl } from './groupMemberUrl';
import { fanoutGroupRelay, postRelayToPeer, RELAY_TREE_EDGES_FETCH_LIMIT } from './groupRelay';

/** 与 m16-group-chat-plan.md §1.2 ACTIVE_WINDOW 一致：2×15min sync 间隔。 */
export const GROUP_ACTIVE_WINDOW_MS = 30 * 60 * 1000;
export const GROUP_SEED_COUNT = 8;
/** M16-SLA §11：主责外发量（每人每轮最多发 8 条）；同时也约束每成员的父节点选择池大小。 */
export const PRIMARY_FANOUT = 8;
/** M16-SLA §20：重建最小间隔 ≥10s（硬前置条件，所有触发场景均适用）。 */
export const GROUP_REBUILD_COOLDOWN_MS = 10_000;
/** 向后兼容别名（已有代码引用）；实际每节点出度由 PRIMARY_FANOUT 约束。 */
export const GROUP_MAX_CHILDREN = PRIMARY_FANOUT;

/** M16-SLA-5：补发链路默认单次 invocation 处理 1 条历史消息（受 CF Workers 50 子请求限制）。
 * 多 invocation 串联由 caller 通过多次调用循环完成（典型为群主 cron 重建后立刻调一次，或
 * 手动刷新触发）。limit 上限 50 防御性硬封顶。 */
export const CATCHUP_FANOUT_DEFAULT_LIMIT = 1;
export const CATCHUP_FANOUT_MAX_LIMIT = 50;

// ── M16-SLA-4：实时覆盖路径 v1.1 强化 ──────────────────────────────
/** M16-SLA §11：与 PRIMARY_FANOUT 同步（建树与覆盖共用同一个 fanout 单位）。 */
export const SEED = 8;
/** M16-SLA v1.1 §四′：单次出站硬上限 = min(SEED×5, ⌊N/2⌋, 32)。常见值 32；N 较小（<64）时按 ⌊N/2⌋ 收缩，保证不超群体一半。 */
export const HARD_INVOKE_LIMIT_CAP = 32;
/**
 * 计算实时覆盖路径在「群主发消息」单次 invocation 内允许的最大并发子请求数。
 * - 单批并发上限固定为 32（≤SEED×5=40 且 ≤Cloudflare Workers 50 总子请求上限）
 * - 当 N 较小（<64）时按 ⌊N/2⌋ 收缩，保证不超群体一半
 * @param memberCount 当前群成员总数（group_members 行数）
 */
export function computeHardInvokeLimit(memberCount: number): number {
  const capByHalf = Math.floor(memberCount / 2);
  return Math.min(SEED * 5, capByHalf, HARD_INVOKE_LIMIT_CAP);
}

export interface GroupMemberRow {
  member_worker_b_url: string;
  member_handle: string;
  member_pubkey: string;
  last_ack_at: string | null;
  /** 入群时间；last_ack 为空时作「首次活跃」回退（禁言群无人发言也能建树） */
  joined_at?: string | null;
  /**
   * GROUP-CAP-SPEAK-1：最近 chat 发言时刻（建树排序）。
   * 活跃资格仍看 last_ack_at；缺省回退 joined_at / last_ack_at。
   */
  last_speak_at?: string | null;
  /** EPOCH v0.3：≥3 仅路由降级，不踢人 */
  empty_ack_streak?: number | null;
  status: string;
  role: string;
  key_state: string;
}

export interface PendingMemberRow {
  member_worker_b_url: string;
  member_handle: string;
  member_pubkey: string;
  key_state: string;
  added_at: string;
  /** SEC-AUDIT-2026-10-15：入群时登记的 X25519 DH；缺省 drain 后仍可 PUT 补登 */
  member_dh_pubkey?: string | null;
}

export interface RelayTreeEdge {
  parent_worker_b_url: string;
  child_worker_b_url: string;
}

export interface RelayTreeBuildResult {
  tree_id: number;
  seeds: string[];
  edges: RelayTreeEdge[];
  /** true = 本次实际重建完成；false = 因冷却期被跳过 */
  rebuilt: boolean;
  /** 本次从待上树列表并入的成员数 */
  pending_merged: number;
}

function nowIso(): string {
  return new Date().toISOString();
}

/** 活跃度时间（资格窗）：优先 last_ack_at；空则回退 joined_at（入群即首次活跃）。 */
export function memberActivityAtMs(m: Pick<GroupMemberRow, 'last_ack_at' | 'joined_at'>): number {
  if (m.last_ack_at) {
    const t = new Date(m.last_ack_at).getTime();
    return Number.isFinite(t) ? t : 0;
  }
  if (m.joined_at) {
    const t = new Date(m.joined_at).getTime();
    return Number.isFinite(t) ? t : 0;
  }
  return 0;
}

/**
 * GROUP-CAP-SPEAK-1：建树排序键 — 最近发言优先；缺省回退入群/ack。
 * 与 memberActivityAtMs 解耦：心跳保资格，发言决座位。
 */
export function memberSpeakRankAtMs(
  m: Pick<GroupMemberRow, 'last_speak_at' | 'joined_at' | 'last_ack_at'>,
): number {
  for (const raw of [m.last_speak_at, m.joined_at, m.last_ack_at]) {
    if (!raw) continue;
    const t = new Date(raw).getTime();
    if (Number.isFinite(t)) return t;
  }
  return 0;
}

/** 空 ack 降级阈值（与 groupKick EMPTY_ACK 对齐；≥ 则不参树父/中继）。 */
export const EMPTY_ACK_DEMOTE_THRESHOLD = 3;

/** 按活跃度在 ACTIVE_WINDOW 内筛选在册非 owner 成员（入群时间可充当首次活跃）。
 * EPOCH v0.3：`empty_ack_streak >= 3` 仅路由降级，仍可保持 membership active。 */
export function filterActiveMembers(
  members: GroupMemberRow[],
  nowMs: number = Date.now(),
): GroupMemberRow[] {
  const cutoff = nowMs - GROUP_ACTIVE_WINDOW_MS;
  return members.filter((m) => {
    if (m.status !== 'active' || m.role === 'owner') return false;
    if ((m.empty_ack_streak ?? 0) >= EMPTY_ACK_DEMOTE_THRESHOLD) return false;
    const activityMs = memberActivityAtMs(m);
    if (!activityMs) return false;
    return activityMs >= cutoff;
  });
}

// ── M16-SLA-3：待上树列表 ─────────────────────────────────────────

/** 查询某群所有待上树成员。 */
export async function getPendingMembers(
  env: Env,
  groupId: string,
): Promise<PendingMemberRow[]> {
  const db = messagingDb(env);
  const { results } = await db
    .prepare(
      `SELECT member_worker_b_url, member_handle, member_pubkey, key_state, added_at, member_dh_pubkey
         FROM group_pending_members
        WHERE group_id = ?
        ORDER BY added_at ASC`,
    )
    .bind(groupId)
    .all<PendingMemberRow>();
  return results ?? [];
}

/**
 * M16-SLA-3：出队 pending 成员，合并到 group_members（幂等 INSERT OR REPLACE）。
 * 在 recomputeAndPersistRelayTree 重建树之前调用。
 * @returns 出队的成员行列表
 */
export async function drainAndMergePendingMembers(
  env: Env,
  groupId: string,
): Promise<PendingMemberRow[]> {
  const db = messagingDb(env);
  const pending = await getPendingMembers(env, groupId);
  if (pending.length === 0) return [];

  const now = nowIso();
  await db.batch(
    pending.map((p) =>
      db
        .prepare(
          // 入群/上树即记首次活跃：last_ack_at = added_at；last_speak_at 同刻作排序回退
          `INSERT OR IGNORE INTO group_members
           (group_id, member_worker_b_url, member_handle, member_pubkey, role, key_state, status,
            last_ack_at, empty_ack_streak, joined_at, last_speak_at, member_dh_pubkey)
           VALUES (?, ?, ?, ?, 'member', ?, 'active', ?, 0, ?, ?, NULLIF(?, ''))`,
        )
        .bind(
          groupId,
          p.member_worker_b_url,
          p.member_handle,
          p.member_pubkey,
          p.key_state,
          p.added_at,
          p.added_at,
          p.added_at,
          (p.member_dh_pubkey ?? '').trim().toLowerCase(),
        ),
    ),
  );

  // 全部合并后清空 pending 表
  await db.prepare(`DELETE FROM group_pending_members WHERE group_id = ?`).bind(groupId).run();
  return pending;
}

/**
 * M16-SLA-4：冷却期内实时覆盖路径（v1.1 强化版）。
 *
 * 群主发消息时（不论是群主自己发还是转发群成员的消息），在已通过 `fanoutGroupRelay`
 * 按树机构向「已在树成员」推送的同时，**额外**对「待上树列表」中的成员直接 POST
 * 消息副本，使新成员在树重建完成前即可实时收到消息。
 *
 * **约束**：
 * - 仅在距上次重建完成 < `GROUP_REBUILD_COOLDOWN_MS`（10s）的冷却期内激活。
 *   冷却期外 pending 已被 `drainAndMergePendingMembers` 并入群成员表，新成员已入树，
 *   无需再走实时覆盖路径。
 * - 单次 invocation 内实时覆盖出站子请求 ≤ `HARD_INVOKE_LIMIT(memberCount)`（v1.1
 *   公式 `min(SEED×5, �N/2⌋, 32)`，常见值 32；N<64 时按 �N/2⌋ 收缩），与主路径 8
 *   共用 ≤Cloudflare Workers 50 子请求上限。
 * - 剩余 pending 成员留待**下一次群主发消息**接力覆盖（M16-SLA-3 设计取舍：单次
 *   发消息只覆盖 32 个，其余由 M16-SLA-5 补发链路在树重建完成后补 gap 窗口消息）。
 * - fail-soft：单个 POST 失败（超时 / 网络错）只 console.warn，不阻断主路径与剩余覆盖。
 * - hop_count=0：pending 成员收到后由 `handleLocalGroupRelay` 落库；其本地 group_relay_seen
 *   幂等保证同一 message_id 重复收到不重复入库。
 */
export async function fanoutGroupRelayToPending(
  env: Env,
  groupId: string,
  envelope: GroupMessageEnvelope,
  ownerReceipt?: OwnerReceiptV1,
): Promise<{ skipped: boolean; reason?: string; attempted: number; success: number; failed: number }> {
  const db = messagingDb(env);

  // ── 冷却期自检（M16-SLA §20）：仅 <10s 时才走实时覆盖 ──
  const group = await db
    .prepare(`SELECT last_rebuilt_at FROM groups WHERE group_id = ? LIMIT 1`)
    .bind(groupId)
    .first<{ last_rebuilt_at: string | null }>();
  if (!group) {
    return { skipped: true, reason: 'group_not_found', attempted: 0, success: 0, failed: 0 };
  }
  const lastRebuiltAtMs = group.last_rebuilt_at ? new Date(group.last_rebuilt_at).getTime() : 0;
  if (Date.now() - lastRebuiltAtMs >= GROUP_REBUILD_COOLDOWN_MS) {
    return { skipped: true, reason: 'not_in_cooldown', attempted: 0, success: 0, failed: 0 };
  }

  // ── 查 pending 列表（按 added_at 升序，先入先覆盖） ──
  const pending = await getPendingMembers(env, groupId);
  if (pending.length === 0) {
    return { skipped: false, attempted: 0, success: 0, failed: 0 };
  }

  // ── 算 HARD_INVOKE_LIMIT（v1.1 公式） ──
  const memberCountRow = await db
    .prepare(`SELECT COUNT(*) AS n FROM group_members WHERE group_id = ? AND status = 'active'`)
    .bind(groupId)
    .first<{ n: number }>();
  const memberCount = memberCountRow?.n ?? 0;
  const hardLimit = Math.max(1, computeHardInvokeLimit(memberCount));
  const batch = pending.slice(0, hardLimit);

  const payload: GroupRelayPayload = {
    envelope,
    hop_count: 0,
    ...(ownerReceipt ? { owner_receipt: ownerReceipt } : {}),
  };

  const settled = await Promise.allSettled(
    batch.map((p) =>
      postRelayToPeer(env, p.member_worker_b_url, payload).catch((err) => {
        console.warn('[group/relay] pending fanout failed', p.member_worker_b_url, err);
        return 'failed' as const;
      }),
    ),
  );

  let success = 0;
  let failed = 0;
  for (const r of settled) {
    if (r.status === 'fulfilled' && r.value === 'ok') success += 1;
    else failed += 1;
  }
  if (failed > 0) {
    console.warn(
      `[group/relay] pending realtime coverage: ${success} ok / ${failed} failed (batch=${batch.length}/${pending.length}, hardLimit=${hardLimit})`,
    );
  }

  return { skipped: false, attempted: batch.length, success, failed };
}

/**
 * M16-SLA-5：补发结果统计。
 *
 * 单次 `catchupFanoutGroupRelay` invocation 的回执：
 *  - skipped=true 表示未实际 fanout（reason 解释原因）；
 *  - messageCount = 本次尝试 fanout 的群主消息条数；
 *  - attempted  = 实际发起 POST/接力调用的次数（≠ 子请求数；
 *                 沿树接力时下游 fanoutGroupRelay 也会发起子请求，估算累加）；
 *  - success    = POST 成功条数（累计到调用栈最深一层的子返回）；
 *  - failed     = 失败的 envelope 数；
 *  - envelopeIds = 已处理的 message_id 列表（含成功 + 失败）。
 */
export interface CatchupFanoutResult {
  skipped: boolean;
  reason?: string;
  gapStart: string | null;
  gapEnd: string;
  messageCount: number;
  attempted: number;
  success: number;
  failed: number;
  envelopeIds: string[];
}

/** M16-SLA-5：从 group_messages 行补回 GroupMessageEnvelope（envelope_json 优先，字段兜底）。
 * 历史消息 envelope_json 可能为 NULL（0004 之前的旧行），用显式字段拼。
 * 接收方 `handleLocalGroupRelay` 走 envelope.message_id 去重，不依赖 sig/nonce；
 * 故 sig/nonce 在兜底路径下用占位（接收方不验签补发 — 防身份关联/反追查：仍保留原 ciphertext）。 */
function envelopeFromGroupMessagesRow(
  row: {
    message_id: string;
    group_id?: string | null;
    epoch: number;
    sender_worker_b_url: string;
    sender_handle: string;
    msg_kind: string;
    ciphertext: string;
    created_at: string;
    expires_at?: string | null;
    envelope_json?: string | null;
  },
  groupId: string,
  ownerWorkerBUrl: string,
): GroupMessageEnvelope | null {
  if (row.envelope_json) {
    try {
      const parsed = JSON.parse(row.envelope_json) as GroupMessageEnvelope;
      // 防身份关联/反追查：保留群主原 ciphertext/envelope；解析失败回落字段拼。
      if (parsed && parsed.message_id) return parsed;
    } catch {
      /* 忽略解析错误，落到字段拼 */
    }
  }
  // 字段兜底：旧消息 expires_at 可空，用 90 天默认（与 group_sync_state 默认 retention 同源）
  const expiresAt =
    row.expires_at ??
    new Date(new Date(row.created_at).getTime() + 90 * 24 * 60 * 60 * 1000).toISOString();
  return {
    v: 1,
    kind: 'GROUP_MESSAGE',
    message_id: row.message_id,
    group_id: groupId,
    epoch: row.epoch,
    sender_worker_b_url: row.sender_worker_b_url,
    sender_handle: row.sender_handle,
    owner_worker_b_url: ownerWorkerBUrl,
    created_at: row.created_at,
    expires_at: expiresAt,
    // 兜底 sig/nonce 占位 — 接收方 `handleLocalGroupRelay` 不验签补发；
    // 真实转发路径（realtime coverage）走原始 envelope_json 保留原签名。
    nonce: 'catchup:placeholder',
    msg_kind: row.msg_kind as 'chat' | 'system',
    ciphertext: row.ciphertext,
    sig: 'catchup:placeholder',
  };
}

/**
 * M16-SLA-5：补发链路（v1.1 partition 利用）。
 *
 * 树重建完成后由**群主**调一次（或 cron 多 invocation 多次）把
 * `[gap_window_start, gap_window_end]` 区间内群主已发出的消息按新树路径重推到新成员。
 *
 * **gap 窗口定义**（§六 6.2）：
 *  - gap_window_end = `options.gapEnd ?? now`
 *  - gap_window_start = `options.gapStart ?? MAX(群主最近一条消息 created_at, groups.last_rebuilt_at)`
 *    取较新点（max）保证不重复补发：若群主最近消息比上次重建更早（即重建后还没发消息），
 *    用 last_rebuilt_at 作为 gap 起点；否则用群主最近消息（避免把重建前更早的消息再补）。
 *    fallback：群主从未发过 → gap_start = `groups.last_rebuilt_at`。
 *
 * **算法**：
 *  1. 校验 group 存在 + 本次 treeId 与 groups.treeId 一致（防止旧树残留）；
 *  2. 查 `[gap_start, gap_end]` 内 sender = owner 的 group_messages 行；
 *  3. 对每行 envelope 调 `fanoutGroupRelay(env, groupId, treeId, owner, envelope, 0)`：
 *     - 第一跳 fanout 到群主 8 个 children（按 v1.1 PRIMARY_FANOUT=8 固定）；
 *     - 后续跳沿树接力；
 *     - 旧成员收到后由 `group_relay_seen` 幂等去重（已实时覆盖过）；
 *     - 新成员（即刚 drain 进 group_members）通常在子树下某处，自然通过接力收到。
 *  4. fail-soft：每条 envelope 单 catch；console.warn；不阻断。
 *
 * **v1.1 partition 性能保证**：v1.1 partition 交集很少 → 双路径冗余 ≤2 人；
 * 每条消息一次 `fanoutGroupRelay` 沿新树接力 ≤GROUP_RELAY_MAX_HOP 跳
 * （每跳 PRIMARY_FANOUT=8 children），群主顶层只发 ≤8 POST，下游接力
 * 由已上树成员分摊。旧成员 seen 去重不掉 byte，全员幂等。
 *
 * **单 invocation 上限**：`limit` 默认 1（每条 envelope 一次 `fanoutGroupRelay`
 * 接力 8+POST 多跳，加上下游接力，单 envelope 已接近 50 子请求；单 invocation
 * 处理单条 envelope 是 CF Workers 50 子请求上限下的最稳配置）。多 envelope 续发
 * 由 caller（cron / triggerPendingRebuilds / 手动刷新）多次串行调用。
 */
export async function catchupFanoutGroupRelay(
  env: Env,
  groupId: string,
  ownerWorkerBUrl: string,
  treeId: number,
  options?: { gapStart?: string; gapEnd?: string; limit?: number },
): Promise<CatchupFanoutResult> {
  const db = messagingDb(env);
  const ownerUrl = normalizeGroupMemberUrl(ownerWorkerBUrl);

  // ── 1. 群组存在 + treeId 一致 ──
  const group = await db
    .prepare(
      `SELECT owner_worker_b_url, tree_id, last_rebuilt_at
         FROM groups WHERE group_id = ? LIMIT 1`,
    )
    .bind(groupId)
    .first<{
      owner_worker_b_url: string;
      tree_id: number;
      last_rebuilt_at: string | null;
    }>();
  if (!group) {
    return {
      skipped: true,
      reason: 'group_not_found',
      gapStart: null,
      gapEnd: options?.gapEnd ?? '',
      messageCount: 0,
      attempted: 0,
      success: 0,
      failed: 0,
      envelopeIds: [],
    };
  }
  if (group.tree_id !== treeId) {
    return {
      skipped: true,
      reason: 'tree_id_mismatch',
      gapStart: null,
      gapEnd: options?.gapEnd ?? '',
      messageCount: 0,
      attempted: 0,
      success: 0,
      failed: 0,
      envelopeIds: [],
    };
  }

  // ── 2. 算 gap_window_end / gap_window_start ──
  const gapEnd = options?.gapEnd ?? new Date().toISOString();
  const lastRebuiltAt = group.last_rebuilt_at ?? new Date(0).toISOString();

  // 群主最近一条消息 created_at（在 gapEnd 之前）
  const lastOwnerMsg = await db
    .prepare(
      `SELECT created_at FROM group_messages
        WHERE group_id = ? AND sender_worker_b_url = ? AND created_at <= ?
        ORDER BY created_at DESC LIMIT 1`,
    )
    .bind(groupId, ownerUrl, gapEnd)
    .first<{ created_at: string }>();

  // fallback：群主从未发过消息 → gap_start = last_rebuilt_at（首次重建前可能为 1970 ISO）
  const candidateStart = lastOwnerMsg?.created_at ?? null;
  // 取 MAX(candidateStart, last_rebuilt_at)：保证不重复补发上次重建前的消息
  const gapStart =
    options?.gapStart ??
    (candidateStart && new Date(candidateStart).getTime() > new Date(lastRebuiltAt).getTime()
      ? candidateStart
      : lastRebuiltAt);

  // ── 3. 查 [gap_start, gap_end] 内 owner 发送的消息 ──
  const limit = Math.max(1, Math.min(options?.limit ?? CATCHUP_FANOUT_DEFAULT_LIMIT, CATCHUP_FANOUT_MAX_LIMIT));
  const { results: rows } = await db
    .prepare(
      `SELECT message_id, group_id, epoch, sender_worker_b_url, sender_handle, msg_kind, ciphertext,
              created_at, expires_at, envelope_json
         FROM group_messages
        WHERE group_id = ? AND sender_worker_b_url = ?
          AND created_at >= ? AND created_at <= ?
        ORDER BY created_at ASC LIMIT ?`,
    )
    .bind(groupId, ownerUrl, gapStart, gapEnd, limit)
    .all<{
      message_id: string;
      group_id: string | null;
      epoch: number;
      sender_worker_b_url: string;
      sender_handle: string;
      msg_kind: string;
      ciphertext: string;
      created_at: string;
      expires_at: string | null;
      envelope_json: string | null;
    }>();

  if (!rows || rows.length === 0) {
    return {
      skipped: true,
      reason: 'no_gap_messages',
      gapStart,
      gapEnd,
      messageCount: 0,
      attempted: 0,
      success: 0,
      failed: 0,
      envelopeIds: [],
    };
  }

  // ── 4. 沿新树 fanout（每条 envelope 一次 fanoutGroupRelay；v1.1 partition 性能保证） ──
  let attempted = 0;
  let success = 0;
  let failed = 0;
  const envelopeIds: string[] = [];

  for (const row of rows) {
    const envelope = envelopeFromGroupMessagesRow(row, groupId, group.owner_worker_b_url);
    if (!envelope) {
      failed += 1;
      envelopeIds.push(row.message_id);
      console.warn('[group/relay] catchup envelope parse failed', row.message_id);
      continue;
    }
    try {
      // fanoutGroupRelay 内部 Promise.allSettled ≤GROUP_RELAY_FANOUT_BATCH=8 children；
      // 接力由各 children 节点本地 fanout 完成；旧成员 seen 幂等去重。
      await fanoutGroupRelay(env, groupId, treeId, ownerUrl, envelope, 0);
      attempted += 1;
      success += 1;
      envelopeIds.push(envelope.message_id);
    } catch (err) {
      console.warn('[group/relay] catchup fanout failed', envelope.message_id, err);
      attempted += 1;
      failed += 1;
      envelopeIds.push(envelope.message_id);
    }
  }

  if (failed > 0) {
    console.warn(
      `[group/relay] catchup fanout: ${success} ok / ${failed} failed (batch=${rows.length}, treeId=${treeId}, gap=[${gapStart}, ${gapEnd}])`,
    );
  }

  return {
    skipped: false,
    gapStart,
    gapEnd,
    messageCount: rows.length,
    attempted,
    success,
    failed,
    envelopeIds,
  };
}

/**
 * 从上棵树边表抽出「父 → 仍活跃子」有序列表（Sticky 座位表）。
 * 父须为群主或仍在活跃集；子须在活跃集。空 ack 降级者已不在 activeSet。
 */
export function preferredChildrenByParent(
  ownerUrl: string,
  activeSet: ReadonlySet<string>,
  previousEdges: readonly RelayTreeEdge[] | undefined,
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (!previousEdges?.length) return out;
  const seenUnderParent = new Map<string, Set<string>>();
  for (const e of previousEdges) {
    const parent = normalizeGroupMemberUrl(e.parent_worker_b_url);
    const child = normalizeGroupMemberUrl(e.child_worker_b_url);
    if (!parent || !child || parent === child) continue;
    if (!activeSet.has(child)) continue;
    if (parent !== ownerUrl && !activeSet.has(parent)) continue;
    let seen = seenUnderParent.get(parent);
    if (!seen) {
      seen = new Set();
      seenUnderParent.set(parent, seen);
    }
    if (seen.has(child)) continue;
    seen.add(child);
    const list = out.get(parent);
    if (list) list.push(child);
    else out.set(parent, [child]);
  }
  return out;
}

/**
 * RELAY-TREE-CPU-1：当前活跃成员 URL 集是否与旧树孩子集一致（无增删）。
 * 一致时可考虑跳过删边/建树/写边，只 touch 时间戳（Cron 错峰仍前进）。
 * 仅看 child 侧：满叉单父树下每个非群主成员恰好作为一条边的 child 出现一次。
 *
 * 注意：调用方须再结合 `shouldSkipRelayRebuildForActiveSet`（含发言序衰减窗），
 * 不可单独用本函数决定短路——否则发言序推进在稳定群中永远不生效。
 */
export function isRelayActiveSetUnchanged(
  ownerWorkerBUrl: string,
  activeMemberUrls: readonly string[],
  previousEdges: readonly RelayTreeEdge[] | undefined,
): boolean {
  if (!previousEdges?.length) return false;
  if (activeMemberUrls.length === 0) return false;
  const ownerUrl = normalizeGroupMemberUrl(ownerWorkerBUrl);
  const prevChildren = new Set<string>();
  for (const e of previousEdges) {
    const child = normalizeGroupMemberUrl(e.child_worker_b_url);
    if (!child || child === ownerUrl) continue;
    prevChildren.add(child);
  }
  if (prevChildren.size !== activeMemberUrls.length) return false;
  for (const raw of activeMemberUrls) {
    const u = normalizeGroupMemberUrl(raw);
    if (!u || !prevChildren.has(u)) return false;
  }
  return true;
}

/**
 * GROUP-CAP-SPEAK-1：Layer1 发言序是否相对旧种子发生实质倒挂。
 * 理想 top-seed 中有人不在当前 seeds，且其 speak 高于当前最弱 seed → 需要重建。
 * （短路只看 URL 集会吞掉发言推进；用本判定补回。不依赖 last_rebuilt_at——短路也会 touch 该字段。）
 */
export function relaySpeakOrderNeedsResort(
  ownerWorkerBUrl: string,
  previousEdges: readonly RelayTreeEdge[] | undefined,
  members: readonly GroupMemberRow[],
  nowMs: number = Date.now(),
): boolean {
  if (!previousEdges?.length) return false;
  const ownerUrl = normalizeGroupMemberUrl(ownerWorkerBUrl);
  const currentSeeds = seedsFromRelayEdges(ownerUrl, previousEdges);
  if (currentSeeds.length === 0) return false;

  const active = filterActiveMembers([...members], nowMs).sort((a, b) => {
    const diff = memberSpeakRankAtMs(b) - memberSpeakRankAtMs(a);
    if (diff !== 0) return diff;
    return normalizeGroupMemberUrl(a.member_worker_b_url).localeCompare(
      normalizeGroupMemberUrl(b.member_worker_b_url),
    );
  });
  if (active.length === 0) return false;

  const seedCap = Math.min(GROUP_SEED_COUNT, PRIMARY_FANOUT, active.length);
  const speakByUrl = new Map<string, number>();
  for (const m of active) {
    speakByUrl.set(normalizeGroupMemberUrl(m.member_worker_b_url), memberSpeakRankAtMs(m));
  }

  let weakestCurrent = Number.POSITIVE_INFINITY;
  for (const s of currentSeeds) {
    weakestCurrent = Math.min(weakestCurrent, speakByUrl.get(s) ?? 0);
  }

  const currentSet = new Set(currentSeeds);
  for (const m of active.slice(0, seedCap)) {
    const url = normalizeGroupMemberUrl(m.member_worker_b_url);
    if (currentSet.has(url)) continue;
    if ((speakByUrl.get(url) ?? 0) > weakestCurrent) return true;
  }
  return false;
}

/**
 * 是否跳过建树：活跃集无增删 **且** Layer1 发言序未实质倒挂。
 */
export function shouldSkipRelayRebuildForActiveSet(input: {
  ownerWorkerBUrl: string;
  activeMemberUrls: readonly string[];
  previousEdges: readonly RelayTreeEdge[] | undefined;
  members: readonly GroupMemberRow[];
  nowMs: number;
}): boolean {
  if (
    !isRelayActiveSetUnchanged(
      input.ownerWorkerBUrl,
      input.activeMemberUrls,
      input.previousEdges,
    )
  ) {
    return false;
  }
  if (
    relaySpeakOrderNeedsResort(
      input.ownerWorkerBUrl,
      input.previousEdges,
      input.members,
      input.nowMs,
    )
  ) {
    return false;
  }
  return true;
}

/** 从旧边还原群主直接孩子（Layer1 seeds），供短路返回。 */
export function seedsFromRelayEdges(
  ownerWorkerBUrl: string,
  edges: readonly RelayTreeEdge[],
): string[] {
  const ownerUrl = normalizeGroupMemberUrl(ownerWorkerBUrl);
  const seeds: string[] = [];
  const seen = new Set<string>();
  for (const e of edges) {
    const parent = normalizeGroupMemberUrl(e.parent_worker_b_url);
    const child = normalizeGroupMemberUrl(e.child_worker_b_url);
    if (parent !== ownerUrl || !child || seen.has(child)) continue;
    seen.add(child);
    seeds.push(child);
  }
  return seeds;
}

/**
 * M16 正向 relay 建树：按活跃度排序的 **PRIMARY_FANOUT 满叉树**（默认 8 叉）。
 *
 * 规则（与产品口径对齐）：
 *  1. 活跃成员按最近活跃降序（并列 URL 稳定排序）
 *  2. 第 1 层：群主 → 最多 8 个 seed
 *  3. 之后 BFS：每个节点最多 **8 个孩子**
 *  4. 单父边（出度硬上限 = PRIMARY_FANOUT，与 fanout LIMIT 8 一致）
 *
 * RELAY-PIGGYBACK-4 Sticky（可选 `previousEdges`）：
 *  - Layer1/深层：仍活跃的旧骨干优先保留座位，不为微小 last_ack 整队重排
 *  - Soft Sticky（GROUP-CAP-SPEAK-1）：Layer1 旧 seed 须仍落在发言序前 `seedCap×2`，否则让位给高频发言者
 *  - 失效座位（不在活跃集 / empty_ack 降级 / 跌出发言 grace 带）才按发言序替补
 *  - 全新成员优先填叶子；Layer1 空位先让「旧树内非 seed」晋升，再让新人上 Layer1
 *  - 无旧边时行为与纯活跃 BFS 一致（冷启动）
 *
 * RELAY-TREE-CPU-1：回退挂载用单调指针扫 `ordered`，整树放置 O(N)（避免 Free 10ms 在千人级被 O(N²) 打穿）。
 */
export function buildRelayTree(
  ownerWorkerBUrl: string,
  members: GroupMemberRow[],
  currentTreeId: number,
  nowMs: number = Date.now(),
  previousEdges?: readonly RelayTreeEdge[],
): RelayTreeBuildResult {
  const ownerUrl = normalizeGroupMemberUrl(ownerWorkerBUrl);
  // 资格窗仍用 last_ack；排序改 last_speak_at（GROUP-CAP-SPEAK-1）
  const active = filterActiveMembers(members, nowMs).sort((a, b) => {
    const diff = memberSpeakRankAtMs(b) - memberSpeakRankAtMs(a);
    if (diff !== 0) return diff;
    return normalizeGroupMemberUrl(a.member_worker_b_url).localeCompare(
      normalizeGroupMemberUrl(b.member_worker_b_url),
    );
  });

  if (active.length === 0) {
    return { tree_id: currentTreeId + 1, seeds: [], edges: [], rebuilt: false, pending_merged: 0 };
  }

  const ordered = active.map((m) => normalizeGroupMemberUrl(m.member_worker_b_url));
  const activeSet = new Set(ordered);
  const preferred = preferredChildrenByParent(ownerUrl, activeSet, previousEdges);

  const edges: RelayTreeEdge[] = [];
  const edgeKey = (p: string, c: string) => `${p}\0${c}`;
  const seenEdge = new Set<string>();
  const pushEdge = (parent: string, child: string) => {
    if (!parent || !child || parent === child) return;
    const k = edgeKey(parent, child);
    if (seenEdge.has(k)) return;
    seenEdge.add(k);
    edges.push({ parent_worker_b_url: parent, child_worker_b_url: child });
  };

  type ParentSlot = { url: string; childCount: number };
  const parents: ParentSlot[] = [];
  let parentIdx = 0;
  const placed = new Set<string>();
  const seedCap = Math.min(GROUP_SEED_COUNT, PRIMARY_FANOUT, ordered.length);

  // Layer1：Soft Sticky——旧 seed 须仍在发言序前 grace 带，否则让位（防永久霸占骨干）
  const speakGraceSet = new Set(ordered.slice(0, Math.min(ordered.length, seedCap * 2)));
  const stickySeeds: string[] = [];
  for (const child of preferred.get(ownerUrl) ?? []) {
    if (stickySeeds.length >= seedCap) break;
    if (!activeSet.has(child) || stickySeeds.includes(child)) continue;
    if (!speakGraceSet.has(child)) continue;
    stickySeeds.push(child);
  }

  const seeds: string[] = [...stickySeeds];
  if (seeds.length < seedCap) {
    // Soft Sticky 空位按发言序补：不再把跌出 grace 的旧 seed 优先塞回 Layer1
    // （grace 带已挡住「一次发言挤爆」；旧逻辑会抵消 Soft Sticky）
    for (const u of ordered) {
      if (seeds.length >= seedCap) break;
      if (seeds.includes(u)) continue;
      seeds.push(u);
    }
  }

  for (const child of seeds) {
    pushEdge(ownerUrl, child);
    placed.add(child);
    parents.push({ url: child, childCount: 0 });
  }

  const unplaced = new Set(ordered.filter((u) => !placed.has(u)));

  // 单调指针：已扫过的 ordered 前缀里不会再出现未放置成员（只删不回 unplaced）
  let fallbackScanIdx = 0;

  /** 为某父挑选下一子：先旧边黏性，再活跃序（O(N) 总扫描） */
  const pickChild = (parentUrl: string): string | null => {
    for (const c of preferred.get(parentUrl) ?? []) {
      if (unplaced.has(c)) return c;
    }
    while (fallbackScanIdx < ordered.length) {
      const u = ordered[fallbackScanIdx++];
      if (unplaced.has(u)) return u;
    }
    return null;
  };

  while (unplaced.size > 0) {
    while (parentIdx < parents.length && parents[parentIdx].childCount >= PRIMARY_FANOUT) {
      parentIdx += 1;
    }
    if (parentIdx >= parents.length) {
      // 正常满叉 BFS 每挂一子就会入队为新父，父槽不应耗尽。禁止挂回群主破
      // PRIMARY_FANOUT：fanout 仍 LIMIT 8，多余边会静默收不到中继。
      console.warn('[group/relay-tree] buildRelayTree parent slots exhausted; leave unplaced', {
        unplaced: unplaced.size,
        parents: parents.length,
        seeds: seeds.length,
      });
      break;
    }
    const parent = parents[parentIdx];
    const child = pickChild(parent.url);
    if (!child) break;
    pushEdge(parent.url, child);
    unplaced.delete(child);
    parent.childCount += 1;
    parents.push({ url: child, childCount: 0 });
  }

  return {
    tree_id: currentTreeId + 1,
    seeds,
    edges,
    rebuilt: false,
    pending_merged: 0,
  };
}

export type RecomputeRelayTreeOptions = {
  /** EPOCH v0.3：踢人/退群/拉黑必须穿透 10s 冷却，避免被踢者残留 edges */
  force?: boolean;
};

/** 读取群成员，建树并写入 group_relay_edges + 更新 groups.tree_id / last_rebuilt_at / member role。
 * M16-SLA §20：距上次重建 <10s 时跳过本次重建（**除非** `force: true`）。
 * @returns rebuilt=true 时树已重建；rebuilt=false 时冷却期内被跳过（调用方不应触发后续 fanout）。 */
export async function recomputeAndPersistRelayTree(
  env: Env,
  groupId: string,
  options?: RecomputeRelayTreeOptions,
): Promise<RelayTreeBuildResult | null> {
  const force = options?.force === true;
  const db = messagingDb(env);
  const group = await db
    .prepare(
      `SELECT group_id, owner_worker_b_url, tree_id, last_rebuilt_at FROM groups WHERE group_id = ? AND dissolved_at IS NULL LIMIT 1`,
    )
    .bind(groupId)
    .first<{ group_id: string; owner_worker_b_url: string; tree_id: number; last_rebuilt_at: string | null }>();
  if (!group) return null;

  // M16-SLA §20：冷却期（踢/退/拉黑用 force 穿透）
  const nowMs = Date.now();
  const lastRebuiltAt = group.last_rebuilt_at ? new Date(group.last_rebuilt_at).getTime() : 0;
  const inCooldown = !force && nowMs - lastRebuiltAt < GROUP_REBUILD_COOLDOWN_MS;

  // M16-SLA-3：非冷却期时，将 pending 成员合并进 group_members 再建树
  let pendingMerged = 0;
  if (!inCooldown) {
    const drained = await drainAndMergePendingMembers(env, groupId);
    pendingMerged = drained.length;
  }

  const { results: memberRows } = await db
    .prepare(
      `SELECT member_worker_b_url, member_handle, member_pubkey, last_ack_at, joined_at, last_speak_at,
              status, role, key_state, empty_ack_streak
         FROM group_members WHERE group_id = ?`,
    )
    .bind(groupId)
    .all<GroupMemberRow>();

  // RELAY-PIGGYBACK-4：删边前读旧树，供 Sticky 保留 Layer1/Layer2 座位
  const { results: previousEdgeRows } = await db
    .prepare(
      `SELECT parent_worker_b_url, child_worker_b_url
         FROM group_relay_edges
        WHERE group_id = ? AND tree_id = ?
        LIMIT ?`,
    )
    .bind(groupId, group.tree_id, RELAY_TREE_EDGES_FETCH_LIMIT)
    .all<RelayTreeEdge>();

  const previousEdges = previousEdgeRows ?? [];
  const ownerUrl = normalizeGroupMemberUrl(group.owner_worker_b_url);
  const activeUrls = filterActiveMembers(memberRows ?? [], nowMs).map((m) =>
    normalizeGroupMemberUrl(m.member_worker_b_url),
  );

  // RELAY-TREE-CPU-1 + SPEAK：活跃集无增删且 Layer1 发言序无倒挂 → 短路；倒挂则重建
  if (
    pendingMerged === 0 &&
    shouldSkipRelayRebuildForActiveSet({
      ownerWorkerBUrl: ownerUrl,
      activeMemberUrls: activeUrls,
      previousEdges,
      members: memberRows ?? [],
      nowMs,
    })
  ) {
    const seeds = seedsFromRelayEdges(ownerUrl, previousEdges);
    const updatedAt = nowIso();
    if (!inCooldown) {
      await db
        .prepare(`UPDATE groups SET last_rebuilt_at = ?, updated_at = ? WHERE group_id = ?`)
        .bind(updatedAt, updatedAt, groupId)
        .run();
    }
    return {
      tree_id: group.tree_id,
      seeds,
      edges: previousEdges.map((e) => ({
        parent_worker_b_url: normalizeGroupMemberUrl(e.parent_worker_b_url),
        child_worker_b_url: normalizeGroupMemberUrl(e.child_worker_b_url),
      })),
      rebuilt: false,
      pending_merged: 0,
    };
  }

  const built = buildRelayTree(
    group.owner_worker_b_url,
    memberRows ?? [],
    group.tree_id,
    nowMs,
    previousEdges,
  );
  const seedSet = new Set(built.seeds);
  const updatedAt = nowIso();

  if (inCooldown) {
    // 冷却期内：返回当前树 ID，rebuilt=false 告知调用方跳过实际写入
    return { tree_id: built.tree_id, seeds: built.seeds, edges: built.edges, rebuilt: false, pending_merged: 0 };
  }

  await db.batch([
    db
      .prepare(`UPDATE groups SET tree_id = ?, last_rebuilt_at = ?, updated_at = ? WHERE group_id = ?`)
      .bind(built.tree_id, updatedAt, updatedAt, groupId),
    db.prepare(`DELETE FROM group_relay_edges WHERE group_id = ?`).bind(groupId),
  ]);

  if (built.edges.length > 0) {
    // D1 batch 上限 50 条/次；超量时分批写入
    const BATCH_SIZE = 50;
    for (let i = 0; i < built.edges.length; i += BATCH_SIZE) {
      const chunk = built.edges.slice(i, i + BATCH_SIZE);
      const stmts = chunk.map((edge) =>
        db
          .prepare(
            `INSERT INTO group_relay_edges
           (group_id, tree_id, parent_worker_b_url, child_worker_b_url)
           VALUES (?, ?, ?, ?)`,
          )
          .bind(groupId, built.tree_id, edge.parent_worker_b_url, edge.child_worker_b_url),
      );
      await db.batch(stmts);
    }
  }

  // 更新成员 role：seed / member
  for (const row of memberRows ?? []) {
    if (row.role === 'owner' || row.status !== 'active') continue;
    const url = normalizeGroupMemberUrl(row.member_worker_b_url);
    const nextRole = seedSet.has(url) ? 'seed' : 'member';
    if (row.role === nextRole) continue;
    await db
      .prepare(
        `UPDATE group_members SET role = ? WHERE group_id = ? AND member_worker_b_url = ?`,
      )
      .bind(nextRole, groupId, url)
      .run();
  }

  return { tree_id: built.tree_id, seeds: built.seeds, edges: built.edges, rebuilt: true, pending_merged: pendingMerged };
}
