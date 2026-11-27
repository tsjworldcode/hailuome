/**
 * M16-5：群聊 retention GC（群主 3 天 / 成员 local_retention_days / nonce 7 天 / 全员 ack 即时删）。
 */
import { resolveIdentityDb } from '../db/bindings';
import type { Env } from '../env';
import { releaseRegisteredMediaObject } from './mediaObjectRegistry';
import {
  createExternalDeleteBudget,
  type ExternalDeleteBudget,
} from './mediaGcBudget';
import { messagingDb } from './messagingDb';
import { resolveGroupMessagesDb } from './messagingShard';
import { maybeLogMessagingDbWatermark } from './messagingDbCapacity';
import { gcDissolvedGroups } from './groupDissolve';
import { normalizeGroupMemberUrl } from './groupMemberUrl';

/** 群主权威 group_messages 保留天数（m16-group-chat-plan.md §四）。 */
export const GROUP_OWNER_RETENTION_DAYS = 3;

/** group_nonces 保留天数（对齐 M10 dm_nonces）。 */
export const GROUP_NONCE_RETENTION_DAYS = 7;

/** 成员本地默认 retention（无 group_sync_state 行时）。 */
export const GROUP_MEMBER_RETENTION_DEFAULT_DAYS = 90;

const GC_BATCH = 100;

export interface GroupGcResult {
  ownerMessages: number;
  ownerFullyAcked: number;
  memberMessages: number;
  nonces: number;
  fastPullRateBuckets: number;
  mediaReleased: number;
  dissolvedPurged: number;
  errors: string[];
}

function nowIso(): string {
  return new Date().toISOString();
}

