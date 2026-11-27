/**
 * M17 · 加好友（互粉请求）— 站主 6 个核心函数。
 *
 * 权威依据：`docs/m17-add-friend-plan.md` v1.1 §四 / §五 / §六。
 * 核心不变量："好友 ≡ 互粉 ≡ 双方各自 `follows` 表中存在指向对方 Worker B URL 的本地记录" —
 * 本文件**不引入**独立的 `friends` 表，接受时由 origin / target 各自 INSERT 自己的 `follows` 行。
 *
 * 函数返回 discriminated union，路由层零分支：
 *   `{ ok: true; data } | { ok: false; error_code; status; message }`
 * 与 `acceptGroupInviteOnOwner`、`urlChange*` 既有模式保持一致。
 *
 * ────────────────────────────────────────────────────────────────────────
 * M-OPT-SPLIT-A6-3 · 补偿语义方案 C 落定（accept 跨库双写拆两步串行）
 *
 * 本文件涉及**四个 binding 域**：
 *   1. `friend_requests`（CONTENT_DB · migration 0060）
 *   2. `follows`        （IDENTITY_DB · migration 0001 拆库）
 *   3. `system_config`  （IDENTITY_DB · migration 0090 汇总，写 `allow_incoming`）
 *   4. 频控 `friend_request_rate_buckets`（GOVERNANCE_DB · migration 0062，
 *      经 `lib/friendRequestRateLimit.ts`，本文件仅调用其 helper）
 *
 * **A-6-3 方案 C 落定**：`acceptRequest` 双写 `INSERT OR IGNORE INTO follows` +
 * `UPDATE friend_requests` 拆为两步串行（先 CONTENT UPDATE → 后 IDENTITY INSERT OR IGNORE），
 * 由 `friendRequestRetention.repairFriendRequestFollows` ≤10min cron 兜底补 INSERT OR IGNORE。
 * 语义等价 M17-FIX-3 P0-3 守护（同步原子 → eventual atomicity ≤10min）；前端不感知，
 * NCF-2/M17/M17-FIX-1/FIX-3 全部契约零回归；禁止改回单 binding batch。
 *
 * 其它函数（listRequests / rejectRequest / cancelRequest / insertRequest / validateTarget /
 * isLocalFollowing）保持 A-6-2 单表单库按表真切不动。
 *
 * ✅ **A-6-3 闭环**：本文件在 BINDING_TABLE 状态已升 ✅（A-7 Phase2+3 完成，binding MIXED 为多库设计，非过渡态）。
 *
 * ────────────────────────────────────────────────────────────────────────
 * M-OPT-SPLIT-5c-7 · 历史背景（listRequests 单表单库按表真切）
 *
 *   - `listRequests` 已切 `resolveContentDb(env)`（friend_requests 在 CONTENT_DB · migration 0060）
 *   - `readLocalUser` / `isLocalFollowing` 已切 `resolveIdentityDb(env)`（users + follows 在 IDENTITY_DB）
 *   - 5c-7 阶段 acceptRequest 双写 batch 观察期保留（plan §3.4 守护）— 5c-4b 阶段进入本文件
 *
 * **A-5 ✅**：5c-7 阶段 acceptRequest 双写 batch 已由 A-6-3 方案 C 替代（两步串行替代单 binding batch）；
 * A-5 遗留历史边界已闭环。
 *
 * 关键不变量（M-OPT-SPLIT-5c-7 + 5c-4b 守护）：acceptRequest 跨库 batch 禁止改成单 binding batch；
 * plan 明确留给 A-6 落补偿语义方案 C。
 */

import { generateId, nowISO } from '@hailuo/shared-utils';
import { normalizeWorkerBOrigin, normalizeHandleLocalSegment } from '@hailuo/shared-utils';
import type { Env } from '../env';
import { resolveLocalNodeUrlAliases, normalizeLocalNodeUrlForMatch } from './localPublicBaseUrl';
import { checkAndIncrementFriendRequestOriginRate } from './friendRequestRateLimit';
import { isNodeBlacklisted } from './blacklistLookup';
import { resolveContentDb, resolveIdentityDb } from '../db/bindings';
import { recordFriendRequestNotification } from './friendRequestNotify';
import { fetchTargetUserProfile } from './friendRequestOutboxFetcher';

// ---- 类型定义 ---------------------------------------------------------

/** 与 D1 `friend_requests.status` CHECK 完全对齐（migration 0060 §一）。 */
export type FriendRequestStatus = 'pending' | 'accepted' | 'rejected' | 'cancelled' | 'expired';

/**
 * REL-FIX-11：列表过滤模式 `resolved` —— **已处理，但回执未确认送达对方**。
 *
 * 语义：接收方（target）已 accept / reject，但本端 `outbox_status != 'acked'`
 * → 回执（accepted / rejected 信封）还没确认送到发起方 → **发起方仍在干等**。
 *
 * 与发起侧的 `inbox_status`（REL-FIX-4）严格对称：
 *   - `inbox_status` 回答「我发的请求，对方收没收到」
 *   - `outbox_status` 回答「我回的结果，对方知不知道」
 *
 * 只在 `direction=incoming` 有意义（outgoing 方向显式 400，不静默给错数据）。
 */
export type FriendRequestListStatus = FriendRequestStatus | 'all' | 'resolved';

/** `users` 表本地行（站点所有者；本节点唯一一行）。 */
export interface LocalUserRow {
  readonly handle: string;
  readonly display_name: string;
  readonly avatar_key: string | null;
  readonly worker_b_url: string;
  /** 站主 Ed25519 raw 公钥（64 hex）；本机发起加好友时写入 friend_requests.origin_pubkey */
  readonly pubkey: string;
}

