/**
 * M17-1e · Worker A 加好友站主端点（5 个，全部 requireOwnerJWT）。
 *
 * 路由表（plan §五.1）：
 *   GET    /api/friend-requests?direction=incoming|outgoing&status=pending&limit=20&cursor=
 *   POST   /api/friend-requests   body={ target_node_url, target_handle, message? }
 *   POST   /api/friend-requests/:id/accept
 *   POST   /api/friend-requests/:id/reject   body={ reason? }
 *   DELETE /api/friend-requests/:id
 *
 * 业务逻辑层 lib（apps/worker-a/src/lib/friendRequests.ts M17-1b）：
 *   - validateTarget：自关注 / handle 格式 / 黑名单 / 已互粉 / 频控
 *   - insertRequest：INSERT friend_requests (pending)
 *   - acceptRequest / rejectRequest / cancelRequest：状态机 + follows + outbox 投递
 *   - listRequests：分页列表
 *
 * 跨节点投递由 lib/friendRequestDelivery.ts 提供（inbox / outbox envelope 构造 + 签名 + fetch）。
 * 跨节点投递是 waitUntil 异步路径，主响应先回 200；投递失败仅 console.warn（与
 * groupMessage.deliverGroupOutboxToOwner 同模式），双写 Repair 由 M17-1g cron 兜底。
 *
 * JWT 鉴权由 index.ts 的 `app.use('/api/friend-requests/*', requireOwnerJWT())` 保障。
 *
 * §F-02 红线：本路由文件不出现 worker-a / WORKER_A_URL / localhost:8787 等字面量。
 */

import { resolveContentDb, resolveIdentityDb } from '../db/bindings';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { randomNonceHex } from '@hailuo/shared-utils';
import type { Env, AppVariables } from '../env';
import {
  acceptRequest,
  cancelRequest,
  insertRequest,
  listRequests,
  rejectRequest,
  validateTarget,
  type FriendRequestListStatus,
} from '../lib/friendRequests';
import {
  buildSignedFriendRequestInboxEnvelope,
  deliverFriendRequestInboxToTarget,
} from '../lib/friendRequestDelivery';
import {
  deliverCancelOutbox,
  deliverStatusOutbox,
} from '../lib/friendRequestOutboxDeliver';

type AppEnv = { Bindings: Env; Variables: AppVariables };
type FriendRequestContext = Context<AppEnv>;

/** friend_request_id 字面规则（generateId('fr') → 'fr_xxxxxxxx...'）。 */
const FRIEND_REQUEST_ID_RE = /^fr_[a-zA-Z0-9_-]{8,128}$/;

/**
 * 列表 status 接受值。
 *
 * REL-FIX-11：新增 `resolved` —— **已处理但回执未确认送达对方**（仅 incoming 有效；
 * outgoing 用它会撒谎，lib 层显式 400）。
 */
const FRIEND_REQUEST_LIST_STATUS_VALUES = new Set<FriendRequestListStatus>([
  'pending',
  'accepted',
  'rejected',
  'cancelled',
  'expired',
  'all',
  'resolved',
]);

export const friendRequestsApp = new Hono<AppEnv>();

function nowIso(): string {
  return new Date().toISOString();
}

function errorJson(
  c: FriendRequestContext,
  status: 400 | 401 | 403 | 404 | 409 | 429 | 500 | 503,
  code: string,
  message: string,
): Response {
  return c.json({ ok: false, error_code: code, message }, status);
}

