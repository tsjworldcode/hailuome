/**
 * M16-GROUP-MOD：全员禁言 + 群管理判定与写接口（MESSAGING_DB）。
 * 计划 SSOT：docs/m16-group-moderation-plan.md
 */
import type { Env } from '../env';
import { messagingDb } from './messagingDb';
import { normalizeGroupMemberUrl } from './groupMemberUrl';

/** 每群管理员上限（不含群主） */
export const GROUP_ADMIN_MAX = 5;

/** 全员禁言时普通成员发信错误码 */
export const GROUP_MEMBERS_MUTED = 'GROUP_MEMBERS_MUTED';

/** 管理员人数已达上限 */
export const GROUP_ADMIN_LIMIT = 'GROUP_ADMIN_LIMIT';

/** 群公告最大长度（与建群一致） */
export const GROUP_ANNOUNCEMENT_MAX = 512;

/** 群名称最大长度（建群 createGroupWithKeys 沿用 64；UX-GROUPS-7b 显式收敛） */
export const GROUP_NAME_MAX = 64;

export type GroupSpeakRole = {
  role: string;
  is_admin: number | boolean;
  status: string;
};

type ModErr = {
  ok: false;
  status: 400 | 403 | 404 | 409;
  error_code: string;
  message: string;
};

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * 是否允许发聊天消息。
 * members_muted=0 → 在册 active 即可（调用方仍须另验 membership）。
 * members_muted=1 → 仅群主或 is_admin=1。
 */
export function canSpeakWhenMuted(
  membersMuted: number | boolean,
  member: GroupSpeakRole,
): boolean {
  if (member.status !== 'active') return false;
  const muted = Number(membersMuted) === 1;
  if (!muted) return true;
  if (member.role === 'owner') return true;
  return Number(member.is_admin) === 1;
}

/** MUTE-RELAY：中继收包禁言闸判定（纯函数，可单测）。 */
export type MuteRelayChatGateDecision =
  | { action: 'pass' }
  | {
      action: 'reject';
      error_code: 'GROUP_NOT_MEMBER' | typeof GROUP_MEMBERS_MUTED;
      message: string;
    };

/**
 * 仅在全员禁言开启时做成员行 + 发言权检查。
 * 未禁言：直接放行——中继节点成员表可滞后，不得因本地缺行误杀已验签的合法 chat。
 */
export function decideMuteRelayChatGate(
  membersMuted: number | boolean | null | undefined,
  senderMember: GroupSpeakRole | null,
): MuteRelayChatGateDecision {
  if (Number(membersMuted) !== 1) {
    return { action: 'pass' };
  }
  if (!senderMember || senderMember.status !== 'active') {
    return {
      action: 'reject',
      error_code: 'GROUP_NOT_MEMBER',
      message: '发送方非本节点已知成员',
    };
  }
  if (!canSpeakWhenMuted(1, senderMember)) {
    return {
      action: 'reject',
      error_code: GROUP_MEMBERS_MUTED,
      message: '本群已开启仅群主与管理员可发言',
    };
  }
  return { action: 'pass' };
}

async function loadGroupOwner(
  env: Env,
  groupId: string,
): Promise<
  | { ok: true; owner_worker_b_url: string }
  | ModErr
> {
  const group = await messagingDb(env)
    .prepare(`SELECT owner_worker_b_url, dissolved_at FROM groups WHERE group_id = ? LIMIT 1`)
    .bind(groupId)
    .first<{ owner_worker_b_url: string; dissolved_at: string | null }>();
  if (!group || group.dissolved_at) {
    return { ok: false, status: 404, error_code: 'GROUP_NOT_FOUND', message: '群不存在或已解散' };
  }
  return { ok: true, owner_worker_b_url: group.owner_worker_b_url };
}

async function loadActiveMember(
  env: Env,
  groupId: string,
  memberWorkerBUrl: string,
): Promise<
  | { ok: true; role: string; is_admin: number }
  | ModErr