/** `friend_requests` 表完整行（迁移 §4.1 字段映射）。 */
export interface FriendRequestRow {
  readonly id: string;
  readonly origin_node_url: string;
  readonly origin_handle: string;
  readonly origin_display_name: string;
  readonly origin_avatar_key: string;
  /**
   * SEC-AUDIT-2026-10-14：发起方已验签 / 本机权威公钥（64 hex）。
   * inbox 验签后落库；本机发起写站主 pubkey；历史行可为 null。
   */
  readonly origin_pubkey: string | null;
  readonly target_node_url: string;
  readonly target_handle: string;
  readonly status: FriendRequestStatus;
  readonly message: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly accepted_at: string | null;
  readonly rejected_at: string | null;
  readonly cancelled_at: string | null;
  readonly expired_at: string | null;
  readonly nonce: string;
  /**
   * REL-FIX-11：回执状态（**接收方**本行 = 「我回给发起方的 accepted / rejected
   * 结果，对方有没有确认收到」）。
   *   ''            — 初始 / 投递中
   *   'acked'       — 发起方已确认收到回执（对方知道结果了）
   *   'pending_retry' — 回执投递失败，cron 24h 内重投
   *   'giveup'      — 超 24h 放弃（**发起方很可能还在干等**）
   *
   * 与 `inbox_status` 严格对称：
   *   - `inbox_status` 回答「我发的请求，对方收没收到」（发起方本行有意义）
   *   - `outbox_status` 回答「我回的结果，对方知不知道」（接收方本行有意义）
   *
   * 发起方（origin）本行：只记录「撤回通知（cancelled）有没有送到对端」，
   * 与「对方知不知道结果」无关 —— 故发起方**不可**用 `status=resolved` 过滤。
   */
  readonly outbox_status: string;
  /**
   * REL-FIX-4：发起端投递状态（origin 侧专用）。
   *   ''            — 未投递 / 初始（waitUntil 尚未落结果）
   *   'acked'       — 对端 Worker B 已收下 inbox envelope
   *   'pending_retry' — 投递失败，cron 24h 内重投
   *   'giveup'      — 超 24h 放弃（对方大概率从未收到）
   *
   * 只在**发起方**本行有意义；接收方（incoming）本行恒为 ''。
   */
  readonly inbox_status: string;
  /**
   * REL-FIX-4：最近一次投递失败的短错误码（脱敏，不含 URL / 邮箱原文）。
   * 成功（acked / 初始）时为空串。
   */
  readonly inbox_error: string;
  /**
   * REL-FIX-11：回执投递最近一次失败的脱敏短码。
   * 成功（acked / 初始）时为空串。
   */
  readonly outbox_error: string;
  /** SEC-AUDIT-2026-10-7: 接收方（incoming）本端是否已固化该节点公钥 Pin */
  readonly has_pin?: boolean;
  /** SEC-AUDIT-2026-10-7: 接收方（incoming）是否属于首见 / 未 Pin 节点 */
  readonly first_seen?: boolean;
}

/** validateTarget 校验通过的入参（已归一化、可直接 INSERT）。 */
export interface ValidateTargetInput {
  readonly target_node_url: string;
  readonly target_handle: string;
  readonly message: string | null;
}

export interface ValidatedTarget {
  readonly origin_node_url: string;
  readonly origin_handle: string;
  readonly origin_display_name: string;
  readonly origin_avatar_key: string;
  /** 本机发起：站主权威公钥，写入 origin_pubkey */
  readonly origin_pubkey: string;
  readonly target_node_url: string;
  readonly target_handle: string;
  readonly message: string | null;
}

export interface InsertRequestResult {
  readonly id: string;
  readonly created_at: string;
}

export interface AcceptResult {
  readonly id: string;
  readonly accepted_at: string;
  readonly followed_at: string;
}

export interface CancelResult {
  readonly id: string;
  readonly cancelled_at: string;
}

export interface RejectResult {
  readonly id: string;
  readonly rejected_at: string;
}

export interface ListRequestsResult {
  readonly items: FriendRequestRow[];
  readonly has_more: boolean;
  readonly next_cursor: string | null;
  /**
   * REL-FIX-11：该 direction 下**待处理**（pending）行数。
   *
   * 用途：面板 / Tab 未读角标（对齐 REL-FIX-5 群主待审批角标）—— 站主不打开
   * 通讯录也能知道「有人在等我回应」。纯 D1 读，零 KV 写（Free Tier 约束）。
   *
   * 注意：这是**当前方向**的 pending 数（incoming = 等我处理；outgoing = 等对方处理）。
   */
  readonly pending_count: number;
}

export type FriendRequestErrorCode =
  | 'FRIEND_REQUEST_INVALID_PARAMS'
  | 'FRIEND_REQUEST_SELF'
  | 'ALREADY_FOLLOWING'
  | 'BLACKLISTED'
  | 'RATE_LIMITED'
  | 'INTERNAL_ERROR'
  | 'FRIEND_REQUEST_NOT_FOUND'
  | 'NOT_RECIPIENT'
  | 'NOT_ORIGIN'
  | 'ALREADY_RESOLVED'
  | 'ORIGIN_PUBKEY_MISMATCH'
  | 'ORIGIN_PUBKEY_UNVERIFIED';

export type FriendRequestResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly error_code: FriendRequestErrorCode; readonly status: 400 | 403 | 404 | 409 | 429 | 500 | 503; readonly message: string };

// ---- 常量（计划 §十一.1 + §九.2） -------------------------------------

/** 附言码点上限；UTF-8 字符按码点计数，不按字节。 */
export const FRIEND_REQUEST_MESSAGE_MAX_CHARS = 200;

/** 列表硬上限 + 默认 limit。 */
export const FRIEND_REQUEST_LIST_DEFAULT_LIMIT = 20;
export const FRIEND_REQUEST_LIST_MAX_LIMIT = 50;

/** D1 `friend_requests` 表字段顺序（用于 SELECT，6 处 SELECT 共用避免漂移）。 */
const FRIEND_REQUEST_COLUMNS =
  'id, origin_node_url, origin_handle, origin_display_name, origin_avatar_key, origin_pubkey, ' +
  'target_node_url, target_handle, status, message, ' +
  'created_at, updated_at, accepted_at, rejected_at, cancelled_at, expired_at, ' +
  'nonce, outbox_status';

/**
 * REL-FIX-4：列表专用字段顺序 —— 在基础字段后**追加**发起端投递回执列。
 *
 * `inbox_status` / `inbox_error` 由 CONTENT_DB migration 0061 / 0062 引入
 * （`''` / `acked` / `pending_retry` / `giveup` + 脱敏短错误码）。
 * 旧节点若尚未 apply 这两条 migration，SELECT 会抛 "no such column" →
 * 整个列表 500。故列表走**降级探测**：先试带列的 SELECT，失败则回落到基础列
 * （inbox_status / inbox_error 返回空串 = "未投递/未知"，前端按"未确认送达"呈现，
 * 不会把未知状态谎报成"已送达"）。
 *
 * REL-FIX-11：`outbox_error` 由 CONTENT_DB migration 0063 引入（与 `outbox_status` 配对，
 * 回答「我回给对方的回执对方收到没」）。同样走降级探测。
 *
 * 注：`outbox_status` 本身来自 migration 0060（基础列里已有），故降级路径仍能给出
 * 「已送达 / 未送达」的**粗**状态，只是拿不到失败短码。
 */
const FRIEND_REQUEST_LIST_COLUMNS =
  FRIEND_REQUEST_COLUMNS + ', inbox_status, inbox_error, outbox_error';

/** 列表行在降级路径下的投递回执默认值（未探测到列时用）。 */
const FRIEND_REQUEST_INBOX_STATUS_UNKNOWN = '';

/** `users` 表本地行字段（站主档案）。 */
const LOCAL_USER_COLUMNS = 'handle, display_name, avatar_key, worker_b_url, pubkey';

/** 归一化 64-hex Ed25519 公钥；非法返回空串。 */
function normalizePubkeyHex(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const hex = raw.trim().toLowerCase();
  return /^[0-9a-f]{64}$/.test(hex) ? hex : '';
}

// ---- 内部工具 --------------------------------------------------------

