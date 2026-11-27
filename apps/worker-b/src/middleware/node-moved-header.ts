/**
 * M7-30f-2：宽限期内为公开读响应附加 X-Hailuo-Node-Moved。
 * KV 读经 `nodeUrlMoved` 模块级 60s 缓存（R-AUDIT-V3 2.6）。
 */
import type { MiddlewareHandler } from 'hono';
import type { Env } from '../env.d';
import { attachNodeMovedHeader } from '../lib/nodeUrlMoved';

type AppEnv = { Bindings: Env };

export const nodeMovedHeaderMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  await next();
  try {
    const requestOrigin = new URL(c.req.url).origin;
    await attachNodeMovedHeader(c.env, c.res.headers, requestOrigin);
  } catch (err) {
    console.error('[nodeMovedHeader] 附加响应头失败', err);
  }
};
