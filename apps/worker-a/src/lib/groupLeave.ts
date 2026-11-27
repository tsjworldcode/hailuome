/**
 * EPOCH v0.3 + SEC-1：主动退群 — 本机立即 left；权威侧须 `GROUP_MEMBER_LEFT_V1` 验签+nonce 后才 left + system + force 树；**不** epoch++。
 */
import { resolveIdentityDb } from '../db/bindings';
import {
  GROUP_MEMBER_LEFT_KIND,
  randomDmNonceHex,
  signGroupMemberLeft,
  signGroupMessageEnvelope,
  verifyGroupMemberLeft,
  type GroupMemberLeftEnvelope,
} from '@hailuo/shared-crypto';
import {
  assertSafePeerWorkerBUrl,
  isPrivateProofTargetAllowed,
} from '@hailuo/shared-utils';
import type { GroupMessageEnvelope } from '@hailuo/shared-types';
import type { Env } from '../env';
import { acceptGroupMessageOnOwner } from './groupMessage';
import { fetchOutboundPeer } from './fetchOutboundPeer';
import { messagingDb } from './messagingDb';
import { normalizeGroupMemberUrl } from './groupMemberUrl';
import { recomputeAndPersistRelayTree } from './groupRelayTree';

const GROUP_MESSAGE_TTL_MS = 24 * 60 * 60 * 1000;
/** 退群信令时间戳允许偏斜（与 HMAC 窗口同档）。 */
export const MEMBER_LEFT_TIMESTAMP_SKEW_MS = 5 * 60 * 1000;

function nowIso(): string {
  return new Date().toISOString();
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function newGroupMessageId(): string {
  return `gmsg_${bytesToHex(crypto.getRandomValues(new Uint8Array(16)))}`;
}

function utf8PlaintextBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

async function getLocalOwner(env: Env): Promise<{
  handle: string;
  worker_b_url: string;
} | null> {
  return resolveIdentityDb(env)
    .prepare(`SELECT handle, worker_b_url FROM users LIMIT 1`)
    .first<{ handle: string; worker_b_url: string }>();
}

async function consumeGroupNonce(
  env: Env,
  groupId: string,
  nonce: string,
  createdAt: string,
): Promise<boolean> {
  try {
    await messagingDb(env)
      .prepare(`INSERT INTO group_nonces (group_id, nonce, created_at) VALUES (?, ?, ?)`)
      .bind(groupId, nonce, createdAt)
      .run();
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('UNIQUE') || message.includes('constraint')) {
      return false;
    }
    throw err;
  }
}

function isMemberLeftTimestampFresh(timestamp: string, nowMs = Date.now()): boolean {
  const ts = Date.parse(timestamp);
  if (!Number.isFinite(ts)) return false;
  return Math.abs(nowMs - ts) <= MEMBER_LEFT_TIMESTAMP_SKEW_MS;
}

export type ApplyMemberLeftInput = {
  group_id: string;
  member_worker_b_url: string;
  member_handle?: string;
  timestamp: string;
  nonce: string;
  sig: string;
};

/**
 * 群主权威：验签 + nonce 后标 left、system 通知、force 重算树；不换钥。
 */