function retentionCutoffIso(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

async function getLocalWorkerBUrl(env: Env): Promise<string | null> {
  const row = await resolveIdentityDb(env).prepare(`SELECT worker_b_url FROM users LIMIT 1`).first<{ worker_b_url: string }>();
  return row?.worker_b_url ? normalizeGroupMemberUrl(row.worker_b_url) : null;
}

/**
 * 释放 member retention 删掉的 mirrored 群图 blob（fail-soft）。
 * CRON-SCHEDULE-AUDIT：外部删除额度不足时返回 deferred=true，
 * 调用方必须保留下一条消息及其 media 行，下一轮重试，避免 blob 引用丢失。
 */
async function releaseMirroredMediaForMessages(
  env: Env,
  messageIds: string[],
  budget: ExternalDeleteBudget,
): Promise<{ released: number; deferred: boolean }> {
  if (messageIds.length === 0) return { released: 0, deferred: false };
  let released = 0;
  const db = messagingDb(env);
  for (const messageId of messageIds) {
    const rows = await db
      .prepare(
        `SELECT local_storage_key FROM messaging_media_local
          WHERE message_id = ? AND local_storage_key IS NOT NULL AND storage_state = 'mirrored'`,
      )
      .bind(messageId)
      .all<{ local_storage_key: string }>();
    let blocked = false;
    for (const row of rows.results ?? []) {
      try {
        const ok = await releaseRegisteredMediaObject(env, row.local_storage_key, budget);
        if (!ok) {
          blocked = true;
          break;
        }
        released += 1;
      } catch (err) {
        console.warn('[groupGc] 释放群图 blob 失败', row.local_storage_key, err);
      }
    }
    if (blocked) return { released, deferred: true };
    await db.prepare(`DELETE FROM messaging_media_local WHERE message_id = ?`).bind(messageId).run();
  }
  return { released, deferred: false };
}

/** 群主侧：3 天硬删 + 在册非 owner 全员 ack 后立即删。 */
async function gcOwnerGroupMessages(env: Env, localUrl: string, result: GroupGcResult): Promise<void> {
  const db = messagingDb(env);
  const cutoff = retentionCutoffIso(GROUP_OWNER_RETENTION_DAYS);

  try {
    const { results: owned } = await db
      .prepare(`SELECT group_id FROM groups WHERE owner_worker_b_url = ? AND dissolved_at IS NULL`)
      .bind(localUrl)
      .all<{ group_id: string }>();

    for (const g of owned ?? []) {
      const msgDb = await resolveGroupMessagesDb(env, g.group_id);
      const batch = await msgDb
        .prepare(
          `SELECT message_id FROM group_messages WHERE group_id = ? AND created_at < ? LIMIT ?`,
        )
        .bind(g.group_id, cutoff, GC_BATCH)
        .all<{ message_id: string }>();
      const agedIds = (batch.results ?? []).map((r) => r.message_id);
      if (agedIds.length === 0) continue;
      const placeholders = agedIds.map(() => '?').join(',');
      const del = await msgDb
        .prepare(`DELETE FROM group_messages WHERE message_id IN (${placeholders})`)
        .bind(...agedIds)
        .run();
      result.ownerMessages += del.meta.changes ?? 0;
    }
  } catch (err) {
    result.errors.push(`owner_aged: ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    const { results: ownedGroups } = await db
      .prepare(`SELECT group_id FROM groups WHERE owner_worker_b_url = ? AND dissolved_at IS NULL`)
      .bind(localUrl)
      .all<{ group_id: string }>();

    for (const { group_id: groupId } of ownedGroups ?? []) {
      const msgDb = await resolveGroupMessagesDb(env, groupId);
      const activeRow = await db
        .prepare(
          `SELECT COUNT(*) AS cnt FROM group_members
            WHERE group_id = ? AND status = 'active' AND role != 'owner'`,
        )
        .bind(groupId)
        .first<{ cnt: number }>();
      const needAcks = activeRow?.cnt ?? 0;
      if (needAcks === 0) continue;

      const { results: candidates } = await msgDb
        .prepare(
          `SELECT message_id FROM group_messages WHERE group_id = ? ORDER BY created_at ASC LIMIT ?`,
        )
        .bind(groupId, GC_BATCH)
        .all<{ message_id: string }>();

      for (const { message_id: messageId } of candidates ?? []) {
        const ackRow = await db
          .prepare(
            `SELECT COUNT(DISTINCT a.member_worker_b_url) AS cnt
               FROM group_message_acks a, json_each(a.acks_json) je
              WHERE a.group_id = ? AND je.value = ?`,
          )
          .bind(groupId, messageId)
          .first<{ cnt: number }>();
        if ((ackRow?.cnt ?? 0) >= needAcks) {
          await msgDb.prepare(`DELETE FROM group_messages WHERE message_id = ?`).bind(messageId).run();
          result.ownerFullyAcked += 1;
        }
      }
    }
  } catch (err) {
    result.errors.push(`owner_fully_acked: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** 成员侧：按 group_sync_state.local_retention_days 删 member_group_messages + mirrored blob。 */
async function gcMemberGroupMessages(
  env: Env,
  result: GroupGcResult,
  budget: ExternalDeleteBudget,
): Promise<void> {
  const db = messagingDb(env);
  const defaultCutoff = retentionCutoffIso(GROUP_MEMBER_RETENTION_DEFAULT_DAYS);

  try {
    const { results: states } = await db
      .prepare(`SELECT group_id, local_retention_days FROM group_sync_state`)
      .all<{ group_id: string; local_retention_days: number }>();

    const seenGroups = new Set<string>();
    for (const row of states ?? []) {
      seenGroups.add(row.group_id);
      const days =
        Number.isFinite(row.local_retention_days) && row.local_retention_days > 0
          ? row.local_retention_days
          : GROUP_MEMBER_RETENTION_DEFAULT_DAYS;
      const cutoff = retentionCutoffIso(days);
      const msgDb = await resolveGroupMessagesDb(env, row.group_id);
      const doomed = await msgDb
        .prepare(
          `SELECT message_id FROM member_group_messages
            WHERE group_id = ? AND created_at < ? LIMIT ?`,
        )
        .bind(row.group_id, cutoff, GC_BATCH)
        .all<{ message_id: string }>();
      const ids = (doomed.results ?? []).map((r) => r.message_id);
      const rel = await releaseMirroredMediaForMessages(env, ids, budget);
      result.mediaReleased += rel.released;
      // 外部删除额度用尽：本群消息暂不删，保留 media 行，下一轮继续。
      if (rel.deferred) break;
      const del = await msgDb
        .prepare(`DELETE FROM member_group_messages WHERE group_id = ? AND created_at < ?`)
        .bind(row.group_id, cutoff)
        .run();
      result.memberMessages += del.meta.changes ?? 0;
    }

    const delOrphan = await db
      .prepare(
        `DELETE FROM member_group_messages
          WHERE group_id NOT IN (SELECT group_id FROM group_sync_state)
            AND created_at < ?`,
      )
      .bind(defaultCutoff)
      .run();
    result.memberMessages += delOrphan.meta.changes ?? 0;
  } catch (err) {
    result.errors.push(`member_messages: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function gcGroupNonces(env: Env, result: GroupGcResult): Promise<void> {
  const cutoff = retentionCutoffIso(GROUP_NONCE_RETENTION_DAYS);
  try {
    const r = await messagingDb(env)
      .prepare(`DELETE FROM group_nonces WHERE created_at < ?`)
      .bind(cutoff)
      .run();
    result.nonces = r.meta.changes ?? 0;
  } catch (err) {
    result.errors.push(`group_nonces: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** SEC-5：只清理补钥过期桶，按批回收且绝不重置当前小时额度。 */
async function gcGroupFastPullRateBuckets(env: Env, result: GroupGcResult): Promise<void> {
  try {
    const r = await messagingDb(env).prepare(
      `DELETE FROM group_rate_buckets WHERE bucket_key IN (
         SELECT bucket_key FROM group_rate_buckets
         WHERE bucket_key LIKE 'fast-pull|%' AND window_start < ? LIMIT ?
       )`,
    ).bind(retentionCutoffIso(1), GC_BATCH).run();
    if (!r.success) throw new Error('fast-pull bucket GC unavailable');
    result.fastPullRateBuckets = r.meta.changes ?? 0;
  } catch {
    // 不记录桶键或原始异常，避免带出群成员地址。
    result.errors.push('fast_pull_rate_buckets: unavailable');
  }
}

/** 群 retention + nonce GC（D1 only，Cron 串行调用）。 */
export async function gcGroupRetention(env: Env): Promise<GroupGcResult> {
  const result: GroupGcResult = {
    ownerMessages: 0,
    ownerFullyAcked: 0,
    memberMessages: 0,
    nonces: 0,
    fastPullRateBuckets: 0,
    mediaReleased: 0,
    dissolvedPurged: 0,
    errors: [],
  };

  try {
    result.dissolvedPurged = await gcDissolvedGroups(env);
  } catch (err) {
    result.errors.push(`dissolved: ${err instanceof Error ? err.message : String(err)}`);
  }

  const localUrl = await getLocalWorkerBUrl(env);
  if (localUrl) {
    await gcOwnerGroupMessages(env, localUrl, result);
  }
  await gcMemberGroupMessages(env, result, createExternalDeleteBudget());
  await gcGroupNonces(env, result);
  await gcGroupFastPullRateBuckets(env, result);

  if (
    result.ownerMessages +
      result.ownerFullyAcked +
      result.memberMessages +
      result.nonces +
      result.fastPullRateBuckets +
      result.mediaReleased +
      result.dissolvedPurged >
      0 ||
    result.errors.length > 0
  ) {
    console.log('[cron/gc] gcGroupRetention', JSON.stringify({ ...result, at: nowIso() }));
  }

  try {
    await maybeLogMessagingDbWatermark(env);
  } catch (err) {
    result.errors.push(`watermark: ${err instanceof Error ? err.message : String(err)}`);
  }

  return result;
}
