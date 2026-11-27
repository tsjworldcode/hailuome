// M10-3：私信 D1 保留期清理（挂既有 minute % 5 Cron，不占新槽位）。

import { resolveIdentityDb } from '../db/bindings';
import type { Env } from '../env';
import { messagingDb } from './messagingDb';
import { deleteMediaObjectFromStorage } from './mediaObjectRegistry';
import { decrementUsage, type MediaUsageBackend } from './mediaStorageUsage';
import {
  createExternalDeleteBudget,
  takeExternalDeleteSlot,
} from './mediaGcBudget';

/** 与 migration 0025 种子值及 m10-dm-e2ee-plan.md 默认保留期一致。 */
export const DEFAULT_DM_RETENTION_DAYS = 180;

/** P0-1：DM 媒体 GC 单批扫描上限（防止一次扫太多阻塞 cron；与 messagingMediaGc 同量级）。 */
const DM_MEDIA_GC_BATCH_LIMIT = 500;

/** media_object_registry 步骤 ⑥ 读取的字段子集（避免引入未导出的 RegistryRow）。 */
interface DmMediaRegistryRow {
  readonly object_key: string;
  readonly backend: MediaUsageBackend;
  readonly size_bytes: number;
  readonly message_id: string;
}

export interface DmGcResult {
  messages: number;
  wrappedKeys: number;
  nonces: number;
  rateBuckets: number;
  /** P0-1：messaging_media_local 中已无对应 dm_messages 引用而删除的行数。 */
  messagingMediaLocal: number;
  /** P0-1：media_object_registry 中 dm_sender active + 不再被 messaging_media_local 引用 → 释放行数。 */
  dmSenderMediaReleased: number;
  /** P0-1：累计释放字节数（dm_sender active 释放时 decrement usage）。 */
  bytesReclaimed: number;
  /** 某步 DELETE 失败时记录步骤名，便于 Cron 日志排障（D1 无跨表事务，已删行不会回滚）。 */
  errors: string[];
}

