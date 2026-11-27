// M16-JOIN-POLICY-1：短群号生成 + join_policy 枚举（MESSAGING_DB）。

import { assertSafePeerWorkerBUrl, isPrivateProofTargetAllowed } from '@hailuo/shared-utils';
import { messagingDb } from './messagingDb';
import { normalizeGroupMemberUrl } from './groupMemberUrl';
import { checkAndIncrementGroupJoinRate } from './groupRateLimit';
import { loadOwnerMembershipPin } from './groupInvite';
import { recordGroupJoinRequestNotification } from './groupJoinNotify';
import { normalizeMemberDhPubkeyHex } from './groupRekeyPolicy';
import { assertGroupHasJoinSlot } from './groupMemberLimit';
import { trySealCurrentEpochForMember } from './groupOwnerSeal';
import type { Env } from '../env';

/** 旧字母表（8 位旧群号用），保留供参考 */
export const GROUP_ID_LEGACY_SUFFIX_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * 首位：字母，去 I/L/O/U（含大小写）
 * 字母集共 44 个：A-Z(22) + a-z(22)
 */
export const GROUP_ID_SUFFIX_FIRST_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZabcdefghjkmnpqrstvwxyz';

/**
 * 其余 11 位：数字 + 大小写字母，去 I/L/O/U（含小写 i/l/o/u）
 * 字符集：0-9(10) + A-Z(26) + a-z(26) - I/L/O/U(4) - i/l/o/u(4) = 58 个
 */
export const GROUP_ID_SUFFIX_REST_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZabcdefghjkmnpqrstvwxyz';

export const GROUP_ID_SUFFIX_LEN = 12;
/** 追加日期后缀（6 位 YYMMDD）后，随机位 + 日期位总长度 */
export const GROUP_ID_SUFFIX_WITH_YMD_LEN = 18;
export const GROUP_ID_PREFIX = 'grp_';
const GROUP_ID_MAX_RETRY = 8;

export const JOIN_POLICIES = ['closed', 'approval', 'open'] as const;
export type GroupJoinPolicy = (typeof JOIN_POLICIES)[number];
export const JOIN_POLICY_DEFAULT: GroupJoinPolicy = 'approval';

export function isGroupJoinPolicy(raw: unknown): raw is GroupJoinPolicy {
  return typeof raw === 'string' && (JOIN_POLICIES as readonly string[]).includes(raw);
}

/**
 * 生成群号：grp_ + 12 位随机 + 6 位日期（YYMMDD）。
 * 随机部分：
 *   第 1 位：字母，去 I/L/O/U/i/l/o/u（44 个）。
 *   其余 11 位：数字 + 大小写字母，去 I/L/O/U/i/l/o/u（58 个）。
 * 日期部分：当前 UTC 日期，格式 YYMMDD（如 260919 表示 2026 年 9 月 19 日）。
 * 约 22 字符（4 + 12 + 6）。
 */
export function generateShortGroupId(): string {
  const bytes = new Uint8Array(GROUP_ID_SUFFIX_LEN);
  crypto.getRandomValues(bytes);

  // 第 1 位：字母
  const first = GROUP_ID_SUFFIX_FIRST_ALPHABET[
    bytes[0]! % GROUP_ID_SUFFIX_FIRST_ALPHABET.length
  ]!;

  // 其余 11 位
  let suffix = '';
  for (let i = 1; i < GROUP_ID_SUFFIX_LEN; i++) {
    suffix += GROUP_ID_SUFFIX_REST_ALPHABET[
      bytes[i]! % GROUP_ID_SUFFIX_REST_ALPHABET.length
    ]!;
  }

  // 日期（YYMMDD，UTC）
  const now = new Date();
  const yy = String(now.getUTCFullYear()).slice(2); // 取后两位，如 26
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0'); // 0-indexed，补零
  const dd = String(now.getUTCDate()).padStart(2, '0');

  return `${GROUP_ID_PREFIX}${first}${suffix}${yy}${mm}${dd}`;
}