> {
  const url = normalizeGroupMemberUrl(memberWorkerBUrl);
  const row = await messagingDb(env)
    .prepare(
      `SELECT role, is_admin, status FROM group_members
        WHERE group_id = ? AND member_worker_b_url = ? LIMIT 1`,
    )
    .bind(groupId, url)
    .first<{ role: string; is_admin: number; status: string }>();
  if (!row || row.status !== 'active') {
    return { ok: false, status: 403, error_code: 'GROUP_NOT_MEMBER', message: '非在册成员，无法操作' };
  }
  return { ok: true, role: row.role, is_admin: Number(row.is_admin) === 1 ? 1 : 0 };
}

/** 群主或管理员可操作（禁言开关等） */
export async function assertGroupOwnerOrAdmin(
  env: Env,
  groupId: string,
  actorWorkerBUrl: string,
): Promise<{ ok: true; isOwner: boolean } | ModErr> {
  const group = await loadGroupOwner(env, groupId);
  if (!group.ok) return group;
  const actor = normalizeGroupMemberUrl(actorWorkerBUrl);
  if (normalizeGroupMemberUrl(group.owner_worker_b_url) === actor) {
    return { ok: true, isOwner: true };
  }
  const member = await loadActiveMember(env, groupId, actor);
  if (!member.ok) return member;
  if (member.is_admin !== 1) {
    return { ok: false, status: 403, error_code: 'GROUP_NOT_MEMBER', message: '仅群主或管理员可操作' };
  }
  return { ok: true, isOwner: false };
}

/** 仅群主可操作（任命管理员等） */
export async function assertGroupOwnerOnly(
  env: Env,
  groupId: string,
  ownerWorkerBUrl: string,
): Promise<{ ok: true } | ModErr> {
  const group = await loadGroupOwner(env, groupId);
  if (!group.ok) return group;
  if (normalizeGroupMemberUrl(group.owner_worker_b_url) !== normalizeGroupMemberUrl(ownerWorkerBUrl)) {
    return { ok: false, status: 403, error_code: 'GROUP_NOT_MEMBER', message: '仅群主可操作' };
  }
  return { ok: true };
}

/** PUT mute：群主或管理员开关全员禁言 */
export async function setGroupMembersMuted(
  env: Env,
  groupId: string,
  actorWorkerBUrl: string,
  membersMuted: boolean,
): Promise<
  | { ok: true; data: { group_id: string; members_muted: boolean } }
  | ModErr
> {
  const gate = await assertGroupOwnerOrAdmin(env, groupId, actorWorkerBUrl);
  if (!gate.ok) return gate;
  const flag = membersMuted ? 1 : 0;
  await messagingDb(env)
    .prepare(`UPDATE groups SET members_muted = ?, updated_at = ? WHERE group_id = ?`)
    .bind(flag, nowIso(), groupId)
    .run();
  return { ok: true, data: { group_id: groupId, members_muted: membersMuted } };
}

/** PUT admins：仅群主任命/撤销；升管时 COUNT(is_admin=1) < GROUP_ADMIN_MAX */
export async function setGroupAdmin(
  env: Env,
  groupId: string,
  ownerWorkerBUrl: string,
  targetWorkerBUrl: string,
  isAdmin: boolean,
): Promise<
  | { ok: true; data: { group_id: string; member_worker_b_url: string; is_admin: boolean } }
  | ModErr
