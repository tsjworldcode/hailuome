/**
 * M17-1c · 加好友跨节点 inbox 接收方 lib（Worker A 内部 `/friend-requests/inbox` 入口的逻辑层）。
 *
 * 流程（计划 §六.1 第 5～8 步）：
 *   1) JSON 解析 + 字段类型校验
 *   2) 时间窗口校验（±5 分钟；plan §5.4）
 *   3) Ed25519 envelope 验签（用 envelope.origin.pubkey）
 *   4) target_node_url 必须是本节点（防 origin 误投错节点；plan §六.4 双端校验）
 *   5) 黑名单门控（origin 被本地拉黑 → BLACKLISTED，**不入库**）
 *   6) `allow_incoming` 开关（system_config.friend_requests_inbox_enabled，默认 true）
 *   7) 频控（inbox 100/h/源节点，复用 lib/friendRequestRateLimit）
 *   8) nonce + uniq_friend_requests_pending 幂等去重
 *   9) INSERT 本地 friend_requests（pending 副本）
 *   10) 写 local_notifications（friend_request_received）
 *
 * lib 输出 discriminated union（与 friendRequests.FriendRequestResult 同形）：
 *   `{ ok: true; data } | { ok: false; error_code; status; message }`
 *
 * 注：路由层（M17-1d）负责 Service Binding + HMAC v2 验签（X-Internal-Forward）；
 *     本 lib 只负责 envelope 验签 + D1 副作用。
 *
 * ────────────────────────────────────────────────────────────────────────
 * M-OPT-SPLIT-A6-2 · CONTENT_DB 切库（**只切 friend_requests 单表单库**）
 *
 * 本步动作：
 *   - `isFriendRequestInboxEnabled` 读 system_config → `resolveIdentityDb(env)`（IDENTITY_DB · migration 0090）
 *   - `findExistingPendingRequest` 查 friend_requests pending → `resolveContentDb(env)`（CONTENT_DB · migration 0060）
 *   - INSERT 本地 `friend_requests` → `resolveContentDb(env)`（CONTENT_DB · migration 0060）
 *
 * 跨库语义保留：
 *   - `friend_request_rate_buckets` 频控 helper（`checkAndIncrementFriendRequestInboxRate`）→ GOVERNANCE_DB（已 5c-1 ✅）
 *   - 黑名单 helper（`isOriginNodeBlacklisted`）→ GOVERNANCE_DB（已 5a ✅）
 *   - 通知写 `local_notifications` → GOVERNANCE_DB（已 5a ✅）
 *
 * **不允许**合并 `friend_requests`（CONTENT）+ `friend_request_rate_buckets`（GOVERNANCE）
 * 到同一 binding 的 batch；本文件坚持三库三次显式查询。A-6-3 落补偿语义方案 C 后，
 * A-7 alias 退役仍保持三次显式调用。
 */

import { generateId, nowISO } from '@hailuo/shared-utils';
import { normalizeWorkerBOrigin, normalizeHandleLocalSegment } from '@hailuo/shared-utils';
import type { Env } from '../env';
import { resolveLocalNodeUrlAliases, isLocalNodeUrlMatch } from './localPublicBaseUrl';
import { checkAndIncrementFriendRequestInboxRate } from './friendRequestRateLimit';
import { truncateFriendRequestMessage } from './friendRequests';
import { recordFriendRequestNotification } from './friendRequestNotify';
import { isNodeBlacklisted } from './blacklistLookup';
import { resolveContentDb, resolveIdentityDb } from '../db/bindings';
import {
  buildFriendRequestEnvelopeSigningInput,
  buildFriendRequestPlaceholderRawBody,
  checkFriendRequestEnvelopeWindow,
  computeFriendRequestBodySha256Hex,
  verifyFriendRequestEnvelope,
} from './friendRequestEnvelope';

// ---- 类型 ------------------------------------------------------------

