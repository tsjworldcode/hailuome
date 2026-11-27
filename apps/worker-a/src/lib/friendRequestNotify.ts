/**
 * M17 · 加好友本地通知 helper（M17-1c 跨节点 inbox / outbox 用）
 *
 * 不动既有 lib/localNotifications.ts.recordLocalNotification（M9-20 19 项契约零回归）；
 * 本文件专为"加好友类型通知"扩展，type 来自 migration 0061 新增的
 *   friend_request_received / friend_request_accepted / friend_request_rejected
 *
 * 失败 fail-soft（console.warn）— 通知非关键路径，绝不阻断主流程。
 */

import { generateId, nowISO } from '@hailuo/shared-utils';
import type { Env } from '../env';
import { resolveGovernanceDb } from '../db/bindings';

export type FriendRequestNotificationType =
  | 'friend_request_received'
  | 'friend_request_accepted'
  | 'friend_request_rejected'
  /** M17-4-1：发起方撤回 pending 请求后对端通知 */
  | 'friend_request_cancelled'
  /** REL-FIX-11：发起方撤回 pending 请求后，本端站主自己的可见性通知 */
  | 'friend_request_withdrawn';

export interface RecordFriendRequestNotificationInput {
  readonly type: FriendRequestNotificationType;
  readonly request_id: string;
  readonly actor_handle: string;
  readonly actor_node_url: string;
  readonly related_node_url: string;
  readonly content_preview?: string;
}

export async function recordFriendRequestNotification(
  env: Env,
  input: RecordFriendRequestNotificationInput,
): Promise<void> {
  try {
    await resolveGovernanceDb(env)
      .prepare(
        `INSERT INTO local_notifications
           (id, type, post_id, actor_handle, actor_node_url, reply_id, content_preview,
            related_node_url, request_id, created_at, read_at)
         VALUES (?, ?, NULL, ?, ?, NULL, ?, ?, ?, ?, NULL)`,
      )
      .bind(
        generateId('notif'),
        input.type,
        input.actor_handle,
        input.actor_node_url,
        input.content_preview ?? null,
        input.related_node_url,
        input.request_id,
        nowISO(),
      )
      .run();
  } catch (err) {
    console.warn('[friendRequestNotify] 写入加好友通知失败', err);
  }
}
