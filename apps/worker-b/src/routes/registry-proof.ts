/**
 * Worker B registry proof 路由：注册 proof 优先，换域 proof 次之（M7-30a）。
 * M7-30f-2：`/hailuo-node-moved` 宽限期内返回签名迁址 JSON。
 */
import { Hono } from 'hono';
import type { Env } from '../env.d';
import {
  REGISTRY_PROOF_KV_KEY,
  REGISTRY_URL_CHANGE_PROOF_KV_KEY,
} from '@hailuo/shared-types';
import { readActiveNodeUrlMoved } from '../lib/nodeUrlMoved';

export const registryProofApp = new Hono<{ Bindings: Env }>();

registryProofApp.get('/hailuo-registry-proof', async (c) => {
  try {
    const registerBody = await c.env.STATE_KV.get(REGISTRY_PROOF_KV_KEY);
    if (registerBody) {
      return c.text(registerBody, 200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
      });
    }

    const urlChangeBody = await c.env.STATE_KV.get(REGISTRY_URL_CHANGE_PROOF_KV_KEY);
    if (!urlChangeBody) {
      return c.text('proof not ready', 404);
    }
    return c.text(urlChangeBody, 200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
    });
  } catch (err) {
    console.error('[/.well-known/hailuo-registry-proof] STATE_KV read failed', err);
    return c.text('internal error', 500);
  }
});

/** M7-30f-2 / M7-30h-6：旧址迁址声明；?old_url= 按链式 entry 查询 */
registryProofApp.get('/hailuo-node-moved', async (c) => {
  try {
    const oldUrlParam = (c.req.query('old_url') ?? '').trim();
    const requestOrigin = new URL(c.req.url).origin;
    const declaration = await readActiveNodeUrlMoved(c.env, {
      oldUrl: oldUrlParam || undefined,
      requestOrigin: oldUrlParam ? undefined : requestOrigin,
    });
    if (!declaration) {
      return c.json(
        { ok: false, error_code: 'NODE_MOVED_NOT_FOUND', message: '当前无有效迁址声明' },
        404,
      );
    }
    return c.json(
      { ok: true, data: declaration },
      200,
      { 'Cache-Control': 'no-store' },
    );
  } catch (err) {
    console.error('[/.well-known/hailuo-node-moved] 读取失败', err);
    return c.json(
      { ok: false, error_code: 'INTERNAL_ERROR', message: '读取迁址声明失败' },
      500,
    );
  }
});
