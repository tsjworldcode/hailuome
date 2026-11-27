/**
 * Worker B 公开 follower-tokens 路由（M6-0a 架构纠正）。
 *
 * 【架构定位】
 *   - Worker B 是粉丝**唯一**公开入口（§F-02 "Worker A 地址永不对外暴露"）。
 *   - 本路由是 follower 申请 24h TTL Ed25519 Token 的公开端点。
 *   - 真正的 D1 黑名单查 + Ed25519 签名仍由 Worker A 完成，Worker B 仅做转发；
 *     Worker A 永不直接暴露给公网。
 *
 * 【转发链路】
 *   follower → Worker B `POST /api/follower-tokens`（CORS 允许，本路由）
 *           → `env.WORKER_A.fetch(...)`（Cloudflare Service Binding，不经公网）
 *           → Worker A `POST /api/follower-tokens`（内部专属，X-Internal-Forward 守卫）
 *           → Ed25519 签名 + D1 黑名单查
 *           ↓ 原路返回
 *
 * 【错误码（本层独有）】
 *   - `WORKER_A_BINDING_MISSING`（503）：worker-b wrangler.toml 未配置 `[[services]]
 *     binding = "WORKER_A"`，或运行时 env.WORKER_A 为 undefined
 *   - `INTERNAL_FORWARD_SECRET_MISSING`（503）：worker-b 未通过
 *     `wrangler secret put INTERNAL_FORWARD_SECRET` 注入共享密钥
 *   - `UPSTREAM_ERROR`（502）：Service Binding 调用 Worker A 时抛 fetch 异常
 *
 * 【错误码（透传自 Worker A）】
 *   - `INVALID_BODY` / `NODE_URL_REQUIRED` / `NODE_URL_INVALID`（400）
 *   - `BLACKLISTED`（403）
 *   - `RATE_LIMITED`（429，SDH-5）
 *   - `INTERNAL_FORWARD_REJECTED`（401，正常情况下不应出现 — 表示两端 secret 不一致）
 *   - `INTERNAL_ERROR`（500）
 *
 * 【安全说明】
 *   - 不在本层做 D1 黑名单查（Worker B 是只读层，没有 D1 binding）。
 *   - 不在错误响应中泄露 Worker A 的内部 URL 或 binding 名。
 *   - 内部转发使用 HMAC 绑定 method/path/body，静态 secret 不再直接作为 bearer 口令发送。
 *   - Worker A 端 D1 限频（SDH-5）；本层仅 body 大小上限。
 */

import { Hono } from 'hono';
import type { Env } from '../env.d';
import {
  assertWorkerABinding,
  forwardRawBodyToWorkerA,
  readRawBodyWithLimit,
} from '../lib/publicIngress';

export const followerTokensApp = new Hono<{ Bindings: Env }>();

/** follower token 申领 JSON body 上限 */
const MAX_FOLLOWER_TOKEN_BODY_BYTES = 8 * 1024;

followerTokensApp.post('/', async (c) => {
  const bindingErr = assertWorkerABinding(c.env);
  if (bindingErr) {
    console.error('[worker-b/follower-tokens] Service Binding 或 secret 未配置');
    return c.json(
      {
        ok: false,
        error_code: bindingErr.status === 503 ? 'WORKER_A_BINDING_MISSING' : 'INTERNAL_FORWARD_SECRET_MISSING',
        message: '签发服务暂不可用，请稍后再试',
      },
      503,
    );
  }

  const bodyRead = await readRawBodyWithLimit(c.req.raw, MAX_FOLLOWER_TOKEN_BODY_BYTES);
  if (!bodyRead.ok) {
    return c.json(
      { ok: false, error_code: 'INVALID_BODY', message: '请求体超过大小限制' },
      400,
    );
  }

  try {
    return await forwardRawBodyToWorkerA(c.env, {
      upstreamPath: '/api/follower-tokens',
      method: 'POST',
      rawBody: bodyRead.rawBody,
    });
  } catch (err) {
    console.error('[worker-b/follower-tokens] Service Binding 调用 Worker A 失败', err);
    return c.json(
      {
        ok: false,
        error_code: 'UPSTREAM_ERROR',
        message: '签发服务暂时不可达，请稍后再试',
      },
      502,
    );
  }
});

export { passthroughResponse } from '../lib/passthroughResponse';
