/**
 * M17 · 加好友 30 天过期清理 + 双写 Repair + outbox 兜底（Cron）
 *
 * 计划 §九.2 + M17-FIX-1 §三.2.5：
 *   - 30 天 pending → expired（cron `minute % 5 === 0` 块内、群专槽 `isGroupExternalSlotMinute`）
 *   - 双写 Repair：本端 `accepted` 行缺本地 follows → 补 INSERT OR IGNORE（rejected 不写 follows，无需 Repair）
 *   - **M17-FIX-1**：outbox_status='pending_retry' 行重新调 `deliverStatusOutbox` 兜底；
 *     超过 24h 仍未投递 → outbox_status='giveup' + console.warn
 *
 * M17-1g：由 `handlers/cronBudget.ts` 任务 `friend-request-gc` 调用 `gcFriendRequestRetention`
 * + `gcFriendRequestRateBuckets`（表未建时 fail-soft）。
 *
 * M17-FIX-1：cron 任务同槽内追加 `gcFriendRequestOutbox(env)` —— **不增 Cron 槽位**（plan §十一.1）。
 *
 * ────────────────────────────────────────────────────────────────────────
 * M-OPT-SPLIT-A6-3 · 补偿语义方案 C 落定（Repair 即方案 C 的兜底实现）
 *
 * **本文件 `repairFriendRequestFollows` 就是方案 C 的 Repair 兜底本身** —— 与
 * `friendRequests.acceptRequest` / `friendRequestOutbox.applyFriendRequestOutbox.accepted`
 * 落定的两步串行（先 CONTENT UPDATE → 后 IDENTITY INSERT OR IGNORE）配合：
 *
 *   - 正常路径：accept 两条 prepare 都成功 → row.status='accepted' + 本端 follows 已含对方
 *   - 异常路径（step 2 抛错 / 进程 crash 在 step 1 与 step 2 之间）：row.status='accepted' +
 *     本端 follows 缺对方 → 本函数 ≤10min cron 扫到该 accepted 行 → 校验本端 follows 是否已含 →
 *     不含则补 `INSERT OR IGNORE INTO follows` → 与 accept 路径语义等价
 *
 * 本步只是把 alias 显式化（CONTENT 扫描源走 `resolveContentDb`、IDENTITY 校验/补 INSERT 走
 * `resolveIdentityDb`），**不**改两步串行的语义结构；这与方案 C 的 Repair 现状完全一致。
 *
 * ────────────────────────────────────────────────────────────────────────
 * M-OPT-SPLIT-A6-2 · CONTENT_DB 切库（**单表单库按表真切**）
 *
 * 本步动作（**严格按表真切**，不拆跨库 batch）：
 *   - `expireOldFriendRequests` 只动 `friend_requests`（CONTENT_DB）→ `resolveContentDb(env)`
 *   - `repairFriendRequestFollows` 读 local users → `resolveIdentityDb(env)`（IDENTITY_DB · migration 0001）
 *   - `repairFriendRequestFollows` Repair 扫描源 `friend_requests` → `resolveContentDb(env)`
 *   - `repairFriendRequestFollows` Repair 补 INSERT `follows` → `resolveIdentityDb(env)`
 *   - `gcFriendRequestRateBuckets` 清理 `friend_request_rate_buckets`（GOVERNANCE_DB）→ `resolveGovernanceDb(env)`
 *   - `gcFriendRequestOutbox` 扫描/标 giveup `friend_requests`（CONTENT_DB）→ `resolveContentDb(env)`
 *
 * **Repair 路径**已自动两步串行（CONTENT 扫描 → IDENTITY 补 INSERT），符合 A-7 alias 退役后
 * 「跨库禁止单 binding batch」的硬约束。本步只是把 alias 显式化，**不**改两步串行的语义结构。
 *
 * ────────────────────────────────────────────────────────────────────────
 * M-OPT-SPLIT-5c-4b · 跨库契约标注（**仅标注，不改行为**）
 *
 * 本文件涉及**三个 binding 域**：
 *   1. `friend_requests`            （CONTENT_DB · migration 0060 — 过期 + Repair 扫描源 + outbox 兜底）
 *   2. `follows`                    （IDENTITY_DB · migration 0001 拆库 — Repair 补 INSERT）
 *   3. `users`                      （IDENTITY_DB · migration 0001 — 读 local handle）
 *   4. `friend_request_rate_buckets`（GOVERNANCE_DB · migration 0062 — `gcFriendRequestRateBuckets` 清理）
 *
 * 观察期 alias 阶段：非 A-6-3 目标的旧 friendRequests 单表路径仍可能 fallback 到 `env.DB`；
 * A-6-3 目标路径已不再使用跨库 `env.DB.batch`，而是显式 CONTENT → IDENTITY 两步串行。
 * 本文件**没有** `env.DB.batch([...])` 跨库单 batch（Repair 是 SELECT → 校验 → 单条 INSERT 三步串行），
 * 符合 A-5c-4b 规则。
 *
 * A-7 alias 退役后 Repair 路径保持两步串行：`resolveContentDb(env)` 读 friend_requests 状态 →
 * `resolveIdentityDb(env)` 校验 follows 是否已含 → `INSERT OR IGNORE INTO follows`。
 * **不允许**合并到单 binding batch；A-6-3 落补偿语义方案 C 时同步再确认。
 */

