/**
 * GROUP-CAP-SPEAK-1：群员硬上限（含群主共 2000）。
 * 占用 = active/pending 成员 + 尚未入册的 pending_members（去重，避免审批双计）。
 * 存储：只读 D1 COUNT，零 KV 写。
 */
import type { Env } from '../env';
import { messagingDb } from './messagingDb';

/** 含群主共 2000；满员拒绝新入群 / 新 pending。 */
export const GROUP_MEMBER_LIMIT = 2000;

export type GroupJoinSlotDenied = {
  ok: false;
  status: 409;
  error_code: 'GROUP_MEMBER_LIMIT';
  message: string;
};

export type GroupJoinSlotResult = { ok: true } | GroupJoinSlotDenied;

/** 统计已占坑位（含群主；不含 kicked / left）。 */
export async function countGroupOccupancy(env: Env, groupId: string): Promise<number> {
  const db = messagingDb(env);
  const row = await db
    .prepare(
      `SELECT (
         SELECT COUNT(*) FROM group_members
          WHERE group_id = ? AND status IN ('active', 'pending')
       ) + (
         SELECT COUNT(*) FROM group_pending_members pm
          WHERE pm.group_id = ?
            AND NOT EXISTS (
              SELECT 1 FROM group_members gm
               WHERE gm.group_id = pm.group_id
                 AND gm.member_worker_b_url = pm.member_worker_b_url
                 AND gm.status IN ('active', 'pending')
            )
       ) AS c`,
    )
    .bind(groupId, groupId)
    .first<{ c: number }>();
  return Number(row?.c ?? 0);
}

/** 入群写库前调用；已占满则 409 GROUP_MEMBER_LIMIT。 */
export async function assertGroupHasJoinSlot(
  env: Env,
  groupId: string,
): Promise<GroupJoinSlotResult> {
  const n = await countGroupOccupancy(env, groupId);
  if (n >= GROUP_MEMBER_LIMIT) {
    return {
      ok: false,
      status: 409,
      error_code: 'GROUP_MEMBER_LIMIT',
      message: '群已满员（含群主共 2000 人）',
    };
  }
  return { ok: true };
}
