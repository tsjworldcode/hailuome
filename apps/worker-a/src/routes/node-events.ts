/**
 * M7-30f-4：Worker A 入站节点事件（仅 Service Binding + HMAC）。
 * 公开入口在 Worker B `POST /api/node/events`。
 */

import { Hono } from 'hono';
import { verifyRequest } from '@hailuo/shared-crypto';
import type { Env, AppVariables } from '../env';
import {
  applyNodeUrlChangedToFollows,
  parseNodeUrlChangedBody,
} from '../lib/nodeUrlChangedInbound';

type AppEnv = { Bindings: Env; Variables: AppVariables };

export const nodeEventsApp = new Hono<AppEnv>();

nodeEventsApp.use('/', async (c, next) => {
  const configured = c.env.INTERNAL_FORWARD_SECRET;
  const marker = c.req.header('X-Internal-Forward') ?? '';
  const timestamp = c.req.header('X-Timestamp') ?? '';
  const nonce = c.req.header('X-Nonce') ?? '';
  const signature = c.req.header('X-Signature') ?? '';
  if (!configured) {
    console.error('[node-events] INTERNAL_FORWARD_SECRET 未配置');
    return c.json(
      { ok: false, error_code: 'INTERNAL_FORWARD_REJECTED', message: '内部转发头验证失败' },
      401,
    );
  }
  if (marker !== 'hmac-v2' || !timestamp || !nonce || !signature) {
    return c.json(
      { ok: false, error_code: 'INTERNAL_FORWARD_REJECTED', message: '内部转发头验证失败' },
      401,
    );
  }
  const rawBody = await c.req.text();
  const ok = await verifyRequest(
    { method: 'POST', path: '/api/node/events' },
    rawBody,
    { timestamp, nonce, signature },
    configured,
  );
  if (!ok) {
    return c.json(
      { ok: false, error_code: 'INTERNAL_FORWARD_REJECTED', message: '内部转发头验证失败' },
      401,
    );
  }
  c.set('internalForwardBody', rawBody);
  await next();
});

nodeEventsApp.post('/', async (c) => {
  let parsed: unknown;
  try {
    const rawBody = c.get('internalForwardBody') as string | undefined;
    parsed = JSON.parse(rawBody ?? '{}') as unknown;
  } catch {
    return c.json(
      { ok: false, error_code: 'INVALID_BODY', message: '请求体须为有效 JSON' },
      400,
    );
  }

  const event = parseNodeUrlChangedBody(parsed);
  if (!event) {
    return c.json(
      {
        ok: false,
        error_code: 'EVENT_UNSUPPORTED',
        message: '仅支持 type=node_url_changed',
      },
      400,
    );
  }

  try {
    const result = await applyNodeUrlChangedToFollows(c.env, event);
    if (!result.ok) {
      const code = result.error_code ?? 'EVENT_VERIFY_FAILED';
      const status =
        code === 'EVENT_RATE_LIMITED'
          ? 429
          : code === 'EVENT_REPLAY' || code === 'EVENT_URL_BLOCKED'
            ? 400
            : 400;
      const messages: Record<string, string> = {
        EVENT_VERIFY_FAILED: '事件验签失败或已过期',
        EVENT_REPLAY: '事件 nonce 已使用，拒绝重放',
        EVENT_URL_BLOCKED: '事件 URL 未通过安全校验',
        EVENT_RATE_LIMITED: '节点事件请求过于频繁，请稍后再试',
      };
      return c.json(
        {
          ok: false,
          error_code: code,
          message: messages[code] ?? '事件处理失败',
        },
        status,
      );
    }
    return c.json({
      ok: true,
      data: { applied: result.applied, matched: result.matched },
    });
  } catch (err) {
    console.error('[node-events] 处理失败', err);
    return c.json(
      { ok: false, error_code: 'INTERNAL_ERROR', message: '处理节点事件失败' },
      500,
    );
  }
});
