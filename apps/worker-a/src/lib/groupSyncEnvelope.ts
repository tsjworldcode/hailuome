import type { GroupSyncRequest } from '@hailuo/shared-types';
import { normalizeGroupMemberUrl } from './groupMemberUrl';

const GROUP_ID_RE = /^grp_[a-zA-Z0-9_-]{8,128}$/;
const GMSG_ID_RE = /^gmsg_[a-zA-Z0-9_-]{8,128}$/;
const HEX_16_32_RE = /^[0-9a-f]{32,64}$/i;

function isNonEmptyString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength;
}

export function parseGroupSyncRequest(raw: unknown): GroupSyncRequest | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;

  let cursor: string | null = null;
  if (obj.cursor === null || obj.cursor === undefined || obj.cursor === '') {
    cursor = null;
  } else if (typeof obj.cursor === 'string' && GMSG_ID_RE.test(obj.cursor.trim())) {
    cursor = obj.cursor.trim();
  } else {
    return null;
  }

  const acksRaw = obj.acks;
  if (!Array.isArray(acksRaw)) return null;
  const acks: string[] = [];
  for (const item of acksRaw) {
    if (typeof item !== 'string' || !GMSG_ID_RE.test(item.trim())) return null;
    acks.push(item.trim());
  }
  if (acks.length > 100) return null;

  const heartbeat = obj.heartbeat === undefined ? undefined : obj.heartbeat === true;

  if (
    obj.v !== 1 ||
    obj.kind !== 'GROUP_SYNC' ||
    !isNonEmptyString(obj.group_id, 140) ||
    !GROUP_ID_RE.test(obj.group_id) ||
    !isNonEmptyString(obj.sender_handle, 64) ||
    !isNonEmptyString(obj.sender_worker_b_url, 2048) ||
    !isNonEmptyString(obj.owner_worker_b_url, 2048) ||
    typeof obj.epoch !== 'number' ||
    !Number.isInteger(obj.epoch) ||
    obj.epoch < 1 ||
    !isNonEmptyString(obj.created_at, 64) ||
    !isNonEmptyString(obj.expires_at, 64) ||
    !isNonEmptyString(obj.nonce, 128) ||
    !HEX_16_32_RE.test(obj.nonce) ||
    !isNonEmptyString(obj.sig, 256)
  ) {
    return null;
  }

  return {
    v: 1,
    kind: 'GROUP_SYNC',
    group_id: obj.group_id.trim(),
    sender_handle: obj.sender_handle.trim().toLowerCase(),
    sender_worker_b_url: normalizeGroupMemberUrl(obj.sender_worker_b_url),
    owner_worker_b_url: normalizeGroupMemberUrl(obj.owner_worker_b_url),
    epoch: obj.epoch,
    created_at: obj.created_at.trim(),
    expires_at: obj.expires_at.trim(),
    nonce: obj.nonce.trim(),
    cursor,
    acks,
    heartbeat,
    sig: obj.sig.trim(),
  };
}

export function isGroupSyncExpired(request: GroupSyncRequest, nowMs = Date.now()): boolean {
  const expiresMs = new Date(request.expires_at).getTime();
  return !Number.isFinite(expiresMs) || expiresMs < nowMs;
}
