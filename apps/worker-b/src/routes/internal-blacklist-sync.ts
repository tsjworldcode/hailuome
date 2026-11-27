/**
 * M9-13：Worker B 内部黑名单 STATE_KV 即时同步（Worker A Service Binding 调用）。
 *
 * ALL-AUDIT-Y-16-4：入站读取 W3C `traceparent`（A 侧注入），挂 WorkerBInternalSync span；
 * HMAC 不签此头，契约不变。属性不含 node_url（防身份关联）。
 */
import { Hono } from 'hono';
import { verifyRequest } from '@hailuo/shared-crypto';
import { blacklistLocalKey } from '@hailuo/shared-utils';
import {
  withSpan,
  SpanName,
  writeCounter,
  parseTraceparent,
  readTraceparent,
} from '@hailuo/otel';
import type { Env } from '../env.d';

export const internalBlacklistSyncApp = new Hono<{ Bindings: Env }>();

interface BlacklistSyncBody {
  action?: unknown;
  node_url?: unknown;
  reason?: unknown;
  created_at?: unknown;
}

// POST /internal/blacklist-sync — 单条 put/delete，失败不清 Worker A dirty（由 A 侧补偿）
internalBlacklistSyncApp.post('/blacklist-sync', (c) =>
  withSpan(c, SpanName.WorkerBInternalSync, async (span) => {
  span.setAttribute('http.method', 'POST');
  span.setAttribute('http.route', '/internal/blacklist-sync');

  // 对齐 A 侧注入的 traceparent（仅记 trace-id 前 8 位作关联，不整串回显到业务响应）
  const tp = readTraceparent(c.req.raw.headers);
  const parsed = tp ? parseTraceparent(tp) : null;
  if (parsed) {
    span.setAttribute('trace.trace_id_prefix', parsed.traceId.slice(0, 8));
    span.setAttribute('trace.has_parent', true);
  } else {
    span.setAttribute('trace.has_parent', false);
  }

  const configured = c.env.INTERNAL_FORWARD_SECRET;
  if (!configured) {
    return c.json(
      { ok: false, error_code: 'INTERNAL_FORWARD_SECRET_MISSING', message: '内部同步服务暂不可用' },
      503,
    );
  }
  const marker = c.req.header('X-Internal-Forward') ?? '';
  const timestamp = c.req.header('X-Timestamp') ?? '';
  const nonce = c.req.header('X-Nonce') ?? '';
  const signature = c.req.header('X-Signature') ?? '';
  if (marker !== 'hmac-v2' || !timestamp || !nonce || !signature) {
    return c.json({ ok: false, error_code: 'INTERNAL_FORWARD_REJECTED', message: '内部转发头验证失败' }, 401);
  }
  const rawBody = await c.req.text();
  const ok = await verifyRequest(
    { method: 'POST', path: '/internal/blacklist-sync' },
    rawBody,
    { timestamp, nonce, signature },
    configured,
  );
  if (!ok) {
    return c.json({ ok: false, error_code: 'INTERNAL_FORWARD_REJECTED', message: '内部转发头验证失败' }, 401);
  }

  let body: BlacklistSyncBody;
  try {
    body = JSON.parse(rawBody) as BlacklistSyncBody;
  } catch {
    return c.json({ ok: false, error_code: 'INVALID_BODY', message: '请求体必须为 JSON' }, 400);
  }

  const action = typeof body.action === 'string' ? body.action : '';
  const nodeUrl = typeof body.node_url === 'string' ? body.node_url.trim() : '';
  if (!nodeUrl.startsWith('https://')) {
    return c.json({ ok: false, error_code: 'NODE_URL_INVALID', message: 'node_url 必须以 https:// 开头' }, 400);
  }

  // action 枚举可进 attribute（put|delete），不含 URL
  if (action === 'put' || action === 'delete') {
    span.setAttribute('blacklist.sync.action', action);
  }

  try {
    if (action === 'put') {
      const reason = typeof body.reason === 'string' ? body.reason : '';
      const createdAt = typeof body.created_at === 'string' ? body.created_at : new Date().toISOString();
      await c.env.STATE_KV.put(
        blacklistLocalKey(nodeUrl),
        JSON.stringify({ reason, created_at: createdAt }),
      );
    } else if (action === 'delete') {
      await c.env.STATE_KV.delete(blacklistLocalKey(nodeUrl));
    } else {
      return c.json({ ok: false, error_code: 'INVALID_BODY', message: 'action 必须为 put 或 delete' }, 400);
    }
  } catch (err) {
    console.error('[internal/blacklist-sync] STATE_KV 写入失败', err);
    writeCounter(c.env, 'worker_b.internal_sync', { route: 'blacklist-sync', ok: '0' });
    return c.json({ ok: false, error_code: 'BLACKLIST_SYNC_FAILED', message: '黑名单 KV 同步失败' }, 500);
  }

  writeCounter(c.env, 'worker_b.internal_sync', { route: 'blacklist-sync', ok: '1' });
  return c.json({ ok: true, data: { synced: true } });
  }),
);