/** 建群时分配短 id；主键冲突重试。 */
export async function allocateShortGroupId(env: Env): Promise<string> {
  const db = messagingDb(env);
  for (let attempt = 0; attempt < GROUP_ID_MAX_RETRY; attempt++) {
    const id = generateShortGroupId();
    const existing = await db
      .prepare(`SELECT 1 AS ok FROM groups WHERE group_id = ? LIMIT 1`)
      .bind(id)
      .first<{ ok: number }>();
    if (!existing) return id;
  }
  throw new Error('GROUP_ID_ALLOC_FAILED');
}

function nowIso(): string {
  return new Date().toISOString();
}

async function assertGroupOwner(
  env: Env,
  groupId: string,
  ownerWorkerBUrl: string,
): Promise<{ ok: true } | { ok: false; status: 403 | 404; error_code: string; message: string }> {
  const db = messagingDb(env);
  const group = await db
    .prepare(`SELECT owner_worker_b_url, dissolved_at FROM groups WHERE group_id = ? LIMIT 1`)
    .bind(groupId)
    .first<{ owner_worker_b_url: string; dissolved_at: string | null }>();
  if (!group || group.dissolved_at) {
    return { ok: false, status: 404, error_code: 'GROUP_NOT_FOUND', message: '群不存在或已解散' };
  }
  if (normalizeGroupMemberUrl(group.owner_worker_b_url) !== normalizeGroupMemberUrl(ownerWorkerBUrl)) {
    return { ok: false, status: 403, error_code: 'GROUP_NOT_MEMBER', message: '仅群主可修改加群策略' };
  }
  return { ok: true };
}

/** 群主更新加群策略（枚举）。同步旧列 join_requires_approval 便于过渡读。 */
export async function setGroupJoinPolicy(
  env: Env,
  groupId: string,
  ownerWorkerBUrl: string,
  policy: GroupJoinPolicy,
): Promise<
  | { ok: true; data: { group_id: string; join_policy: GroupJoinPolicy } }
  | { ok: false; status: 400 | 403 | 404; error_code: string; message: string }
> {
  if (!isGroupJoinPolicy(policy)) {
    return { ok: false, status: 400, error_code: 'GROUP_JOIN_POLICY_INVALID', message: '加群策略无效' };
  }
  const ownerOk = await assertGroupOwner(env, groupId, ownerWorkerBUrl);
  if (!ownerOk.ok) return ownerOk;
  const db = messagingDb(env);
  const requiresApproval = policy === 'approval' ? 1 : 0;
  await db
    .prepare(
      `UPDATE groups
       SET join_policy = ?, join_requires_approval = ?, updated_at = ?
       WHERE group_id = ?`,
    )
    .bind(policy, requiresApproval, nowIso(), groupId)
    .run();
  return { ok: true, data: { group_id: groupId, join_policy: policy } };
}

const GROUP_ID_RE = /^grp_[a-zA-Z0-9_-]{8,128}$/;
const PUBKEY_RE = /^[0-9a-f]{64}$/i;

export type JoinGroupByIdInput = {
  group_id: string;
  member_worker_b_url: string;
  member_handle: string;
  member_pubkey: string;
  /**
   * SEC-AUDIT-2026-10-15：入群强制 X25519 DH 公钥（64 hex），写入 member_dh_pubkey。
   * 缺省拒收，避免离线成员拖死后续 rekey-commit。
   */
  member_dh_pubkey: string;
  wrapped_key_json?: string | null;
};

export type JoinGroupByIdResult = {
  group_id: string;
  epoch: number;
  tree_id: number;
  name: string;
  owner_worker_b_url: string;
  membership_status: 'active' | 'pending';
  join_policy: GroupJoinPolicy;
  /** GRP-RELAY-AUTH-2：群主 pin，供成员节点 mirrorAcceptedGroupLocally 回填 */
  owner_handle?: string;
  owner_pubkey?: string;
};

function resolveStoredJoinPolicy(row: {
  join_policy: string | null;
  join_requires_approval: number | null;
}): GroupJoinPolicy {
  if (isGroupJoinPolicy(row.join_policy)) return row.join_policy;
  return Number(row.join_requires_approval ?? 0) === 1 ? 'approval' : 'open';
}

/**
 * M16-JOIN-POLICY-2：按固定群号加入（群主权威节点）。
 * closed → GROUP_JOIN_CLOSED；approval → members pending；open → pending_members（待上树）。
 */
