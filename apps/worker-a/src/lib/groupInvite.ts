// M16-1c / M16-INVITE-SHORT / M16-INVITE-LIFE：群邀请创建与 accept（群主 MESSAGING_DB）。

import { assertSafePeerWorkerBUrl, generateId, isPrivateProofTargetAllowed } from '@hailuo/shared-utils';
import type { Env } from '../env';
import { messagingDb } from './messagingDb';
import { normalizeGroupMemberUrl } from './groupMemberUrl';
import { assertGroupOwnerOrAdmin } from './groupModeration';
import { recordGroupJoinRequestNotification } from './groupJoinNotify';
import { normalizeMemberDhPubkeyHex } from './groupRekeyPolicy';
import { assertGroupHasJoinSlot } from './groupMemberLimit';
import { trySealCurrentEpochForMember } from './groupOwnerSeal';
import {
  notifyApplicantGroupJoinDecision,
  type GroupJoinDecision,
} from './groupJoinDecision'; // M16-SLA-3：不再在这里调用 recomputeAndPersistRelayTree，改为加入待上树列表

const PUBKEY_RE = /^[0-9a-f]{64}$/i;
const GROUP_ID_RE = /^grp_[a-zA-Z0-9_-]{8,128}$/;

/** M16-INVITE-LIFE：允许的有效期（天）；默认 7 */
export const INVITE_TTL_DAYS_ALLOWED = [7, 30, 365, 3650] as const;
export type InviteTtlDays = (typeof INVITE_TTL_DAYS_ALLOWED)[number];
export const INVITE_TTL_DAYS_DEFAULT: InviteTtlDays = 7;

/** Crockford 风格：去掉易混 I/L/O/U，大写 32 字符集 */
export const INVITE_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const INVITE_CODE_LEN = 8;
export const INVITE_CODE_RE = /^[0-9A-HJKMNP-TV-Z]{8}$/;
const INVITE_CODE_MAX_RETRY = 8;

export interface CreateGroupInviteOptions {
  /** 白名单天数；缺省 7 */
  ttl_days?: number;
  /**
   * 是否需群主同意（LIFE-3 接通分支；LIFE-1 仅落库快照）。
   * 缺省读 groups.join_requires_approval。
   */
  requires_approval?: boolean;
}

export interface CreateGroupInviteResult {
  invite_token: string;
  invite_code: string;
  expires_at: string;
  requires_approval: boolean;
  group_name: string;
  ttl_days: InviteTtlDays;
}

export interface AcceptInviteInput {
  /** 短码入群时可省略；权威以 group_invites 行为准 */
  group_id?: string;
  invite_token: string;
  member_worker_b_url: string;
  member_handle: string;
  member_pubkey: string;
  /** SEC-AUDIT-2026-10-15：入群强制 X25519 DH（64 hex） */
  member_dh_pubkey: string;
  wrapped_key_json?: string | null;
}

export interface AcceptInviteResult {
  group_id: string;
  epoch: number;
  tree_id: number;
  name: string;
  owner_worker_b_url: string;
  /** LIFE-1 起恒为 active；LIFE-3 起可能 pending */
  membership_status: 'active' | 'pending';
  /**
   * GRP-RELAY-AUTH-2：权威侧群主成员行 pin，供成员节点本地镜像验 owner_receipt。
   * 缺行时省略（影子 fail-soft，AUTH-3 前不挡入群）。
   */
  owner_handle?: string;
  owner_pubkey?: string;
}