/** inbox envelope origin 子结构（plan §五.2 修缮：含 pubkey，与 M9-19 actor 同形）。 */
export interface FriendRequestInboxOrigin {
  readonly node_url: string;
  readonly handle: string;
  readonly display_name?: string;
  readonly avatar_key?: string;
  /** Ed25519 raw 公钥（64 hex 字符）— 必须与 origin 节点实际公钥一致。 */
  readonly pubkey: string;
}

export interface FriendRequestInboxTarget {
  readonly node_url: string;
  readonly handle: string;
}

export interface FriendRequestInboxBody {
  readonly request_id: string;
  readonly origin: FriendRequestInboxOrigin;
  readonly target: FriendRequestInboxTarget;
  readonly message?: string;
  readonly nonce: string;
  readonly sig: string;
  /** unix sec 字符串（与 HMAC v2 ts 同口径） */
  readonly ts: string;
}

export type FriendRequestInboxErrorCode =
  | 'FRIEND_REQUEST_INVALID_PARAMS'
  | 'FRIEND_REQUEST_INVALID_SIG'
  | 'FRIEND_REQUEST_SIGNATURE_EXPIRED'
  | 'FRIEND_REQUEST_REPLAY'
  | 'BLACKLISTED'
  | 'INCOMING_DISABLED'
  | 'RATE_LIMITED'
  | 'PIN_CHECK_FAILED'
  | 'INTERNAL_ERROR';

export type FriendRequestInboxResult<T> =
  | { readonly ok: true; readonly data: T }
  | {
      readonly ok: false;
      readonly error_code: FriendRequestInboxErrorCode;
      readonly status: 400 | 401 | 403 | 404 | 409 | 429 | 500 | 503;
      readonly message: string;
    };

export interface IngestFriendRequestInboxSuccess {
  /** 本节点 friend_requests.id（envelope.request_id 同值，保证跨节点对齐） */
  readonly id: string;
  readonly created_at: string;
  /** 'inserted' = 新写入；'duplicate' = 命中已有 pending（幂等） */
  readonly mode: 'inserted' | 'duplicate';
  /** SEC-AUDIT-2026-10-7: 首见标记（无存储级 pin 或冷启动时为 true；匹配已存 pin 时为 false） */
  readonly first_seen: boolean;
}

// ---- 存储级 pin 校验（防换钥顶替）----------------------------------

export interface OriginPubkeyPinCheckResult {
  readonly ok: boolean;
  readonly hasPin: boolean;
  readonly firstSeen: boolean;
  readonly pinnedPubkey?: string;
  readonly dbError?: boolean;
}

/**
 * SEC-AUDIT-2026-10-7 · P1-1 第二刀：存储级 pin 校验（防换钥顶替）
 * 从 IDENTITY_DB 的 follows 表中读取对方节点已固化的 followed_pubkey：
 * - 若已存在 pin 且不匹配：返回 ok=false（换钥顶替，调用方应直接 403 拒绝且不入库）
 * - 若已存在 pin 且匹配：返回 ok=true, hasPin=true, firstSeen=false
 * - 若未找到关注记录，或历史存量关注 followed_pubkey 为空（冷启动）：返回 ok=true, hasPin=false, firstSeen=true
 */