> {
  const ownerOk = await assertGroupOwnerOnly(env, groupId, ownerWorkerBUrl);
  if (!ownerOk.ok) return ownerOk;

  const targetUrl = normalizeGroupMemberUrl(targetWorkerBUrl);
  if (!targetUrl) {
    return { ok: false, status: 400, error_code: 'GROUP_ENVELOPE_INVALID', message: 'member_worker_b_url 无效' };
  }

  const group = await loadGroupOwner(env, groupId);
  if (!group.ok) return group;
  if (normalizeGroupMemberUrl(group.owner_worker_b_url) === targetUrl) {
    return { ok: false, status: 400, error_code: 'GROUP_ENVELOPE_INVALID', message: '不能将群主设为管理员' };
  }

  const target = await loadActiveMember(env, groupId, targetUrl);
  if (!target.ok) {
    return {
      ok: false,
      status: 404,
      error_code: 'GROUP_NOT_MEMBER',
      message: '目标成员不存在或不在册',
    };
  }

  const db = messagingDb(env);
  if (isAdmin) {
    if (target.is_admin === 1) {
      return {
        ok: true,
        data: { group_id: groupId, member_worker_b_url: targetUrl, is_admin: true },
      };
    }
    const countRow = await db
      .prepare(
        `SELECT COUNT(*) AS n FROM group_members
          WHERE group_id = ? AND is_admin = 1 AND status = 'active'`,
      )
      .bind(groupId)
      .first<{ n: number }>();
    const current = Number(countRow?.n ?? 0);
    if (current >= GROUP_ADMIN_MAX) {
      return {
        ok: false,
        status: 409,
        error_code: GROUP_ADMIN_LIMIT,
        message: `管理员人数已达上限（${GROUP_ADMIN_MAX}）`,
      };
    }
    await db
      .prepare(
        `UPDATE group_members SET is_admin = 1 WHERE group_id = ? AND member_worker_b_url = ?`,
      )
      .bind(groupId, targetUrl)
      .run();
    return {
      ok: true,
      data: { group_id: groupId, member_worker_b_url: targetUrl, is_admin: true },
    };
  }

  await db
    .prepare(
      `UPDATE group_members SET is_admin = 0 WHERE group_id = ? AND member_worker_b_url = ?`,
    )
    .bind(groupId, targetUrl)
    .run();
  return {
    ok: true,
    data: { group_id: groupId, member_worker_b_url: targetUrl, is_admin: false },
  };
}

/** PUT announcement：群主或管理员改公告（空字符串清空） */
export async function setGroupAnnouncement(
  env: Env,
  groupId: string,
  actorWorkerBUrl: string,
  announcement: string,
): Promise<
  | { ok: true; data: { group_id: string; announcement: string | null } }
  | ModErr
> {
  const gate = await assertGroupOwnerOrAdmin(env, groupId, actorWorkerBUrl);
  if (!gate.ok) return gate;
  const text = announcement.trim().slice(0, GROUP_ANNOUNCEMENT_MAX);
  const value = text.length > 0 ? text : null;
  await messagingDb(env)
    .prepare(`UPDATE groups SET announcement = ?, updated_at = ? WHERE group_id = ?`)
    .bind(value, nowIso(), groupId)
    .run();
  return { ok: true, data: { group_id: groupId, announcement: value } };
}

/** UX-GROUPS-7b：PUT name — 仅群主可改群名称（比 announcement 更收敛，避免管理员误改核心元数据）。 */
export async function setGroupName(
  env: Env,
  groupId: string,
  ownerWorkerBUrl: string,
  name: string,
): Promise<
  | { ok: true; data: { group_id: string; name: string } }
  | ModErr
> {
  const ownerOk = await assertGroupOwnerOnly(env, groupId, ownerWorkerBUrl);
  if (!ownerOk.ok) return ownerOk;
  const text = name.trim();
  if (text.length === 0) {
    return { ok: false, status: 400, error_code: 'GROUP_NAME_INVALID', message: '群名称不能为空' };
  }
  if (text.length > GROUP_NAME_MAX) {
    return {
      ok: false,
      status: 400,
      error_code: 'GROUP_NAME_INVALID',
      message: `群名称超过最大长度 ${GROUP_NAME_MAX}`,
    };
  }
  await messagingDb(env)
    .prepare(`UPDATE groups SET name = ?, updated_at = ? WHERE group_id = ?`)
    .bind(text, nowIso(), groupId)
    .run();
  return { ok: true, data: { group_id: groupId, name: text } };
}