/** 码点级 trim + 截断（与 lib/localNotifications.truncatePreview 行为一致）。 */
export function truncateFriendRequestMessage(raw: string): string {
  const chars = [...raw.trim()];
  if (chars.length <= FRIEND_REQUEST_MESSAGE_MAX_CHARS) return chars.join('');
  return chars.slice(0, FRIEND_REQUEST_MESSAGE_MAX_CHARS).join('');
}

/**
 * handle 校验：归一化本地段后必须含 `HANDLE_LOCAL_RE_LEGACY`（与 follower-tokens 入口同口径）。
 *
 * M-F2：入参可能是注册中心下发的**限定名**（`alice@reg2`）。跨节点加好友的 handle
 * 比较必须统一到「裸本地名」口径，否则①发起端被格式校验拒（请求发不出去）②接收端
 * `target_handle !== localUser.handle` 误判 NOT_RECIPIENT（对方点接受失败）。
 */
function isValidFriendHandle(handle: string): boolean {
  const local = normalizeHandleLocalSegment(handle);
  if (!local) return false;
  return /^[a-z0-9][a-z0-9-]{0,31}$/.test(local);
}

/** 读本地 users 单行（站主权威）。fail-soft 返 null。 */
async function readLocalUser(env: Env): Promise<LocalUserRow | null> {
  const identityDb = resolveIdentityDb(env);
  const row = await identityDb
    .prepare(`SELECT ${LOCAL_USER_COLUMNS} FROM users LIMIT 1`)
    .first<{
      handle: string;
      display_name: string;
      avatar_key: string | null;
      worker_b_url: string;
      pubkey: string | null;
    }>();
  if (!row || !row.handle) return null;
  return {
    // M-F2：本地 handle 统一归一化为裸本地名（与跨节点比较口径一致）
    handle: normalizeHandleLocalSegment(row.handle),
    display_name: row.display_name ?? '',
    avatar_key: row.avatar_key ?? null,
    worker_b_url: normalizeWorkerBOrigin(row.worker_b_url ?? ''),
    pubkey: normalizePubkeyHex(row.pubkey),
  };
}

/** 黑名单门控：返回 true 即被封禁。M-OPT-SPLIT-5 统一走 GOVERNANCE_DB helper。 */

/**
 * 本地单边 follow 判定（M17-FIX-4 / P1-3）。
 * 仅查本端 `follows` 是否已有 target 行；不查对端，也不声称「互粉」。
 */
async function isLocalFollowing(env: Env, targetNodeUrl: string): Promise<boolean> {
  const identityDb = resolveIdentityDb(env);
  const localFollow = await identityDb
    .prepare(`SELECT 1 FROM follows WHERE follower_node_url = ? LIMIT 1`)
    .bind(targetNodeUrl)
    .first<{ 1: number }>();
  return localFollow !== null;
}

// =========================================================================
//  1. validateTarget — 校验 + 归一化入口（自关注 / handle 格式 / 频控）
// =========================================================================

/**
 * 站主发起加好友前的前置校验。频控在本步触发（一旦通过即占用配额）。
 *
 * 错误码对照计划 §5.6：
 * - `FRIEND_REQUEST_SELF` (400)        — 自关注
 * - `FRIEND_REQUEST_INVALID_PARAMS` (400) — 字段缺失或格式错
 * - `BLACKLISTED` (403)                 — 对方已封禁本站
 * - `ALREADY_FOLLOWING` (409)           — 本端已关注对方（单边；非互粉确认）
 * - `RATE_LIMITED` (429)                — 频控上限
 */
export async function validateTarget(
  env: Env,
  input: ValidateTargetInput,
): Promise<FriendRequestResult<ValidatedTarget>> {
  // ---- 1. 字段基础校验 -------------------------------------------------
  const targetNodeUrlRaw = typeof input.target_node_url === 'string' ? input.target_node_url.trim() : '';
  // M-F2：限定名（alice@reg2）统一归一化为裸本地名再校验与落库
  const targetHandleRaw = normalizeHandleLocalSegment(
    typeof input.target_handle === 'string' ? input.target_handle : '',
  );
  if (!targetNodeUrlRaw) {
    return { ok: false, status: 400, error_code: 'FRIEND_REQUEST_INVALID_PARAMS', message: 'target_node_url 不能为空' };
  }
  if (!targetNodeUrlRaw.startsWith('https://')) {
    return { ok: false, status: 400, error_code: 'FRIEND_REQUEST_INVALID_PARAMS', message: 'target_node_url 必须以 https:// 开头' };
  }
  if (!targetHandleRaw || !isValidFriendHandle(targetHandleRaw)) {
    return { ok: false, status: 400, error_code: 'FRIEND_REQUEST_INVALID_PARAMS', message: 'target_handle 格式不合法' };
  }
  const targetNodeUrl = normalizeWorkerBOrigin(targetNodeUrlRaw);

  // ---- 2. 读本地用户 ----------------------------------------------------
  const localUser = await readLocalUser(env);
  if (!localUser) {
    return { ok: false, status: 500, error_code: 'INTERNAL_ERROR', message: '本地用户档案缺失，无法发起加好友请求' };
  }
  const originNodeUrl = normalizeWorkerBOrigin(localUser.worker_b_url);
  if (!originNodeUrl) {
    return { ok: false, status: 500, error_code: 'INTERNAL_ERROR', message: '本站 worker_b_url 未配置，无法发起加好友请求' };
  }

  // ---- 3. 自关注门控 ----------------------------------------------------
  // 与 follows.ts CANNOT_FOLLOW_SELF 同口径：节点公开基址相同即视为自关注
  // REL-FIX-2：归一到 origin 级再比（大小写 host / 默认端口 / 尾斜杠 / path 忽略），
  // 别名表命中任一即视为本站（custom domain ↔ workers.dev 互认）；落库原文不动。
  const localAliases = await resolveLocalNodeUrlAliases(env);
  const localMatchSet = new Set(localAliases);
  const targetMatchNorm = normalizeLocalNodeUrlForMatch(targetNodeUrlRaw);
  const originMatchNorm = normalizeLocalNodeUrlForMatch(originNodeUrl);
  if (
    (targetMatchNorm && targetMatchNorm === originMatchNorm) ||
    (targetMatchNorm && localMatchSet.has(targetMatchNorm))
  ) {
    return { ok: false, status: 400, error_code: 'FRIEND_REQUEST_SELF', message: '不能向自己发起加好友请求' };
  }

  // ---- 4. 本端已关注判定（单边；避免跨节点同步延迟误拒）-----------------
  // M17-FIX-4：错误码 ALREADY_FOLLOWING（原 ALREADY_FRIENDS 误称互粉）。
  if (await isLocalFollowing(env, targetNodeUrl)) {
    return { ok: false, status: 409, error_code: 'ALREADY_FOLLOWING', message: '已关注对方，无需重复发起请求' };
  }

  // ---- 5. 黑名单门控（origin 端：target 是否把本站拉黑）-----------------
  // 注：黑名单语义对等 — 任意一方拉黑都拒绝；origin 端只能查对方是否封禁本站。
  // target 端是否拉黑 origin 由 M17-1c 跨节点 inbox lib 在落 D1 前再查一次。
  if (await isNodeBlacklisted(env, targetNodeUrl)) {
    return { ok: false, status: 403, error_code: 'BLACKLISTED', message: '对方节点已封禁本地，无法发起加好友请求' };
  }

  // ---- 6. 频控门控（origin 端：按节点 URL 双窗口 20/h + 100/d）----------
  if (!(await checkAndIncrementFriendRequestOriginRate(env, originNodeUrl))) {
    return { ok: false, status: 429, error_code: 'RATE_LIMITED', message: '加好友请求过于频繁，请稍后再试' };
  }

  // ---- 7. 组装结果（附言截断在 insertRequest 内再做）--------------------
  const message = typeof input.message === 'string' ? input.message : '';
  return {
    ok: true,
    data: {
      origin_node_url: originNodeUrl,
      origin_handle: localUser.handle,
      origin_display_name: localUser.display_name,
      origin_avatar_key: localUser.avatar_key ?? '',
      origin_pubkey: localUser.pubkey,
      target_node_url: targetNodeUrl,
      target_handle: targetHandleRaw,
      // 附言在 insertRequest 截断；validateTarget 阶段先保留原文做长度校验
      message: message.length > 0 ? message : null,
    },
  };
}

