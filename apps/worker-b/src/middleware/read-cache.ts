/**
 * NCF-2E：公开读缓存策略 + 边缘 Cache API 中间件。
 * protected 档强制 private, no-store + Vary: Authorization，旁路共享缓存。
 */
import type { MiddlewareHandler } from 'hono';
import { isProtectedFollowerTokenMode, normalizeFollowerTokenMode } from '@hailuo/shared-utils';
import type { Env, WorkerBVariables } from '../env.d';
import type { FollowerTokenMode } from '../lib/followerTokenModeCache';

export type WorkerBReadContext = {
  env: Env;
  get: (key: keyof WorkerBVariables) => WorkerBVariables[keyof WorkerBVariables] | undefined;
};

export interface ReadCachePolicy {
  cacheControl: string;
  vary?: string;
}

export function resolveTokenMode(c: WorkerBReadContext): FollowerTokenMode {
  const fromCtx = c.get('followerTokenMode');
  if (fromCtx) return normalizeFollowerTokenMode(fromCtx);
  return normalizeFollowerTokenMode(c.env.FOLLOWER_TOKEN_MODE);
}

/**
 * 根据模式与「公开读期希望的缓存头」生成最终响应缓存策略。
 *   - protected 档：private, no-store + Vary: Authorization
 *   - public-read：返回 publicCacheControl 原样
 */
export function getReadCachePolicy(
  mode: FollowerTokenMode,
  publicCacheControl: string,
): ReadCachePolicy {
  if (isProtectedFollowerTokenMode(mode)) {
    return { cacheControl: 'private, no-store', vary: 'Authorization' };
  }
  return { cacheControl: publicCacheControl };
}

/** 把 ReadCachePolicy 应用到 Headers（Cache-Control 与可选 Vary） */
export function applyCachePolicy(headers: Headers, policy: ReadCachePolicy): void {
  headers.set('Cache-Control', policy.cacheControl);
  if (policy.vary) {
    headers.set('Vary', policy.vary);
  }
}

/**
 * Cloudflare Cache API 边缘缓存中间件（token 模式感知）。
 * protected：旁路 caches.default；public-read：命中则直接返回。
 */
export function edgeCache(
  ttlSec: number,
): MiddlewareHandler<{ Bindings: Env; Variables: WorkerBVariables }> {
  return async (c, next) => {
    if (c.req.method !== 'GET') {
      await next();
      return;
    }
    const mode = resolveTokenMode(c);
    if (isProtectedFollowerTokenMode(mode)) {
      await next();
      const resEnforced = c.res;
      if (resEnforced && resEnforced.status === 200) {
        const wrapped = new Response(resEnforced.clone().body, resEnforced);
        applyCachePolicy(
          wrapped.headers,
          getReadCachePolicy(mode, `public, max-age=${ttlSec}`),
        );
        c.res = wrapped;
      }
      return;
    }
    const cache = caches.default;
    const cacheKey = new Request(c.req.url, { method: 'GET' });
    const hit = await cache.match(cacheKey);
    if (hit) {
      return hit;
    }
    await next();
    const res = c.res;
    if (res && res.status === 200) {
      const cached = new Response(res.clone().body, res);
      applyCachePolicy(
        cached.headers,
        getReadCachePolicy(mode, `public, max-age=${ttlSec}`),
      );
      c.executionCtx.waitUntil(cache.put(cacheKey, cached.clone()));
      c.res = cached;
    }
  };
}

/** /posts·/feed 列表边缘 TTL（秒）。R-AUDIT-V3 P2-3：与 Worker A Cron 刷 feed/posts KV 周期对齐为 60s，避免 30–60s stale 窗口。 */
export const EDGE_CACHE_TTL_SEC = 60;

/**
 * GET /posts/:id 单帖边缘 TTL（秒）。
 * 帖子不可变（无更新接口），删除走显式 DELETE /posts/:id → KV delete。
 * 5 分钟 TTL 大幅减少 KV 读取（Cloudflare Cache API 命中边缘内存，
 * 无需每次请求都访问 KV），同时保证删帖后最多 5 分钟内全网生效。
 */
export const EDGE_CACHE_TTL_POST_SEC = 300;
