/**
 * M10-2: Worker B public DM inbox.
 *
 * Worker B only accepts the encrypted envelope and forwards it to Worker A with
 * Service Binding + HMAC. It does not decrypt, store, or write KV/D1.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env } from '../env.d';
import {
  assertWorkerABinding,
  forwardRawBodyToWorkerA,
  ingressErrorJson,
  readRawBodyWithLimit,
} from '../lib/publicIngress';

type AppEnv = { Bindings: Env };
type DmContext = Context<AppEnv>;

const MAX_DM_BODY_BYTES = 64 * 1024;

export const dmApp = new Hono<AppEnv>();

function errorJson(c: DmContext, status: 400 | 403 | 413 | 503, code: string, message: string): Response {
  return c.json({ ok: false, error_code: code, message }, status);
}

function looksLikeDmEnvelope(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object') return false;
  const e = raw as Record<string, unknown>;
  const ticket = e.send_ticket as Record<string, unknown> | undefined;
  return (
    e.v === 1 &&
    e.aad_version === 1 &&
    typeof e.conversation_id === 'string' &&
    typeof e.message_id === 'string' &&
    typeof e.sender_handle === 'string' &&
    typeof e.sender_worker_b_url === 'string' &&
    typeof e.recipient_handle === 'string' &&
    typeof e.created_at === 'string' &&
    typeof e.nonce === 'string' &&
    typeof e.key_epoch === 'number' &&
    typeof e.ephemeral_pubkey === 'string' &&
    typeof e.ciphertext === 'string' &&
    typeof e.sig === 'string' &&
    !!ticket &&
    typeof ticket.sender_handle === 'string' &&
    typeof ticket.recipient_handle === 'string' &&
    typeof ticket.recipient_worker_b_url === 'string' &&
    typeof ticket.exp === 'number' &&
    typeof ticket.nonce === 'string' &&
    typeof ticket.sig === 'string'
  );
}

dmApp.post('/inbox', async (c) => {
  const bindingErr = assertWorkerABinding(c.env);
  if (bindingErr) {
    return errorJson(c, 503, 'WORKER_A_BINDING_MISSING', '私信服务暂不可用，请稍后再试');
  }

  const bodyRead = await readRawBodyWithLimit(c.req.raw, MAX_DM_BODY_BYTES);
  if (!bodyRead.ok) {
    return errorJson(c, 413, 'DM_ENVELOPE_TOO_LARGE', '私信 envelope 超过大小限制');
  }
  const rawBody = bodyRead.rawBody;

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    return errorJson(c, 400, 'INVALID_BODY', '请求体必须为 JSON');
  }
  if (!looksLikeDmEnvelope(parsed.envelope)) {
    return errorJson(c, 400, 'DM_ENVELOPE_INVALID', '私信 envelope 无效');
  }

  return forwardRawBodyToWorkerA(c.env, {
    upstreamPath: '/dm/inbox',
    method: 'POST',
    rawBody,
  });
});

/** MM-3：持 DM_MEDIA_FETCH_TICKET_V1 拉取密文 blob（HMAC 转发 Worker A 验签） */
dmApp.get('/media/:storage_key', async (c) => {
  const bindingErr = assertWorkerABinding(c.env);
  if (bindingErr) {
    return errorJson(c, 503, 'WORKER_A_BINDING_MISSING', '媒体服务暂不可用，请稍后再试');
  }

  const ticketRaw = c.req.query('ticket');
  if (!ticketRaw) {
    return errorJson(c, 403, 'DM_MEDIA_TICKET_INVALID', '缺少 ticket');
  }

  let ticket: unknown;
  try {
    ticket = JSON.parse(decodeURIComponent(ticketRaw));
  } catch {
    return errorJson(c, 403, 'DM_MEDIA_TICKET_INVALID', 'ticket 无效');
  }
  const exp = (ticket as { exp?: number }).exp;
  if (typeof exp !== 'number' || exp < Math.floor(Date.now() / 1000)) {
    return errorJson(c, 403, 'DM_MEDIA_TICKET_INVALID', 'ticket 已过期');
  }

  const storageKey = decodeURIComponent(c.req.param('storage_key'));
  const rawBody = JSON.stringify({ storage_key: storageKey, ticket });

  return forwardRawBodyToWorkerA(c.env, {
    upstreamPath: '/dm/media/serve',
    method: 'POST',
    rawBody,
  });
});
