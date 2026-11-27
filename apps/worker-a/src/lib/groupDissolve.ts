/**
 * M16-6：群解散（群主设 dissolved_at）+ 48h 后本地副本 GC。
 */
import type { Env } from '../env';
import { releaseRegisteredMediaObject } from './mediaObjectRegistry';
import { messagingDb } from './messagingDb';
import { resolveGroupMessagesDb } from './messagingShard';
import { normalizeGroupMemberUrl } from './groupMemberUrl';

/** 解散后本地只读保留时长（m16-group-chat-plan.md §9.4）。 */
export const GROUP_DISSOLVED_RETENTION_HOURS = 48;

const DISSOLVED_GC_BATCH = 5;

function nowIso(): string {
  return new Date().toISOString();
}

function dissolvedCutoffIso(): string {
  return new Date(Date.now() - GROUP_DISSOLVED_RETENTION_HOURS * 3_600_000).toISOString();
}

/** 删除本节点某群全部 MESSAGING_DB 副本（fail-soft 分步）。 */
export async function purgeDissolvedGroupReplica(env: Env, groupId: string): Promise<void> {
  const metaDb = messagingDb(env);
  const msgDb = await resolveGroupMessagesDb(env, groupId);

  const mediaRows = await metaDb
    .prepare(
      `SELECT local_storage_key FROM messaging_media_local
        WHERE group_id = ? AND local_storage_key IS NOT NULL`,
    )
    .bind(groupId)
    .all<{ local_storage_key: string }>();
  for (const row of mediaRows.results ?? []) {
    try {
      await releaseRegisteredMediaObject(env, row.local_storage_key);
    } catch (err) {
      console.warn('[groupDissolve] 释放群图失败', row.local_storage_key, err);
    }
  }

  await msgDb.prepare(`DELETE FROM member_group_messages WHERE group_id = ?`).bind(groupId).run();
  await msgDb.prepare(`DELETE FROM group_messages WHERE group_id = ?`).bind(groupId).run();

  await metaDb.batch([
    metaDb.prepare(`DELETE FROM messaging_media_local WHERE group_id = ?`).bind(groupId),
    metaDb.prepare(`DELETE FROM group_outbox WHERE group_id = ?`).bind(groupId),
    metaDb.prepare(`DELETE FROM group_relay_edges WHERE group_id = ?`).bind(groupId),
    metaDb.prepare(`DELETE FROM group_wrapped_keys WHERE group_id = ?`).bind(groupId),
    metaDb.prepare(`DELETE FROM group_sync_state WHERE group_id = ?`).bind(groupId),
    metaDb.prepare(`DELETE FROM group_message_acks WHERE group_id = ?`).bind(groupId),
    metaDb.prepare(`DELETE FROM group_relay_seen WHERE group_id = ?`).bind(groupId),
    metaDb.prepare(`DELETE FROM group_invites WHERE group_id = ?`).bind(groupId),
    metaDb.prepare(`DELETE FROM group_members WHERE group_id = ?`).bind(groupId),
    metaDb.prepare(`DELETE FROM group_nonces WHERE group_id = ?`).bind(groupId),
    metaDb.prepare(`DELETE FROM group_message_shard_routes WHERE group_id = ?`).bind(groupId),
    metaDb.prepare(`DELETE FROM groups WHERE group_id = ?`).bind(groupId),
  ]);
}

/** 群主解散群：写 dissolved_at，成员经 sync 获知。 */
export async function dissolveGroupOnOwner(
  env: Env,
  groupId: string,
  localWorkerBUrl: string,
): Promise<
  | { ok: true; data: { group_id: string; dissolved_at: string } }
  | { ok: false; error_code: string; message: string; status: 403 | 404 | 409 }
> {
  const localUrl = normalizeGroupMemberUrl(localWorkerBUrl);
  const db = messagingDb(env);
  const group = await db
    .prepare(
      `SELECT group_id, owner_worker_b_url, dissolved_at FROM groups WHERE group_id = ? LIMIT 1`,
    )
    .bind(groupId)
    .first<{ group_id: string; owner_worker_b_url: string; dissolved_at: string | null }>();

  if (!group) {
    return { ok: false, status: 404, error_code: 'GROUP_NOT_FOUND', message: '群不存在' };
  }
  if (normalizeGroupMemberUrl(group.owner_worker_b_url) !== localUrl) {
    return { ok: false, status: 403, error_code: 'GROUP_NOT_MEMBER', message: '仅群主可解散群' };
  }
  if (group.dissolved_at) {
    return { ok: true, data: { group_id: groupId, dissolved_at: group.dissolved_at } };
  }

  const dissolvedAt = nowIso();
  await db
    .prepare(`UPDATE groups SET dissolved_at = ?, updated_at = ? WHERE group_id = ?`)
    .bind(dissolvedAt, dissolvedAt, groupId)
    .run();

  console.log('[group/dissolve] 群主解散', JSON.stringify({ groupId, dissolvedAt }));
  return { ok: true, data: { group_id: groupId, dissolved_at: dissolvedAt } };
}

/** Cron：解散超过 48h 的群，purge 本节点本地副本。 */
export async function gcDissolvedGroups(env: Env): Promise<number> {
  const cutoff = dissolvedCutoffIso();
  const db = messagingDb(env);
  const { results } = await db
    .prepare(
      `SELECT group_id FROM groups
        WHERE dissolved_at IS NOT NULL AND dissolved_at < ?
        LIMIT ?`,
    )
    .bind(cutoff, DISSOLVED_GC_BATCH)
    .all<{ group_id: string }>();

  let purged = 0;
  for (const row of results ?? []) {
    try {
      await purgeDissolvedGroupReplica(env, row.group_id);
      purged += 1;
    } catch (err) {
      console.error('[groupGc] purge 已解散群失败', row.group_id, err);
    }
  }
  if (purged > 0) {
    console.log('[cron/gc] gcDissolvedGroups', JSON.stringify({ purged, cutoff }));
  }
  return purged;
}
