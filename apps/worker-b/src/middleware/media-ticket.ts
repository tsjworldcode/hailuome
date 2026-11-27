/**
 * SEC-AUDIT-2026-10-6a · 媒体票据鉴权中间件（MEDIA-TICKET-1）。
 *
 * 【为什么需要独立中间件】
 *   `requireFollowerToken` 是 `app.use(path, mw)` 形式挂载的，Hono 在
 *   `use()` 阶段**尚未**完成路径参数解析，`c.req.param('key')` 取不到值；
 *   而票据必须**精确绑定**当前 `GET /img/:key` 的 key。
 *   故本中间件改用 `app.get('/img/:key', mw, handler)` 形式挂载——
 *   此时 `c.req.param('key')` 可用，能拿到真实 key 做比对。
 *
 * 【职责】
 *   在需要票据的保护档（`token-required` / `following-only` / `mutual-only`）下，
 *   为 `GET /img/:key` 提供「`?ticket=` 合法票据」替代 Authorization（浏览器 `<img>`
 *   发不出该头）。SEC-6-AUTO：随档位自动开/关，不必再翻 `MEDIA_TICKET_ENABLED=true`。
 *
 * 【行为矩阵】
 *   | 模式 | secret / 关闸 | 请求 | 结果 |
 *   |---|---|---|---|
 *   | public-read | 任意 | 任意 | 放行（公开读，票据无意义） |
 *   | token-required 等 | secret 未配或紧急关闸 | 任意 | 交给 `requireFollowerToken` |
 *   | token-required 等 | 已配 secret | 无 ticket | 同上（Authorization 路径） |
 *   | token-required 等 | 已配 secret | ticket 合法 | 放行 + 短 TTL 私有缓存 + `no-referrer` |
 *   | token-required 等 | 已配 secret | ticket 非法/过期/换 key | **403 `MEDIA_TICKET_INVALID`**（不回落 Bearer） |
 *   | owner-only | 任意 | 任意 | 403 `READ_PROTECTION_OWNER_ONLY`（不接受票据） |
 *
 * 【⚠️ 为什么「票据非法 → 403 且不回落 Bearer」】
 *   若回落，攻击者可构造「坏票据 + 任意 Bearer」组合绕过票据语义，
 *   且前后端难以判断到底是哪一条路径生效。显式拒绝更安全、更可排障。
 *
 * 【⚠️ 已知边界（不可回避，必须写进文档）】
 *   票据**不绑定浏览器会话**：`<img>` 直连场景无法验证调用者身份。
 *   因此票据只解决「能不能加载图」，不解决「是不是同一个粉丝」。
 *   请求者级隔离仍依赖 protected 档下的 `Authorization` 路径。
 */

import type { MiddlewareHandler } from 'hono';
import { isProtectedFollowerTokenMode } from '@hailuo/shared-utils';
import type { Env, WorkerBVariables } from '../env.d';
import { resolveTokenMode } from './read-cache';
import { isMediaTicketUsable, verifyMediaTicketForKey } from '../lib/mediaTicket';

export interface MediaTicketVars {
  /** 命中票据授权（用于 handler 决定缓存头） */
  mediaTicketAuthorized?: boolean;
}

/** 票据授权通过的响应缓存策略：允许浏览器本地缓存，禁止共享代理缓存。 */
export const MEDIA_TICKET_CACHE_CONTROL = 'private, max-age=60';

/**
 * 媒体票据鉴权中间件（挂 `app.get('/img/:key', mw, handler)`）。
 *
 * @param next 原路由 handler（票据未生效时由调用方继续走 Authorization 路径）
 */
export function requireMediaTicketOrFallthrough(): MiddlewareHandler<{
  Bindings: Env;
  Variables: WorkerBVariables & MediaTicketVars;
}> {
  return async (c, next) => {
    const mode = resolveTokenMode(c);

    // public-read：公开可读，票据无意义 → 直接放行
    if (!isProtectedFollowerTokenMode(mode)) {
      await next();
      return;
    }

    // owner-only：仅站主可读，不接受任何粉丝侧票据
    if (mode === 'owner-only') {
      return c.json(
        {
          ok: false,
          error_code: 'READ_PROTECTION_OWNER_ONLY',
          message: '当前节点为仅站主可读模式，不接受粉丝读帖 Token',
        },
        403,
      );
    }

    // 档位不需要 / secret 未配 / 紧急关闸 → Authorization 路径
    if (!isMediaTicketUsable(c.env, mode)) {
      await next();
      return;
    }

    const ticket = c.req.query('ticket');
    if (!ticket) {
      // 无票据 → 走 Authorization 路径
      await next();
      return;
    }

    const storageKey = c.req.param('key') ?? '';
    if (!storageKey) {
      return c.json(
        {
          ok: false,
          error_code: 'MEDIA_TICKET_INVALID',
          message: '媒体票据无效或已过期',
        },
        403,
      );
    }

    const verdict = await verifyMediaTicketForKey(c.env, ticket, storageKey);
    if (!verdict.ok) {
      // 票据存在但非法（过期 / 签名错 / key 不匹配 / 版本不符）→ 显式拒绝
      return c.json(
        {
          ok: false,
          error_code: 'MEDIA_TICKET_INVALID',
          message: '媒体票据无效或已过期',
        },
        403,
      );
    }

    // 票据有效：放行，并标记缓存策略
    c.set('mediaTicketAuthorized', true);
    await next();

    // ⚠️ 必须**就地修改** `c.res.headers`，不能 `c.res = new Response(...)`：
    // Hono 的 `c.res` setter 在已有响应时会把旧响应的 headers 逐条覆盖到新响应上，
    // 导致 handler 设的 `Cache-Control: private, no-store` + `Vary: Authorization`
    // 覆盖掉票据路径应有的短 TTL 缓存策略。就地改 headers 可绕开该覆盖行为。
    const res = c.res;
    if (res && res.status === 200) {
      res.headers.set('Cache-Control', MEDIA_TICKET_CACHE_CONTROL);
      // 票据在 URL 里 → 禁止 Referer 携带当前 URL 外泄
      res.headers.set('Referrer-Policy', 'no-referrer');
      // 票据路径不按 Authorization 区分响应，无需 Vary
      res.headers.delete('Vary');
    }
  };
}