async function readRawJson(c: FriendRequestContext): Promise<Record<string, unknown> | null> {
  try {
    const parsed = await c.req.json();
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// GET /api/friend-requests — 列请求（incoming/outgoing + status + cursor）
// ---------------------------------------------------------------------------
friendRequestsApp.get('/', async (c) => {
  const directionRaw = (c.req.query('direction') ?? 'incoming').trim();
  if (directionRaw !== 'incoming' && directionRaw !== 'outgoing') {
    return errorJson(c, 400, 'FRIEND_REQUEST_INVALID_PARAMS', 'direction 必须为 incoming 或 outgoing');
  }
  const statusRaw = (c.req.query('status') ?? 'pending').trim();
  if (!FRIEND_REQUEST_LIST_STATUS_VALUES.has(statusRaw as FriendRequestListStatus)) {
    return errorJson(c, 400, 'FRIEND_REQUEST_INVALID_PARAMS', 'status 不合法');
  }
  const limitRaw = c.req.query('limit');
  let limit: number | undefined;
  if (limitRaw != null && limitRaw !== '') {
    const parsed = parseInt(limitRaw, 10);
    if (Number.isNaN(parsed) || parsed < 1 || parsed > 50) {
      return errorJson(c, 400, 'FRIEND_REQUEST_INVALID_PARAMS', 'limit 须在 1~50');
    }
    limit = parsed;
  }
  const cursorRaw = c.req.query('cursor');
  const cursor = cursorRaw && cursorRaw.trim() !== '' ? cursorRaw.trim() : null;

  const result = await listRequests(c.env, {
    direction: directionRaw,
    status: statusRaw as FriendRequestListStatus,
    ...(limit != null ? { limit } : {}),
    ...(cursor != null ? { cursor } : {}),
  });
  if (!result.ok) {
    return errorJson(c, result.status, result.error_code, result.message);
  }
  return c.json({
    ok: true,
    data: {
      direction: directionRaw,
      status: statusRaw,
      items: result.data.items,
      has_more: result.data.has_more,
      next_cursor: result.data.next_cursor,
      // REL-FIX-11：该方向待处理数（面板 / Tab 未读角标数据源）
      pending_count: result.data.pending_count,
    },
  });
});

// ---------------------------------------------------------------------------
// POST /api/friend-requests — 发起加好友（本地 INSERT + waitUntil 跨节点投递）
// ---------------------------------------------------------------------------
friendRequestsApp.post('/', async (c) => {
  const body = await readRawJson(c);
  if (!body) {
    return errorJson(c, 400, 'FRIEND_REQUEST_INVALID_PARAMS', '请求体必须为 JSON');
  }
  const targetNodeUrlRaw = typeof body.target_node_url === 'string' ? body.target_node_url.trim() : '';
  const targetHandleRaw = typeof body.target_handle === 'string' ? body.target_handle.trim() : '';
  const messageRaw = typeof body.message === 'string' ? body.message : '';

  if (!targetNodeUrlRaw || !targetHandleRaw) {
    return errorJson(c, 400, 'FRIEND_REQUEST_INVALID_PARAMS', 'target_node_url 与 target_handle 必填');
  }

  const validation = await validateTarget(c.env, {
    target_node_url: targetNodeUrlRaw,
    target_handle: targetHandleRaw,
    message: messageRaw,
  });
  if (!validation.ok) {
    return errorJson(c, validation.status, validation.error_code, validation.message);
  }

  const insert = await insertRequest(c.env, validation.data);
  if (!insert.ok) {
    return errorJson(c, insert.status, insert.error_code, insert.message);
  }

  // waitUntil 跨节点投递 inbox envelope 到目标节点 Worker B（公开入口）
  c.executionCtx.waitUntil(deliverOriginInbox(c.env, validation.data, insert.data.id, messageRaw));

  return c.json({
    ok: true,
    data: {
      id: insert.data.id,
      target_node_url: validation.data.target_node_url,
      target_handle: validation.data.target_handle,
      status: 'pending',
      created_at: insert.data.created_at,
    },
  }, 201);
});

// ---------------------------------------------------------------------------
// POST /api/friend-requests/:id/accept — 接受（本地写 follows + waitUntil 跨节点 outbox）
// ---------------------------------------------------------------------------
friendRequestsApp.post('/:id/accept', async (c) => {
  const id = c.req.param('id');
  if (!FRIEND_REQUEST_ID_RE.test(id)) {
    return errorJson(c, 400, 'FRIEND_REQUEST_INVALID_PARAMS', 'id 不合法');
  }

  // SEC-AUDIT-2026-10-14：缺 origin_pubkey 的存量行经 waitUntil 异步补 pin（主路径零同步外网）
  const result = await acceptRequest(c.env, id, {
    waitUntil: (p) => c.executionCtx.waitUntil(p),
  });
  if (!result.ok) {
    return errorJson(c, result.status, result.error_code, result.message);
  }

  // waitUntil 跨节点投递 outbox envelope 到 origin 节点 Worker B（公开入口）
  c.executionCtx.waitUntil(deliverStatusOutbox(c.env, id, 'accepted', c.env.ED25519_PRIVATE_KEY));

  return c.json({
    ok: true,
    data: {
      id: result.data.id,
      status: 'accepted',
      accepted_at: result.data.accepted_at,
      followed_at: result.data.followed_at,
    },
  });
});

// ---------------------------------------------------------------------------
// POST /api/friend-requests/:id/reject — 拒绝（不写 follows + waitUntil 跨节点 outbox）
// ---------------------------------------------------------------------------
friendRequestsApp.post('/:id/reject', async (c) => {
  const id = c.req.param('id');
  if (!FRIEND_REQUEST_ID_RE.test(id)) {
    return errorJson(c, 400, 'FRIEND_REQUEST_INVALID_PARAMS', 'id 不合法');
  }
  // 读取 reason 字段（plan §5.1 body 形态；当前 lib 不消费，保留接口位）
  await readRawJson(c);

  const result = await rejectRequest(c.env, id);
  if (!result.ok) {
    return errorJson(c, result.status, result.error_code, result.message);
  }

  // waitUntil 跨节点投递 outbox envelope 到 origin 节点 Worker B
  c.executionCtx.waitUntil(deliverStatusOutbox(c.env, id, 'rejected', c.env.ED25519_PRIVATE_KEY));

  return c.json({
    ok: true,
    data: {
      id: result.data.id,
      status: 'rejected',
      rejected_at: result.data.rejected_at,
    },
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/friend-requests/:id — 撤回（仅 origin；M17-4-1 waitUntil 投递 cancelled→target）
// ---------------------------------------------------------------------------
friendRequestsApp.delete('/:id', async (c) => {
  const id = c.req.param('id');
  if (!FRIEND_REQUEST_ID_RE.test(id)) {
    return errorJson(c, 400, 'FRIEND_REQUEST_INVALID_PARAMS', 'id 不合法');
  }

  const result = await cancelRequest(c.env, id);
  if (!result.ok) {
    return errorJson(c, result.status, result.error_code, result.message);
  }
  // M17-4-1：本地撤回成功后异步通知对端（origin→target outbox cancelled）
  c.executionCtx.waitUntil(deliverCancelOutbox(c.env, id));
  return c.json({
    ok: true,
    data: {
      id: result.data.id,
      status: 'cancelled',
      cancelled_at: result.data.cancelled_at,
    },
  });
});

// ---------------------------------------------------------------------------
// 内部 helpers — waitUntil 跨节点投递（静默失败）
// ---------------------------------------------------------------------------

/** 读本地 users 行；提供 origin 节点站主档案（用于 inbox envelope.origin）。 */
async function readLocalUser(env: Env): Promise<{
  handle: string;
  display_name: string;
  avatar_key: string | null;
  pubkey: string;
  worker_b_url: string;
} | null> {
  try {
    const row = await resolveIdentityDb(env)
      .prepare(`SELECT handle, display_name, avatar_key, pubkey, worker_b_url FROM users LIMIT 1`)
      .first<{
        handle: string;
        display_name: string;
        avatar_key: string | null;
        pubkey: string;
        worker_b_url: string;
      }>();
    if (!row?.handle?.trim()) return null;
    return {
      handle: row.handle.trim().toLowerCase(),
      display_name: (row.display_name ?? '').trim(),
      avatar_key: row.avatar_key ?? null,
      pubkey: (row.pubkey ?? '').trim(),
      worker_b_url: (row.worker_b_url ?? '').trim(),
    };
  } catch (err) {
    console.warn('[friendRequests] readLocalUser 失败', err);
    return null;
  }
}

/**
 * M-F3 / M-F3b：写 inbox_status='pending_retry' + inbox_error（短错误码，不含 URL/邮箱）。
 * 同时写 inbox_last_retry_at（队尾排序用）；updated_at 仅在「首次进入 pending_retry」刷新，
 * 作为 24h giveup 窗起点（后续 cron 失败重试不再动 updated_at，见 gcFriendRequestInbox）。
 * fail-soft：D1 写失败只 warn。
 */
async function recordInboxRetry(env: Env, requestId: string, errCode: string): Promise<void> {
  try {
    const nowIso = new Date().toISOString();
    const safeCode = (errCode || 'INBOX_DELIVERY_FAILED').slice(0, 64);
    await resolveContentDb(env)
      .prepare(
        `UPDATE friend_requests
            SET inbox_status = 'pending_retry',
                inbox_error = ?,
                inbox_last_retry_at = ?,
                updated_at = ?
          WHERE id = ? AND status = 'pending'`,
      )
      .bind(safeCode, nowIso, nowIso, requestId)
      .run();
    console.warn('[friendRequests] inbox 投递失败 pending_retry', { requestId, err_code: safeCode });
  } catch (err) {
    console.warn('[friendRequests] recordInboxRetry 写 D1 失败', err);
  }
}

/** M-F3 / M-F3b：写 inbox_status='acked'，清空 inbox_error / inbox_last_retry_at。fail-soft。 */
async function markInboxAcked(env: Env, requestId: string): Promise<void> {
  try {
    const nowIso = new Date().toISOString();
    await resolveContentDb(env)
      .prepare(
        `UPDATE friend_requests
            SET inbox_status = 'acked', inbox_error = '', inbox_last_retry_at = '', updated_at = ?
          WHERE id = ?`,
      )
      .bind(nowIso, requestId)
      .run();
  } catch (err) {
    console.warn('[friendRequests] markInboxAcked 写 D1 失败', err);
  }
}

/**
 * 发起端把 pending 请求投递到对端 Worker B `/friend-requests/inbox`。
 * M-F3：成功 → inbox_status=acked；失败 → pending_retry（cron 24h 内重试）。
 */
async function deliverOriginInbox(
  env: Env,
  validated: {
    origin_node_url: string;
    origin_handle: string;
    origin_display_name: string;
    origin_avatar_key: string;
    target_node_url: string;
    target_handle: string;
    message: string | null;
  },
  requestId: string,
  messageRaw: string,
): Promise<void> {
  try {
    const localUser = await readLocalUser(env);
    if (!localUser || !localUser.pubkey || localUser.pubkey.length !== 64) {
      console.warn('[friendRequests] 本地 origin 用户档案缺失 pubkey，跳过跨节点投递');
      await recordInboxRetry(env, requestId, 'ORIGIN_PUBKEY_MISSING');
      return;
    }
    const ts = String(Math.floor(Date.now() / 1000));
    const nonce = randomNonceHex(16);
    const trimmedMessage = messageRaw && messageRaw.trim() !== '' ? messageRaw.trim() : undefined;

    const envelope = await buildSignedFriendRequestInboxEnvelope(env, {
      request_id: requestId,
      origin: {
        node_url: validated.origin_node_url,
        handle: validated.origin_handle,
        display_name: validated.origin_display_name || undefined,
        avatar_key: validated.origin_avatar_key || undefined,
        pubkey: localUser.pubkey,
      },
      target: {
        node_url: validated.target_node_url,
        handle: validated.target_handle,
      },
      ...(trimmedMessage !== undefined ? { message: trimmedMessage } : {}),
      nonce,
      ts,
    });
    const result = await deliverFriendRequestInboxToTarget(env, validated.target_node_url, envelope);
    if (!result.ok) {
      console.warn('[friendRequests] origin inbox 跨节点投递失败', {
        requestId,
        error_code: result.error_code,
        status: result.status,
        message: result.message,
      });
      await recordInboxRetry(env, requestId, result.error_code);
      return;
    }
    await markInboxAcked(env, requestId);
  } catch (err) {
    console.warn('[friendRequests] deliverOriginInbox 异常', err);
    await recordInboxRetry(env, requestId, 'INBOX_DELIVERY_EXCEPTION');
  }
}

// REL-FIX-1：deliverStatusOutbox / deliverCancelOutbox 已下沉到 lib/friendRequestOutboxDeliver.ts
//（route waitUntil + cron gcFriendRequestOutbox 共用）
