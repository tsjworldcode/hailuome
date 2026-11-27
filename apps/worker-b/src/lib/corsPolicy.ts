/**
 * SDH-4：Worker B 分路径 CORS Allow-Methods。
 * 公开读仅 GET/OPTIONS；跨节点 ingress 仅必要写方法；站主 Owner Gateway 保留完整写方法。
 */

const OWNER_GATEWAY_PREFIXES = [
  '/auth/',
  '/api/local/',
  '/api/lookup/',
  '/api/follows',
  '/api/blacklist',
  '/api/posts',
  '/api/images',
  '/api/node-settings',
  '/api/messaging',
] as const;

/** SEC-AUDIT-2026-10-6b：媒体票据签发端点是 POST（批量取票必须走 POST body）。 */
const MEDIA_TICKET_PATH = '/api/media/tickets';

/** 跨节点浏览器 ingress（粉丝 Token / DM / 互动 / 加好友） */
const CROSS_NODE_INGRESS_PREFIXES = [
  '/api/follower-tokens',
  '/dm/',
  '/interactions',
  '/friend-requests',
] as const;

function startsWithAny(pathname: string, prefixes: readonly string[]): boolean {
  return prefixes.some((p) => pathname === p || pathname.startsWith(p));
}

/**
 * 内部专用路由不暴露浏览器跨域写能力。
 */
export function isInternalIngressPath(pathname: string): boolean {
  return pathname.startsWith('/internal/');
}

/**
 * 按路径返回 Access-Control-Allow-Methods 值；internal 路由返回 null（不设置 Methods 头）。
 */
export function resolveCorsAllowMethods(pathname: string): string | null {
  if (isInternalIngressPath(pathname)) {
    return null;
  }
  if (pathname.startsWith('/dm/media/') || pathname.startsWith('/groups/media/')) {
    return 'GET, OPTIONS';
  }
  // SEC-AUDIT-2026-10-6b：浏览器批量取票（POST /api/media/tickets）
  if (pathname === MEDIA_TICKET_PATH) {
    return 'POST, OPTIONS';
  }
  if (startsWithAny(pathname, OWNER_GATEWAY_PREFIXES)) {
    return 'GET, POST, PATCH, DELETE, OPTIONS';
  }
  if (startsWithAny(pathname, CROSS_NODE_INGRESS_PREFIXES)) {
    return 'POST, DELETE, OPTIONS';
  }
  return 'GET, OPTIONS';
}
