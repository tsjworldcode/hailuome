/**
 * M9-20：站主本地互动通知（D1 权威，JWT 轮询读取）。
 * M17-2：list 扩返回 friend_request_* 类型 + request_id / related_node_url（0061 列）。
 * recordLocalNotification 仍仅写 like/reply，加好友写入走 friendRequestNotify。
 */
import { generateId, nowISO } from '@hailuo/shared-utils';
import type { Env } from '../env';
import { resolveGovernanceDb } from '../db/bindings';

export type LocalNotificationType =
  | 'like'
  | 'reply'
  | 'friend_request_received'
  | 'friend_request_accepted'
  | 'friend_request_rejected'
  | 'friend_request_cancelled'
  /** REL-FIX-11：发起方撤回加好友请求后，本端站主自己的可见性通知 */
  | 'friend_request_withdrawn'
  | 'group_join_request_received'
  /** REL-FIX-7：群主同意入群（申请人节点本地） */
  | 'group_join_approved'
  /** REL-FIX-7：群主拒绝入群（申请人节点本地） */
  | 'group_join_rejected';

export interface LocalNotificationRow {
  readonly id: string;
  readonly type: LocalNotificationType;
  readonly post_id: string | null;
  readonly actor_handle: string;
  readonly actor_node_url: string;
  readonly reply_id: string | null;
  readonly content_preview: string | null;
  readonly related_node_url: string | null;
  readonly request_id: string | null;
  readonly created_at: string;
  readonly read_at: string | null;
}

export interface RecordLocalNotificationInput {
  readonly type: 'like' | 'reply';
  readonly post_id: string;
  readonly actor_handle: string;
  readonly actor_node_url: string;
  readonly reply_id?: string;
  readonly content_preview?: string;
}

const CONTENT_PREVIEW_MAX = 80;

const LIST_SELECT = `SELECT id, type, post_id, actor_handle, actor_node_url, reply_id, content_preview,
            related_node_url, request_id, created_at, read_at
           FROM local_notifications`;

export function truncatePreview(content: string): string {
  const chars = [...content.trim()];
  if (chars.length <= CONTENT_PREVIEW_MAX) return chars.join('');
  return `${chars.slice(0, CONTENT_PREVIEW_MAX).join('')}…`;
}

/** 他人对本节点帖子点赞/回复成功后写入通知（fail-soft，不阻断主流程）。 */
export async function recordLocalNotification(
  env: Env,
  input: RecordLocalNotificationInput,
): Promise<void> {
  try {
    await resolveGovernanceDb(env)
      .prepare(
        `INSERT INTO local_notifications
         (id, type, post_id, actor_handle, actor_node_url, reply_id, content_preview, created_at, read_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .bind(
        generateId('notif'),
        input.type,
        input.post_id,
        input.actor_handle,
        input.actor_node_url,
        input.reply_id ?? null,
        input.content_preview ?? null,
        nowISO(),
      )
      .run();
  } catch (err) {
    console.warn('[localNotifications] 写入通知失败', err);
  }
}

export async function countUnreadLocalNotifications(env: Env): Promise<number> {
  const row = await resolveGovernanceDb(env)
    .prepare(`SELECT COUNT(*) AS count FROM local_notifications WHERE read_at IS NULL`)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

export async function listLocalNotifications(
  env: Env,
  opts: { limit: number; before?: string | null },
): Promise<{ items: LocalNotificationRow[]; has_more: boolean; next_cursor: string | null }> {
  const governanceDb = resolveGovernanceDb(env);
  const limit = opts.limit;
  const fetchN = limit + 1;
  let rows: LocalNotificationRow[];

  if (!opts.before) {
    const result = await governanceDb
      .prepare(`${LIST_SELECT} ORDER BY created_at DESC, id DESC LIMIT ?`)
      .bind(fetchN)
      .all<LocalNotificationRow>();
    rows = result.results ?? [];
  } else {
    const cursor = await governanceDb
      .prepare(`SELECT created_at, id FROM local_notifications WHERE id = ? LIMIT 1`)
      .bind(opts.before)
      .first<{ created_at: string; id: string }>();
    if (!cursor) {
      return { items: [], has_more: false, next_cursor: null };
    }
    const result = await governanceDb
      .prepare(
        `${LIST_SELECT}
          WHERE created_at < ? OR (created_at = ? AND id < ?)
          ORDER BY created_at DESC, id DESC
          LIMIT ?`,
      )
      .bind(cursor.created_at, cursor.created_at, cursor.id, fetchN)
      .all<LocalNotificationRow>();
    rows = result.results ?? [];
  }

  const has_more = rows.length > limit;
  const items = has_more ? rows.slice(0, limit) : rows;
  const next_cursor = has_more && items.length > 0 ? items[items.length - 1]!.id : null;
  return { items, has_more, next_cursor };
}

/** 标记已读：传 ids 则只标指定项，否则全部未读标已读。 */
export async function markLocalNotificationsRead(env: Env, ids?: readonly string[]): Promise<number> {
  const readAt = nowISO();
  const governanceDb = resolveGovernanceDb(env);
  if (ids && ids.length > 0) {
    let changed = 0;
    for (const id of ids) {
      const result = await governanceDb
        .prepare(`UPDATE local_notifications SET read_at = ? WHERE id = ? AND read_at IS NULL`)
        .bind(readAt, id)
        .run();
      changed += result.meta.changes ?? 0;
    }
    return changed;
  }
  const result = await governanceDb
    .prepare(`UPDATE local_notifications SET read_at = ? WHERE read_at IS NULL`)
    .bind(readAt)
    .run();
  return result.meta.changes ?? 0;
}
