/**
 * NCF-AUDIT-Y-15-2：DM 内部 HMAC ingress（Worker B → A）。
 * 从 routes/dm.ts 原样抽出；契约不变。
 */
import { Hono } from 'hono';
import { verifyRequest } from '@hailuo/shared-crypto';
import { parseDmEnvelope } from '../../lib/dmEnvelope';
import { mirrorDmMediaFromSender } from '../../lib/dmMediaMirror';
import { decodeDmMediaFetchTicketParam } from '../../lib/dmMediaFetchTicket';
import { serveMediaObject } from '../../lib/mediaServe';
import {
  executeServeMessagingMedia,
  type ServeMessagingMediaResult,
} from '../../services/messaging-media';
import {
  executeReceiveDmInbox,
  type ReceiveDmInboxResult,
} from '../../services/dm';
import type { Env, AppVariables } from '../../env';
import {
  type DmContext,
  errorJson,
  readRawJson,
} from './shared';

type AppEnv = { Bindings: Env; Variables: AppVariables };

export const dmInternalApp = new Hono<AppEnv>();

async function requireInternalForward(c: DmContext, next: () => Promise<void>): Promise<Response | void> {
  const configured = c.env.INTERNAL_FORWARD_SECRET;
  const marker = c.req.header('X-Internal-Forward') ?? '';
  const timestamp = c.req.header('X-Timestamp') ?? '';
  const nonce = c.req.header('X-Nonce') ?? '';
  const signature = c.req.header('X-Signature') ?? '';
  if (!configured || marker !== 'hmac-v2' || !timestamp || !nonce || !signature) {
    return errorJson(c, 403, 'INTERNAL_FORWARD_REJECTED', '内部转发头验证失败');
  }

  const rawBody = await c.req.text();
  const url = new URL(c.req.url);
  const ok = await verifyRequest(
    { method: c.req.method.toUpperCase(), path: `${url.pathname}${url.search}` },
    rawBody,
    { timestamp, nonce, signature },
    configured,
  );
  if (!ok) {
    return errorJson(c, 403, 'INTERNAL_FORWARD_REJECTED', '内部转发头验证失败');
  }
  c.set('internalForwardBody', rawBody);
  await next();
}

async function handleInternalInbox(c: DmContext): Promise<Response> {
  // NCF-2D1：HTTP/HMAC 在中间件；编排进 services/dm
  const body = await readRawJson(c);
  const envelope = parseDmEnvelope(body?.envelope);
  if (!envelope) return errorJson(c, 400, 'DM_ENVELOPE_INVALID', '私信 envelope 无效');

  const result = await executeReceiveDmInbox(c.env, { envelope });

  if (result.status === 'ok' && result.flags?.needMediaMirror) {
    c.executionCtx.waitUntil(mirrorDmMediaFromSender(c.env, envelope));
  }

  return receiveDmInboxResultToResponse(c, result);
}

/** NCF-2D1：result → 既有 HTTP JSON */
function receiveDmInboxResultToResponse(c: DmContext, result: ReceiveDmInboxResult): Response {
  if (result.status === 'ok' && result.data) {
    return c.json({ ok: true, data: result.data });
  }
  return errorJson(
    c,
    (result.httpStatus as 400 | 403 | 404 | 409 | 429 | 500 | 503),
    result.error_code ?? 'INTERNAL_ERROR',
    result.message ?? '私信接收失败',
  );
}

dmInternalApp.use('*', requireInternalForward);
dmInternalApp.post('/inbox', handleInternalInbox);

/** MM-3 / NCF-2D3：Worker B GET /dm/media → 内部验 ticket 并返回密文 blob */
dmInternalApp.post('/media/serve', async (c) => {
  const body = await readRawJson(c);
  const storageKey =
    typeof body?.storage_key === 'string' ? body.storage_key.trim() : '';
  const ticketRaw = body?.ticket;
  if (!storageKey || !ticketRaw) {
    return errorJson(c, 400, 'INVALID_BODY', '缺少 storage_key 或 ticket');
  }
  const ticket =
    typeof ticketRaw === 'string'
      ? decodeDmMediaFetchTicketParam(ticketRaw)
      : typeof ticketRaw === 'object'
        ? (ticketRaw as import('@hailuo/shared-types').DmMediaFetchTicket)
        : null;
  if (!ticket) {
    return errorJson(c, 403, 'DM_MEDIA_TICKET_INVALID', 'ticket 无效');
  }

  const result = await executeServeMessagingMedia(c.env, {
    kind: 'dm',
    ticket,
    storageKey,
  });
  return serveMessagingMediaResultToResponse(c, result);
});

/** NCF-2D3：验票 result → JSON 错误或 serveMediaObject */
function serveMessagingMediaResultToResponse(
  c: DmContext,
  result: ServeMessagingMediaResult,
): Response | Promise<Response> {
  if (result.status === 'ok' && result.data?.storage_key) {
    return serveMediaObject(c.env, result.data.storage_key);
  }
  return errorJson(
    c,
    (result.httpStatus as 400 | 403 | 404 | 500),
    result.error_code ?? 'INTERNAL_ERROR',
    result.message ?? '媒体验票失败',
  );
}

