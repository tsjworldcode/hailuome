/**
 * M-RT-1：消息通知 cursor 快照（仅 id + cursor，无明文）。
 * 供 Owner Gateway SSE 推送；D1 读廉价，不写 KV。
 */
import type { Env } from '../env';
import { messagingDb } from './messagingDb';

export type MessagingNotifyScope = 'dm' | 'group';

export interface MessagingNotifyTip {
  readonly scope: MessagingNotifyScope;
  readonly id: string;
  /** 可比字符串：created_at + TAB + message_id */
  readonly cursor: string;
}

function tipCursor(createdAt: string, messageId: string): string {
  return `${createdAt}\t${messageId}`;
}

async function latestFromTable(
  env: Env,
  table: 'dm_messages' | 'member_group_messages' | 'group_messages',
  scope: MessagingNotifyScope,
): Promise<MessagingNotifyTip | null> {
  const row = await messagingDb(env)
    .prepare(
      `SELECT message_id AS id, created_at
         FROM ${table}
        ORDER BY created_at DESC, message_id DESC
        LIMIT 1`,
    )
    .first<{ id: string; created_at: string }>();
  if (!row?.id || !row.created_at) return null;
  return { scope, id: row.id, cursor: tipCursor(row.created_at, row.id) };
}

/** 群侧取 member / owner 两表较新的 tip。 */
export async function readMessagingNotifyTips(env: Env): Promise<{
  dm: MessagingNotifyTip | null;
  group: MessagingNotifyTip | null;
}> {
  const [dm, member, owner] = await Promise.all([
    latestFromTable(env, 'dm_messages', 'dm'),
    latestFromTable(env, 'member_group_messages', 'group'),
    latestFromTable(env, 'group_messages', 'group'),
  ]);
  let group: MessagingNotifyTip | null = null;
  if (member && owner) {
    group = member.cursor >= owner.cursor ? member : owner;
  } else {
    group = member ?? owner;
  }
  return { dm, group };
}

export function compareCursor(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}
