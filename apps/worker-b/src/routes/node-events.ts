/**
 * Worker B 公开节点事件入口（M7-30f-4）。
 *
 * 对端节点 → POST /api/node/events → Service Binding → Worker A 入站验签改 follows。
 */

import { Hono } from 'hono';
import type { Env } from '../env.d';
import {
  forwardRawBodyToWorkerA,
  readRawBodyWithLimit,
} from '../lib/publicIngress';

export const nodeEventsApp = new Hono<{ Bindings: Env }>();

const MAX_NODE_EVENTS_BODY_BYTES = 16 * 1024;

nodeEventsApp.post('/', async (c) => {
  if (!c.env.WORKER_A) {
    return c.json(
      {
        ok: false,
        error_code: 'WORKER_A_BINDING_MISSING',
        message: '事件服务暂不可用，请稍后再试',
      },
      503,
    );
  }
  if (!c.env.INTERNAL_FORWARD_SECRET) {
    return c.json(
      {
        ok: false,
        error_code: 'INTERNAL_FORWARD_SECRET_MISSING',
        message: '事件服务暂不可用，请稍后再试',
      },
      503,
    );
  }

  const bodyRead = await readRawBodyWithLimit(c.req.raw, MAX_NODE_EVENTS_BODY_BYTES);
  if (!bodyRead.ok) {
    return c.json(
      { ok: false, error_code: 'INVALID_BODY', message: '请求体超过大小限制' },
      400,
    );
  }

  try {
    return await forwardRawBodyToWorkerA(c.env, {
      upstreamPath: '/api/node/events',
      method: 'POST',
      rawBody: bodyRead.rawBody,
    });
  } catch (err) {
    console.error('[worker-b/node-events] Service Binding 调用 Worker A 失败', err);
    return c.json(
      { ok: false, error_code: 'UPSTREAM_ERROR', message: '上游服务暂时不可用' },
      502,
    );
  }
});
