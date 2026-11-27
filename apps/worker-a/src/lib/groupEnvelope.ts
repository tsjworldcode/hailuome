import type { GroupMessageEnvelope, GroupMessageMedia } from '@hailuo/shared-types';
import { normalizeGroupMemberUrl } from './groupMemberUrl';

const GROUP_ID_RE = /^grp_[a-zA-Z0-9_-]{8,128}$/;
const GMSG_ID_RE = /^gmsg_[a-zA-Z0-9_-]{8,128}$/;
const HEX_16_32_RE = /^[0-9a-f]{32,64}$/i;
const BASE64_RE = /^[A-Za-z0-9+/=_-]{1,65536}$/;

function isNonEmptyString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength;
}

function parseGroupMessageMedia(raw: unknown): GroupMessageMedia | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (
    !isNonEmptyString(o.media_id, 140) ||
    !isNonEmptyString(o.sender_storage_key, 512) ||
    !isNonEmptyString(o.sender_worker_b_url, 2048) ||
    typeof o.size_bytes !== 'number' ||
    !Number.isFinite(o.size_bytes) ||
    o.size_bytes < 0 ||
    !isNonEmptyString(o.ciphertext_sha256, 128) ||
    !/^[0-9a-f]{64}$/i.test(o.ciphertext_sha256.trim()) ||
    !isNonEmptyString(o.alg, 64)
  ) {
    return null;
  }
  return {
    media_id: o.media_id.trim(),
    sender_storage_key: o.sender_storage_key.trim(),
    sender_worker_b_url: normalizeGroupMemberUrl(o.sender_worker_b_url),
    size_bytes: Math.floor(o.size_bytes),
    ciphertext_sha256: o.ciphertext_sha256.trim().toLowerCase(),
    alg: o.alg.trim(),
  };
}

/** 签名前校验（不含 sig 或 sig 占位）。 */
export function parseGroupMessageEnvelopeUnsigned(
  raw: unknown,
): Omit<GroupMessageEnvelope, 'sig'> | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const media = obj.media === undefined ? undefined : parseGroupMessageMedia(obj.media);
  if (obj.media !== undefined && !media) return null;

  if (
    obj.v !== 1 ||
    obj.kind !== 'GROUP_MESSAGE' ||
    !isNonEmptyString(obj.group_id, 140) ||
    !GROUP_ID_RE.test(obj.group_id) ||
    !isNonEmptyString(obj.message_id, 140) ||
    !GMSG_ID_RE.test(obj.message_id) ||
    typeof obj.epoch !== 'number' ||
    !Number.isInteger(obj.epoch) ||
    obj.epoch < 1 ||
    !isNonEmptyString(obj.sender_handle, 64) ||
    !isNonEmptyString(obj.sender_worker_b_url, 2048) ||
    !isNonEmptyString(obj.owner_worker_b_url, 2048) ||
    !isNonEmptyString(obj.created_at, 64) ||
    !isNonEmptyString(obj.expires_at, 64) ||
    !isNonEmptyString(obj.nonce, 128) ||
    !HEX_16_32_RE.test(obj.nonce) ||
    (obj.msg_kind !== 'chat' && obj.msg_kind !== 'system') ||
    !isNonEmptyString(obj.ciphertext, 65536) ||
    !BASE64_RE.test(obj.ciphertext)
  ) {
    return null;
  }

  return {
    v: 1,
    kind: 'GROUP_MESSAGE',
    group_id: obj.group_id.trim(),
    message_id: obj.message_id.trim(),
    epoch: obj.epoch,
    sender_handle: obj.sender_handle.trim().toLowerCase(),
    sender_worker_b_url: normalizeGroupMemberUrl(obj.sender_worker_b_url),
    owner_worker_b_url: normalizeGroupMemberUrl(obj.owner_worker_b_url),
    created_at: obj.created_at.trim(),
    expires_at: obj.expires_at.trim(),
    nonce: obj.nonce.trim(),
    msg_kind: obj.msg_kind,
    ciphertext: obj.ciphertext.trim(),
    ...(media ? { media } : {}),
  };
}

export function parseGroupMessageEnvelope(raw: unknown): GroupMessageEnvelope | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const media = obj.media === undefined ? undefined : parseGroupMessageMedia(obj.media);
  if (obj.media !== undefined && !media) return null;

  if (
    obj.v !== 1 ||
    obj.kind !== 'GROUP_MESSAGE' ||
    !isNonEmptyString(obj.group_id, 140) ||
    !GROUP_ID_RE.test(obj.group_id) ||
    !isNonEmptyString(obj.message_id, 140) ||
    !GMSG_ID_RE.test(obj.message_id) ||
    typeof obj.epoch !== 'number' ||
    !Number.isInteger(obj.epoch) ||
    obj.epoch < 1 ||
    !isNonEmptyString(obj.sender_handle, 64) ||
    !isNonEmptyString(obj.sender_worker_b_url, 2048) ||
    !isNonEmptyString(obj.owner_worker_b_url, 2048) ||
    !isNonEmptyString(obj.created_at, 64) ||
    !isNonEmptyString(obj.expires_at, 64) ||
    !isNonEmptyString(obj.nonce, 128) ||
    !HEX_16_32_RE.test(obj.nonce) ||
    (obj.msg_kind !== 'chat' && obj.msg_kind !== 'system') ||
    !isNonEmptyString(obj.ciphertext, 65536) ||
    !BASE64_RE.test(obj.ciphertext) ||
    !isNonEmptyString(obj.sig, 256)
  ) {
    return null;
  }

  return {
    v: 1,
    kind: 'GROUP_MESSAGE',
    group_id: obj.group_id.trim(),
    message_id: obj.message_id.trim(),
    epoch: obj.epoch,
    sender_handle: obj.sender_handle.trim().toLowerCase(),
    sender_worker_b_url: normalizeGroupMemberUrl(obj.sender_worker_b_url),
    owner_worker_b_url: normalizeGroupMemberUrl(obj.owner_worker_b_url),
    created_at: obj.created_at.trim(),
    expires_at: obj.expires_at.trim(),
    nonce: obj.nonce.trim(),
    msg_kind: obj.msg_kind,
    ciphertext: obj.ciphertext.trim(),
    ...(media ? { media } : {}),
    sig: obj.sig.trim(),
  };
}

export function isGroupMessageExpired(envelope: GroupMessageEnvelope, nowMs = Date.now()): boolean {
  const expiresMs = new Date(envelope.expires_at).getTime();
  return !Number.isFinite(expiresMs) || expiresMs < nowMs;
}