// =========================================================================
//  2. insertRequest — 写入 friend_requests（pending 状态）
// =========================================================================

/**
 * 校验通过后 INSERT `friend_requests`。UNIQUE 部分索引 `uniq_friend_requests_pending`
 * 兜底重复 pending；SQLITE_CONSTRAINT → ALREADY_RESOLVED 语义错（应明确告知用户）。
 */
export async function insertRequest(
  env: Env,
  validated: ValidatedTarget,
): Promise<FriendRequestResult<InsertRequestResult>> {
  const id = generateId('fr');
  const nonce = generateId('frn');
  const now = nowISO();
  const message = validated.message ? truncateFriendRequestMessage(validated.message) : null;

  const contentDb = resolveContentDb(env);
  try {
    await contentDb
      .prepare(
        `INSERT INTO friend_requests
           (id, origin_node_url, origin_handle, origin_display_name, origin_avatar_key, origin_pubkey,
            target_node_url, target_handle,
            status, message,
            created_at, updated_at, nonce, outbox_status)
         VALUES (?, ?, ?, ?, ?, NULLIF(?, ''), ?, ?, 'pending', ?, ?, ?, ?, '')`,
      )
      .bind(
        id,
        validated.origin_node_url,
        validated.origin_handle,
        validated.origin_display_name,
        validated.origin_avatar_key,
        validated.origin_pubkey,
        validated.target_node_url,
        validated.target_handle,
        message,
        now,
        now,
        nonce,
      )
      .run();
    return { ok: true, data: { id, created_at: now } };
  } catch (err) {
    const messageText = err instanceof Error ? err.message : String(err);
    // UNIQUE 部分索引 uniq_friend_requests_pending 命中 → 已存在 pending 行
    if (messageText.includes('UNIQUE') || messageText.includes('unique') || messageText.includes('SQLITE_CONSTRAINT')) {
      // 区分"重复 pending"与"已被对方拉黑"（后者校验顺序更靠后；此处只能兜底为重复 pending）
      return { ok: false, status: 409, error_code: 'ALREADY_RESOLVED', message: '已存在与该节点的加好友请求，请勿重复发起' };
    }
    console.error('[friendRequests] INSERT 失败', err);
    return { ok: false, status: 500, error_code: 'INTERNAL_ERROR', message: '写入加好友请求失败，请重试' };
  }
}

// =========================================================================
//  3. acceptRequest — 接受请求（target 端写本地 follows + 通知)
// =========================================================================

/**
 * 接受流程：
 *   1) 读请求行 → 校验 status=pending + target_handle == 本地 handle（NOT_RECIPIENT）
 *   2) UPDATE friend_requests SET status='accepted', accepted_at=now
 *   3) INSERT OR IGNORE INTO follows (follower_node_url = origin_node_url)
 *   4) 写 local_notifications（friend_request_accepted 给 origin 端本地副本；跨节点 outbox 由 M17-1c 处理）
 */
export type AcceptRequestOptions = {
  /** 缺 origin_pubkey 的存量行：异步取档回填 pin（禁止在 accept 主路径同步外网） */
  readonly waitUntil?: (promise: Promise<unknown>) => void;
};