export async function checkOriginFollowPubkeyPin(
  env: Env,
  originNodeUrlNorm: string,
  incomingPubkey: string,
): Promise<OriginPubkeyPinCheckResult> {
  const normPubkey = (incomingPubkey ?? '').trim().toLowerCase();
  if (!normPubkey || !originNodeUrlNorm) {
    return { ok: false, hasPin: false, firstSeen: false };
  }
  try {
    const identityDb = resolveIdentityDb(env);
    const row = await identityDb
      .prepare(
        `SELECT followed_pubkey FROM follows
          WHERE follower_node_url = ? OR followed_worker_b_url = ?
          LIMIT 1`,
      )
      .bind(originNodeUrlNorm, originNodeUrlNorm)
      .first<{ followed_pubkey: string | null }>();

    const storedPin = row?.followed_pubkey?.trim();
    if (!row || !storedPin) {
      // 未关注或历史存量关注尚未 pin 权威公钥（冷启动 / 首见）
      return { ok: true, hasPin: false, firstSeen: true };
    }

    const matches = storedPin.toLowerCase() === normPubkey;
    return {
      ok: matches,
      hasPin: true,
      firstSeen: false,
      pinnedPubkey: storedPin,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('no such column: followed_pubkey') || msg.includes('no such column')) {
      console.warn('[friendRequestInbox] follows.followed_pubkey 列未初始化，fail-soft 放行冷启动', err);
      return { ok: true, hasPin: false, firstSeen: true };
    }
    console.error('[friendRequestInbox] checkOriginFollowPubkeyPin 异常，fail-closed 拒绝', err);
    return { ok: false, hasPin: false, firstSeen: false, dbError: true };
  }
}

// ---- 1. 解析 envelope body -----------------------------------------

/**
 * 解析 inbox raw body + 字段类型校验；非对象 / 缺必填字段 / 类型不符 → 返回 null。
 * 与 lib/interactionEnvelope.normalizeEnvelopeActor 同模式（防御性类型校验）。
 */
export function parseFriendRequestInboxBody(raw: unknown): FriendRequestInboxBody | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;

  const requestId = typeof obj.request_id === 'string' ? obj.request_id.trim() : '';
  if (!requestId) return null;

  const originRaw = obj.origin;
  if (!originRaw || typeof originRaw !== 'object') return null;
  const originObj = originRaw as Record<string, unknown>;
  const originNodeUrl = typeof originObj.node_url === 'string' ? originObj.node_url.trim() : '';
  // M-F2：限定名（alice@reg2）归一化为裸本地名，避免与本地 users.handle 比较时误判
  const originHandle = normalizeHandleLocalSegment(
    typeof originObj.handle === 'string' ? originObj.handle : '',
  );
  const originPubkey = typeof originObj.pubkey === 'string' ? originObj.pubkey.trim() : '';
  const originDisplayName = typeof originObj.display_name === 'string' ? originObj.display_name : '';
  const originAvatarKey = typeof originObj.avatar_key === 'string' ? originObj.avatar_key : '';
  if (!originNodeUrl || !originHandle || !originPubkey) return null;
  if (originPubkey.length !== 64) return null;

  const targetRaw = obj.target;
  if (!targetRaw || typeof targetRaw !== 'object') return null;
  const targetObj = targetRaw as Record<string, unknown>;
  const targetNodeUrl = typeof targetObj.node_url === 'string' ? targetObj.node_url.trim() : '';
  const targetHandle = normalizeHandleLocalSegment(
    typeof targetObj.handle === 'string' ? targetObj.handle : '',
  );
  if (!targetNodeUrl || !targetHandle) return null;

  const message = typeof obj.message === 'string' ? obj.message : undefined;
  const nonce = typeof obj.nonce === 'string' ? obj.nonce.trim() : '';
  const sig = typeof obj.sig === 'string' ? obj.sig.trim() : '';
  const ts = typeof obj.ts === 'string' ? obj.ts.trim() : '';
  if (!nonce || !sig || !ts) return null;

  const origin: FriendRequestInboxOrigin = {
    node_url: originNodeUrl,
    handle: originHandle,
    pubkey: originPubkey,
    ...(originDisplayName ? { display_name: originDisplayName } : {}),
    ...(originAvatarKey ? { avatar_key: originAvatarKey } : {}),
  };

  return {
    request_id: requestId,
    origin,
    target: { node_url: targetNodeUrl, handle: targetHandle },
    ...(message !== undefined ? { message } : {}),
    nonce,
    sig,
    ts,
  };
}

// ---- 2. allow_incoming 开关 ----------------------------------------

