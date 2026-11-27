/**
 * M17-4-2a：内部互粉投影（仅 Service Binding + HMAC）。
 * Worker B `GET /users/:handle/friends` 转发至此。
 */
import { Hono } from 'hono';
import { verifyRequest } from '@hailuo/shared-crypto';
import type { Env, AppVariables } from '../env';
import {
  clampMutualFriendsLimit,
  listAcceptedMutualPeers,
  MUTUAL_FRIENDS_PROJECTION_MAX,
  readLocalOwnerHandle,
  toFriendsProjection,
} from '../lib/mutualFriendsProjection';

type AppEnv = { Bindings: Env; Variables: AppVariables };

export const internalFriendsProjectionApp = new Hono<AppEnv>();

async function verifyInternalGet(
  c: {
    env: Env;
    req: { header: (name: string) => string | undefined };
  },
  path: string,
): Promise<boolean> {
  const configured = c.env.INTERNAL_FORWARD_SECRET;
  if (!configured) return false;
  const marker = c.req.header('X-Internal-Forward') ?? '';
  const timestamp = c.req.header('X-Timestamp') ?? '';
  const nonce = c.req.header('X-Nonce') ?? '';
  const signature = c.req.header('X-Signature') ?? '';
  if (marker !== 'hmac-v2' || !timestamp || !nonce || !signature) return false;
  return verifyRequest(
    { method: 'GET', path },
    '',
    { timestamp, nonce, signature },
    configured,
  );
}

// GET /internal/users/:handle/friends
internalFriendsProjectionApp.get('/users/:handle/friends', async (c) => {
  const handleParam = (c.req.param('handle') ?? '').trim().toLowerCase();
  const path = new URL(c.req.url).pathname;
  if (!(await verifyInternalGet(c, path))) {
    return c.json(
      { ok: false, error_code: 'INTERNAL_FORWARD_REJECTED', message: '内部转发头验证失败' },
      401,
    );
  }

  if (!handleParam) {
    return c.json(
      { ok: false, error_code: 'USER_NOT_FOUND', message: '用户不存在' },
      404,
    );
  }

  const ownerHandle = await readLocalOwnerHandle(c.env);
  if (!ownerHandle || ownerHandle !== handleParam) {
    return c.json(
      { ok: false, error_code: 'USER_NOT_FOUND', message: '用户不存在' },
      404,
    );
  }

  // limit：优先内部头（B 侧 HMAC 不签 query），其次 query
  const limitHeader = c.req.header('X-Hailuo-Friends-Limit') ?? '';
  const limitQuery = c.req.query('limit') ?? '';
  const limit = clampMutualFriendsLimit(limitHeader || limitQuery || MUTUAL_FRIENDS_PROJECTION_MAX);

  try {
    const peers = await listAcceptedMutualPeers(c.env, { limit });
    const items = toFriendsProjection(peers);
    return c.json({
      ok: true,
      data: {
        handle: ownerHandle,
        items,
        limit,
      },
    });
  } catch (err) {
    console.error('[internal/friends-projection] 查询失败', err);
    return c.json(
      { ok: false, error_code: 'INTERNAL_ERROR', message: '互粉投影暂不可用，请稍后重试' },
      500,
    );
  }
});