/** 从权威 group_members 读群主 pin（role=owner 优先，否则按 owner URL）。 */
export async function loadOwnerMembershipPin(
  db: D1Database,
  groupId: string,
  ownerWorkerBUrl: string,
): Promise<{ owner_handle: string; owner_pubkey: string } | null> {
  const ownerUrl = normalizeGroupMemberUrl(ownerWorkerBUrl);
  const byRole = await db
    .prepare(
      `SELECT member_handle, member_pubkey FROM group_members
        WHERE group_id = ? AND role = 'owner' AND status = 'active' LIMIT 1`,
    )
    .bind(groupId)
    .first<{ member_handle: string; member_pubkey: string }>();
  if (byRole?.member_pubkey && PUBKEY_RE.test(byRole.member_pubkey)) {
    return {
      owner_handle: byRole.member_handle.trim().toLowerCase(),
      owner_pubkey: byRole.member_pubkey.trim().toLowerCase(),
    };
  }
  const byUrl = await db
    .prepare(
      `SELECT member_handle, member_pubkey FROM group_members
        WHERE group_id = ? AND member_worker_b_url = ? AND status = 'active' LIMIT 1`,
    )
    .bind(groupId, ownerUrl)
    .first<{ member_handle: string; member_pubkey: string }>();
  if (byUrl?.member_pubkey && PUBKEY_RE.test(byUrl.member_pubkey)) {
    return {
      owner_handle: byUrl.member_handle.trim().toLowerCase(),
      owner_pubkey: byUrl.member_pubkey.trim().toLowerCase(),
    };
  }
  return null;
}

/**
 * 本机写入/刷新群主成员行（role=owner），作为 owner_receipt 验签 pin。
 * 入群镜像与 sync 下行回填共用；pubkey 非法返回 false（不写库）。
 */
export async function upsertLocalOwnerMembershipPin(
  db: D1Database,
  args: {
    groupId: string;
    ownerWorkerBUrl: string;
    ownerHandle?: string | null;
    ownerPubkey: string;
    nowIso: string;
  },
): Promise<boolean> {
  const ownerUrl = normalizeGroupMemberUrl(args.ownerWorkerBUrl);
  const ownerPubkey = args.ownerPubkey.trim().toLowerCase();
  if (!ownerUrl || !PUBKEY_RE.test(ownerPubkey)) return false;
  const ownerHandle =
    typeof args.ownerHandle === 'string' && args.ownerHandle.trim()
      ? args.ownerHandle.trim().toLowerCase()
      : 'owner';
  await db
    .prepare(
      `INSERT OR REPLACE INTO group_members
       (group_id, member_worker_b_url, member_handle, member_pubkey, role, key_state, status,
        last_ack_at, empty_ack_streak, joined_at, last_speak_at)
       VALUES (?, ?, ?, ?, 'owner', 'active', 'active', ?, 0, ?, ?)`,
    )
    .bind(
      args.groupId,
      ownerUrl,
      ownerHandle,
      ownerPubkey,
      args.nowIso,
      args.nowIso,
      args.nowIso,
    )
    .run();
  return true;
}

function nowIso(): string {
  return new Date().toISOString();
}

/** 解析并校验 ttl_days；非法返回 null。 */
export function parseInviteTtlDays(raw: unknown): InviteTtlDays | null {
  if (raw === undefined || raw === null || raw === '') return INVITE_TTL_DAYS_DEFAULT;
  const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
  if (!Number.isInteger(n)) return null;
  return (INVITE_TTL_DAYS_ALLOWED as readonly number[]).includes(n) ? (n as InviteTtlDays) : null;
}

/** 是否为 8 位短邀请码（非 ginv_ 主键）。 */
export function isGroupInviteShortCode(raw: string): boolean {
  return INVITE_CODE_RE.test(raw.trim().toUpperCase());
}

/** 生成 8 位短码（密码学随机）。 */
export function generateGroupInviteCode(): string {
  const bytes = new Uint8Array(INVITE_CODE_LEN);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < INVITE_CODE_LEN; i++) {
    out += INVITE_CODE_ALPHABET[bytes[i]! % INVITE_CODE_ALPHABET.length]!;
  }
  return out;
}