/** 读取 system_config `friend_requests_inbox_enabled`，默认 true。
 *  M-OPT-SPLIT-A6-2：system_config 在 IDENTITY_DB（migration 0090），切 resolveIdentityDb(env)。 */
export async function isFriendRequestInboxEnabled(env: Env): Promise<boolean> {
  try {
    const identityDb = resolveIdentityDb(env);
    const row = await identityDb
      .prepare(`SELECT value FROM system_config WHERE key = 'friend_requests_inbox_enabled' LIMIT 1`)
      .first<{ value: string }>();
    const v = (row?.value ?? '').trim().toLowerCase();
    if (!v) return true;
    return v !== 'false' && v !== '0';
  } catch (err) {
    console.warn('[friendRequestInbox] 读取 allow_incoming 开关失败，按默认开启', err);
    return true;
  }
}

// ---- 3. 黑名单门控（接收方专用） ------------------------------------
// M-OPT-SPLIT-5：统一走 blacklistLookup（GOVERNANCE_DB）

async function isOriginNodeBlacklisted(env: Env, normalizedNodeUrl: string): Promise<boolean> {
  return isNodeBlacklisted(env, normalizedNodeUrl);
}

// ---- 4. nonce + pending 幂等查 -------------------------------------

/**
 * 查同 (origin_node_url, target_node_url) 的 pending 行 — 用于幂等去重。
 * 返回已有行 id；null 表示可 INSERT。
 * M-OPT-SPLIT-A6-2：friend_requests 在 CONTENT_DB（migration 0060），切 resolveContentDb(env)。 */
async function findExistingPendingRequest(
  env: Env,
  originNodeUrl: string,
  targetHandle: string,
): Promise<string | null> {
  try {
    const contentDb = resolveContentDb(env);
    const row = await contentDb
      .prepare(
        `SELECT id FROM friend_requests
          WHERE origin_node_url = ? AND target_handle = ? AND status = 'pending'
          LIMIT 1`,
      )
      .bind(originNodeUrl, targetHandle)
      .first<{ id: string }>();
    return row?.id ?? null;
  } catch (err) {
    console.warn('[friendRequestInbox] pending 查重失败，按可插入处理', err);
    return null;
  }
}

// ---- 5. 完整 ingest 入口 --------------------------------------------

/**
 * 接收方完整流程入口。路由层（M17-1d）只需：
 *   - 解析 raw body（c.req.text()）
 *   - 调 ingestFriendRequestInbox(env, rawBody, expectedPath)
 *   - 把 Result 序列化为 JSON 返回
 *
 * expectedPath 必须与 envelope 签名输入里的 path 一致（防跨端点重放）。
 */
