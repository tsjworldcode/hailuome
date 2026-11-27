/**
 * M16-P4b：群消息 primary → MESSAGING_SHARD_1 batch 搬迁（与 migrate-group-messages-to-shard.mjs 语义对齐）。
 */
import { resolveIdentityDb } from '../db/bindings';
import type { Env } from '../env';
import { messagingDb } from './messagingDb';
import {
  hasMessagingShard1,
  invalidateGroupCacheAcrossShards,
  registerGroupMessageShardRoute,
} from './messagingShard';

/** R-AUDIT-2：默认每批 20 行，留出容量探测/登记/删除余量，贴近 Free Tier ≤50 queries/invocation */
export const MESSAGING_AUTO_SHARD_BATCH_ROWS_DEFAULT = 20;

export type ShardMessageTable = 'group_messages' | 'member_group_messages';

type GroupMessageRow = {
  message_id: string;
  group_id: string;
  epoch: number;
  sender_worker_b_url: string;
  sender_handle: string;
  msg_kind: string;
  ciphertext: string;
  created_at: string;
  expires_at: string | null;
  envelope_json: string | null;
  /** MSG-FIX-4：搬迁时保留单调序，避免分片后 sync 空洞 */
  recv_seq: number | null;
  received_at: string | null;
};

type MemberGroupMessageRow = {
  message_id: string;
  group_id: string;
  epoch: number;
  sender_worker_b_url: string;
  sender_handle: string;
  msg_kind: string;
  ciphertext: string;
  created_at: string;
  envelope_json: string | null;
  recv_seq: number | null;
  received_at: string | null;
};

const SHARD_TABLES: ShardMessageTable[] = ['group_messages', 'member_group_messages'];

/** R-AUDIT-5：硬封顶与默认同为 20，禁止再调到 40 以免单 invocation 超 50 D1 queries。 */
export const MESSAGING_AUTO_SHARD_BATCH_ROWS_MAX = 20;

/** 每 tick 搬迁行数上限（默认 20；env 硬封顶 20）。 */
export function resolveAutoShardBatchRows(env: Env): number {
  const raw = env.MESSAGING_AUTO_SHARD_BATCH_ROWS?.trim();
  if (!raw) return MESSAGING_AUTO_SHARD_BATCH_ROWS_DEFAULT;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return MESSAGING_AUTO_SHARD_BATCH_ROWS_DEFAULT;
  return Math.min(n, MESSAGING_AUTO_SHARD_BATCH_ROWS_MAX);
}

