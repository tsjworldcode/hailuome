import type { DmEnvelope, DmSendTicket, MessagingMediaSigned } from '@hailuo/shared-types';
import { parseMessagingMediaSigned } from './dmMediaFetchTicket';

const DM_ID_RE = /^(conv|dm)_[a-zA-Z0-9_-]{8,128}$/;
const HEX_32_RE = /^[0-9a-f]{64}$/i;
const HEX_16_32_RE = /^[0-9a-f]{32,64}$/i;
const BASE64_RE = /^[A-Za-z0-9+/=_-]{1,65536}$/;

function isNonEmptyString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength;
}

function normalizeUrl(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

export function parseDmSendTicket(raw: unknown): DmSendTicket | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  if (
    !isNonEmptyString(obj.sender_handle, 64) ||
    !isNonEmptyString(obj.recipient_handle, 64) ||
    !isNonEmptyString(obj.recipient_worker_b_url, 2048) ||
    typeof obj.exp !== 'number' ||
    !Number.isFinite(obj.exp) ||
    !isNonEmptyString(obj.nonce, 128) ||
    !isNonEmptyString(obj.sig, 256)
  ) {
    return null;
  }
  return {
    sender_handle: obj.sender_handle.trim().toLowerCase(),
    recipient_handle: obj.recipient_handle.trim().toLowerCase(),
    recipient_worker_b_url: normalizeUrl(obj.recipient_worker_b_url),
    exp: Math.floor(obj.exp),
    nonce: obj.nonce.trim(),
    sig: obj.sig.trim(),
  };
}

export function parseDmEnvelope(raw: unknown): DmEnvelope | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const ticket = parseDmSendTicket(obj.send_ticket);
  if (!ticket) return null;
  if (
    obj.v !== 1 ||
    obj.aad_version !== 1 ||
    !isNonEmptyString(obj.conversation_id, 140) ||
    !DM_ID_RE.test(obj.conversation_id) ||
    !isNonEmptyString(obj.message_id, 140) ||
    !DM_ID_RE.test(obj.message_id) ||
    !isNonEmptyString(obj.sender_handle, 64) ||
    !isNonEmptyString(obj.sender_worker_b_url, 2048) ||
    !isNonEmptyString(obj.recipient_handle, 64) ||
    !isNonEmptyString(obj.created_at, 64) ||
    !isNonEmptyString(obj.nonce, 128) ||
    !HEX_16_32_RE.test(obj.nonce) ||
    typeof obj.key_epoch !== 'number' ||
    !Number.isInteger(obj.key_epoch) ||
    obj.key_epoch < 1 ||
    !isNonEmptyString(obj.ephemeral_pubkey, 64) ||
    !HEX_32_RE.test(obj.ephemeral_pubkey) ||
    !isNonEmptyString(obj.ciphertext, 65536) ||
    !BASE64_RE.test(obj.ciphertext) ||
    !isNonEmptyString(obj.sig, 256)
  ) {
    return null;
  }
  let media: MessagingMediaSigned | undefined;
  if (obj.media !== undefined && obj.media !== null) {
    const parsedMedia = parseMessagingMediaSigned(obj.media);
    if (!parsedMedia) return null;
    media = parsedMedia;
  }
  return {
    v: 1,
    conversation_id: obj.conversation_id.trim(),
    message_id: obj.message_id.trim(),
    sender_handle: obj.sender_handle.trim().toLowerCase(),
    sender_worker_b_url: normalizeUrl(obj.sender_worker_b_url),
    recipient_handle: obj.recipient_handle.trim().toLowerCase(),
    created_at: obj.created_at.trim(),
    nonce: obj.nonce.trim(),
    key_epoch: obj.key_epoch,
    ephemeral_pubkey: obj.ephemeral_pubkey.trim(),
    ciphertext: obj.ciphertext.trim(),
    aad_version: 1,
    send_ticket: ticket,
    media,
    sig: obj.sig.trim(),
  };
}

/** 浏览器签名前解析（不要求 sig 字段）。 */
export function parseDmEnvelopeUnsigned(raw: unknown): Omit<DmEnvelope, 'sig'> | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const ticket = parseDmSendTicket(obj.send_ticket);
  if (!ticket) return null;
  if (
    obj.v !== 1 ||
    obj.aad_version !== 1 ||
    !isNonEmptyString(obj.conversation_id, 140) ||
    !DM_ID_RE.test(obj.conversation_id) ||
    !isNonEmptyString(obj.message_id, 140) ||
    !DM_ID_RE.test(obj.message_id) ||
    !isNonEmptyString(obj.sender_handle, 64) ||
    !isNonEmptyString(obj.sender_worker_b_url, 2048) ||
    !isNonEmptyString(obj.recipient_handle, 64) ||
    !isNonEmptyString(obj.created_at, 64) ||
    !isNonEmptyString(obj.nonce, 128) ||
    !HEX_16_32_RE.test(obj.nonce) ||
    typeof obj.key_epoch !== 'number' ||
    !Number.isInteger(obj.key_epoch) ||
    obj.key_epoch < 1 ||
    !isNonEmptyString(obj.ephemeral_pubkey, 64) ||
    !HEX_32_RE.test(obj.ephemeral_pubkey) ||
    !isNonEmptyString(obj.ciphertext, 65536) ||
    !BASE64_RE.test(obj.ciphertext)
  ) {
    return null;
  }
  let media: MessagingMediaSigned | undefined;
  if (obj.media !== undefined && obj.media !== null) {
    const parsedMedia = parseMessagingMediaSigned(obj.media);
    if (!parsedMedia) return null;
    media = parsedMedia;
  }
  return {
    v: 1,
    conversation_id: obj.conversation_id.trim(),
    message_id: obj.message_id.trim(),
    sender_handle: obj.sender_handle.trim().toLowerCase(),
    sender_worker_b_url: normalizeUrl(obj.sender_worker_b_url),
    recipient_handle: obj.recipient_handle.trim().toLowerCase(),
    created_at: obj.created_at.trim(),
    nonce: obj.nonce.trim(),
    key_epoch: obj.key_epoch,
    ephemeral_pubkey: obj.ephemeral_pubkey.trim(),
    ciphertext: obj.ciphertext.trim(),
    aad_version: 1,
    send_ticket: ticket,
    media,
  };
}

export function normalizeDmPeerUrl(value: string): string {
  return normalizeUrl(value);
}