export async function ingestFriendRequestInbox(
  env: Env,
  rawBody: string,
  expectedPath: string,
  now: Date = new Date(),
): Promise<FriendRequestInboxResult<IngestFriendRequestInboxSuccess>> {
  // ---- 1) JSON 解析 + 字段校验 --------------------------------------
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawBody);
  } catch {
    return { ok: false, status: 400, error_code: 'FRIEND_REQUEST_INVALID_PARAMS', message: 'envelope body 必须为 JSON' };
  }
  const body = parseFriendRequestInboxBody(parsedJson);
  if (!body) {
    return { ok: false, status: 400, error_code: 'FRIEND_REQUEST_INVALID_PARAMS', message: 'envelope 字段缺失或类型不符' };
  }

  // ---- 2) 时间窗口校验 --------------------------------------------
  const window = checkFriendRequestEnvelopeWindow(body.ts, now);
  if (!window.ok) {
    const status = window.error_code === 'FRIEND_REQUEST_SIGNATURE_EXPIRED' ? 403 : 401;
    return { ok: false, status, error_code: window.error_code, message: 'envelope 签名时间窗口外' };
  }

  // ---- 3) Ed25519 envelope 验签 ------------------------------------
  // 发送方用 sig 占位 body 计算 SHA-256 后签名；接收方必须重建同一占位 body 复算。
  // 直接对含真实 sig 的 rawBody 取 hash 会得到不同摘要，导致合法请求恒报 INVALID_SIG。
  const placeholderRawBody = buildFriendRequestPlaceholderRawBody(parsedJson);
  if (!placeholderRawBody) {
    return { ok: false, status: 400, error_code: 'FRIEND_REQUEST_INVALID_PARAMS', message: 'envelope body 必须为 JSON 对象' };
  }
  const bodySha = await computeFriendRequestBodySha256Hex(placeholderRawBody);
  const signingInput = buildFriendRequestEnvelopeSigningInput(
    'POST',
    expectedPath,
    body.ts,
    body.nonce,
    bodySha,
  );
  const sigOk = await verifyFriendRequestEnvelope(signingInput, body.sig, body.origin.pubkey);
  if (!sigOk) {
    return { ok: false, status: 403, error_code: 'FRIEND_REQUEST_INVALID_SIG', message: 'envelope 签名验证失败' };
  }

  // ---- 4) target_node_url 必须等于本节点 ---------------------------
  // REL-FIX-2：比对前做 origin 级归一（大小写 host / 默认端口 / 尾斜杠 / path 忽略），
  // 并命中本机别名表（canonical + users 分叉 + env 回落 + 宽限期内旧址）。
  // 归一只做比对，不改落库原文；是否本机一律走别名成员判定，禁止裸 accept 任意 host。
  const localAliases = await resolveLocalNodeUrlAliases(env);
  const targetNodeUrlNorm = normalizeWorkerBOrigin(body.target.node_url);
  if (localAliases.length === 0 || !isLocalNodeUrlMatch(body.target.node_url, localAliases)) {
    return {
      ok: false,
      status: 400,
      error_code: 'FRIEND_REQUEST_INVALID_PARAMS',
      message: 'envelope.target.node_url 与本节点公开基址不一致（误投错节点）',
    };
  }

  // ---- 5) 黑名单门控 -----------------------------------------------
  const originNodeUrlNorm = normalizeWorkerBOrigin(body.origin.node_url);
  if (!originNodeUrlNorm) {
    return { ok: false, status: 400, error_code: 'FRIEND_REQUEST_INVALID_PARAMS', message: 'origin.node_url 不合法' };
  }
  if (await isOriginNodeBlacklisted(env, originNodeUrlNorm)) {
    // 黑名单门控命中：返回错误且**不入库**（plan §六.4）
    return { ok: false, status: 403, error_code: 'BLACKLISTED', message: 'origin 节点已被本地封禁' };
  }

  // ---- 6) allow_incoming 开关 --------------------------------------
  if (!(await isFriendRequestInboxEnabled(env))) {
    return { ok: false, status: 403, error_code: 'INCOMING_DISABLED', message: '本站已关闭加好友接收入口' };
  }

  // ---- 6.1) 存储级 pin 门禁（SEC-AUDIT-2026-10-7 · P1-1 第二刀 · 防换钥顶替） -----
  const pinCheck = await checkOriginFollowPubkeyPin(env, originNodeUrlNorm, body.origin.pubkey);
  if (!pinCheck.ok) {
    if (pinCheck.dbError) {
      return {
        ok: false,
        status: 503,
        error_code: 'PIN_CHECK_FAILED',
        message: '验证节点信任公钥时数据库异常，请稍后重试',
      };
    }
    // 换钥顶替攻击拦截：已有 pin 但公钥不一致，直接 403 拒绝且绝对不入库、不写通知
    console.warn(
      `[friendRequestInbox] 拒绝换钥顶替请求: origin=${originNodeUrlNorm} 公钥与存储级 pin 不匹配`,
    );
    return {
      ok: false,
      status: 403,
      error_code: 'FRIEND_REQUEST_INVALID_SIG',
      message: 'origin 节点公钥与本地 pin 不匹配（疑似换钥冒名；若对方确已换钥，需先取关并重新发起关注以更新信任 Pin），请求被拒绝',
    };
  }

  // ---- 7) 频控（inbox 100/h/源节点）-------------------------------
  if (!(await checkAndIncrementFriendRequestInboxRate(env, originNodeUrlNorm))) {
    return { ok: false, status: 429, error_code: 'RATE_LIMITED', message: 'inbox 频控已达上限' };
  }

  // ---- 8) pending 幂等查重 ----------------------------------------
  const existingId = await findExistingPendingRequest(env, originNodeUrlNorm, body.target.handle);
  if (existingId) {
    return {
      ok: true,
      data: {
        id: existingId,
        created_at: nowISO(),
        mode: 'duplicate',
        first_seen: pinCheck.firstSeen,
      },
    };
  }

  // ---- 9) INSERT 本地 friend_requests ------------------------------
  // M-OPT-SPLIT-A6-2：friend_requests 在 CONTENT_DB（migration 0060），切 resolveContentDb(env)。
  // 注意：不要与 system_config 读（IDENTITY_DB）/ 频控（GOVERNANCE_DB）合并到同一 batch，
  // 必须三库三次显式查询（即使观察期 alias 阶段走 env.DB）。
  const nowIso = nowISO();
  const message = body.message ? truncateFriendRequestMessage(body.message) : null;
  try {
    const contentDb = resolveContentDb(env);
    // 落库申请里的公钥，供接受时和对方公开档案比对。这里的验签只证明对方拿着私钥。
    const originPubkey =
      typeof body.origin.pubkey === 'string' && /^[0-9a-fA-F]{64}$/.test(body.origin.pubkey.trim())
        ? body.origin.pubkey.trim().toLowerCase()
        : '';
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
        body.request_id,
        originNodeUrlNorm,
        body.origin.handle,
        body.origin.display_name ?? '',
        body.origin.avatar_key ?? '',
        originPubkey,
        targetNodeUrlNorm,
        body.target.handle,
        message,
        nowIso,
        nowIso,
        body.nonce,
      )
      .run();
  } catch (err) {
    const messageText = err instanceof Error ? err.message : String(err);
    // UNIQUE 部分索引 uniq_friend_requests_pending 命中 → 视为幂等（plan §六.4 状态机幂等）
    if (messageText.includes('UNIQUE') || messageText.includes('unique') || messageText.includes('SQLITE_CONSTRAINT')) {
      return {
        ok: true,
        data: {
          id: body.request_id,
          created_at: nowIso,
          mode: 'duplicate',
          first_seen: pinCheck.firstSeen,
        },
      };
    }
    console.error('[friendRequestInbox] INSERT 失败', err);
    return { ok: false, status: 500, error_code: 'INTERNAL_ERROR', message: '写入加好友请求失败' };
  }

  // ---- 10) 写通知（fail-soft；lib/friendRequestNotify 已自吞异常） ---
  // M17-FIX-4 / P2-6：content_preview 带 origin_display_name（及可选附言）供详情面板展示
  const originDisplayName = (body.origin.display_name ?? '').trim();
  const messagePreview = body.message ? truncateFriendRequestMessage(body.message) : '';
  const previewParts = [originDisplayName || null, messagePreview || null].filter(
    (p): p is string => Boolean(p),
  );
  await recordFriendRequestNotification(env, {
    type: 'friend_request_received',
    request_id: body.request_id,
    actor_handle: body.origin.handle,
    actor_node_url: originNodeUrlNorm,
    related_node_url: originNodeUrlNorm,
    ...(previewParts.length > 0 ? { content_preview: previewParts.join(' · ') } : {}),
  });

  return {
    ok: true,
    data: {
      id: body.request_id,
      created_at: nowIso,
      mode: 'inserted',
      first_seen: pinCheck.firstSeen,
    },
  };
}