export async function acceptRequest(
  env: Env,
  requestId: string,
  options?: AcceptRequestOptions,
): Promise<FriendRequestResult<AcceptResult>> {
  if (!requestId || typeof requestId !== 'string') {
    return { ok: false, status: 400, error_code: 'FRIEND_REQUEST_INVALID_PARAMS', message: 'request_id 不能为空' };
  }
  const localUser = await readLocalUser(env);
  if (!localUser) {
    return { ok: false, status: 500, error_code: 'INTERNAL_ERROR', message: '本地用户档案缺失' };
  }

  const now = nowISO();
  // 预声明供 try 块内赋值；_ 前缀显式标记为"故意保留（v1.1 notification 扩展用）"，
  // TypeScript strict 模式下不触发 unused variable 警告。
  let _updatedRow: FriendRequestRow | null;
  const contentDb = resolveContentDb(env);
  try {
    // 单库读取：friend_requests 已进入 CONTENT_DB；跨库补偿只发生在后续两步写入。
    const row = await contentDb
      .prepare(
        `SELECT ${FRIEND_REQUEST_COLUMNS}
           FROM friend_requests WHERE id = ? LIMIT 1`,
      )
      .bind(requestId)
      .first<FriendRequestRow>();
    if (!row) {
      return { ok: false, status: 404, error_code: 'FRIEND_REQUEST_NOT_FOUND', message: '加好友请求不存在或已删除' };
    }
    // 接收方门控：必须 target_handle == 本地 handle
    // M-F2：row 里可能是限定名（alice@reg2），双方归一化到裸本地名再比较
    if (normalizeHandleLocalSegment(row.target_handle) !== localUser.handle) {
      return { ok: false, status: 403, error_code: 'NOT_RECIPIENT', message: '仅接收方可接受该请求' };
    }
    // 状态机幂等：非 pending 即拒
    if (row.status !== 'pending') {
      return { ok: false, status: 409, error_code: 'ALREADY_RESOLVED', message: '该请求已被处理' };
    }
    // 跨节点 inbox lib（M17-1c）保证 target_node_url 等于本节点；这里再兜底一次
    // REL-FIX-2：别名成员判定（归一 origin 级）；不一致仅 warn 不阻断（过渡期多基址）。
    {
      const aliases = await resolveLocalNodeUrlAliases(env);
      const rowMatchNorm = normalizeLocalNodeUrlForMatch(row.target_node_url);
      if (rowMatchNorm && aliases.length > 0 && !aliases.includes(rowMatchNorm)) {
        // 不一致：可能是同节点多基址过渡期；不阻断，但 console.warn（只打归一后 origin，不打完整 URL）
        console.warn('[friendRequests] accept target_node_url 与本节点公开基址不一致', { row_target: rowMatchNorm, local_aliases: aliases.length });
      }
    }

    // 黑名单门控：origin 被拉黑后仍可拒收（计划 §6.4）
    if (await isNodeBlacklisted(env, row.origin_node_url)) {
      return { ok: false, status: 403, error_code: 'BLACKLISTED', message: '对方节点已被本地封禁，无法接受该请求' };
    }

    // M-OPT-SPLIT-A6-3 · 补偿语义方案 C 落定（两步串行 + Repair 兜底）
    //
    // 修前：env.DB.batch([follows INSERT, friend_requests UPDATE]) —— 单 binding batch 同步原子，
    //       但 CONTENT(friend_requests) + IDENTITY(follows) 物理上分库后单 binding 不可见另一库表。
    // 修后：拆为两步串行（先 CONTENT UPDATE friend_requests → 后 IDENTITY INSERT OR IGNORE INTO follows），
    //       任一失败 → 留「friend_requests.status='accepted' 但 follows 缺」行 →
    //       `friendRequestRetention.repairFriendRequestFollows` ≤10min cron 扫描补 INSERT OR IGNORE。
    //
    // 语义等价性（M17-FIX-3 P0-3 守护保持）：
    //   - 成功路径：两步都成功 → 与原 batch 同步原子语义等价
    //   - 第二步失败（极罕见，INSERT OR IGNORE 一般不抛）：user 视角 ≤10min 短暂「已接受但未互粉」，
    //     Repair 兜底补齐（plan §二.3 收益与代价表第 3 行）
    //   - 第一步失败：不变，返回 INTERNAL_ERROR，无副作用
    //
    // 禁止改回单 binding batch（本文件 BINDING_TABLE 状态已升 ✅）。
    // 注：`followed_display_name` / `followed_avatar_key` 在 row 上必有（`friend_requests` migration 0060 显式 NOT NULL），
    //     `origin_avatar_key` 来自本地请求行；本步不再使用观察期 alias batch。
    const identityDb = resolveIdentityDb(env);
    const originNorm = normalizeWorkerBOrigin(row.origin_node_url);
    const claimedPubkey = normalizePubkeyHex(row.origin_pubkey);
    // 申请里的公钥只证明对方拿着对应私钥。本地还没有 Pin 时，先和对方公开档案比对，
    // 不一致或暂时连不上就拒绝接受，不把这把公钥写进关注表。
    let peerPubkey = '';
    if (claimedPubkey) {
      const stored = await identityDb
        .prepare(
          `SELECT followed_pubkey FROM follows
            WHERE follower_node_url = ? OR followed_worker_b_url = ?
            LIMIT 1`,
        )
        .bind(originNorm, originNorm)
        .first<{ followed_pubkey: string | null }>();
      const storedPin = normalizePubkeyHex(stored?.followed_pubkey);
      if (storedPin && storedPin !== claimedPubkey) {
        return {
          ok: false,
          status: 403,
          error_code: 'ORIGIN_PUBKEY_MISMATCH',
          message: '对方公钥与本地已保存的公钥不一致，已拒绝',
        };
      }
      if (!storedPin) {
        const profile = await fetchTargetUserProfile(originNorm, row.origin_handle, env);
        const livePubkey = normalizePubkeyHex(profile?.pubkey);
        if (!livePubkey) {
          return {
            ok: false,
            status: 503,
            error_code: 'ORIGIN_PUBKEY_UNVERIFIED',
            message: '暂时无法核对对方公开档案里的公钥，请稍后再接受',
          };
        }
        if (livePubkey !== claimedPubkey) {
          return {
            ok: false,
            status: 403,
            error_code: 'ORIGIN_PUBKEY_MISMATCH',
            message: '对方公开档案里的公钥与申请不一致，已拒绝',
          };
        }
      }
      peerPubkey = claimedPubkey;
    }

    // step 1: 推进 friend_requests 状态机（CONTENT_DB · migration 0060）
    const upd = await contentDb
      .prepare(
        `UPDATE friend_requests
            SET status = 'accepted', updated_at = ?, accepted_at = ?
          WHERE id = ? AND status = 'pending'`,
      )
      .bind(now, now, requestId)
      .run();
    if ((upd.meta.changes ?? 0) === 0) {
      // 已被另一路径处理（target 端 inbox lib / 重复请求）→ 幂等 ALREADY_RESOLVED
      return { ok: false, status: 409, error_code: 'ALREADY_RESOLVED', message: '该请求已被处理' };
    }

    // step 2: 写本地 follows（IDENTITY_DB · migration 0001，幂等 INSERT OR IGNORE）
    // 注：与 Repair 路径同源（`repairFriendRequestFollows` 自身也是两步串行 + INSERT OR IGNORE）——
    //     若本步异常退出，row.status='accepted' + 本端无 follow 行的孤儿状态会被 Repair cron ≤10min 补齐。
    const followId = generateId('follow');
    const followInsertRes = await identityDb
      .prepare(
        `INSERT OR IGNORE INTO follows
           (id, follower_node_url, followed_at,
            followed_handle, followed_display_name, followed_avatar_key, followed_worker_b_url, followed_pubkey)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULLIF(?, ''))`,
      )
      .bind(
        followId,
        row.origin_node_url,
        now,
        row.origin_handle,
        row.origin_display_name,
        row.origin_avatar_key,
        row.origin_node_url,
        peerPubkey,
      )
      .run();

    // 若此前已有 follow 行且 followed_pubkey 仍为空，且本行已有权威公钥，补齐 pin 避免永久无 pin
    if (peerPubkey && (followInsertRes.meta.changes ?? 0) === 0) {
      await identityDb
        .prepare(
          `UPDATE follows
              SET followed_pubkey = ?
            WHERE follower_node_url = ?
              AND (followed_pubkey IS NULL OR followed_pubkey = '')`,
        )
        .bind(peerPubkey, row.origin_node_url)
        .run()
        .catch((err) => {
          console.warn('[friendRequests] acceptRequest 补写已存在 follow 的 pin 失败', err);
        });
    }

    // 存量 pending（migration 前）缺 origin_pubkey：仅 waitUntil 异步取档；失败留给 Repair cron
    if (!peerPubkey && options?.waitUntil) {
      const originNode = row.origin_node_url;
      const originHandle = row.origin_handle;
      const followRowId = followId;
      options.waitUntil(
        (async () => {
          try {
            const profile = await fetchTargetUserProfile(originNode, originHandle, env);
            const pubkey = normalizePubkeyHex(profile?.pubkey);
            if (!pubkey) return;
            await identityDb
              .prepare(
                `UPDATE follows
                    SET followed_pubkey = ?
                  WHERE (id = ? OR follower_node_url = ?)
                    AND (followed_pubkey IS NULL OR followed_pubkey = '')`,
              )
              .bind(pubkey, followRowId, originNode)
              .run();
            // 同步回填 friend_requests.origin_pubkey，后续 Repair 可免出站
            await contentDb
              .prepare(
                `UPDATE friend_requests
                    SET origin_pubkey = ?
                  WHERE id = ?
                    AND (origin_pubkey IS NULL OR origin_pubkey = '')`,
              )
              .bind(pubkey, requestId)
              .run()
              .catch(() => undefined);
          } catch (err) {
            console.warn('[friendRequests] acceptRequest 异步回填 followed_pubkey 失败', err);
          }
        })(),
      );
    }

    _updatedRow = { ...row, status: 'accepted', accepted_at: now, updated_at: now };
  } catch (err) {
    console.error('[friendRequests] accept 失败', err);
    return { ok: false, status: 500, error_code: 'INTERNAL_ERROR', message: '接受操作失败，请重试' };
  }

  // 通知：target 端写"accepted"给 origin（跨节点 outbox lib M17-1c 再回写到 origin 端）
  // 注：M17-1b 不写通知行 — friend_request_accepted 通知由 M17-1c outbox lib 在 origin 端落 D1 时写；
  //     本端 target 也写一条对应"accepted"通知（type=friend_request_accepted, actor=target 自身），
  //     保持与 §4.2 表结构对称，但语义上"我刚接受了谁"通知对站主本人意义不大，
  //     因此本步不主动写 — 由后续 §7.3 Web UI 在 /notifications 列表里直接展示 friend_requests 行
  //     （Web 客户端 JOIN local_notifications.request_id 反查 §六.3）。
  //     此处保持静默，保留 v1.1 接口位。
  // _updatedRow 保留（v1.1 notification 扩展时使用）；本步不消费。

  return { ok: true, data: { id: requestId, accepted_at: now, followed_at: now } };
}

