/**
 * M17-1d · Worker B 公开 ingress（加好友跨节点转发）。
 *
 * 极窄转发 — 与 `routes/dm.ts` / `routes/groups.ts` 完全同模式：
 *   - POST /friend-requests/inbox   → forwardRawBodyToWorkerA → Worker A `/friend-requests/inbox`
 *   - POST /friend-requests/outbox  → forwardRawBodyToWorkerA → Worker A `/friend-requests/outbox`
 *   - readRawBodyWithLimit (8 KB) + assertWorkerABinding + HMAC v2
 *   - 不解密、不写 D1、不写 KV
 *
 * envelope 字段 / 错误码权威在 Worker A lib（M17-1c）：
 *   - `friendRequestInbox.ts`  → `ingestFriendRequestInbox(env, rawBody, expectedPath)`
 *   - `friendRequestOutbox.ts` → `applyFriendRequestOutbox(env, rawBody, expectedPath)`
 *   - plan §五.2 / §五.3 body schema 是本端外形校验的依据。
 *
 * 本端只做：
 *   1. 8 KB body 上限（plan §363 / §611）
 *   2. envelope 字段 type + 必填存在性粗校验（防御性 + 减少 Worker A 无效请求）
 *   3. WORKER_A binding + INTERNAL_FORWARD_SECRET 存在性检查
 *   4. 透传 Worker A 的权威响应（status / error_code / message）
 *
 * 路由层校验 vs Worker A lib 校验：Worker B 是公开入口（来自别节点 Worker A 的
 * `c.executionCtx.waitUntil(POST https://<self_b>/...)`，Service Binding 不经
 * 浏览器但仍走公网），需要粗校验把"字段缺失 / 类型不符 / JSON 解析失败"在边缘挡掉，
 * 避免把垃圾请求全部转给 Worker A 浪费 DB 行；Worker A lib 仍做权威验签 +
 * 字段归一化 + D1 副作用。
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env } from '../env.d';
import {
  assertWorkerABinding,
  forwardRawBodyToWorkerA,
  ingressErrorJson,
  readRawBodyWithLimit,
} from '../lib/publicIngress';

type AppEnv = { Bindings: Env };
type FriendRequestContext = Context<AppEnv>;

// plan §363 / §611 定稿：8 KB body 上限（与 dm.ts 64 KB、groups.ts 16 KB 不同；
// 加好友 envelope 体积小，pubkey 64 hex + handle/node_url + nonce + sig + ts ≈ 600B）。
const MAX_FRIEND_REQUEST_BODY_BYTES = 8 * 1024;

// Ed25519 raw 公钥固定 64 hex 字符（小写或大写；用 i flag 兼容）；lib 内部还
// 会再做一次严格 64 hex 校验，本端只是把"看起来不是 hex"的请求在边缘挡掉。
const HEX_64_RE = /^[0-9a-f]{64}$/i;

export const friendRequestsApp = new Hono<AppEnv>();

/**
 * inbox envelope 外形校验（plan §五.2 修缮版 v1.2）：
 *   {
 *     request_id: string,
 *     origin: { node_url, handle, display_name?, avatar_key?, pubkey },
 *     target: { node_url, handle },
 *     message?: string,
 *     nonce: string,
 *     sig: string,
 *     ts: string,            // unix sec 字符串
 *   }
 */
function looksLikeFriendRequestInboxEnvelope(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object') return false;
  const o = raw as Record<string, unknown>;

  if (typeof o.request_id !== 'string' || o.request_id.trim().length === 0) return false;
  if (typeof o.nonce !== 'string' || o.nonce.trim().length === 0) return false;
  if (typeof o.sig !== 'string' || o.sig.trim().length === 0) return false;
  if (typeof o.ts !== 'string' || o.ts.trim().length === 0) return false;
  if (o.message !== undefined && typeof o.message !== 'string') return false;

  const origin = o.origin;
  if (!origin || typeof origin !== 'object') return false;
  const or = origin as Record<string, unknown>;
  if (typeof or.node_url !== 'string' || or.node_url.trim().length === 0) return false;
  if (typeof or.handle !== 'string' || or.handle.trim().length === 0) return false;
  if (typeof or.pubkey !== 'string' || !HEX_64_RE.test(or.pubkey.trim())) return false;
  if (or.display_name !== undefined && typeof or.display_name !== 'string') return false;
  if (or.avatar_key !== undefined && typeof or.avatar_key !== 'string') return false;

  const target = o.target;
  if (!target || typeof target !== 'object') return false;
  const tr = target as Record<string, unknown>;
  if (typeof tr.node_url !== 'string' || tr.node_url.trim().length === 0) return false;
  if (typeof tr.handle !== 'string' || tr.handle.trim().length === 0) return false;

  return true;
}

