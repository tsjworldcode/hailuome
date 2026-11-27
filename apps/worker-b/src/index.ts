/**
 * Worker B — 公开只读层（M3）
 *
 * 路由一览：
 *   GET /health              — 节点探活（公开）
 *   GET /.well-known/…       — proof / 迁址声明
 *   GET /users/:handle       — 公开用户信息（NCF-2E → routes/public-reads）
 *   GET /posts|/posts/:id|/feed|/img/:key — 公开读（NCF-2E → public-reads）
 *
 * CORS：public-read 兼容期 Allow-Origin: *；protected 回显 Origin + Vary。
 * 粉丝 Token / 边缘缓存策略见 middleware/follower-token + middleware/read-cache。
 *
 * Worker B 只读，无任何写操作（无 D1，无 KV.put）。
 */

import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { isProtectedFollowerTokenMode } from '@hailuo/shared-utils';
import type { Env, WorkerBVariables } from './env.d';
import { requireFollowerTokenStrict, type FollowerTokenVars } from './middleware/follower-token';
import { followerTokensApp } from './routes/follower-tokens';
import { mediaTicketsApp } from './routes/media-tickets';
import { nodeEventsApp } from './routes/node-events';
import { registryProofApp } from './routes/registry-proof';
import { publicRegistryEndpointsApp } from './routes/public-registry-endpoints';
import { ownerProxyHandler } from './routes/owner-proxy';
import { nodeMovedHeaderMiddleware } from './middleware/node-moved-header';
import { interactionsApp } from './routes/interactions';
import { dmApp } from './routes/dm';
import { groupsApp } from './routes/groups';
import { friendRequestsApp } from './routes/friend-requests';
import { internalBlacklistSyncApp } from './routes/internal-blacklist-sync';
import { lookupAssistApp } from './routes/lookup-assist';
import { usersFriendsApp } from './routes/users-friends';
import { publicReadsApp } from './routes/public-reads';
import {
  resolveFollowerTokenMode,
  type FollowerTokenMode,
} from './lib/followerTokenModeCache';
import { resolveCorsAllowMethods, isInternalIngressPath } from './lib/corsPolicy';
import { resolveTokenMode } from './middleware/read-cache';

// ---------------------------------------------------------------------------
// CORS（依赖 FOLLOWER_TOKEN_MODE；与读缓存策略正交）
// ---------------------------------------------------------------------------

function applyCorsHeaders(
  headers: Headers,
  mode: FollowerTokenMode,
  env: Env,
  origin: string | undefined,
  pathname: string,
): void {
  const allowedOrigin = env.WORKER_A_ORIGIN?.trim();
  // protected 档允许 Authorization 头，只放行站主 Web Origin，不能使用 `*`。
  if (isProtectedFollowerTokenMode(mode)) {
    if (origin && origin === allowedOrigin) {
      headers.set('Access-Control-Allow-Origin', origin);
      headers.set('Vary', 'Origin');
    }
  } else if (!isInternalIngressPath(pathname)) {
    headers.set('Access-Control-Allow-Origin', '*');
  }
  const allowMethods = resolveCorsAllowMethods(pathname);
  if (allowMethods) {
    headers.set('Access-Control-Allow-Methods', allowMethods);
    headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    headers.set('Access-Control-Max-Age', '86400');
  }
}

const workerBCors: MiddlewareHandler<{ Bindings: Env; Variables: WorkerBVariables }> = async (c, next) => {
  const origin = c.req.header('Origin');
  const mode = resolveTokenMode(c);
  const pathname = new URL(c.req.url).pathname;
  if (c.req.method === 'OPTIONS') {
    if (isInternalIngressPath(pathname)) {
      return new Response(null, { status: 403 });
    }
    if (isProtectedFollowerTokenMode(mode) && origin && origin !== c.env.WORKER_A_ORIGIN?.trim()) {
      return new Response(null, { status: 403 });
    }
    const headers = new Headers();
    applyCorsHeaders(headers, mode, c.env, origin, pathname);
    return new Response(null, { status: 204, headers });
  }
  await next();
  applyCorsHeaders(c.res.headers, mode, c.env, origin, pathname);
};

/** M13-1：isolate TTL 缓存读 follower_token_mode；/health 仅用 env 不读 KV */
const loadFollowerTokenMode: MiddlewareHandler<{ Bindings: Env; Variables: WorkerBVariables }> = async (c, next) => {
  const skipKv = c.req.path === '/health';
  const resolved = await resolveFollowerTokenMode(c.env, c.env.STATE_KV, { skipKv });
  if (!resolved.ok) {
    return c.json(
      { ok: false, error_code: resolved.error_code, message: resolved.message },
      503,
    );
  }
  c.set('followerTokenMode', resolved.mode);
  await next();
};

const app = new Hono<{ Bindings: Env; Variables: WorkerBVariables & FollowerTokenVars }>();

app.use('*', loadFollowerTokenMode);
app.use('*', workerBCors);

// ── 健康探活（公开，供注册中心 Cron 使用） ───────────────────────────────
app.use('/health', nodeMovedHeaderMiddleware);
app.get('/health', (c) => {
  return c.json({ ok: true, service: 'worker-b', version: '0.1.0' });
});

app.route('/.well-known', registryProofApp);
app.route('/api/follower-tokens', followerTokensApp);
// SEC-AUDIT-2026-10-6a：媒体票据签发（MEDIA-TICKET-1）；默认关闭，public-read 档行为不变
app.route('/api/media/tickets', mediaTicketsApp);
app.route('/api/node/events', nodeEventsApp);
app.route('/api/public', publicRegistryEndpointsApp);

// ── M8-11：站主写层代理（@deprecated since M9-23；默认 disabled，仅 OWNER_PROXY_MODE=compat）──
app.all('/auth/*', ownerProxyHandler);
app.all('/api/local/*', ownerProxyHandler);
app.all('/api/lookup/*', ownerProxyHandler);
app.all('/api/follows', ownerProxyHandler);
app.all('/api/follows/*', ownerProxyHandler);
app.all('/api/blacklist', ownerProxyHandler);
app.all('/api/blacklist/*', ownerProxyHandler);
app.all('/api/posts', ownerProxyHandler);
app.all('/api/posts/*', ownerProxyHandler);
app.all('/api/images', ownerProxyHandler);
app.all('/api/images/*', ownerProxyHandler);
app.all('/api/messaging/media', ownerProxyHandler);
app.all('/api/messaging/media/*', ownerProxyHandler);
app.all('/api/node-settings', ownerProxyHandler);
app.all('/api/node-settings/*', ownerProxyHandler);
// M17-1f：站主加好友写层（compat owner-proxy；细粒度仍由 isAllowedOwnerPath 校验）
app.all('/api/friend-requests', ownerProxyHandler);
app.all('/api/friend-requests/*', ownerProxyHandler);

app.route('/lookup-assist', lookupAssistApp);

// M17-4-2a：互粉投影（挂在 /users，须在 publicReads 的 /users/:handle 之前更具体路径亦可并存）
app.route('/users', usersFriendsApp);

// NCF-2E：公开读（users / posts / feed / img）——须在 owner-proxy 之后挂载
app.route('/', publicReadsApp);

app.use('/interactions/*', requireFollowerTokenStrict());
app.route('/interactions', interactionsApp);
app.route('/dm', dmApp);
app.route('/groups', groupsApp);
app.route('/friend-requests', friendRequestsApp);
// NCF-2E-PRE：/internal 只挂一次
app.route('/internal', internalBlacklistSyncApp);

export default app;