async function countGroupRowsOnDb(
  db: D1Database,
  table: ShardMessageTable,
  groupId: string,
): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE group_id = ?`)
    .bind(groupId)
    .first<{ n: number }>();
  return Number(row?.n ?? 0);
}

/** primary 上该群两表是否均已清空。 */
export async function isGroupEmptyOnPrimary(env: Env, groupId: string): Promise<boolean> {
  const primary = messagingDb(env);
  for (const table of SHARD_TABLES) {
    if ((await countGroupRowsOnDb(primary, table, groupId)) > 0) return false;
  }
  return true;
}

/**
 * 在尚未登记 shard_1 的群中，按消息字节合计取 primary 上最大一群。
 */
export async function pickLargestPrimaryGroupForAutoShard(env: Env): Promise<string | null> {
  const primary = messagingDb(env);
  const row = await primary
    .prepare(
      `SELECT group_id
         FROM (
           SELECT gm.group_id AS group_id,
                  SUM(LENGTH(gm.ciphertext) + LENGTH(COALESCE(gm.envelope_json, ''))) AS total_bytes
             FROM (
               SELECT group_id, ciphertext, envelope_json FROM group_messages
               UNION ALL
               SELECT group_id, ciphertext, envelope_json FROM member_group_messages
             ) gm
            WHERE gm.group_id NOT IN (
              SELECT group_id FROM group_message_shard_routes WHERE shard_id = 'shard_1'
            )
            GROUP BY gm.group_id
         )
        WHERE total_bytes > 0
        ORDER BY total_bytes DESC
        LIMIT 1`,
    )
    .first<{ group_id: string }>();
  return row?.group_id ?? null;
}

async function fetchGroupMessageBatch(
  primary: D1Database,
  groupId: string,
  limit: number,
): Promise<GroupMessageRow[]> {
  const { results } = await primary
    .prepare(
      `SELECT message_id, group_id, epoch, sender_worker_b_url, sender_handle, msg_kind,
              ciphertext, created_at, expires_at, envelope_json, recv_seq, received_at
         FROM group_messages
        WHERE group_id = ?
        ORDER BY created_at ASC, message_id ASC
        LIMIT ?`,
    )
    .bind(groupId, limit)
    .all<GroupMessageRow>();
  return results ?? [];
}

async function fetchMemberGroupMessageBatch(
  primary: D1Database,
  groupId: string,
  limit: number,
): Promise<MemberGroupMessageRow[]> {
  const { results } = await primary
    .prepare(
      `SELECT message_id, group_id, epoch, sender_worker_b_url, sender_handle, msg_kind,
              ciphertext, created_at, envelope_json, recv_seq, received_at
         FROM member_group_messages
        WHERE group_id = ?
        ORDER BY created_at ASC, message_id ASC
        LIMIT ?`,
    )
    .bind(groupId, limit)
    .all<MemberGroupMessageRow>();
  return results ?? [];
}

async function copyGroupMessagesToShard(shard: D1Database, rows: GroupMessageRow[]): Promise<void> {
  if (rows.length === 0) return;
  const stmts = rows.map((row) =>
    shard
      .prepare(
        `INSERT OR IGNORE INTO group_messages
         (message_id, group_id, epoch, sender_worker_b_url, sender_handle, msg_kind,
          ciphertext, created_at, expires_at, envelope_json, recv_seq, received_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        row.message_id,
        row.group_id,
        row.epoch,
        row.sender_worker_b_url,
        row.sender_handle,
        row.msg_kind,
        row.ciphertext,
        row.created_at,
        row.expires_at,
        row.envelope_json,
        row.recv_seq,
        row.received_at,
      ),
  );
  await shard.batch(stmts);
}

