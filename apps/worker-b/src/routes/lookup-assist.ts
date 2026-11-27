/**
 * M-OPT-8b/8c：公开查找协助入口。
 * GET /lookup-assist/:handle[?fof=1] → Service Binding 转发 Worker A。
 */
import { Hono } from 'hono';
import { signRequest } from '@hailuo/shared-crypto';
import type { Env } from '../env.d';
import { assertWorkerABinding } from '../lib/publicIngress';
import { passthroughResponse } from '../lib/passthroughResponse';

export const lookupAssistApp = new Hono<{ Bindings: Env }>();

lookupAssistApp.get('/:handle', async (c) => {
  const bindingErr = assertWorkerABinding(c.env);
  if (bindingErr) return bindingErr;

  const handle = c.req.param('handle');
  const fofRaw = (c.req.query('fof') ?? '').trim().toLowerCase();
  const wantFof = fofRaw === '1' || fofRaw === 'true';
  // HMAC 只签 pathname；fof 用内部头传递，避免 query 进签名串
  const upstreamPath = `/internal/lookup-assist/${encodeURIComponent(handle)}`;
  const signed = await signRequest(
    { method: 'GET', path: upstreamPath },
    '',
    c.env.INTERNAL_FORWARD_SECRET!,
  );

  const headers: Record<string, string> = {
    Accept: 'application/json',
    'X-Internal-Forward': 'hmac-v2',
    'X-Timestamp': signed['X-Timestamp'],
    'X-Nonce': signed['X-Nonce'],
    'X-Signature': signed['X-Signature'],
  };
  if (wantFof) {
    headers['X-Hailuo-Assist-Mode'] = 'fof';
  }

  let upstream: Response;
  try {
    upstream = await c.env.WORKER_A!.fetch(
      new Request(`https://worker-a.internal${upstreamPath}`, {
        method: 'GET',
        headers,
      }),
    );
  } catch (err) {
    console.warn('[lookup-assist] Service Binding 失败', err);
    return c.json(
      { ok: false, error_code: 'LOOKUP_ASSIST_UPSTREAM', message: '查找协助上游不可用' },
      503,
    );
  }

  // 中文注释：passthroughResponse 为 async，须 await 后再改响应头
  const out = await passthroughResponse(upstream);
  out.headers.set('Cache-Control', 'private, no-store');
  return out;
});