export async function joinGroupByIdOnOwner(
  env: Env,
  input: JoinGroupByIdInput,
): Promise<
  | { ok: true; data: JoinGroupByIdResult }
  | {
      ok: false;
      status: 400 | 403 | 404 | 409 | 429;
      error_code: string;
      message: string;
    }
> {
  const groupId = input.group_id.trim();
  if (!GROUP_ID_RE.test(groupId)) {
    return { ok: false, status: 400, error_code: 'GROUP_ENVELOPE_INVALID', message: 'group_id 无效' };
  }
  const memberUrl = normalizeGroupMemberUrl(input.member_worker_b_url);
  const memberHandle = input.member_handle.trim();
  const memberPubkey = input.member_pubkey.trim().toLowerCase();
  const memberDhPubkey = normalizeMemberDhPubkeyHex(input.member_dh_pubkey);
  if (!memberUrl || !memberHandle || !PUBKEY_RE.test(memberPubkey)) {
    return { ok: false, status: 400, error_code: 'GROUP_ENVELOPE_INVALID', message: '入群字段无效' };
  }
  // SEC-AUDIT-2026-10-15：入群强制 DH，否则日后 rekey-commit 被离线成员拖死
  if (!memberDhPubkey) {
    return {
      ok: false,
      status: 400,
      error_code: 'GROUP_ENVELOPE_INVALID',
      message: '入群须携带有效 member_dh_pubkey（64 位 hex X25519）',
    };
  }

  // SEC-AUDIT-2026-10-2：写库前拦截恶意/私网 URL（normalize 不动，边界断言）
  const urlSafe = assertSafePeerWorkerBUrl(memberUrl, {
    allowPrivate: isPrivateProofTargetAllowed(env),
  });
  if (!urlSafe.ok) {
    return {
      ok: false,
      status: 400,
      error_code: 'GROUP_ENVELOPE_INVALID',
      message: '成员节点地址不安全',
    };
  }

  // JOIN-POLICY-4 + 群级频控：防换 URL 重置桶
  const allowed = await checkAndIncrementGroupJoinRate(env, memberUrl, groupId);
  if (!allowed) {
    return {
      ok: false,
      status: 429,
      error_code: 'GROUP_RATE_LIMITED',
      message: '入群尝试过于频繁，请稍后再试',
    };
  }

  const db = messagingDb(env);
  const group = await db
    .prepare(
      `SELECT group_id, name, owner_worker_b_url, epoch, tree_id, dissolved_at,
              join_policy, join_requires_approval
         FROM groups WHERE group_id = ? LIMIT 1`,
    )
    .bind(groupId)
    .first<{
      group_id: string;
      name: string;
      owner_worker_b_url: string;
      epoch: number;
      tree_id: number;
      dissolved_at: string | null;
      join_policy: string | null;
      join_requires_approval: number | null;
    }>();
  if (!group || group.dissolved_at) {
    return { ok: false, status: 404, error_code: 'GROUP_NOT_FOUND', message: '群不存在或已解散' };
  }
  if (normalizeGroupMemberUrl(group.owner_worker_b_url) === memberUrl) {
    return { ok: false, status: 409, error_code: 'GROUP_NOT_MEMBER', message: '群主无需申请入群' };
  }

  const policy = resolveStoredJoinPolicy(group);
  if (policy === 'closed') {
    return { ok: false, status: 403, error_code: 'GROUP_JOIN_CLOSED', message: '该群不允许加入' };
  }

  const existing = await db
    .prepare(
      `SELECT status FROM group_members WHERE group_id = ? AND member_worker_b_url = ? LIMIT 1`,
    )
    .bind(groupId, memberUrl)
    .first<{ status: string }>();
  if (existing?.status === 'active') {
    return { ok: false, status: 409, error_code: 'GROUP_ALREADY_MEMBER', message: '已是群成员' };
  }
  if (existing?.status === 'kicked') {
    return { ok: false, status: 403, error_code: 'GROUP_NOT_MEMBER', message: '已被移出群聊' };
  }

  const joinedAt = nowIso();
  const keyState =
    typeof input.wrapped_key_json === 'string' && input.wrapped_key_json.trim().length > 0
      ? 'active'
      : 'pending_key';

  // GRP-RELAY-AUTH-2：入群成功响应带群主 pin，供成员节点镜像
  const ownerPin = await loadOwnerMembershipPin(db, groupId, group.owner_worker_b_url);
  const baseData: JoinGroupByIdResult = {
    group_id: group.group_id,
    epoch: group.epoch,
    tree_id: group.tree_id,
    name: group.name,
    owner_worker_b_url: group.owner_worker_b_url,
    membership_status: policy === 'approval' ? 'pending' : 'active',
    join_policy: policy,
    ...(ownerPin
      ? { owner_handle: ownerPin.owner_handle, owner_pubkey: ownerPin.owner_pubkey }
      : {}),
  };

  if (policy === 'approval') {
    if (existing?.status === 'pending') {
      return { ok: true, data: baseData };
    }
    // GROUP-CAP-SPEAK-1：含群主共 2000，满员拒新 pending
    const slot = await assertGroupHasJoinSlot(env, groupId);
    if (!slot.ok) return slot;
    await db
      .prepare(
        `INSERT OR REPLACE INTO group_members
         (group_id, member_worker_b_url, member_handle, member_pubkey, role, key_state, status,
          last_ack_at, empty_ack_streak, joined_at, last_speak_at, member_dh_pubkey)
         VALUES (?, ?, ?, ?, 'member', ?, 'pending', NULL, 0, ?, ?, ?)`,
      )
      .bind(
        groupId,
        memberUrl,
        memberHandle,
        memberPubkey,
        keyState,
        joinedAt,
        joinedAt,
        memberDhPubkey,
      )
      .run();
    if (keyState === 'active' && input.wrapped_key_json) {
      await db
        .prepare(
          `INSERT OR REPLACE INTO group_wrapped_keys
           (group_id, epoch, member_worker_b_url, wrapped_key_json, updated_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .bind(groupId, group.epoch, memberUrl, input.wrapped_key_json.trim(), joinedAt)
        .run();
    }
    // OWNER-KEY-3：审批制申请已带 DH → 尽早代封（审批通过后可立刻 Fast-Pull）
    try {
      await trySealCurrentEpochForMember(env, groupId, memberUrl);
    } catch (err) {
      console.warn('[owner-seal] join approval 代封异常', err instanceof Error ? err.message : 'unknown');
    }
    // REL-FIX-3：入群 pending → 群主站内通知（fail-soft；重复申请早返回故天然幂等）
    await recordGroupJoinRequestNotification(env, {
      group_id: groupId,
      group_name: group.name,
      member_handle: memberHandle,
      member_worker_b_url: memberUrl,
    });
    return { ok: true, data: baseData };
  }

  // open：与邀请免审路径一致——写待上树列表，冷却后 drain 入 group_members
  // GROUP-CAP-SPEAK-1：仅「新占坑」查满员；已在 pending_members 可幂等刷新
  const alreadyQueued = await db
    .prepare(
      `SELECT 1 AS ok FROM group_pending_members
        WHERE group_id = ? AND member_worker_b_url = ? LIMIT 1`,
    )
    .bind(groupId, memberUrl)
    .first<{ ok: number }>();
  if (!alreadyQueued) {
    const openSlot = await assertGroupHasJoinSlot(env, groupId);
    if (!openSlot.ok) return openSlot;
  }
  await db
    .prepare(
      `INSERT OR REPLACE INTO group_pending_members
       (group_id, member_worker_b_url, member_handle, member_pubkey, key_state, added_at, member_dh_pubkey)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(groupId, memberUrl, memberHandle, memberPubkey, keyState, joinedAt, memberDhPubkey)
    .run();

  if (keyState === 'active' && input.wrapped_key_json) {
    await db
      .prepare(
        `INSERT OR REPLACE INTO group_wrapped_keys
         (group_id, epoch, member_worker_b_url, wrapped_key_json, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(groupId, group.epoch, memberUrl, input.wrapped_key_json.trim(), joinedAt)
      .run();
  }

  // OWNER-KEY-3：open 入群 → 代封当前 epoch（fail-soft）
  try {
    await trySealCurrentEpochForMember(env, groupId, memberUrl);
  } catch (err) {
    console.warn('[owner-seal] join open 代封异常', err instanceof Error ? err.message : 'unknown');
  }

  return { ok: true, data: baseData };
}