export async function applyMemberLeftOnOwner(
  env: Env,
  input: ApplyMemberLeftInput,
): Promise<{ ok: true } | { ok: false; error_code: string; message: string; status?: number }> {
  const groupId = input.group_id.trim();
  const memberUrl = normalizeGroupMemberUrl(input.member_worker_b_url);
  const timestamp = typeof input.timestamp === 'string' ? input.timestamp.trim() : '';
  const nonce = typeof input.nonce === 'string' ? input.nonce.trim().toLowerCase() : '';
  const sig = typeof input.sig === 'string' ? input.sig.trim().toLowerCase() : '';

  if (!groupId || !memberUrl || !timestamp || !nonce || !/^[0-9a-f]{32,64}$/i.test(nonce) || !/^[0-9a-f]{128}$/i.test(sig)) {
    return { ok: false, status: 400, error_code: 'GROUP_ENVELOPE_INVALID', message: 'member-left 字段无效' };
  }
  if (!isMemberLeftTimestampFresh(timestamp)) {
    return { ok: false, status: 400, error_code: 'GROUP_ENVELOPE_INVALID', message: '退群信令已过期' };
  }

  const db = messagingDb(env);
  const localOwner = await getLocalOwner(env);
  if (!localOwner?.worker_b_url) {
    return { ok: false, error_code: 'USER_NOT_REGISTERED', message: '节点尚未完成注册' };
  }

  const localUrl = normalizeGroupMemberUrl(localOwner.worker_b_url);
  const group = await db
    .prepare(
      `SELECT group_id, owner_worker_b_url, epoch, dissolved_at FROM groups WHERE group_id = ? LIMIT 1`,
    )
    .bind(groupId)
    .first<{ group_id: string; owner_worker_b_url: string; epoch: number; dissolved_at: string | null }>();

  if (!group || group.dissolved_at) {
    return { ok: false, error_code: 'GROUP_NOT_FOUND', message: '群不存在或已解散' };
  }
  if (normalizeGroupMemberUrl(group.owner_worker_b_url) !== localUrl) {
    return { ok: false, error_code: 'GROUP_NOT_FOUND', message: '本节点非群主权威' };
  }

  const member = await db
    .prepare(
      `SELECT role, status, member_handle, member_pubkey FROM group_members
        WHERE group_id = ? AND member_worker_b_url = ? LIMIT 1`,
    )
    .bind(groupId, memberUrl)
    .first<{ role: string; status: string; member_handle: string; member_pubkey: string }>();

  if (!member || member.role === 'owner') {
    return { ok: false, error_code: 'GROUP_OWNER_CANNOT_LEAVE', message: '群主不能退出' };
  }

  const pinPubkey = (member.member_pubkey ?? '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/i.test(pinPubkey)) {
    return { ok: false, status: 403, error_code: 'GROUP_ENVELOPE_INVALID', message: '成员公钥缺失，无法验签' };
  }

  const envelope: GroupMemberLeftEnvelope = {
    kind: GROUP_MEMBER_LEFT_KIND,
    group_id: groupId,
    member_worker_b_url: memberUrl,
    timestamp,
    nonce,
    sig,
    member_handle: input.member_handle,
  };
  const sigOk = await verifyGroupMemberLeft(envelope, pinPubkey);
  if (!sigOk) {
    return { ok: false, status: 403, error_code: 'GROUP_ENVELOPE_INVALID', message: '退群签名无效' };
  }

  const nonceOk = await consumeGroupNonce(env, groupId, nonce, timestamp);
  if (!nonceOk) {
    return { ok: false, status: 409, error_code: 'GROUP_NONCE_REPLAY', message: '退群信令重复' };
  }

  // 幂等：已 left 仍可 force 树（避免半失败）
  if (member.status !== 'left') {
    await db
      .prepare(
        `UPDATE group_members SET status = 'left', is_admin = 0
          WHERE group_id = ? AND member_worker_b_url = ? AND status IN ('active', 'pending')`,
      )
      .bind(groupId, memberUrl)
      .run();
  }

  const handle = (
    input.member_handle ||
    member.member_handle ||
    'member'
  )
    .trim()
    .toLowerCase();
  const ownerUrl = normalizeGroupMemberUrl(group.owner_worker_b_url);
  const unsigned = {
    v: 1 as const,
    kind: 'GROUP_MESSAGE' as const,
    group_id: groupId,
    message_id: newGroupMessageId(),
    epoch: group.epoch,
    sender_handle: localOwner.handle.trim().toLowerCase(),
    sender_worker_b_url: ownerUrl,
    owner_worker_b_url: ownerUrl,
    created_at: nowIso(),
    expires_at: new Date(Date.now() + GROUP_MESSAGE_TTL_MS).toISOString(),
    nonce: randomDmNonceHex(16),
    msg_kind: 'system' as const,
    ciphertext: utf8PlaintextBase64(`@${handle} 已退出群聊`),
  };
  const systemSig = await signGroupMessageEnvelope(unsigned, env.ED25519_PRIVATE_KEY);
  const systemEnvelope: GroupMessageEnvelope = { ...unsigned, sig: systemSig };

  const posted = await acceptGroupMessageOnOwner(env, systemEnvelope);
  if (!posted.ok && posted.error_code !== 'GROUP_NONCE_REPLAY') {
    console.warn('[group/leave] system 消息失败', groupId, posted.error_code);
  }

  await db
    .prepare(`DELETE FROM group_wrapped_keys WHERE group_id = ? AND member_worker_b_url = ?`)
    .bind(groupId, memberUrl)
    .run();
  await db
    .prepare(`DELETE FROM group_pending_members WHERE group_id = ? AND member_worker_b_url = ?`)
    .bind(groupId, memberUrl)
    .run();

  await recomputeAndPersistRelayTree(env, groupId, { force: true });
  return { ok: true };
}

/** 成员节点 → 群主 Worker B：签 `GROUP_MEMBER_LEFT_V1` 后异步通知（失败不回滚本机 left）。 */
export async function notifyOwnerMemberLeft(
  env: Env,
  ownerWorkerBUrl: string,
  body: {
    group_id: string;
    member_worker_b_url: string;
    member_handle: string;
  },
): Promise<void> {
  const ownerUrl = normalizeGroupMemberUrl(ownerWorkerBUrl).replace(/\/$/, '');
  const memberUrl = normalizeGroupMemberUrl(body.member_worker_b_url);

  // EPOCH NET-1：出站前边界断言（非法则 0 连接）
  const safe = assertSafePeerWorkerBUrl(ownerUrl, {
    allowPrivate: isPrivateProofTargetAllowed(env),
  });
  if (!safe.ok) {
    console.warn('[group/leave] 群主 URL 不安全，跳过通知', safe.reason);
    return;
  }

  const timestamp = nowIso();
  const nonce = randomDmNonceHex(16);
  const unsigned = {
    kind: GROUP_MEMBER_LEFT_KIND,
    group_id: body.group_id,
    member_worker_b_url: memberUrl,
    timestamp,
    nonce,
  };
  let sig: string;
  try {
    sig = await signGroupMemberLeft(unsigned, env.ED25519_PRIVATE_KEY);
  } catch (err) {
    console.warn('[group/leave] 退群签名失败', err);
    return;
  }

  const payload = {
    group_id: body.group_id,
    member_worker_b_url: memberUrl,
    member_handle: body.member_handle,
    timestamp,
    nonce,
    sig,
  };

  const fetched = await fetchOutboundPeer(env, `${ownerUrl}/groups/member-left`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    timeoutMs: 5_000,
  });
  if (!fetched.ok) {
    console.warn('[group/leave] 通知群主失败', fetched.reason, fetched.host);
    return;
  }
  if (!fetched.response.ok) {
    console.warn('[group/leave] 通知群主失败', fetched.response.status);
  }
}
