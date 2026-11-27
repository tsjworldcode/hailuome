/** MOD-1：签名绑定群、群主、管理员、目标与 epoch，禁止跨用途挪用。 */
import { signMessage, verifyMessage } from './ed25519';

export type GroupModerationKickUnsigned = {
  kind: 'GROUP_MODERATION_KICK';
  group_id: string;
  owner_worker_b_url: string;
  actor_worker_b_url: string;
  target_member_worker_b_url: string;
  expected_epoch: number;
  timestamp: string;
  nonce: string;
};
export type GroupModerationKickEnvelope = GroupModerationKickUnsigned & { sig: string };

function validUrl(raw: unknown): raw is string {
  if (typeof raw !== 'string' || raw.length > 2048 || /[\u0000-\u0020\u007f]/.test(raw) || raw.endsWith('/')) return false;
  try {
    const u = new URL(raw);
    return ['https:', 'http:'].includes(u.protocol) && !u.username && !u.password && !u.search && !u.hash;
  } catch { return false; }
}

export function parseGroupModerationKick(raw: unknown): GroupModerationKickEnvelope | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const e = raw as GroupModerationKickEnvelope;
  if (e.kind !== 'GROUP_MODERATION_KICK' || typeof e.group_id !== 'string' ||
    !/^grp_[a-zA-Z0-9_-]{8,128}$/.test(e.group_id) ||
    !validUrl(e.owner_worker_b_url) || !validUrl(e.actor_worker_b_url) || !validUrl(e.target_member_worker_b_url) ||
    !Number.isSafeInteger(e.expected_epoch) || e.expected_epoch < 1 ||
    typeof e.timestamp !== 'string' || typeof e.nonce !== 'string' || !/^[0-9a-f]{32,64}$/.test(e.nonce) ||
    typeof e.sig !== 'string' || !/^[0-9a-f]{128}$/i.test(e.sig)) return null;
  const time = Date.parse(e.timestamp);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== e.timestamp || Math.abs(Date.now() - time) > 300_000) return null;
  return e;
}

export function buildGroupModerationKickSignatureInput(e: GroupModerationKickUnsigned): string {
  return [e.kind, e.group_id, e.owner_worker_b_url, e.actor_worker_b_url,
    e.target_member_worker_b_url, String(e.expected_epoch), e.timestamp, e.nonce].join('\n');
}
export function signGroupModerationKick(e: GroupModerationKickUnsigned, key: string): Promise<string> {
  return signMessage(buildGroupModerationKickSignatureInput(e), key);
}
export function verifyGroupModerationKick(e: GroupModerationKickEnvelope, key: string): Promise<boolean> {
  return verifyMessage(buildGroupModerationKickSignatureInput(e), e.sig, key);
}
