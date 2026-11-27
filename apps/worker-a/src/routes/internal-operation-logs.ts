import { Hono, type Context } from 'hono';
import { verifyRequest } from '@hailuo/shared-crypto';
import type { Env, AppVariables } from '../env';
import { writeOperationLog, type OperationLogLevel } from '../lib/operationLog';

type AppEnv = { Bindings: Env; Variables: AppVariables };
type AppContext = Context<AppEnv>;

export const internalOperationLogsApp = new Hono<AppEnv>();

const ALLOWED_SOURCES = new Set(['worker-a', 'worker-b-proxy', 'registry']);
const ALLOWED_LEVELS = new Set(['debug', 'info', 'warn', 'error']);

function errorJson(c: AppContext, status: 400 | 401 | 503, code: string, message: string): Response {
  return c.json({ ok: false, error_code: code, message }, status);
}

// POST /api/internal/operation-logs — Worker B 通过 Service Binding 写入站主可见运行日志。
internalOperationLogsApp.post('/operation-logs', async (c) => {
  const configured = c.env.INTERNAL_FORWARD_SECRET;
  if (!configured) {
    console.error('[internal-operation-logs] INTERNAL_FORWARD_SECRET 未配置，拒绝内部日志写入');
    return errorJson(c, 503, 'INTERNAL_FORWARD_SECRET_MISSING', '内部日志服务暂不可用');
  }

  const timestamp = c.req.header('X-Timestamp') ?? '';
  const nonce = c.req.header('X-Nonce') ?? '';
  const signature = c.req.header('X-Signature') ?? '';
  const marker = c.req.header('X-Internal-Forward') ?? '';
  if (marker !== 'hmac-v2' || !timestamp || !nonce || !signature) {
    return errorJson(c, 401, 'INTERNAL_FORWARD_REJECTED', '内部转发头验证失败');
  }

  const rawBody = await c.req.text();
  const ok = await verifyRequest(
    { method: 'POST', path: '/api/internal/operation-logs' },
    rawBody,
    { timestamp, nonce, signature },
    configured,
  );
  if (!ok) {
    return errorJson(c, 401, 'INTERNAL_FORWARD_REJECTED', '内部转发头验证失败');
  }

  let body: {
    source?: unknown;
    level?: unknown;
    event?: unknown;
    message?: unknown;
    details?: unknown;
  };
  try {
    body = JSON.parse(rawBody) as typeof body;
  } catch {
    return errorJson(c, 400, 'INVALID_BODY', '请求体必须为 JSON');
  }

  const source = typeof body.source === 'string' && ALLOWED_SOURCES.has(body.source)
    ? body.source as 'worker-a' | 'worker-b-proxy' | 'registry'
    : 'worker-b-proxy';
  const level = typeof body.level === 'string' && ALLOWED_LEVELS.has(body.level)
    ? body.level as OperationLogLevel
    : 'info';
  const event = typeof body.event === 'string' ? body.event : 'worker_b_event';
  const message = typeof body.message === 'string' ? body.message : '';
  const details = body.details && typeof body.details === 'object'
    ? body.details as Record<string, unknown>
    : {};

  await writeOperationLog(c.env, { source, level, event, message, details });
  return c.json({ ok: true, data: { written: true } });
});