/** 读取 system_config.dm_retention_days，缺省用 DEFAULT_DM_RETENTION_DAYS。 */
export async function getDmRetentionDays(db: D1Database): Promise<number> {
  const row = await db
    .prepare(`SELECT value FROM system_config WHERE key = 'dm_retention_days'`)
    .first<{ value: string }>()
    .catch(() => null);
  const parsed = parseInt(row?.value ?? String(DEFAULT_DM_RETENTION_DAYS), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_DM_RETENTION_DAYS;
}

/**
 * 按保留策略清理 dm_messages / dm_wrapped_keys / dm_nonces / dm_rate_buckets，
 * 顺带清旧限频桶（180 天保留期到期）。
 * 算法与 m10-dm-e2ee-plan.md §7.3 一致；各步 fail-soft，部分成功仍返回已删计数。
 *
 * P0-1 扩展（2026-09-16 闭环）：
 *   步骤 ⑤ 清 `messaging_media_local`（MESSAGING_DB）中 `message_id` 已不在
 *          `dm_messages` 引用集合的行；
 *   步骤 ⑥ 清 `media_object_registry`（IDENTITY_DB）中 `scope='messaging'` +
 *          `owner_kind='dm_sender'` + `storage_state='active'` + 不再被
 *          `messaging_media_local` 引用的行，释放对应 bytes（KV/R2/B2/Filebase）
 *          并 decrement usage。
 *
 * 群 sender（`owner_kind='group_sender'`）**不动**：群图 90 天到期由
 * `gcMessagingMediaBlobs`（retain_until 过期路径）清理，群解散由 `groupDissolve`
 * 流程触发清理；不与 DM 共用 GC 路径以避免跨职责、跨库。
 *
 * 跨库 D1 JOIN 不支持（IDENTITY_DB ≠ MESSAGING_DB）：步骤 ⑥ 先在 messagingDb
 * 拉活跃 `(message_id, media_id)` 集合，再在 identityDb 扫注册行，内存级
 * intersect → 释放。两库步骤均 fail-soft。
 */
export async function gcDmRetention(env: Env): Promise<DmGcResult> {
  const result: DmGcResult = {
    messages: 0,
    wrappedKeys: 0,
    nonces: 0,
    rateBuckets: 0,
    messagingMediaLocal: 0,
    dmSenderMediaReleased: 0,
    bytesReclaimed: 0,
    errors: [],
  };

  let retentionDays = DEFAULT_DM_RETENTION_DAYS;
  try {
    retentionDays = await getDmRetentionDays(resolveIdentityDb(env));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    result.errors.push(`getDmRetentionDays: ${message}`);
  }

  const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString();
  const nonceCutoff = new Date(new Date(cutoff).getTime() - 7 * 86_400_000).toISOString();
  const rateBucketCutoff = new Date(Date.now() - 48 * 3_600_000).toISOString();

  try {
    const msgResult = await messagingDb(env)
      .prepare(`DELETE FROM dm_messages WHERE created_at < ?`)
      .bind(cutoff)
      .run();
    result.messages = msgResult.meta.changes ?? 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    result.errors.push(`dm_messages: ${message}`);
  }

  try {
    const wrappedResult = await messagingDb(env)
      .prepare(
        `DELETE FROM dm_wrapped_keys
          WHERE conversation_id NOT IN (SELECT DISTINCT conversation_id FROM dm_messages)`,
      )
      .run();
    result.wrappedKeys = wrappedResult.meta.changes ?? 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    result.errors.push(`dm_wrapped_keys: ${message}`);
  }

  try {
    const nonceResult = await messagingDb(env)
      .prepare(`DELETE FROM dm_nonces WHERE created_at < ?`)
      .bind(nonceCutoff)
      .run();
    result.nonces = nonceResult.meta.changes ?? 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    result.errors.push(`dm_nonces: ${message}`);
  }

  try {
    const rateResult = await messagingDb(env)
      .prepare(`DELETE FROM dm_rate_buckets WHERE window_hour < ?`)
      .bind(rateBucketCutoff)
      .run();
    result.rateBuckets = rateResult.meta.changes ?? 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    result.errors.push(`dm_rate_buckets: ${message}`);
  }

  // 步骤 ⑤：清 messaging_media_local 中 message_id 已不在 dm_messages 引用集合的行。
  //   触发条件：步骤 ① 已删除老 dm_messages；messaging_media_local 的 (message_id, media_id) PK
  //   对应的 message_id 必然不在 dm_messages 中（外键无声明，应用层保证）。
  try {
    const mmlResult = await messagingDb(env)
      .prepare(
        `DELETE FROM messaging_media_local
          WHERE message_id NOT IN (SELECT message_id FROM dm_messages)`,
      )
      .run();
    result.messagingMediaLocal = mmlResult.meta.changes ?? 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    result.errors.push(`messaging_media_local: ${message}`);
  }

  // 步骤 ⑥：清 media_object_registry dm_sender active 行 + 不再被 messaging_media_local 引用。
  //   跨库内存级 intersect（D1 不支持跨 binding JOIN）。
  try {
    // ⑥.1 在 messagingDb 拉活跃 (message_id, media_id) 集合
    const activeRows = await messagingDb(env)
      .prepare(`SELECT message_id, media_id FROM messaging_media_local`)
      .all<{ message_id: string; media_id: string }>();
    // 用 message_id 作 key 即可：DM 每条 message 至多 1 个 media（与 sendDmMessage 链路一致）
    const activeMessageIds = new Set<string>();
    for (const row of activeRows.results ?? []) {
      if (row.message_id) activeMessageIds.add(row.message_id);
    }

    // ⑥.2 在 identityDb 扫 media_object_registry dm_sender active 行
    const idDb = resolveIdentityDb(env);
    const registryRows = await idDb
      .prepare(
        `SELECT object_key, backend, size_bytes, message_id
           FROM media_object_registry
          WHERE scope = 'messaging'
            AND owner_kind = 'dm_sender'
            AND storage_state = 'active'
            AND released_at IS NULL
            AND message_id IS NOT NULL
          LIMIT ?`,
      )
      .bind(DM_MEDIA_GC_BATCH_LIMIT)
      .all<DmMediaRegistryRow>();

    // ⑥.3 内存级 intersect：message_id 不在 activeMessageIds 集合的行 → 释放
    // CRON-SCHEDULE-AUDIT：B2/Filebase 删除是外部 fetch，每轮最多 10 个；
    // 超限行保留到下一轮（binding 后端 kv/r2 不受限）。
    const now = new Date().toISOString();
    const deleteBudget = createExternalDeleteBudget();
    for (const row of registryRows.results ?? []) {
      if (activeMessageIds.has(row.message_id)) continue;
      if (!takeExternalDeleteSlot(deleteBudget, row.backend)) continue;
      try {
        if (row.size_bytes > 0) {
          await decrementUsage(env, row.backend, row.size_bytes);
        }
        await deleteMediaObjectFromStorage(env, row.object_key, row.backend);
        await idDb
          .prepare(
            `UPDATE media_object_registry
                SET released_at = ?
              WHERE object_key = ?
                AND released_at IS NULL`,
          )
          .bind(now, row.object_key)
          .run();
        result.dmSenderMediaReleased += 1;
        result.bytesReclaimed += row.size_bytes;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        result.errors.push(`dm_sender_media:${row.object_key}: ${message}`);
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    result.errors.push(`dm_sender_media:query: ${message}`);
  }

  return result;
}