// =========================================================================
//  4. rejectRequest — 拒绝请求（仅状态机推进，不写 follows）
// =========================================================================

/**
 * 拒绝流程：
 *   1) 读请求行 → 校验 status=pending + target_handle == 本地 handle（NOT_RECIPIENT）
 *   2) UPDATE friend_requests SET status='rejected', rejected_at=now
 *   3) 通知 origin 端由 M17-1c outbox lib 处理（写 friend_request_rejected 通知）
 */
export async function rejectRequest(
  env: Env,
  requestId: string,
): Promise<FriendRequestResult<RejectResult>> {
  if (!requestId || typeof requestId !== 'string') {
    return { ok: false, status: 400, error_code: 'FRIEND_REQUEST_INVALID_PARAMS', message: 'request_id 不能为空' };
  }
  const localUser = await readLocalUser(env);
  if (!localUser) {
    return { ok: false, status: 500, error_code: 'INTERNAL_ERROR', message: '本地用户档案缺失' };
  }

  const now = nowISO();
  const contentDb = resolveContentDb(env);
  try {
    const row = await contentDb
      .prepare(
        `SELECT id, target_handle, status FROM friend_requests WHERE id = ? LIMIT 1`,
      )
      .bind(requestId)
      .first<{ id: string; target_handle: string; status: FriendRequestStatus }>();
    if (!row) {
      return { ok: false, status: 404, error_code: 'FRIEND_REQUEST_NOT_FOUND', message: '加好友请求不存在或已删除' };
    }
    if (normalizeHandleLocalSegment(row.target_handle) !== localUser.handle) {
      return { ok: false, status: 403, error_code: 'NOT_RECIPIENT', message: '仅接收方可拒绝该请求' };
    }
    if (row.status !== 'pending') {
      return { ok: false, status: 409, error_code: 'ALREADY_RESOLVED', message: '该请求已被处理' };
    }
    const upd = await contentDb
      .prepare(
        `UPDATE friend_requests
            SET status = 'rejected', updated_at = ?, rejected_at = ?
          WHERE id = ? AND status = 'pending'`,
      )
      .bind(now, now, requestId)
      .run();
    if ((upd.meta.changes ?? 0) === 0) {
      return { ok: false, status: 409, error_code: 'ALREADY_RESOLVED', message: '该请求已被处理' };
    }
    return { ok: true, data: { id: requestId, rejected_at: now } };
  } catch (err) {
    console.error('[friendRequests] reject 失败', err);
    return { ok: false, status: 500, error_code: 'INTERNAL_ERROR', message: '拒绝操作失败，请重试' };
  }
}

// =========================================================================
//  5. cancelRequest — 撤回请求（仅 origin 端 + 状态=pending）
// =========================================================================

/**
 * 撤回流程（M17-4-1）：
 *   1) 读请求行 → 校验 status=pending + origin_handle == 本地 handle（NOT_ORIGIN）
 *   2) UPDATE friend_requests SET status='cancelled', cancelled_at=now, outbox_status=''
 *      （清空 outbox_status，供随后 cancel→target 投递跟踪 acked/pending_retry）
 *   3) 路由层 waitUntil 投递 cancelled outbox 到 target（本函数只做本地状态机）
 */
export async function cancelRequest(
  env: Env,
  requestId: string,
): Promise<FriendRequestResult<CancelResult>> {
  if (!requestId || typeof requestId !== 'string') {
    return { ok: false, status: 400, error_code: 'FRIEND_REQUEST_INVALID_PARAMS', message: 'request_id 不能为空' };
  }
  const localUser = await readLocalUser(env);
  if (!localUser) {
    return { ok: false, status: 500, error_code: 'INTERNAL_ERROR', message: '本地用户档案缺失' };
  }

  const now = nowISO();
  const contentDb = resolveContentDb(env);
  try {
    const row = await contentDb
      .prepare(
        `SELECT id, origin_handle, target_node_url, target_handle, status
           FROM friend_requests WHERE id = ? LIMIT 1`,
      )
      .bind(requestId)
      .first<{
        id: string;
        origin_handle: string;
        target_node_url: string;
        target_handle: string;
        status: FriendRequestStatus;
      }>();
    if (!row) {
      return { ok: false, status: 404, error_code: 'FRIEND_REQUEST_NOT_FOUND', message: '加好友请求不存在或已删除' };
    }
    if (normalizeHandleLocalSegment(row.origin_handle) !== localUser.handle) {
      return { ok: false, status: 403, error_code: 'NOT_ORIGIN', message: '仅发起方可撤回该请求' };
    }
    if (row.status !== 'pending') {
      return { ok: false, status: 409, error_code: 'ALREADY_RESOLVED', message: '该请求已被处理，无法撤回' };
    }
    const upd = await contentDb
      .prepare(
        `UPDATE friend_requests
            SET status = 'cancelled', updated_at = ?, cancelled_at = ?, outbox_status = ''
          WHERE id = ? AND status = 'pending'`,
      )
      .bind(now, now, requestId)
      .run();
    if ((upd.meta.changes ?? 0) === 0) {
      return { ok: false, status: 409, error_code: 'ALREADY_RESOLVED', message: '该请求已被处理，无法撤回' };
    }

    // REL-FIX-11：补一条发起方侧可见性通知（「我撤回了这条请求」）。
    // 撤回后该行从 pending 列表消失 → 若无此通知，站主回头完全看不到撤回发生过。
    // fail-soft（recordFriendRequestNotification 自吞异常），不阻断撤回主流程。
    await recordFriendRequestNotification(env, {
      type: 'friend_request_withdrawn',
      request_id: requestId,
      actor_handle: localUser.handle,
      actor_node_url: localUser.worker_b_url,
      related_node_url: row.target_node_url,
      content_preview: row.target_handle,
    });

    return { ok: true, data: { id: requestId, cancelled_at: now } };
  } catch (err) {
    console.error('[friendRequests] cancel 失败', err);
    return { ok: false, status: 500, error_code: 'INTERNAL_ERROR', message: '撤回操作失败，请重试' };
  }
}