async function copyMemberGroupMessagesToShard(
  shard: D1Database,
  rows: MemberGroupMessageRow[],
): Promise<void> {
  if (rows.length === 0) return;
  const stmts = rows.map((row) =>
    shard
      .prepare(
        `INSERT OR IGNORE INTO member_group_messages
         (message_id, group_id, epoch, sender_worker_b_url, sender_handle, msg_kind,
          ciphertext, created_at, envelope_json, recv_seq, received_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        row.message_id,
        row.group_id,
        row.epoch,
        row.sender_worker_b_url,
        row.sender_handle,
        row.msg_kind,
        row.ciphertext,
        row.created_at,
        row.envelope_json,
        row.recv_seq,
        row.received_at,
      ),
  );
  await shard.batch(stmts);
}

async function deleteGroupMessagesFromPrimary(
  primary: D1Database,
  groupId: string,
  messageIds: string[],
): Promise<void> {
  if (messageIds.length === 0) return;
  const placeholders = messageIds.map(() => '?').join(', ');
  await primary
    .prepare(
      `DELETE FROM group_messages
        WHERE group_id = ? AND message_id IN (${placeholders})`,
    )
    .bind(groupId, ...messageIds)
    .run();
}

async function deleteMemberGroupMessagesFromPrimary(
  primary: D1Database,
  groupId: string,
  messageIds: string[],
): Promise<void> {
  if (messageIds.length === 0) return;
  const placeholders = messageIds.map(() => '?').join(', ');
  await primary
    .prepare(
      `DELETE FROM member_group_messages
        WHERE group_id = ? AND message_id IN (${placeholders})`,
    )
    .bind(groupId, ...messageIds)
    .run();
}

/**
 * 单 tick：搬迁至多 limit 行（两表合计），先 group_messages 再 member_group_messages。
 */
export async function migrateGroupMessagesToShardBatch(
  env: Env,
  groupId: string,
  limit: number,
): Promise<number> {
  if (!hasMessagingShard1(env)) return 0;
  const primary = messagingDb(env);
  const shard = env.MESSAGING_SHARD_1!;
  let remaining = limit;
  let moved = 0;

  if (remaining > 0) {
    const rows = await fetchGroupMessageBatch(primary, groupId, remaining);
    if (rows.length > 0) {
      await copyGroupMessagesToShard(shard, rows);
      await deleteGroupMessagesFromPrimary(
        primary,
        groupId,
        rows.map((r) => r.message_id),
      );
      moved += rows.length;
      remaining -= rows.length;
    }
  }

  if (remaining > 0) {
    const rows = await fetchMemberGroupMessageBatch(primary, groupId, remaining);
    if (rows.length > 0) {
      await copyMemberGroupMessagesToShard(shard, rows);
      await deleteMemberGroupMessagesFromPrimary(
        primary,
        groupId,
        rows.map((r) => r.message_id),
      );
      moved += rows.length;
    }
  }

  return moved;
}

export const AUTO_SHARD_LAST_GROUP_KEY = 'messaging_auto_shard_last_group';
export const AUTO_SHARD_LAST_AT_KEY = 'messaging_auto_shard_last_at';
export const AUTO_SHARD_LAST_ERROR_KEY = 'messaging_auto_shard_last_error';
export const AUTO_SHARD_LAST_ERROR_AT_KEY = 'messaging_auto_shard_last_error_at';

/** 登记路由后 final drain 最多批次数（消化 count→register 竞态窗口）。 */
const FINAL_DRAIN_MAX_BATCHES = 5;

/** primary 上仍有消息、尚未登记 shard_1 的群数量（P4c 可观测）。 */
export async function countPrimaryPendingAutoShardGroups(env: Env): Promise<number> {
  const primary = messagingDb(env);
  const row = await primary
    .prepare(
      `SELECT COUNT(DISTINCT group_id) AS n
         FROM (
           SELECT group_id FROM group_messages
           UNION
           SELECT group_id FROM member_group_messages
         ) g
        WHERE group_id NOT IN (
          SELECT group_id FROM group_message_shard_routes WHERE shard_id = 'shard_1'
        )`,
    )
    .first<{ n: number }>();
  return Number(row?.n ?? 0);
}

/** 读取 Cron 卸货进度与最近失败（P4c/P4e 可观测）。 */
export async function readAutoShardProgress(
  env: Env,
): Promise<{
  lastGroupId: string | null;
  lastAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
}> {
  const rows = await resolveIdentityDb(env).batch([
    resolveIdentityDb(env).prepare('SELECT value FROM system_config WHERE key = ? LIMIT 1').bind(
      AUTO_SHARD_LAST_GROUP_KEY,
    ),
    resolveIdentityDb(env).prepare('SELECT value FROM system_config WHERE key = ? LIMIT 1').bind(
      AUTO_SHARD_LAST_AT_KEY,
    ),
    resolveIdentityDb(env).prepare('SELECT value FROM system_config WHERE key = ? LIMIT 1').bind(
      AUTO_SHARD_LAST_ERROR_KEY,
    ),
    resolveIdentityDb(env).prepare('SELECT value FROM system_config WHERE key = ? LIMIT 1').bind(
      AUTO_SHARD_LAST_ERROR_AT_KEY,
    ),
  ]);
  const lastGroupRow = rows[0]?.results?.[0] as { value?: string } | undefined;
  const lastAtRow = rows[1]?.results?.[0] as { value?: string } | undefined;
  const lastErrorRow = rows[2]?.results?.[0] as { value?: string } | undefined;
  const lastErrorAtRow = rows[3]?.results?.[0] as { value?: string } | undefined;
  return {
    lastGroupId: lastGroupRow?.value ?? null,
    lastAt: lastAtRow?.value ?? null,
    lastError: lastErrorRow?.value ?? null,
    lastErrorAt: lastErrorAtRow?.value ?? null,
  };
}

async function writeAutoShardProgress(env: Env, groupId: string): Promise<void> {
  const now = new Date().toISOString();
  await resolveIdentityDb(env).batch([
    resolveIdentityDb(env)
      .prepare('INSERT OR REPLACE INTO system_config (key, value, updated_at) VALUES (?, ?, ?)')
      .bind(AUTO_SHARD_LAST_GROUP_KEY, groupId, now),
    resolveIdentityDb(env)
      .prepare('INSERT OR REPLACE INTO system_config (key, value, updated_at) VALUES (?, ?, ?)')
      .bind(AUTO_SHARD_LAST_AT_KEY, now, now),
    resolveIdentityDb(env).prepare('DELETE FROM system_config WHERE key = ?').bind(AUTO_SHARD_LAST_ERROR_KEY),
    resolveIdentityDb(env).prepare('DELETE FROM system_config WHERE key = ?').bind(AUTO_SHARD_LAST_ERROR_AT_KEY),
  ]);
}

/** 记录自动卸货失败（§4 fail-soft + P4e 可观测）。 */
export async function writeAutoShardError(env: Env, message: string): Promise<void> {
  const now = new Date().toISOString();
  const trimmed = message.trim().slice(0, 480);
  await resolveIdentityDb(env).batch([
    resolveIdentityDb(env)
      .prepare('INSERT OR REPLACE INTO system_config (key, value, updated_at) VALUES (?, ?, ?)')
      .bind(AUTO_SHARD_LAST_ERROR_KEY, trimmed, now),
    resolveIdentityDb(env)
      .prepare('INSERT OR REPLACE INTO system_config (key, value, updated_at) VALUES (?, ?, ?)')
      .bind(AUTO_SHARD_LAST_ERROR_AT_KEY, now, now),
  ]);
}

/** primary 该群已空则登记 shard_1；登记后 final drain 消化竞态滞留行。 */
export async function finalizeGroupShardRouteIfEmpty(
  env: Env,
  groupId: string,
): Promise<boolean> {
  if (!(await isGroupEmptyOnPrimary(env, groupId))) return false;

  await registerGroupMessageShardRoute(env, groupId, 'shard_1');

  // SPILL-2-4：路由一改就失效群级 STATE_KV cache（fail-soft）。
  // 放在 register 之后、drain 之前：即使后续 drain 失败、本函数返 false，
  // 读路径也不会继续命中「以为还在 primary」的过期缓存。
  await invalidateGroupCacheAcrossShards(env, groupId);

  const batchLimit = resolveAutoShardBatchRows(env);
  let batches = 0;
  while (!(await isGroupEmptyOnPrimary(env, groupId)) && batches < FINAL_DRAIN_MAX_BATCHES) {
    const moved = await migrateGroupMessagesToShardBatch(env, groupId, batchLimit);
    if (moved === 0) break;
    batches += 1;
  }

  if (!(await isGroupEmptyOnPrimary(env, groupId))) {
    await writeAutoShardError(
      env,
      `群 ${groupId} 已登记 shard_1 但 primary 仍有滞留消息，请运行 migrate-group-messages-to-shard.mjs 补迁`,
    );
    return false;
  }

  await writeAutoShardProgress(env, groupId);
  return true;
}

export type AutoShardMigrationTickResult = {
  skipped: boolean;
  reason?: string;
  groupId?: string;
  rowsMoved?: number;
  routed?: boolean;
};
