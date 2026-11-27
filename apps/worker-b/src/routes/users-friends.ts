/**
 * M17-4-2a：公开互粉投影入口。
 * GET /users/:handle/friends?limit=20
 * → 读保护与 posts 同档（requireFollowerToken）
 * → Service Binding + HMAC 转发 Worker A `/internal/users/:handle/friends`
 */
import { Hono } from 'hono';
import { signRequest } from '@hailuo/shared-crypto';
import type { Env, WorkerBVariables } from '../env.d';
import { assertWorkerABinding } from '../lib/publicIngress';
import { passthroughResponse } from '../lib/passthroughResponse';
import { requireFollowerToken, type FollowerTokenVars } from '../middleware/follower-token';

type AppEnv = { Bindings: Env; Variables: WorkerBVariables & FollowerTokenVars };

export const usersFriendsApp = new Hono<AppEnv>();

/** 与 Worker A MUTUAL_FRIENDS_PROJECTION_MAX 对齐 */
const FRIENDS_LIMIT_MAX = 20;

function clampLimit(raw: string | undefined): number {
  const n = Number.parseInt((raw ?? '').trim(), 10);
  if (!Number.isFinite(n) || n < 1) return FRIENDS_LIMIT_MAX;
  return Math.min(n, FRIENDS_LIMIT_MAX);
}

usersFriendsApp.use('/:handle/friends', requireFollowerToken());

usersFriendsApp.get('/:handle/friends', async (c) => {
  const bindingErr = assertWorkerABinding(c.env);
  if (bindingErr) return bindingErr;

  const handle = (c.req.param('handle') ?? '').trim();
  if (!handle) {
    return c.json({ ok: false, error_code: 'USER_NOT_FOUND', message: '用户不存在' }, 404);
  }

  const limit = clampLimit(c.req.query('limit'));
  // HMAC 只签 pathname；limit 走内部头，避免 query 进签名串
  const upstreamPath = `/internal/users/${encodeURIComponent(handle)}/friends`;
  const signed = await signRequest(
    { method: 'GET', path: upstreamPath },
    '',
    c.env.INTERNAL_FORWARD_SECRET!,
  );

  let upstream: Response;
  try {
    upstream = await c.env.WORKER_A!.fetch(
      new Request(`https://worker-a.internal${upstreamPath}`, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          'X-Internal-Forward': 'hmac-v2',
          'X-Timestamp': signed['X-Timestamp'],
          'X-Nonce': signed['X-Nonce'],
          'X-Signature': signed['X-Signature'],
          'X-Hailuo-Friends-Limit': String(limit),
        },
      }),
    );
  } catch (err) {
    console.warn('[users/friends] Service Binding 失败', err);
    return c.json(
      { ok: false, error_code: 'FRIENDS_UPSTREAM', message: '互粉投影上游不可用' },
      503,
    );
  }

  const out = await passthroughResponse(upstream);
  // 与 Token 读帖同纪律：勿进共享缓存
  out.headers.set('Cache-Control', 'private, no-store');
  out.headers.set('Vary', 'Authorization');
  return out;
});