// =========================================================================
//  6. listRequests — 列请求（incoming / outgoing + cursor 分页）
// =========================================================================

export interface ListRequestsOptions {
  readonly direction: 'incoming' | 'outgoing';
  readonly status?: FriendRequestListStatus;
  readonly limit?: number;
  readonly cursor?: string | null;
}

/**
 * SEC-AUDIT-2026-10-7: 批量为 incoming 好友请求附带本地存储级 Pin 状态（has_pin & first_seen）
 * 读 IDENTITY_DB follows 表，零 KV 写入。未建索引或异常时 fail-soft 保留原结构。
 */
async function enrichIncomingRequestsWithPinStatus(
  env: Env,
  items: FriendRequestRow[],
): Promise<FriendRequestRow[]> {
  if (items.length === 0) return items;
  try {
    const identityDb = resolveIdentityDb(env);
    const originUrls = [...new Set(items.map((r) => normalizeWorkerBOrigin(r.origin_node_url)).filter(Boolean))];
    if (originUrls.length === 0) return items;

    const placeholders = originUrls.map(() => '?').join(',');
    const followRows = await identityDb
      .prepare(
        `SELECT follower_node_url, followed_worker_b_url, followed_pubkey FROM follows
          WHERE follower_node_url IN (${placeholders}) OR followed_worker_b_url IN (${placeholders})`,
      )
      .bind(...originUrls, ...originUrls)
      .all<{ follower_node_url: string; followed_worker_b_url: string | null; followed_pubkey: string | null }>();

    const pinnedUrlSet = new Set<string>();
    for (const fr of followRows.results ?? []) {
      const pubkey = fr.followed_pubkey?.trim();
      if (pubkey && pubkey.length === 64) {
        if (fr.follower_node_url) pinnedUrlSet.add(normalizeWorkerBOrigin(fr.follower_node_url));
        if (fr.followed_worker_b_url) pinnedUrlSet.add(normalizeWorkerBOrigin(fr.followed_worker_b_url));
      }
    }

    return items.map((r) => {
      const norm = normalizeWorkerBOrigin(r.origin_node_url);
      const isPinned = pinnedUrlSet.has(norm);
      return {
        ...r,
        has_pin: isPinned,
        first_seen: !isPinned,
      };
    });
  } catch (err) {
    console.warn('[friendRequests] enrichIncomingRequestsWithPinStatus 异常，fail-soft', err);
    return items;
  }
}

/**
 * REL-FIX-11：`resolved` 过滤只对 **incoming** 有意义。
 *
 * incoming 语义：本站是接收方，已 accept / reject，但 `outbox_status != 'acked'`
 * → **我回给发起方的结果，对方还没确认收到** → 发起方仍在干等。
 * 这与发起侧的 `inbox_status`（REL-FIX-4）严格对称。
 *
 * outgoing 方向**不允许**用 `resolved`：origin 行的 `outbox_status` 语义不同
 * （只记录「撤回通知有没有送到对端」），拿它判断「对方知不知道结果」会**撒谎**。
 * → 显式 400，不静默给错数据。
 */
function isResolvedStatusAllowed(direction: 'incoming' | 'outgoing'): boolean {
  return direction === 'incoming';
}

/**
 * 列表分页策略与 `localNotifications.listLocalNotifications` 对齐：
 *   ORDER BY created_at DESC, id DESC；cursor = 上一页最后一条的 id；
 *   "上一页"定义为 (created_at, id) 严格小于 cursor 对应行的 (created_at, id)。
 */
