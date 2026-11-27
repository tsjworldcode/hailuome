/**
 * REL-FIX-3 · 入群待审批站内通知 helper。
 *
 * 镜像 friendRequestNotify.ts 的 fail-soft 写法：
 * - 只在 approval / requires_approval 落 status='pending' 之后由调用点显式调用
 * - 重复申请走调用点早返回（existing pending → 直接 return），天然幂等，不写第二行
 * - 通知仅站主 JWT 可读；content_preview 只放群名 + 申请人 handle（禁邮箱/pubkey/完整 URL）
 * - D1 写（GOVERNANCE_DB），零 KV 写，零新 binding
 */

import { generateId, nowISO } from '@hailuo/shared-utils';
import type { Env } from '../env';
import { resolveGovernanceDb } from '../db/bindings';
import { truncatePreview } from './localNotifications';

export const GROUP_JOIN_NOTIFICATION_TYPE = 'group_join_request_received' as const;

export interface RecordGroupJoinNotificationInput {
  /** 群 id；复用 request_id 列（群申请无 friend_requests.id，便于前端一键跳转群设置） */
  readonly group_id: string;
  readonly group_name: string;
  readonly member_handle: string;
  readonly member_worker_b_url: string;
}

export async function recordGroupJoinRequestNotification(
  env: Env,
  input: RecordGroupJoinNotificationInput,
): Promise<void> {
  try {
    const preview = truncatePreview(`${input.group_name} · @${input.member_handle}`);
    await resolveGovernanceDb(env)
      .prepare(
        `INSERT INTO local_notifications
           (id, type, post_id, actor_handle, actor_node_url, reply_id, content_preview,
            related_node_url, request_id, created_at, read_at)
         VALUES (?, ?, NULL, ?, ?, NULL, ?, ?, ?, ?, NULL)`,
      )
      .bind(
        generateId('notif'),
        GROUP_JOIN_NOTIFICATION_TYPE,
        input.member_handle,
        input.member_worker_b_url,
        preview,
        input.member_worker_b_url,
        input.group_id,
        nowISO(),
      )
      .run();
  } catch (err) {
    console.warn('[groupJoinNotify] 写入入群待审批通知失败', err);
  }
}