export async function createGroupInvite(
  env: Env,
  groupId: string,
  ownerWorkerBUrl: string,
  opts: CreateGroupInviteOptions = {},
): Promise<CreateGroupInviteResult | null> {
  const db = messagingDb(env);
  const group = await db
    .prepare(
      `SELECT group_id, name, join_requires_approval, join_policy
         FROM groups WHERE group_id = ? AND dissolved_at IS NULL LIMIT 1`,
    )
    .bind(groupId)
    .first<{
      group_id: string;
      name: string;
      join_requires_approval: number | null;
      join_policy: string | null;
    }>();
  if (!group) return null;

  const ttlDays = parseInviteTtlDays(opts.ttl_days ?? INVITE_TTL_DAYS_DEFAULT);
  if (ttlDays === null) return null;

  // 优先 join_policy；approval→需同意，closed/open→临时邀请默认不要求（closed 本不应发邀请）
  const requiresApproval =
    typeof opts.requires_approval === 'boolean'
      ? opts.requires_approval
      : group.join_policy === 'approval' ||
        (group.join_policy == null && Number(group.join_requires_approval ?? 0) === 1);

  const createdAt = nowIso();
  const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000).toISOString();
  const inviteToken = generateId('ginv');
  const ownerUrl = normalizeGroupMemberUrl(ownerWorkerBUrl);
  const requiresApprovalInt = requiresApproval ? 1 : 0;

  let inviteCode = '';
  let inserted = false;
  for (let attempt = 0; attempt < INVITE_CODE_MAX_RETRY; attempt++) {
    inviteCode = generateGroupInviteCode();
    try {
      await db
        .prepare(
          `INSERT INTO group_invites
           (invite_token, group_id, owner_worker_b_url, created_at, expires_at, invite_code,
            requires_approval)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(inviteToken, groupId, ownerUrl, createdAt, expiresAt, inviteCode, requiresApprovalInt)
        .run();
      inserted = true;
      break;
    } catch {
      // 唯一索引冲突：换短码重试
    }
  }
  if (!inserted) {
    // 短码反复冲突时仍写入无短码行，调用方可回落长链
    await db
      .prepare(
        `INSERT INTO group_invites
         (invite_token, group_id, owner_worker_b_url, created_at, expires_at, requires_approval)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(inviteToken, groupId, ownerUrl, createdAt, expiresAt, requiresApprovalInt)
      .run();
    return {
      invite_token: inviteToken,
      invite_code: '',
      expires_at: expiresAt,
      requires_approval: requiresApproval,
      group_name: group.name,
      ttl_days: ttlDays,
    };
  }

  return {
    invite_token: inviteToken,
    invite_code: inviteCode,
    expires_at: expiresAt,
    requires_approval: requiresApproval,
    group_name: group.name,
    ttl_days: ttlDays,
  };
}

type InviteRow = {
  invite_token: string;
  group_id: string;
  owner_worker_b_url: string;
  expires_at: string;
  consumed_at: string | null;
  revoked_at: string | null;
  requires_approval: number | null;
};

/** 群主权威 accept：校验 invite、写入 membership、可选 wrapped_key。 */
export async function acceptGroupInviteOnOwner(
  env: Env,
  input: AcceptInviteInput,
): Promise<
  | { ok: true; data: AcceptInviteResult }
  | { ok: false; error_code: string; message: string; status: 400 | 403 | 404 | 409 }
> {
  const memberUrl = normalizeGroupMemberUrl(input.member_worker_b_url);
  const memberHandle = input.member_handle.trim().toLowerCase();
  const memberPubkey = input.member_pubkey.trim().toLowerCase();
  const memberDhPubkey = normalizeMemberDhPubkeyHex(input.member_dh_pubkey);
  if (!memberHandle || !memberUrl || !PUBKEY_RE.test(memberPubkey)) {
    return { ok: false, status: 400, error_code: 'GROUP_ENVELOPE_INVALID', message: '成员身份字段无效' };
  }
  // SEC-AUDIT-2026-10-15：邀请入群同样强制 DH
  if (!memberDhPubkey) {
    return {
      ok: false,
      status: 400,
      error_code: 'GROUP_ENVELOPE_INVALID',
      message: '入群须携带有效 member_dh_pubkey（64 位 hex X25519）',
    };
  }
  // SEC-AUDIT-2026-10-2：邀请入群同样写库前拦截恶意 URL
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
  const tokenRaw = input.invite_token.trim();
  if (!tokenRaw) {
    return { ok: false, status: 400, error_code: 'GROUP_ENVELOPE_INVALID', message: 'invite_token 无效' };
  }

  const clientGroupId = typeof input.group_id === 'string' ? input.group_id.trim() : '';
  if (clientGroupId && !GROUP_ID_RE.test(clientGroupId)) {
    return { ok: false, status: 400, error_code: 'GROUP_ENVELOPE_INVALID', message: 'group_id 无效' };
  }

  const db = messagingDb(env);
  let invite: InviteRow | null = null;

  if (isGroupInviteShortCode(tokenRaw)) {
    const code = tokenRaw.toUpperCase();
    invite = await db
      .prepare(
        `SELECT invite_token, group_id, owner_worker_b_url, expires_at, consumed_at, revoked_at, requires_approval
           FROM group_invites WHERE invite_code = ? LIMIT 1`,
      )
      .bind(code)
      .first<InviteRow>();
  } else {
    invite = await db
      .prepare(
        `SELECT invite_token, group_id, owner_worker_b_url, expires_at, consumed_at, revoked_at, requires_approval
           FROM group_invites WHERE invite_token = ? LIMIT 1`,
      )
      .bind(tokenRaw)
      .first<InviteRow>();
  }

  if (!invite) {
    return { ok: false, status: 404, error_code: 'GROUP_NOT_FOUND', message: '邀请不存在或已失效' };
  }
  if (clientGroupId && invite.group_id !== clientGroupId) {
    return { ok: false, status: 404, error_code: 'GROUP_NOT_FOUND', message: '邀请不存在或已失效' };
  }
  // 非短码路径且未带 group_id：仍要求能解析到邀请行（已满足）；旧客户端一般总会带 group_id
  if (!clientGroupId && !isGroupInviteShortCode(tokenRaw) && !tokenRaw.startsWith('ginv_')) {
    return { ok: false, status: 400, error_code: 'GROUP_ENVELOPE_INVALID', message: 'group_id 无效' };
  }

  const groupId = invite.group_id;

  // LIFE-1：旧一次性邀请已消耗 → 仍拒绝，避免复活
  if (invite.consumed_at) {
    return { ok: false, status: 409, error_code: 'GROUP_INVITE_CONSUMED', message: '邀请已被使用' };
  }
  if (invite.revoked_at) {
    return { ok: false, status: 409, error_code: 'GROUP_INVITE_REVOKED', message: '邀请已作废' };
  }
  if (new Date(invite.expires_at).getTime() < Date.now()) {
    return { ok: false, status: 409, error_code: 'GROUP_INVITE_EXPIRED', message: '邀请已过期' };
  }

  const group = await db
    .prepare(
      `SELECT group_id, name, owner_worker_b_url, epoch, tree_id, dissolved_at
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
    }>();
  if (!group || group.dissolved_at) {
    return { ok: false, status: 404, error_code: 'GROUP_NOT_FOUND', message: '群不存在或已解散' };
  }
  if (normalizeGroupMemberUrl(group.owner_worker_b_url) === memberUrl) {
    return { ok: false, status: 409, error_code: 'GROUP_NOT_MEMBER', message: '群主无需接受邀请' };
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
  const requiresApproval = Number(invite.requires_approval ?? 0) === 1;

  // GRP-RELAY-AUTH-2：入群成功响应带群主 pin，供成员节点镜像
  const ownerPin = await loadOwnerMembershipPin(db, groupId, group.owner_worker_b_url);
  const baseData = (membership_status: 'active' | 'pending'): AcceptInviteResult => ({
    group_id: group.group_id,
    epoch: group.epoch,
    tree_id: group.tree_id,
    name: group.name,
    owner_worker_b_url: group.owner_worker_b_url,
    membership_status,
    ...(ownerPin
      ? { owner_handle: ownerPin.owner_handle, owner_pubkey: ownerPin.owner_pubkey }
      : {}),
  });

  // LIFE-3：需群主同意 → 只写 group_members.status=pending，不上树
  if (requiresApproval) {
    if (existing?.status === 'pending') {
      return { ok: true, data: baseData('pending') };
    }
    // GROUP-CAP-SPEAK-1：含群主共 2000
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
    // OWNER-KEY-3：有 DH 则群主 Worker 代封当前 epoch（缺持钥表则 fail-soft）
    try {
      await trySealCurrentEpochForMember(env, groupId, memberUrl);
    } catch (err) {
      console.warn('[owner-seal] invite pending 代封异常', err instanceof Error ? err.message : 'unknown');
    }
    // REL-FIX-3：邀请需审批 → 群主站内通知（fail-soft；重复 accept 早返回故天然幂等）
    await recordGroupJoinRequestNotification(env, {
      group_id: groupId,
      group_name: group.name,
      member_handle: memberHandle,
      member_worker_b_url: memberUrl,
    });
    return { ok: true, data: baseData('pending') };
  }

  // 自动入群：待上树列表（SLA-3）；冷却期满后由 cron 触发重建；LIFE-1 起不再写 consumed_at
  // GROUP-CAP-SPEAK-1：仅新占坑查满员；已排队可幂等刷新
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

  // OWNER-KEY-3：免审入群 → 代封（写入 wrap + pending_members.key_state=active）
  try {
    await trySealCurrentEpochForMember(env, groupId, memberUrl);
  } catch (err) {
    console.warn('[owner-seal] invite accept 代封异常', err instanceof Error ? err.message : 'unknown');
  }

  return { ok: true, data: baseData('active') };
}

/** 成员节点 accept 成功后写入本地 MESSAGING_DB 副本。 */
export async function mirrorAcceptedGroupLocally(
  env: Env,
  data: AcceptInviteResult,
  member: {
    member_worker_b_url: string;
    member_handle: string;
    member_pubkey: string;
    member_dh_pubkey?: string | null;
  },
  keyState: 'pending_key' | 'active' = 'pending_key',
): Promise<void> {
  const db = messagingDb(env);
  const now = nowIso();
  const memberUrl = normalizeGroupMemberUrl(member.member_worker_b_url);
  const ownerUrl = normalizeGroupMemberUrl(data.owner_worker_b_url);
  const memberDh = normalizeMemberDhPubkeyHex(member.member_dh_pubkey);
  // LIFE-3：pending 审批中也镜像本地，但 status 与权威一致
  const memberStatus = data.membership_status === 'pending' ? 'pending' : 'active';

  const stmts = [
    db
      .prepare(
        `INSERT OR REPLACE INTO groups
         (group_id, name, announcement, owner_worker_b_url, epoch, tree_id, dissolved_at, created_at, updated_at)
         VALUES (?, ?, NULL, ?, ?, ?, NULL, ?, ?)`,
      )
      .bind(data.group_id, data.name, ownerUrl, data.epoch, data.tree_id, now, now),
    db
      .prepare(
        `INSERT OR REPLACE INTO group_members
         (group_id, member_worker_b_url, member_handle, member_pubkey, role, key_state, status,
          last_ack_at, empty_ack_streak, joined_at, last_speak_at, member_dh_pubkey)
         VALUES (?, ?, ?, ?, 'member', ?, ?, ?, 0, ?, ?, NULLIF(?, ''))`,
      )
      .bind(
        data.group_id,
        memberUrl,
        member.member_handle,
        member.member_pubkey,
        keyState,
        memberStatus,
        now,
        now,
        now,
        memberDh,
      ),
    db
      .prepare(
        `INSERT OR REPLACE INTO group_sync_state
         (group_id, parent_worker_b_url, cursor, sync_tier, local_retention_days, last_sync_at, updated_at)
         VALUES (?, ?, NULL, 'unsynced', 90, NULL, ?)`,
      )
      .bind(data.group_id, ownerUrl, now),
  ];

  await db.batch(stmts);

  // GRP-RELAY-AUTH-2：回填群主成员行，作为本机 pin 的 owner_receipt 验签公钥源
  const ownerPubkey =
    typeof data.owner_pubkey === 'string' ? data.owner_pubkey.trim().toLowerCase() : '';
  const pinned = await upsertLocalOwnerMembershipPin(db, {
    groupId: data.group_id,
    ownerWorkerBUrl: ownerUrl,
    ownerHandle: data.owner_handle,
    ownerPubkey,
    nowIso: now,
  });
  if (!pinned) {
    console.warn('[groups] mirror 缺群主 pubkey pin（AUTH-2 影子；AUTH-3 强制前可补）');
  }
}

export type GroupJoinRequestItem = {
  member_worker_b_url: string;
  member_handle: string;
  member_pubkey: string;
  key_state: string;
  joined_at: string;
};

async function assertGroupOwner(
  env: Env,
  groupId: string,
  ownerWorkerBUrl: string,
): Promise<{ ok: true } | { ok: false; status: 403 | 404; error_code: string; message: string }> {
  const db = messagingDb(env);
  const group = await db
    .prepare(
      `SELECT owner_worker_b_url, dissolved_at FROM groups WHERE group_id = ? LIMIT 1`,
    )
    .bind(groupId)
    .first<{ owner_worker_b_url: string; dissolved_at: string | null }>();
  if (!group || group.dissolved_at) {
    return { ok: false, status: 404, error_code: 'GROUP_NOT_FOUND', message: '群不存在或已解散' };
  }
  if (normalizeGroupMemberUrl(group.owner_worker_b_url) !== normalizeGroupMemberUrl(ownerWorkerBUrl)) {
    return { ok: false, status: 403, error_code: 'GROUP_NOT_MEMBER', message: '仅群主可操作' };
  }
  return { ok: true };
}

/**
 * REL-FIX-7：审批完成后回推结果给申请人节点。
 * 群名从群主库读；投递失败只落 outbox（内部 fail-soft），不阻断审批主流程。
 */
async function notifyGroupJoinDecision(
  env: Env,
  groupId: string,
  memberWorkerBUrl: string,
  decision: GroupJoinDecision,
): Promise<void> {
  try {
    const row = await messagingDb(env)
      .prepare(`SELECT name FROM groups WHERE group_id = ? LIMIT 1`)
      .bind(groupId)
      .first<{ name: string }>();
    await notifyApplicantGroupJoinDecision(env, {
      group_id: groupId,
      group_name: row?.name ?? '',
      member_worker_b_url: memberWorkerBUrl,
      decision,
    });
  } catch (err) {
    console.warn('[groupInvite] 回推入群审批结果失败', err);
  }
}

/** 群主或管理员：列出待审批入群申请（status=pending）。 */
export async function listGroupJoinRequests(
  env: Env,
  groupId: string,
  actorWorkerBUrl: string,
): Promise<
  | { ok: true; items: GroupJoinRequestItem[] }
  | { ok: false; status: 400 | 403 | 404 | 409; error_code: string; message: string }
> {
  const gate = await assertGroupOwnerOrAdmin(env, groupId, actorWorkerBUrl);
  if (!gate.ok) return gate;
  const db = messagingDb(env);
  const { results } = await db
    .prepare(
      `SELECT member_worker_b_url, member_handle, member_pubkey, key_state, joined_at
         FROM group_members
        WHERE group_id = ? AND status = 'pending'
        ORDER BY joined_at ASC`,
    )
    .bind(groupId)
    .all<GroupJoinRequestItem>();
  return { ok: true, items: results ?? [] };
}

/** 群主或管理员同意：pending → active，并进入待上树列表。 */
export async function approveGroupJoinRequest(
  env: Env,
  groupId: string,
  actorWorkerBUrl: string,
  memberWorkerBUrl: string,
): Promise<
  | { ok: true; data: { group_id: string; member_worker_b_url: string; status: 'active' } }
  | { ok: false; status: 400 | 403 | 404 | 409; error_code: string; message: string }
> {
  const gate = await assertGroupOwnerOrAdmin(env, groupId, actorWorkerBUrl);
  if (!gate.ok) return gate;
  const memberUrl = normalizeGroupMemberUrl(memberWorkerBUrl);
  const db = messagingDb(env);
  const row = await db
    .prepare(
      `SELECT member_worker_b_url, member_handle, member_pubkey, member_dh_pubkey, key_state, status
         FROM group_members WHERE group_id = ? AND member_worker_b_url = ? LIMIT 1`,
    )
    .bind(groupId, memberUrl)
    .first<{
      member_worker_b_url: string;
      member_handle: string;
      member_pubkey: string;
      member_dh_pubkey: string | null;
      key_state: string;
      status: string;
    }>();
  if (!row || row.status !== 'pending') {
    return { ok: false, status: 404, error_code: 'GROUP_NOT_FOUND', message: '没有待审批的入群申请' };
  }
  const now = nowIso();
  // 审批通过 = 首次活跃；last_speak_at 缺省回填（排序回退，非真发言）
  await db
    .prepare(
      `UPDATE group_members
          SET status = 'active',
              last_ack_at = COALESCE(last_ack_at, ?),
              last_speak_at = COALESCE(last_speak_at, ?)
        WHERE group_id = ? AND member_worker_b_url = ?`,
    )
    .bind(now, now, groupId, memberUrl)
    .run();
  await db
    .prepare(
      `INSERT OR REPLACE INTO group_pending_members
       (group_id, member_worker_b_url, member_handle, member_pubkey, key_state, added_at, member_dh_pubkey)
       VALUES (?, ?, ?, ?, ?, ?, NULLIF(?, ''))`,
    )
    .bind(
      groupId,
      memberUrl,
      row.member_handle,
      row.member_pubkey,
      row.key_state,
      now,
      (row.member_dh_pubkey ?? '').trim().toLowerCase(),
    )
    .run();
  // OWNER-KEY-3：审批通过后若已有 DH，群主节点代封当前 epoch
  try {
    await trySealCurrentEpochForMember(env, groupId, memberUrl);
  } catch (err) {
    console.warn('[owner-seal] approve 代封异常', err instanceof Error ? err.message : 'unknown');
  }
  // REL-FIX-7：把审批结果回推申请人节点（失败仅落 outbox 待重投，不阻断审批）
  await notifyGroupJoinDecision(env, groupId, memberUrl, 'approved');
  return {
    ok: true,
    data: { group_id: groupId, member_worker_b_url: memberUrl, status: 'active' },
  };
}

/** 群主或管理员拒绝：删除 pending 成员行，便于同一人再次申请。 */
export async function rejectGroupJoinRequest(
  env: Env,
  groupId: string,
  actorWorkerBUrl: string,
  memberWorkerBUrl: string,
): Promise<
  | { ok: true; data: { group_id: string; member_worker_b_url: string; status: 'rejected' } }
  | { ok: false; status: 400 | 403 | 404 | 409; error_code: string; message: string }
> {
  const gate = await assertGroupOwnerOrAdmin(env, groupId, actorWorkerBUrl);
  if (!gate.ok) return gate;
  const memberUrl = normalizeGroupMemberUrl(memberWorkerBUrl);
  const db = messagingDb(env);
  const row = await db
    .prepare(
      `SELECT status FROM group_members WHERE group_id = ? AND member_worker_b_url = ? LIMIT 1`,
    )
    .bind(groupId, memberUrl)
    .first<{ status: string }>();
  if (!row || row.status !== 'pending') {
    return { ok: false, status: 404, error_code: 'GROUP_NOT_FOUND', message: '没有待审批的入群申请' };
  }
  await db
    .prepare(`DELETE FROM group_members WHERE group_id = ? AND member_worker_b_url = ? AND status = 'pending'`)
    .bind(groupId, memberUrl)
    .run();
  // REL-FIX-7：把拒绝结果回推申请人节点（失败仅落 outbox 待重投，不阻断审批）
  await notifyGroupJoinDecision(env, groupId, memberUrl, 'rejected');
  return {
    ok: true,
    data: { group_id: groupId, member_worker_b_url: memberUrl, status: 'rejected' },
  };
}

/** 群主作废邀请（短码或 ginv_）。 */
export async function revokeGroupInvite(
  env: Env,
  groupId: string,
  ownerWorkerBUrl: string,
  inviteTokenOrCode: string,
): Promise<
  | { ok: true; data: { group_id: string; invite_token: string; revoked_at: string } }
  | { ok: false; status: 403 | 404; error_code: string; message: string }
> {
  const ownerOk = await assertGroupOwner(env, groupId, ownerWorkerBUrl);
  if (!ownerOk.ok) return ownerOk;
  const db = messagingDb(env);
  const raw = inviteTokenOrCode.trim();
  let inviteToken: string | null = null;
  if (isGroupInviteShortCode(raw)) {
    const row = await db
      .prepare(`SELECT invite_token, group_id FROM group_invites WHERE invite_code = ? LIMIT 1`)
      .bind(raw.toUpperCase())
      .first<{ invite_token: string; group_id: string }>();
    if (row && row.group_id === groupId) inviteToken = row.invite_token;
  } else {
    const row = await db
      .prepare(`SELECT invite_token, group_id FROM group_invites WHERE invite_token = ? LIMIT 1`)
      .bind(raw)
      .first<{ invite_token: string; group_id: string }>();
    if (row && row.group_id === groupId) inviteToken = row.invite_token;
  }
  if (!inviteToken) {
    return { ok: false, status: 404, error_code: 'GROUP_NOT_FOUND', message: '邀请不存在' };
  }
  const revokedAt = nowIso();
  await db
    .prepare(`UPDATE group_invites SET revoked_at = ? WHERE invite_token = ?`)
    .bind(revokedAt, inviteToken)
    .run();
  return { ok: true, data: { group_id: groupId, invite_token: inviteToken, revoked_at: revokedAt } };
}

/** @deprecated JOIN-POLICY 起改用 setGroupJoinPolicy；保留并双写 join_policy。 */
export async function setGroupJoinRequiresApproval(
  env: Env,
  groupId: string,
  ownerWorkerBUrl: string,
  requires: boolean,
): Promise<
  | { ok: true; data: { group_id: string; join_requires_approval: boolean } }
  | { ok: false; status: 403 | 404; error_code: string; message: string }
> {
  const ownerOk = await assertGroupOwner(env, groupId, ownerWorkerBUrl);
  if (!ownerOk.ok) return ownerOk;
  const db = messagingDb(env);
  const policy = requires ? 'approval' : 'open';
  await db
    .prepare(
      `UPDATE groups SET join_requires_approval = ?, join_policy = ?, updated_at = ? WHERE group_id = ?`,
    )
    .bind(requires ? 1 : 0, policy, nowIso(), groupId)
    .run();
  return { ok: true, data: { group_id: groupId, join_requires_approval: requires } };
}
