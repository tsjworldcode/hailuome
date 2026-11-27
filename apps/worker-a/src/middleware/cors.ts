/**
 * Worker A CORS 中间件（F-15 / F-17）。
 *
 * 规则：
 * - F-15：Worker A Allow-Origin 只允许节点本人 Web 主域名（env.WORKER_A_ORIGIN）；禁止 *。
 * - F-17：开发环境优先读 env.WORKER_A_DEV_ORIGIN（仅 .dev.vars 或 [env.dev] 配置，
 *         生产不设此变量），用于本地 Web 前端（http://localhost:5173）联调。
 *
 * 允许方法：GET, POST, DELETE, OPTIONS。
 */
import type { MiddlewareHandler } from 'hono';
import type { Env } from '../env';

/** 从运行时 env 解析当前允许的 Origin。 */
function resolveConfiguredOrigin(env: Env): string {
  return env.WORKER_A_DEV_ORIGIN?.trim() || env.WORKER_A_ORIGIN?.trim() || '';
}

/**
 * 匹配 Pages 正式域与预览部署域（{hash}.{project}.pages.dev）。
 * configured 例：https://hailuo-web-xxx.pages.dev
 */
function isPagesDevSiblingOrigin(configured: string, requestOrigin: string): boolean {
  try {
    const cfg = new URL(configured);
    const req = new URL(requestOrigin);
    if (cfg.protocol !== req.protocol) return false;
    if (!cfg.hostname.endsWith('.pages.dev') || !req.hostname.endsWith('.pages.dev')) return false;
    if (req.hostname === cfg.hostname) return true;
    return req.hostname.endsWith(`.${cfg.hostname}`);
  } catch {
    return false;
  }
}

/** 按请求 Origin 返回应写入 ACAO 的值（须与浏览器 Origin 完全一致） */
function resolveAllowedOrigin(env: Env, requestOrigin: string | undefined): string {
  const configured = resolveConfiguredOrigin(env);
  if (!configured) return '';
  if (!requestOrigin) return configured;
  if (requestOrigin === configured) return configured;
  if (isPagesDevSiblingOrigin(configured, requestOrigin)) return requestOrigin;
  return configured;
}

const ALLOW_METHODS = 'GET, POST, PATCH, DELETE, OPTIONS';
const ALLOW_HEADERS = 'Content-Type, Authorization';
const MAX_AGE = '86400';

export function workerACors(): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    const requestOrigin = c.req.header('Origin');
    const allowedOrigin = resolveAllowedOrigin(c.env, requestOrigin);

    // Preflight
    if (c.req.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': allowedOrigin,
          'Access-Control-Allow-Methods': ALLOW_METHODS,
          'Access-Control-Allow-Headers': ALLOW_HEADERS,
          'Access-Control-Max-Age': MAX_AGE,
        },
      });
    }

    await next();

    // 注入响应头（仅在有合法 Origin 时设置，避免发送空字符串）
    if (allowedOrigin) {
      c.res.headers.set('Access-Control-Allow-Origin', allowedOrigin);
      c.res.headers.set('Vary', 'Origin');
    }
  };
}