/**
 * outbox envelope 外形校验（plan §五.3 修缮版 v1.2）：
 *   {
 *     request_id: string,
 *     status: 'accepted' | 'rejected' | 'cancelled',
 *     actor: { node_url, handle, pubkey },
 *     nonce: string,
 *     sig: string,
 *     ts: string,
 *   }
 *   （M17-4-1：cancelled = origin→target 撤回通知）
 */
function looksLikeFriendRequestOutboxEnvelope(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object') return false;
  const o = raw as Record<string, unknown>;

  if (typeof o.request_id !== 'string' || o.request_id.trim().length === 0) return false;
  if (o.status !== 'accepted' && o.status !== 'rejected' && o.status !== 'cancelled') return false;
  if (typeof o.nonce !== 'string' || o.nonce.trim().length === 0) return false;
  if (typeof o.sig !== 'string' || o.sig.trim().length === 0) return false;
  if (typeof o.ts !== 'string' || o.ts.trim().length === 0) return false;

  const actor = o.actor;
  if (!actor || typeof actor !== 'object') return false;
  const ar = actor as Record<string, unknown>;
  if (typeof ar.node_url !== 'string' || ar.node_url.trim().length === 0) return false;
  if (typeof ar.handle !== 'string' || ar.handle.trim().length === 0) return false;
  if (typeof ar.pubkey !== 'string' || !HEX_64_RE.test(ar.pubkey.trim())) return false;

  return true;
}

/**
 * 加好友 ingress 通用转发 helper（与 `routes/groups.ts` `forwardGroupIngress` 同模式）。
 */
async function forwardFriendRequestIngress(
  c: FriendRequestContext,
  upstreamPath: '/friend-requests/inbox' | '/friend-requests/outbox',
  validate: (raw: unknown) => boolean,
): Promise<Response> {
  // binding + secret 缺失 → 503（与 dm.ts / groups.ts 同口径）
  const bindingErr = assertWorkerABinding(c.env);
  if (bindingErr) return bindingErr;

  const bodyRead = await readRawBodyWithLimit(c.req.raw, MAX_FRIEND_REQUEST_BODY_BYTES);
  if (!bodyRead.ok) {
    return ingressErrorJson(413, 'FRIEND_REQUEST_ENVELOPE_TOO_LARGE', '加好友 envelope 超过大小限制');
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(bodyRead.rawBody) as Record<string, unknown>;
  } catch {
    return ingressErrorJson(400, 'INVALID_BODY', '请求体必须为 JSON');
  }
  if (!validate(parsed)) {
    return ingressErrorJson(400, 'FRIEND_REQUEST_ENVELOPE_INVALID', '加好友 envelope 字段缺失或类型不符');
  }

  return forwardRawBodyToWorkerA(c.env, {
    upstreamPath,
    method: 'POST',
    rawBody: bodyRead.rawBody,
  });
}

/** 接收方（target 节点）— origin 节点 Worker A waitUntil POST 到本节点 Worker B 的入口 */
friendRequestsApp.post('/inbox', async (c) =>
  forwardFriendRequestIngress(c, '/friend-requests/inbox', looksLikeFriendRequestInboxEnvelope),
);

/** 回报方（origin 节点）— target 节点 Worker A waitUntil POST 到本节点 Worker B 的入口 */
friendRequestsApp.post('/outbox', async (c) =>
  forwardFriendRequestIngress(c, '/friend-requests/outbox', looksLikeFriendRequestOutboxEnvelope),
);
