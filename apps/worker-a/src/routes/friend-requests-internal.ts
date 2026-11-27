/**
 * M17-1e · Worker A 加好友内部端点（2 个，Service Binding + HMAC v2）。
 *
 * 路由表（plan §五.2 / §五.3）：
 *   POST /friend-requests/inbox  — origin 节点 Worker B 转发 → ingestFriendRequestInbox lib
 *   POST /friend-requests/outbox — target 节点 Worker B 转发 → applyFriendRequestOutbox lib
 *
 * 鉴权：requireInternalForward 中间件校验 X-Internal-Forward: hmac-v2 + X-Timestamp +
 *       X-Nonce + X-Signature（与 routes/dm.ts / routes/groups.ts 内部端点同模板）。
 *
 * 路由挂载：app.route('/friend-requests', friendRequestsInternalApp) — 不挂 JWT，
 *       Service Binding + HMAC 已足；index.ts 必须把本路由挂在所有 `/api/*` 路由之前
 *       避免被通用中间件吞掉。
 *
 * §F-02 红线：本路由文件不出现 worker-a / WORKER_A_URL / localhost:8787 等字面量。
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import { verifyRequest } from '@hailuo/shared-crypto';
import type { Env, AppVariables } from '../env';
import { ingestFriendRequestInbox } from '../lib/friendRequestInbox';
import { applyFriendRequestOutbox } from '../lib/friendRequestOutbox';

type AppEnv = { Bindings: Env; Variables: AppVariables };
type FriendRequestInternalContext = Context<AppEnv>;

export const friendRequestsInternalApp = new Hono<AppEnv>();

function errorJson(
  c: FriendRequestInternalContext,
  status: 400 | 401 | 403 | 404 | 409 | 429 | 500 | 503,
  code: string,
  message: string,
): Response {
  return c.json({ ok: false, error_code: code, message }, status);
}

/** Service Binding + HMAC v2 鉴权中间件（与 dm.ts / groups.ts 完全同模式）。 */
async function requireInternalForward(
  c: FriendRequestInternalContext,
  next: () => Promise<void>,
): Promise<Response | void> {
  const configured = c.env.INTERNAL_FORWARD_SECRET;
  const marker = c.req.header('X-Internal-Forward') ?? '';
  const timestamp = c.req.header('X-Timestamp') ?? '';
  const nonce = c.req.header('X-Nonce') ?? '';
  const signature = c.req.header('X-Signature') ?? '';
  if (!configured || marker !== 'hmac-v2' || !timestamp || !nonce || !signature) {
    return errorJson(c, 403, 'INTERNAL_FORWARD_REJECTED', '内部转发头验证失败');
  }

  const rawBody = await c.req.text();
  const url = new URL(c.req.url);
  const ok = await verifyRequest(
    { method: c.req.method.toUpperCase(), path: `${url.pathname}${url.search}` },
    rawBody,
    { timestamp, nonce, signature },
    configured,
  );
  if (!ok) {
    return errorJson(c, 403, 'INTERNAL_FORWARD_REJECTED', '内部转发头验证失败');
  }
  c.set('internalForwardBody', rawBody);
  await next();
}

/** 统一 inbox / outbox result → HTTP 响应（路由层零分支）。 */
function resultToResponse(
  c: FriendRequestInternalContext,
  result:
    | { readonly ok: true; readonly data: unknown }
    | {
        readonly ok: false;
        readonly error_code: string;
        readonly status: number;
        readonly message: string;
      },
): Response {
  if (result.ok) {
    return c.json({ ok: true, data: result.data });
  }
  return errorJson(
    c,
    result.status as 400 | 401 | 403 | 404 | 409 | 429 | 500 | 503,
    result.error_code,
    result.message,
  );
}

// 所有内部端点都必须经 HMAC v2 验签
friendRequestsInternalApp.use('*', requireInternalForward);

/** POST /friend-requests/inbox — origin → target（接收方） */
friendRequestsInternalApp.post('/inbox', async (c) => {
  const rawBody = c.get('internalForwardBody') as string | undefined;
  if (!rawBody) {
    return errorJson(c, 400, 'INVALID_BODY', '请求体为空');
  }
  const url = new URL(c.req.url);
  const result = await ingestFriendRequestInbox(c.env, rawBody, url.pathname);
  return resultToResponse(c, result);
});

/** POST /friend-requests/outbox — target → origin（回报方） */
friendRequestsInternalApp.post('/outbox', async (c) => {
  const rawBody = c.get('internalForwardBody') as string | undefined;
  if (!rawBody) {
    return errorJson(c, 400, 'INVALID_BODY', '请求体为空');
  }
  const url = new URL(c.req.url);
  const result = await applyFriendRequestOutbox(c.env, rawBody, url.pathname);
  return resultToResponse(c, result);
});
