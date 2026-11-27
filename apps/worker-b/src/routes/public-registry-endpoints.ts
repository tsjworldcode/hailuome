/**
 * GET /api/public/registry-endpoints — 脱敏 registry_endpoints 只读（M9-3-5）。
 *
 * 读共享 STATE_KV `node:registry_endpoints`；Worker A Cron 同步写入。
 */

import { Hono } from 'hono';
import { REGISTRY_ENDPOINTS_KV_KEY } from '@hailuo/shared-types';
import { parsePublicRegistryEndpointsKv } from '@hailuo/shared-utils';
import type { Env } from '../env.d';

export const publicRegistryEndpointsApp = new Hono<{ Bindings: Env }>();

publicRegistryEndpointsApp.get('/registry-endpoints', async (c) => {
  try {
    const raw = await c.env.STATE_KV.get(REGISTRY_ENDPOINTS_KV_KEY);
    const items = parsePublicRegistryEndpointsKv(raw);
    return c.json(
      { ok: true, data: { items } },
      200,
      { 'Cache-Control': 'public, max-age=60' },
    );
  } catch (err) {
    console.error('[api/public/registry-endpoints] STATE_KV read failed', err);
    return c.json(
      { ok: false, error_code: 'INTERNAL_ERROR', message: '读取注册中心列表失败' },
      500,
    );
  }
});