import type { Env } from '../env';
import { normalizeWorkerBOrigin, randomNonceHex } from '@hailuo/shared-utils';
import { generateId, nowISO } from '@hailuo/shared-utils';
import { resolveContentDb, resolveIdentityDb, resolveGovernanceDb } from '../db/bindings';
import {
  buildSignedFriendRequestInboxEnvelope,
  deliverFriendRequestInboxToTarget,
} from './friendRequestDelivery';
import {
  deliverCancelOutbox,
  deliverStatusOutbox,
} from './friendRequestOutboxDeliver';
import { fetchTargetUserProfile } from './friendRequestOutboxFetcher';

// ---- 常量（计划 §九.2） -----------------------------------------------

/** pending 30 天过期（计划 §9.2 + §十三）。 */
export const FRIEND_REQUEST_PENDING_RETENTION_DAYS = 30;

/** 双写 Repair 扫描上限（Cron 每 tick 最多处理 N 条，避免单次占外部预算）。 */
export const FRIEND_REQUEST_REPAIR_BATCH = 50;

/**
 * SEC-AUDIT-2026-10-7 增强 · Repair 取对端权威公钥的**外部子请求预算**（每 tick 递减）。
 *
 * 【为什么必须有上限】Repair 为补齐 `follows.followed_pubkey`，会对「缺 pin 的 accepted 行」
 * 拉取对端 `GET /users/:handle` —— 这是**外部 fetch**。若不设上限：
 *   - 扫描批 50 × origin/target 两段 = 最坏 100 次出站
 *   - **超过 Cloudflare 单次 invocation 50 个子请求的硬上限**（仓库硬约束）
 *   - 且 cron 预算只申报 15，账实不符 → 触发时可能整轮 invocation 失败
 *
 * 【降级语义】预算耗尽 → **只跳过本次取公钥**，DB 修复（补 follows / 回填 pin）照常做；
 * 未取到的 pin 顺延到后续 tick（Repair 本身是幂等补偿，天然可重入）。
 */
export const FRIEND_REQUEST_REPAIR_PIN_FETCH_CAP = 10;

/** M17-FIX-1：outbox 重试最大时长（超过即 giveup），plan §三.2.5 */
export const FRIEND_REQUEST_OUTBOX_RETRY_MAX_HOURS = 24;

/** M17-FIX-1 历史常量名（giveup 扫描上限）；REL-FIX-1 真重投批大小见 OUTBOX_RETRY_BATCH */
export const FRIEND_REQUEST_OUTBOX_GC_BATCH = 50;

/** REL-FIX-1：每 tick 最多真重投 N 条 outbox pending_retry（控外部子请求） */
export const FRIEND_REQUEST_OUTBOX_RETRY_BATCH = 5;

/** M-F3：inbox 重试窗口与 outbox 一致（24h） */
export const FRIEND_REQUEST_INBOX_RETRY_MAX_HOURS = 24;

/** M-F3：每 tick 最多重投递 N 条 inbox pending_retry（控外部子请求） */
export const FRIEND_REQUEST_INBOX_RETRY_BATCH = 10;

// ---- 类型 ------------------------------------------------------------

export interface FriendRequestGcResult {
  /** pending → expired 行数 */
  expired: number;
  /** 双写 Repair 补 INSERT 关注行数（origin 端：accepted 但本端 follows 缺失） */
  repaired_origin: number;
  /** 双写 Repair 补 INSERT 关注行数（target 端：accepted 但本端 follows 缺失） */
  repaired_target: number;
  /** GC 失败步骤（D1 无跨表事务，部分成功不阻断；与 dmGc.result.errors 同模式） */
  errors: string[];
}