export async function listRequests(
  env: Env,
  opts: ListRequestsOptions,
): Promise<FriendRequestResult<ListRequestsResult>> {
  if (opts.direction !== 'incoming' && opts.direction !== 'outgoing') {
    return { ok: false, status: 400, error_code: 'FRIEND_REQUEST_INVALID_PARAMS', message: 'direction 必须为 incoming 或 outgoing' };
  }
  const statusFilter: FriendRequestListStatus = opts.status ?? 'pending';
  if (statusFilter === 'resolved' && !isResolvedStatusAllowed(opts.direction)) {
    return {
      ok: false,
      status: 400,
      error_code: 'FRIEND_REQUEST_INVALID_PARAMS',
      message: 'status=resolved 仅支持 direction=incoming',
    };
  }

  const localUser = await readLocalUser(env);
  if (!localUser) {
    return { ok: false, status: 500, error_code: 'INTERNAL_ERROR', message: '本地用户档案缺失' };
  }

  const limit = Math.min(
    Math.max(opts.limit ?? FRIEND_REQUEST_LIST_DEFAULT_LIMIT, 1),
    FRIEND_REQUEST_LIST_MAX_LIMIT,
  );
  const fetchN = limit + 1;

  // 维度列：incoming = target_handle = 本地 handle；outgoing = origin_handle = 本地 handle
  const dimColumn = opts.direction === 'incoming' ? 'target_handle' : 'origin_handle';

  const whereParts: string[] = [`${dimColumn} = ?`];
  const binds: (string | number)[] = [localUser.handle];
  if (statusFilter === 'resolved') {
    // REL-FIX-11：已处理（accepted / rejected）但回执未被对端确认 → 对方还在干等
    whereParts.push("status IN ('accepted','rejected')");
    whereParts.push("COALESCE(outbox_status, '') != 'acked'");
  } else if (statusFilter !== 'all') {
    whereParts.push('status = ?');
    binds.push(statusFilter);
  }

  // M-OPT-SPLIT-A6-3：除已落方案 C 的 accept 两步串行外，本函数其余路径仍待后续 A-6 切片；
  // `friend_requests` 列表已走 CONTENT_DB，users / follows 读取走 IDENTITY_DB。
  const contentDb = resolveContentDb(env);
  let cursorRow: { created_at: string; id: string } | null = null;
  if (opts.cursor) {
    cursorRow = await contentDb
      .prepare(`SELECT created_at, id FROM friend_requests WHERE id = ? LIMIT 1`)
      .bind(opts.cursor)
      .first<{ created_at: string; id: string }>();
    if (!cursorRow) {
      return { ok: true, data: { items: [], has_more: false, next_cursor: null, pending_count: await countPendingRequests(env, dimColumn, localUser.handle) } };
    }
  }

  let sql: string;
  let bindValues: (string | number)[];
  if (cursorRow) {
    whereParts.push('(created_at < ? OR (created_at = ? AND id < ?))');
    binds.push(cursorRow.created_at, cursorRow.created_at, cursorRow.id);
    sql = `SELECT ${FRIEND_REQUEST_LIST_COLUMNS}
             FROM friend_requests
             WHERE ${whereParts.join(' AND ')}
             ORDER BY created_at DESC, id DESC
             LIMIT ?`;
    bindValues = [...binds, fetchN];
  } else {
    sql = `SELECT ${FRIEND_REQUEST_LIST_COLUMNS}
             FROM friend_requests
             WHERE ${whereParts.join(' AND ')}
             ORDER BY created_at DESC, id DESC
             LIMIT ?`;
    bindValues = [...binds, fetchN];
  }

  try {
    const stmt = contentDb.prepare(sql).bind(...bindValues);
    const result = await stmt.all<FriendRequestRow>();
    const rows = result.results ?? [];
    const has_more = rows.length > limit;
    const rawItems = has_more ? rows.slice(0, limit) : rows;
    const items = dimColumn === 'target_handle' ? await enrichIncomingRequestsWithPinStatus(env, rawItems) : rawItems;
    const next_cursor = has_more && items.length > 0 ? items[items.length - 1]!.id : null;
    return {
      ok: true,
      data: {
        items,
        has_more,
        next_cursor,
        pending_count: await countPendingRequests(env, dimColumn, localUser.handle),
      },
    };
  } catch (err) {
    // REL-FIX-4：旧节点 CONTENT_DB 未 apply migration 0061/0062（缺 inbox_status 列）
    // → "no such column" → **降级**回落基础列列表，而不是整单 500。
    // 降级后投递回执按"未知"处理（前端不会谎报"已送达"）。
    if (isMissingReceiptColumnError(err)) {
      console.warn(
        '[friendRequests] list 降级：CONTENT_DB 缺 inbox_status/inbox_error/outbox_error 列（未 apply migration 0061/0062/0063），投递回执按未知处理',
      );
      return listRequestsWithoutReceiptColumns(contentDb, whereParts, binds, fetchN, limit, env, dimColumn, localUser.handle);
    }
    console.error('[friendRequests] list 失败', err);
    return { ok: false, status: 500, error_code: 'INTERNAL_ERROR', message: '查询加好友请求失败' };
  }
}

/**
 * REL-FIX-11：统计某方向的 pending 行数（未读角标数据源）。
 *
 * 纯 D1 COUNT（读操作，零 KV 写）—— 符合 Free Tier 约束（计数器不落 KV）。
 * fail-soft：查询失败返回 0（前端不显示角标，不报错打扰用户）。
 */
async function countPendingRequests(
  env: Env,
  dimColumn: 'target_handle' | 'origin_handle',
  localHandle: string,
): Promise<number> {
  try {
    const row = await resolveContentDb(env)
      .prepare(
        `SELECT COUNT(*) AS count FROM friend_requests
          WHERE ${dimColumn} = ? AND status = 'pending'`,
      )
      .bind(localHandle)
      .first<{ count: number }>();
    return row?.count ?? 0;
  } catch (err) {
    console.warn('[friendRequests] pending_count 统计失败，按 0 处理', err);
    return 0;
  }
}

/**
 * REL-FIX-4 / REL-FIX-11：列表降级路径 —— 不带回执列（inbox_status / inbox_error /
 * outbox_error）查询，并把回执补成空串（= 未知，**不**谎报 acked）。
 *
 * 注意 `outbox_status` 属基础列（migration 0060），降级路径**仍能拿到**它 ——
 * 即「已处理但回执未确认」这一维度在旧库上依然可用，只有失败短码拿不到。
 */
async function listRequestsWithoutReceiptColumns(
  contentDb: D1Database,
  whereParts: string[],
  binds: (string | number)[],
  fetchN: number,
  limit: number,
  env: Env,
  dimColumn: 'target_handle' | 'origin_handle',
  localHandle: string,
): Promise<FriendRequestResult<ListRequestsResult>> {
  try {
    const result = await contentDb
      .prepare(
        `SELECT ${FRIEND_REQUEST_COLUMNS}
           FROM friend_requests
           WHERE ${whereParts.join(' AND ')}
           ORDER BY created_at DESC, id DESC
           LIMIT ?`,
      )
      .bind(...binds, fetchN)
      .all<FriendRequestRow>();
    const rows = result.results ?? [];
    const has_more = rows.length > limit;
    const sliced = has_more ? rows.slice(0, limit) : rows;
    const next_cursor = has_more && sliced.length > 0 ? sliced[sliced.length - 1]!.id : null;
    const items = sliced.map((row) => ({
      ...row,
      inbox_status: FRIEND_REQUEST_INBOX_STATUS_UNKNOWN,
      inbox_error: FRIEND_REQUEST_INBOX_STATUS_UNKNOWN,
      outbox_error: FRIEND_REQUEST_INBOX_STATUS_UNKNOWN,
    }));
    const finalItems = dimColumn === 'target_handle' ? await enrichIncomingRequestsWithPinStatus(env, items) : items;
    return {
      ok: true,
      data: {
        items: finalItems,
        has_more,
        next_cursor,
        pending_count: await countPendingRequests(env, dimColumn, localHandle),
      },
    };
  } catch (err) {
    console.error('[friendRequests] list 降级路径失败', err);
    return { ok: false, status: 500, error_code: 'INTERNAL_ERROR', message: '查询加好友请求失败' };
  }
}

/**
 * D1 报错文本判定：缺回执列（旧库未 apply 0061 / 0062 / 0063）。
 *
 * 覆盖 `inbox_status` / `inbox_error` / `outbox_error` 三列 —— 任一缺失都走降级路径。
 * 注意 `outbox_status` 来自 migration 0060（基础列），**不**在此判定范围内：
 * 缺 outbox_error 只影响「失败短码」，基础列查询仍能拿到 outbox_status。
 */
function isMissingReceiptColumnError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /no such column/i.test(msg) && /(inbox_status|inbox_error|outbox_error)/i.test(msg);
}

// =========================================================================
//  7. recordFriendRequestNotification — 已迁出到 ./friendRequestNotify.ts
// =========================================================================
// M17-1c 跨节点 inbox / outbox lib 写 `local_notifications` 的 helper 单列在
// friendRequestNotify.ts；保持本文件聚焦"站主 6 个核心函数 + 类型常量"。
