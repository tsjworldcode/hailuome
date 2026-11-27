/**
 * MM-3：DM 媒体 fetch ticket 签发与发送方验签。
 * NCF-2D3：发送方 serve 验票迁入 services/messaging-media；本文件保留签发 / 远端拉取 / 兼容壳。
 */
import type { DmEnvelope, DmMediaFetchTicket, MessagingMediaSigned } from '@hailuo/shared-types';
import {
  randomDmNonceHex,
  signDmMediaFetchTicket,
} from '@hailuo/shared-crypto';
import { isMessagingMediaStorageKey } from '@hailuo/shared-utils';
import type { Env } from '../env';
import {
  executeServeMessagingMedia,
  type ServeMessagingMediaResult,
} from '../services/messaging-media';
import { parseDmEnvelope } from './dmEnvelope';
import { messagingDb } from './messagingDb';
import { fetchOutboundPeer } from './fetchOutboundPeer';
import { assertMediaIntegrity, readResponseBodyWithLimit } from './remoteBodyLimit';
import { resolveLocalPublicBaseUrl } from './localPublicBaseUrl';

export const DM_MEDIA_TICKET_TTL_SEC = 300;

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function normalizeWorkerBUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

export function parseMessagingMediaSigned(raw: unknown): MessagingMediaSigned | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (
    typeof o.media_id !== 'string' ||
    typeof o.sender_storage_key !== 'string' ||
    typeof o.sender_worker_b_url !== 'string' ||
    typeof o.size_bytes !== 'number' ||
    typeof o.ciphertext_sha256 !== 'string' ||
    typeof o.alg !== 'string'
  ) {
    return null;
  }
  if (!isMessagingMediaStorageKey(o.sender_storage_key)) return null;
  return {
    media_id: o.media_id.trim(),
    sender_storage_key: o.sender_storage_key.trim(),
    sender_worker_b_url: normalizeWorkerBUrl(o.sender_worker_b_url.trim()),
    size_bytes: Math.floor(o.size_bytes),
    ciphertext_sha256: o.ciphertext_sha256.trim().toLowerCase(),
    alg: o.alg.trim(),
  };
}

export async function loadDmEnvelopeByMessageId(
  env: Env,
  messageId: string,
  direction: 'inbox' | 'outbox',
): Promise<DmEnvelope | null> {
  const row = await messagingDb(env)
    .prepare(
      `SELECT envelope_json FROM dm_messages WHERE message_id = ? AND direction = ? LIMIT 1`,
    )
    .bind(messageId, direction)
    .first<{ envelope_json: string }>();
  if (!row) return null;
  try {
    return parseDmEnvelope(JSON.parse(row.envelope_json));
  } catch {
    return null;
  }
}

export interface IssueDmMediaFetchTicketInput {
  message_id: string;
  media_id: string;
  conversation_id: string;
  sender_storage_key: string;
}

/** 请求方 Worker A：校验 inbox 行后签发 ticket。 */
export async function issueDmMediaFetchTicket(
  env: Env,
  input: IssueDmMediaFetchTicketInput,
): Promise<DmMediaFetchTicket | null> {
  const envelope = await loadDmEnvelopeByMessageId(env, input.message_id, 'inbox');
  if (!envelope) return null;
  if (envelope.conversation_id !== input.conversation_id) return null;
  const media = envelope.media;
  if (!media) return null;
  if (media.media_id !== input.media_id) return null;
  if (media.sender_storage_key !== input.sender_storage_key) return null;

  const unsigned: Omit<DmMediaFetchTicket, 'sig'> = {
    v: 1,
    message_id: envelope.message_id,
    media_id: media.media_id,
    conversation_id: envelope.conversation_id,
    sender_storage_key: media.sender_storage_key,
    sender_worker_b_url: normalizeWorkerBUrl(media.sender_worker_b_url),
    requester_worker_b_url: normalizeWorkerBUrl(await resolveLocalPublicBaseUrl(env)),
    exp: nowSec() + DM_MEDIA_TICKET_TTL_SEC,
    nonce: randomDmNonceHex(),
  };
  const sig = await signDmMediaFetchTicket(unsigned, env.ED25519_PRIVATE_KEY);
  return { ...unsigned, sig };
}

/** NCF-2D3：深模块 result → 既有 {ok} 形 */
function serveResultToLegacy(
  result: ServeMessagingMediaResult,
): { ok: true } | { ok: false; error_code: string; message: string } {
  if (result.status === 'ok') return { ok: true };
  return {
    ok: false,
    error_code: result.error_code ?? 'INTERNAL_ERROR',
    message: result.message ?? '媒体验票失败',
  };
}

/** 发送方 Worker A：委托 NCF-2D3 `executeServeMessagingMedia`。 */
export async function verifyDmMediaFetchTicketOnSender(
  env: Env,
  ticket: DmMediaFetchTicket,
  storageKey: string,
): Promise<{ ok: true } | { ok: false; error_code: string; message: string }> {
  const result = await executeServeMessagingMedia(env, {
    kind: 'dm',
    ticket,
    storageKey,
  });
  return serveResultToLegacy(result);
}

export function encodeDmMediaFetchTicketParam(ticket: DmMediaFetchTicket): string {
  return encodeURIComponent(JSON.stringify(ticket));
}

export function decodeDmMediaFetchTicketParam(raw: string): DmMediaFetchTicket | null {
  try {
    const parsed = JSON.parse(decodeURIComponent(raw)) as DmMediaFetchTicket;
    if (parsed?.v !== 1 || typeof parsed.sig !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

export type FetchRemoteMediaOptions = {
  /** 硬上限（字节）；通常取 messaging media max */
  maxBytes: number;
  expectedSizeBytes?: number;
  expectedSha256Hex?: string;
};

/** 从发送方 Worker B 拉取密文 blob（server-side；R-AUDIT-2 硬上限 + 可选 hash）。 */
export async function fetchDmMediaFromSenderWorkerB(
  env: Env,
  senderWorkerBUrl: string,
  storageKey: string,
  ticket: DmMediaFetchTicket,
  options: FetchRemoteMediaOptions,
): Promise<ArrayBuffer | null> {
  const url = `${normalizeWorkerBUrl(senderWorkerBUrl)}/dm/media/${encodeURIComponent(storageKey)}?ticket=${encodeDmMediaFetchTicketParam(ticket)}`;
  // SEC-AUDIT-2026-10-8：统一出站网关（SSRF 门禁 + redirect:manual + 中性 UA + 超时）。
  // URL 来自外部可控的 media.sender_worker_b_url → 非法时 0 连接；302 不跟随。
  const fetched = await fetchOutboundPeer(env, url, { timeoutMs: 30_000 });
  if (!fetched.ok) {
    console.warn('[dmMediaFetchTicket] outbound blocked', { host: fetched.host, reason: fetched.reason });
    return null;
  }
  try {
    const res = fetched.response;
    if (!res.ok) return null;
    const read = await readResponseBodyWithLimit(res, options.maxBytes);
    if (!read.ok) {
      console.warn('[dmMediaFetchTicket] remote body rejected', read.reason);
      return null;
    }
    const intact = await assertMediaIntegrity(read.bytes, {
      expectedSizeBytes: options.expectedSizeBytes,
      expectedSha256Hex: options.expectedSha256Hex,
    });
    if (!intact) {
      console.warn('[dmMediaFetchTicket] remote body integrity mismatch');
      return null;
    }
    return read.bytes;
  } catch (err) {
    console.error('[dmMediaFetchTicket] fetch sender blob failed', err);
    return null;
  }
}