// ---- 内部工具 --------------------------------------------------------

function cutoffIsoForPending(now: Date): string {
  return new Date(now.getTime() - FRIEND_REQUEST_PENDING_RETENTION_DAYS * 86_400_000).toISOString();
}

// ---- 1. 30 天过期清理 ------------------------------------------------

/**
 * 把 30 天前的 pending 行标为 expired。
 * 用 JS ISO 字符串 bind（与 dmGc / messagingMedia 同口径；SQLite datetime(now) 跟 ISO 比较恒偏）。
 *
 * 单 SQL 更新；DELETE 计划 §六.3 选 UPDATE 是为了保留审计字段（created/updated/expired_at）。
 *
 * M-OPT-SPLIT-A6-2：本函数只动 `friend_requests`（CONTENT_DB），单表单库，
 * 切 `resolveContentDb(env)`。
 */
export async function expireOldFriendRequests(
  env: Env,
  now: Date = new Date(),
): Promise<{ expired: number; errors: string[] }> {
  const cutoff = cutoffIsoForPending(now);
  const nowIso = now.toISOString();
  try {
    const contentDb = resolveContentDb(env);
    const result = await contentDb
      .prepare(
        `UPDATE friend_requests
            SET status = 'expired', updated_at = ?, expired_at = ?
          WHERE status = 'pending' AND created_at < ?`,
      )
      .bind(nowIso, nowIso, cutoff)
      .run();
    return { expired: result.meta.changes ?? 0, errors: [] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn('[friendRequestRetention] 过期清理失败', err);
    return { expired: 0, errors: [`expire_pending: ${message}`] };
  }
}

// ---- 2. 双写 Repair ---------------------------------------------------

type FollowPinRow = { id: string; followed_pubkey: string | null };

/**
 * SEC-AUDIT-2026-10-11 #5 / 10-17 #6：按节点 URL 一次查出本批 follows，
 * 供 Repair 循环内 Map 命中（替代逐行 SELECT）。
 * 同时匹配 `follower_node_url` 与 `followed_worker_b_url`（对齐 inbox pin 双字段；
 * 换域后两列可能不一致，只扫其一会漏已有行 → 误走 INSERT 撞唯一约束）。
 */
async function loadFollowsByNodeUrls(
  identityDb: D1Database,
  nodeUrls: readonly string[],
): Promise<Map<string, FollowPinRow>> {
  const map = new Map<string, FollowPinRow>();
  const urls = [...new Set(nodeUrls.map((u) => u.trim()).filter((u) => u.length > 0))];
  if (urls.length === 0) return map;
  const placeholders = urls.map(() => '?').join(',');
  const rows = await identityDb
    .prepare(
      `SELECT id, follower_node_url, followed_worker_b_url, followed_pubkey FROM follows
        WHERE follower_node_url IN (${placeholders})
           OR followed_worker_b_url IN (${placeholders})`,
    )
    .bind(...urls, ...urls)
    .all<{
      id: string;
      follower_node_url: string;
      followed_worker_b_url: string | null;
      followed_pubkey: string | null;
    }>();
  for (const r of rows.results ?? []) {
    const row: FollowPinRow = { id: r.id, followed_pubkey: r.followed_pubkey };
    // 两列都挂同一行，lookup 用任一别名都能命中
    const keyFollower = normalizeWorkerBOrigin(r.follower_node_url);
    if (keyFollower) map.set(keyFollower, row);
    const keyFollowed = normalizeWorkerBOrigin(r.followed_worker_b_url ?? '');
    if (keyFollowed) map.set(keyFollowed, row);
  }
  return map;
}

/**
 * 双写 Repair — 扫 accepted 行，校验本端 `follows` 表是否已包含对方行（origin / target 各自）。
 * 缺失则补 INSERT（与 friendRequests.acceptRequest 同样的 INSERT OR IGNORE 语义）。
 *
 * 触发场景：
 *   - accept 已成功，但 cron 之前 crash / 写入路径异常未补齐
 *   - 跨节点 outbox 失败但已 write-ahead（W17-1g 起 outbox 入 D1 outbound_events 表）
 *
 * 批大小：FRIEND_REQUEST_REPAIR_BATCH；避免单 tick 占 D1 写预算。
 *
 * M-OPT-SPLIT-5c-4b：本函数是 friend accept 双写的**唯一补偿语义**，同时动
 * `friend_requests`（CONTENT，扫描源）+ `follows`（IDENTITY，补 INSERT）—— 跨库路径。
 * 当前观察期 alias 阶段走 `env.DB` 跨库两步串行（SELECT/校验/单条 INSERT）。
 * A-7 alias 退役后必须保持两步串行（`resolveContentDb` SELECT → `resolveIdentityDb`
 * INSERT OR IGNORE），**不允许**合并单 binding batch。
 */
export async function repairFriendRequestFollows(
  env: Env,
  now: Date = new Date(),
): Promise<{ repaired_origin: number; repaired_target: number; errors: string[] }> {
  const result = { repaired_origin: 0, repaired_target: 0, errors: [] as string[] };
  const nowIso = now.toISOString();

  /**
   * SEC-AUDIT-2026-10-7 增强 · 取对端权威公钥的**外部子请求预算**（origin/target 两段共享）。
   *
   * 每次取 pin 都要发一次外部 `GET /users/:handle`；扫描批 50 × 2 段最坏 100 次，
   * 会击穿 Cloudflare 单次 invocation 50 子请求硬上限。故封顶
   * `FRIEND_REQUEST_REPAIR_PIN_FETCH_CAP`；耗尽后**只跳过取 pin**，DB 修复照常，
   * 未取到的 pin 顺延到后续 tick（Repair 幂等可重入）。
   */
  let pinFetchBudget = FRIEND_REQUEST_REPAIR_PIN_FETCH_CAP;

  /** 取对端公钥（受预算约束）；预算耗尽或失败 → null。 */
  async function fetchPeerPubkey(
    nodeUrl: string,
    handle: string,
  ): Promise<string | null> {
    if (pinFetchBudget <= 0) return null;
    pinFetchBudget -= 1;
    try {
      const profile = await fetchTargetUserProfile(nodeUrl, handle, env);
      if (profile?.pubkey && /^[0-9a-fA-F]{64}$/.test(profile.pubkey.trim())) {
        return profile.pubkey.trim().toLowerCase();
      }
    } catch {
      // fail-soft：取不到就留空 pin，后续 tick 再补
    }
    return null;
  }

  // M17-FIX-4 / P2-3：本地 users 只有站主一行；跨节点 handle 不在 users 表。
  // 去掉 JOIN users，改按站主 handle 分桶（origin_handle=本端 / target_handle=本端）。
  // M-OPT-SPLIT-A6-2：users 在 IDENTITY_DB，切 resolveIdentityDb(env)。
  let localHandle = '';
  try {
    const identityDb = resolveIdentityDb(env);
    const localUser = await identityDb
      .prepare(`SELECT handle FROM users LIMIT 1`)
      .first<{ handle: string }>();
    localHandle = (localUser?.handle ?? '').trim().toLowerCase();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    result.errors.push(`local_user: ${message}`);
    return result;
  }
  if (!localHandle) {
    result.errors.push('local_user: missing handle');
    return result;
  }

  try {
    // origin 端：本站是发起方 → 需补 follows(target)
    // M-OPT-SPLIT-A6-2：friend_requests 扫描源在 CONTENT_DB，切 resolveContentDb(env)。
    const contentDb = resolveContentDb(env);
    const own = await contentDb
      .prepare(
        `SELECT fr.id AS id,
                fr.origin_node_url AS origin_node_url,
                fr.origin_handle AS origin_handle,
                fr.target_node_url AS target_node_url,
                fr.target_handle AS target_handle
           FROM friend_requests fr
          WHERE fr.status = 'accepted'
            AND fr.origin_handle = ?
          ORDER BY fr.accepted_at DESC
          LIMIT ?`,
      )
      .bind(localHandle, FRIEND_REQUEST_REPAIR_BATCH)
      .all<{
        id: string;
        origin_node_url: string;
        origin_handle: string;
        target_node_url: string;
        target_handle: string;
      }>();
    const ownRows = own.results ?? [];
    // M-OPT-SPLIT-A6-2：follows 补 INSERT 走 IDENTITY_DB（与扫描源不同库）。
    const identityDb = resolveIdentityDb(env);
    // SEC-AUDIT-2026-10-11 #5：循环前 IN 批量预取 follows，避免每行一次 SELECT（最坏 50→1）
    const ownFollowByNode = await loadFollowsByNodeUrls(
      identityDb,
      ownRows.map((r) => normalizeWorkerBOrigin(r.target_node_url)),
    );
    for (const row of ownRows) {
      try {
        const targetNode = normalizeWorkerBOrigin(row.target_node_url);
        const existingFollow = ownFollowByNode.get(targetNode) ?? null;

        // SEC-AUDIT-2026-10-7 P1-1: 补写或更新 followed_pubkey 避免 Repair 产生永久无 pin 行
        const peerPubkey = existingFollow?.followed_pubkey
          ? null
          : await fetchPeerPubkey(targetNode, row.target_handle);

        if (existingFollow) {
          if (peerPubkey && !existingFollow.followed_pubkey) {
            await identityDb
              .prepare(
                `UPDATE follows SET followed_pubkey = ?
                  WHERE id = ? AND (followed_pubkey IS NULL OR followed_pubkey = '')`,
              )
              .bind(peerPubkey, existingFollow.id)
              .run();
            ownFollowByNode.set(targetNode, {
              id: existingFollow.id,
              followed_pubkey: peerPubkey,
            });
          }
          continue;
        }

        const followId = generateId('follow');
        await identityDb
          .prepare(
            `INSERT OR IGNORE INTO follows
               (id, follower_node_url, followed_at,
                followed_handle, followed_display_name, followed_avatar_key, followed_worker_b_url, followed_pubkey)
             VALUES (?, ?, ?, ?, '', '', ?, NULLIF(?, ''))`,
          )
          .bind(followId, targetNode, nowIso, row.target_handle || null, targetNode, peerPubkey ?? '')
          .run();
        // 同批多行同一对端：后续命中 Map，避免重复计数
        ownFollowByNode.set(targetNode, {
          id: followId,
          followed_pubkey: peerPubkey,
        });
        result.repaired_origin += 1;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        result.errors.push(`origin/${row.id}: ${message}`);
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    result.errors.push(`origin_scan: ${message}`);
  }

  try {
    // target 端：本站是接收方 → 需补 follows(origin)
    // M-OPT-SPLIT-A6-2：friend_requests 扫描源在 CONTENT_DB，复用上一步 contentDb。
    const contentDb = resolveContentDb(env);
    const identityDb = resolveIdentityDb(env);
    const incoming = await contentDb
      .prepare(
        `SELECT fr.id AS id,
                fr.origin_node_url AS origin_node_url,
                fr.origin_handle AS origin_handle,
                fr.origin_display_name AS origin_display_name,
                fr.origin_avatar_key AS origin_avatar_key,
                fr.origin_pubkey AS origin_pubkey
           FROM friend_requests fr
          WHERE fr.status = 'accepted'
            AND fr.target_handle = ?
          ORDER BY fr.accepted_at DESC
          LIMIT ?`,
      )
      .bind(localHandle, FRIEND_REQUEST_REPAIR_BATCH)
      .all<{
        id: string;
        origin_node_url: string;
        origin_handle: string;
        origin_display_name: string;
        origin_avatar_key: string;
        origin_pubkey: string | null;
      }>();
    const incomingRows = incoming.results ?? [];
    // SEC-AUDIT-2026-10-11 #5：incoming 段同样 IN 预取（再 50→1）
    const incomingFollowByNode = await loadFollowsByNodeUrls(
      identityDb,
      incomingRows.map((r) => normalizeWorkerBOrigin(r.origin_node_url)),
    );
    for (const row of incomingRows) {
      try {
        const originNode = normalizeWorkerBOrigin(row.origin_node_url);
        const existingFollow = incomingFollowByNode.get(originNode) ?? null;

        // 申请里的公钥不能直接当 Pin。有声明时必须和对端公开档案一致；没有声明才取档回填。
        const pinnedOrigin =
          typeof row.origin_pubkey === 'string' && /^[0-9a-fA-F]{64}$/.test(row.origin_pubkey.trim())
            ? row.origin_pubkey.trim().toLowerCase()
            : '';
        let peerPubkey: string | null = null;
        if (!existingFollow?.followed_pubkey) {
          const live = await fetchPeerPubkey(originNode, row.origin_handle);
          peerPubkey = pinnedOrigin ? (live === pinnedOrigin ? live : null) : live;
        }

        if (existingFollow) {
          if (peerPubkey && !existingFollow.followed_pubkey) {
            await identityDb
              .prepare(
                `UPDATE follows SET followed_pubkey = ?
                  WHERE id = ? AND (followed_pubkey IS NULL OR followed_pubkey = '')`,
              )
              .bind(peerPubkey, existingFollow.id)
              .run();
            incomingFollowByNode.set(originNode, {
              id: existingFollow.id,
              followed_pubkey: peerPubkey,
            });
          }
          continue;
        }

        const followId = generateId('follow');
        await identityDb
          .prepare(
            `INSERT OR IGNORE INTO follows
               (id, follower_node_url, followed_at,
                followed_handle, followed_display_name, followed_avatar_key, followed_worker_b_url, followed_pubkey)
             VALUES (?, ?, ?, ?, ?, ?, ?, NULLIF(?, ''))`,
          )
          .bind(
            followId,
            originNode,
            nowIso,
            row.origin_handle,
            row.origin_display_name,
            row.origin_avatar_key,
            originNode,
            peerPubkey ?? '',
          )
          .run();
        incomingFollowByNode.set(originNode, {
          id: followId,
          followed_pubkey: peerPubkey,
        });
        result.repaired_target += 1;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        result.errors.push(`target/${row.id}: ${message}`);
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    result.errors.push(`target_scan: ${message}`);
  }

  return result;
}

// ---- 3. 综合 GC（M17-1g cron 主入口） --------------------------------

/**
 * 单次 GC 入口 — 顺序跑 expireOldFriendRequests + repairFriendRequestFollows。
 * fail-soft：各步独立 try/catch，结果聚合返回；与 dmGc / d1Gc 同模式。
 * 频控桶清理见 `gcFriendRequestRateBuckets`（cron 任务内另调，表未建时 fail-soft）。
 */
export async function gcFriendRequestRetention(
  env: Env,
  now: Date = new Date(),
): Promise<FriendRequestGcResult> {
  const result: FriendRequestGcResult = {
    expired: 0,
    repaired_origin: 0,
    repaired_target: 0,
    errors: [],
  };
  try {
    const expired = await expireOldFriendRequests(env, now);
    result.expired = expired.expired;
    result.errors.push(...expired.errors);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    result.errors.push(`expire_top: ${message}`);
  }
  try {
    const repaired = await repairFriendRequestFollows(env, now);
    result.repaired_origin = repaired.repaired_origin;
    result.repaired_target = repaired.repaired_target;
    result.errors.push(...repaired.errors);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    result.errors.push(`repair_top: ${message}`);
  }
  return result;
}

// ---- 4. 频控表清理（计划 §九.2 fail-soft） ----------------------------

/**
 * 清理 48 小时前的频控桶（与 dmGc rate_buckets 保留期一致）。
 * 表未建时 `.catch` → 零删除（fail-soft；migration 0062 落地后自然生效）。
 *
 * M-OPT-SPLIT-A6-2：friend_request_rate_buckets 在 GOVERNANCE_DB（migration 0062），切 resolveGovernanceDb(env)。
 */
export async function gcFriendRequestRateBuckets(
  env: Env,
  now: Date = new Date(),
): Promise<{ deleted: number; errors: string[] }> {
  const cutoff = new Date(now.getTime() - 48 * 3_600_000).toISOString();
  try {
    const governanceDb = resolveGovernanceDb(env);
    const result = await governanceDb
      .prepare(`DELETE FROM friend_request_rate_buckets WHERE window_start < ?`)
      .bind(cutoff)
      .run()
      .catch(() => null);
    if (!result) return { deleted: 0, errors: [] };
    return { deleted: result.meta.changes ?? 0, errors: [] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { deleted: 0, errors: [`rate_buckets: ${message}`] };
  }
}

// ---- 5. outbox 兜底重试（M17-FIX-1 plan §三.2.5） ---------------------

/**
 * REL-FIX-1：扫 `outbox_status='pending_retry'` 的 accepted / rejected / cancelled 行：
 *   - 超窗（updated_at < now-24h）→ giveup
 *   - 窗内按批真重投（重建 envelope ts/nonce → deliverStatusOutbox / deliverCancelOutbox）
 *   - 失败只刷 outbox_last_retry_at（沉队尾），不动 updated_at（对齐 M-F3b）
 *
 * 禁止再「只 COUNT 不投」——那会让同意/拒绝回执永久分叉。
 */
export interface FriendRequestOutboxGcResult {
  /** 本 tick 尝试重投的行数 */
  scanned: number;
  /** 本 tick 重投成功数 */
  acked: number;
  /** 超过 24h 被标记 giveup 的行数 */
  given_up: number;
  errors: string[];
}

export async function gcFriendRequestOutbox(
  env: Env,
  now: Date = new Date(),
): Promise<FriendRequestOutboxGcResult> {
  const result: FriendRequestOutboxGcResult = { scanned: 0, acked: 0, given_up: 0, errors: [] };
  const contentDb = resolveContentDb(env);
  const nowIso = now.toISOString();
  const cutoff = new Date(
    now.getTime() - FRIEND_REQUEST_OUTBOX_RETRY_MAX_HOURS * 3_600_000,
  ).toISOString();

  // ---- A) 超窗 → giveup ------------------------------------------------
  try {
    const upd = await contentDb
      .prepare(
        `UPDATE friend_requests
            SET outbox_status = 'giveup', updated_at = ?
          WHERE outbox_status = 'pending_retry'
            AND status IN ('accepted','rejected','cancelled')
            AND updated_at < ?`,
      )
      .bind(nowIso, cutoff)
      .run();
    result.given_up = upd.meta.changes ?? 0;
    if (result.given_up > 0) {
      console.warn('[friendRequestRetention] outbox giveup', { given_up: result.given_up, cutoff });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    result.errors.push(`giveup: ${message}`);
  }

  // ---- B) 窗内 → 真重投 ------------------------------------------------
  let rows: Array<{ id: string; status: string }> = [];
  try {
    const listed = await contentDb
      .prepare(
        `SELECT id, status
           FROM friend_requests
          WHERE outbox_status = 'pending_retry'
            AND status IN ('accepted','rejected','cancelled')
            AND updated_at >= ?
          ORDER BY COALESCE(NULLIF(outbox_last_retry_at, ''), updated_at) ASC
          LIMIT ?`,
      )
      .bind(cutoff, FRIEND_REQUEST_OUTBOX_RETRY_BATCH)
      .all<{ id: string; status: string }>();
    rows = listed.results ?? [];
    result.scanned = rows.length;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    result.errors.push(`outbox_scan: ${message}`);
    return result;
  }

  for (const row of rows) {
    try {
      if (row.status === 'cancelled') {
        await deliverCancelOutbox(env, row.id);
      } else if (row.status === 'accepted' || row.status === 'rejected') {
        await deliverStatusOutbox(env, row.id, row.status, '');
      } else {
        continue;
      }
      // 成功则 deliver* 已写 acked；再读状态确认
      const after = await contentDb
        .prepare(`SELECT outbox_status FROM friend_requests WHERE id = ? LIMIT 1`)
        .bind(row.id)
        .first<{ outbox_status: string }>();
      if ((after?.outbox_status ?? '') === 'acked') {
        result.acked += 1;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result.errors.push(`outbox_retry:${row.id}:${message}`);
    }
  }

  return result;
}

// ---- 6. inbox 投递重试（M-F3） -----------------------------------------

/**
 * M-F3 / M-F3b：扫 `inbox_status='pending_retry'` 且仍 `status='pending'` 的行：
 *   - 窗口内（≤24h，按 updated_at）：重建 envelope 重投对端 Worker B inbox；成功 → acked
 *   - 窗口外：标记 inbox_status='giveup'
 *   - **M-F3b**：失败只刷 inbox_error + inbox_last_retry_at，不动 updated_at；
 *     扫描按 COALESCE(NULLIF(inbox_last_retry_at,''), updated_at) ASC，避免队头阻塞。
 *
 * 挂既有 `friend-request-gc` 槽，不增 Cron。批大小 FRIEND_REQUEST_INBOX_RETRY_BATCH
 * 控外部子请求（每条 1 次 fetch）。
 */
export interface FriendRequestInboxGcResult {
  /** 尝试重投递的行数 */
  scanned: number;
  /** 本 tick 重投成功数 */
  acked: number;
  /** 超过 24h 标记 giveup 的行数 */
  given_up: number;
  errors: string[];
}

export async function gcFriendRequestInbox(
  env: Env,
  now: Date = new Date(),
): Promise<FriendRequestInboxGcResult> {
  const result: FriendRequestInboxGcResult = { scanned: 0, acked: 0, given_up: 0, errors: [] };
  const contentDb = resolveContentDb(env);
  const nowIso = now.toISOString();
  const cutoff = new Date(now.getTime() - FRIEND_REQUEST_INBOX_RETRY_MAX_HOURS * 3_600_000).toISOString();

  // ---- A) 超窗 → giveup ------------------------------------------------
  try {
    const upd = await contentDb
      .prepare(
        `UPDATE friend_requests
            SET inbox_status = 'giveup', updated_at = ?
          WHERE inbox_status = 'pending_retry'
            AND status = 'pending'
            AND updated_at < ?`,
      )
      .bind(nowIso, cutoff)
      .run();
    result.given_up = upd.meta.changes ?? 0;
    if (result.given_up > 0) {
      console.warn('[friendRequestRetention] inbox giveup', { given_up: result.given_up, cutoff });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    result.errors.push(`inbox_giveup: ${message}`);
  }

  // ---- B) 窗内 → 重投递 ------------------------------------------------
  let rows: Array<{
    id: string;
    origin_node_url: string;
    origin_handle: string;
    origin_display_name: string;
    origin_avatar_key: string;
    target_node_url: string;
    target_handle: string;
    message: string | null;
  }> = [];
  try {
    // M-F3b：按「最近一次重试时间」升序；空 last_retry 回落到 updated_at（兼容未 migrate 旧行）
    const listed = await contentDb
      .prepare(
        `SELECT id, origin_node_url, origin_handle, origin_display_name, origin_avatar_key,
                target_node_url, target_handle, message
           FROM friend_requests
          WHERE inbox_status = 'pending_retry'
            AND status = 'pending'
            AND updated_at >= ?
          ORDER BY COALESCE(NULLIF(inbox_last_retry_at, ''), updated_at) ASC
          LIMIT ?`,
      )
      .bind(cutoff, FRIEND_REQUEST_INBOX_RETRY_BATCH)
      .all<{
        id: string;
        origin_node_url: string;
        origin_handle: string;
        origin_display_name: string;
        origin_avatar_key: string;
        target_node_url: string;
        target_handle: string;
        message: string | null;
      }>();
    rows = listed.results ?? [];
    result.scanned = rows.length;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    result.errors.push(`inbox_scan: ${message}`);
    return result;
  }

  if (rows.length === 0) return result;

  // 本端 pubkey（签名用）—— 整批共用一次读
  let localPubkey = '';
  try {
    const user = await resolveIdentityDb(env)
      .prepare(`SELECT pubkey FROM users LIMIT 1`)
      .first<{ pubkey: string }>();
    localPubkey = (user?.pubkey ?? '').trim();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    result.errors.push(`inbox_local_pubkey: ${message}`);
    return result;
  }
  if (!localPubkey || localPubkey.length !== 64) {
    result.errors.push('inbox_local_pubkey: missing');
    return result;
  }

  for (const row of rows) {
    try {
      const ts = String(Math.floor(Date.now() / 1000));
      const nonce = randomNonceHex(16);
      const trimmedMessage =
        row.message && row.message.trim() !== '' ? row.message.trim() : undefined;
      const envelope = await buildSignedFriendRequestInboxEnvelope(env, {
        request_id: row.id,
        origin: {
          node_url: row.origin_node_url,
          handle: row.origin_handle,
          display_name: row.origin_display_name || undefined,
          avatar_key: row.origin_avatar_key || undefined,
          pubkey: localPubkey,
        },
        target: {
          node_url: row.target_node_url,
          handle: row.target_handle,
        },
        ...(trimmedMessage !== undefined ? { message: trimmedMessage } : {}),
        nonce,
        ts,
      });
      const delivered = await deliverFriendRequestInboxToTarget(env, row.target_node_url, envelope);
      if (delivered.ok) {
        await contentDb
          .prepare(
            `UPDATE friend_requests
                SET inbox_status = 'acked', inbox_error = '', inbox_last_retry_at = '', updated_at = ?
              WHERE id = ?`,
          )
          .bind(new Date().toISOString(), row.id)
          .run();
        result.acked += 1;
      } else {
        // M-F3b：保持 pending_retry；刷 inbox_error + inbox_last_retry_at（沉队尾），
        // 不动 updated_at（避免无限拖延 giveup 窗）
        const safeCode = (delivered.error_code || 'INBOX_DELIVERY_FAILED').slice(0, 64);
        const retryAt = new Date().toISOString();
        await contentDb
          .prepare(
            `UPDATE friend_requests
                SET inbox_error = ?, inbox_last_retry_at = ?
              WHERE id = ?`,
          )
          .bind(safeCode, retryAt, row.id)
          .run()
          .catch(() => null);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result.errors.push(`inbox_retry:${row.id}:${message}`);
    }
  }

  return result;
}
