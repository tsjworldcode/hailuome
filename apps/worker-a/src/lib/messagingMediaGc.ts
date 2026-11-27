/**
 * M-AUDIT-FIX-2：私信媒体 GC（孤儿 + 过期 blob 回收）。
 *
 * 回收三类 orphan blob：
 * 1. pending 超时：reserveMessagingMediaUpload 后未在 PENDING_TIMEOUT_MS 内 activate
 *    → pending 时未调 finalizeMediaUpload，配额未加；仅删 bytes
 * 2. abandoned：M-AUDIT-FIX-1 失败路径标记的行（reserve 后 upload 或 activate 失败）
 *    → 同上未加配额；仅删 bytes
 * 3. retain_until 过期：群图 90 天到期
 *    → 已加配额；decrementUsage + delete bytes
 *
 * 挂点：handlers/cronBudget.ts 的 minute % 20 === 11（非 Feed、非群槽）；
 * 每轮最多 10 个 B2/Filebase 外部删除（KV/R2 走 binding，不占额度）。
 *
 * SSOT：docs/audit-messaging-2026-09-followup-plan.md §2.2
 */
import type { Env } from '../env';
import { resolveIdentityDb } from '../db/bindings';
import { decrementUsage } from './mediaStorageUsage';
import { deleteMediaObjectFromStorage } from './mediaObjectRegistry';
import {
  createExternalDeleteBudget,
  takeExternalDeleteSlot,
  type ExternalDeleteBudget,
} from './mediaGcBudget';

/** pending 状态最长保留时间（30 分钟）；超时视为孤儿。
 *  M-AUDIT-FIX-2：与 finalizeMessagingMediaUpload 的 abandon 路径配合，
 *  reserveMessagingMediaUpload 后 30 分钟内未 activate 的行视为孤儿。 */
export const PENDING_TIMEOUT_MS = 30 * 60 * 1000;

/** 单批扫描行数；防止一次扫太多阻塞 cron。 */
const GC_BATCH_LIMIT = 500;

export interface MediaGcResult {
  pendingExpired: number; // pending 超时回收条数
  abandoned: number; // abandoned 状态回收条数
  expiredRetain: number; // retain_until 过期回收条数
  unreferenced: number; // 不再被任何 dm_messages 引用（占位，本轮不实做跨库 diff）
  bytesReclaimed: number; // 累计释放字节数
  errors: string[]; // 步骤级错误
}

interface PendingRow {
  object_key: string;
  backend: 'kv' | 'r2' | 'b2' | 'filebase';
  size_bytes: number;
}

function pushErr(result: MediaGcResult, step: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  result.errors.push(`${step}: ${message}`);
}

async function deleteBytes(
  env: Env,
  row: PendingRow,
): Promise<void> {
  // deleteMediaObjectFromStorage 内部已经处理四种 backend；
  // 任一失败抛错（不静默），由 caller 记录到 result.errors
  await deleteMediaObjectFromStorage(env, row.object_key, row.backend);
}

async function markReleased(db: D1Database, objectKey: string): Promise<void> {
  // 双重释放保护：released_at IS NULL 才更新
  await db
    .prepare(
      `UPDATE media_object_registry
          SET released_at = ?
        WHERE object_key = ?
          AND released_at IS NULL`,
    )
    .bind(new Date().toISOString(), objectKey)
    .run();
}

/**
 * 回收 pending 超时 + abandoned 行（reserve 后未成功的孤儿）。
 * 这两类行：未加配额，仅需删 bytes。
 */
async function gcOrphanBlobs(
  env: Env,
  result: MediaGcResult,
  budget: ExternalDeleteBudget,
): Promise<void> {
  const db = resolveIdentityDb(env);
  const cutoff = new Date(Date.now() - PENDING_TIMEOUT_MS).toISOString();

  // ① pending 超时
  try {
    const rows = await db
      .prepare(
        `SELECT object_key, backend, size_bytes
           FROM media_object_registry
          WHERE scope = 'messaging'
            AND storage_state = 'pending'
            AND created_at < ?
          LIMIT ?`,
      )
      .bind(cutoff, GC_BATCH_LIMIT)
      .all<PendingRow>();
    for (const row of rows.results ?? []) {
      if (!takeExternalDeleteSlot(budget, row.backend)) continue;
      try {
        await deleteBytes(env, row);
        await markReleased(db, row.object_key);
        result.pendingExpired += 1;
        result.bytesReclaimed += row.size_bytes;
      } catch (err) {
        pushErr(result, `pendingExpired:${row.object_key}`, err);
      }
    }
  } catch (err) {
    pushErr(result, 'pendingExpired:query', err);
  }

  // M-AUDIT-FIX-2：abandoned（P0-1 失败路径）
  try {
    const rows = await db
      .prepare(
        `SELECT object_key, backend, size_bytes
           FROM media_object_registry
          WHERE scope = 'messaging'
            AND storage_state = 'abandoned'
            AND released_at IS NULL
          LIMIT ?`,
      )
      .bind(GC_BATCH_LIMIT)
      .all<PendingRow>();
    for (const row of rows.results ?? []) {
      if (!takeExternalDeleteSlot(budget, row.backend)) continue;
      try {
        await deleteBytes(env, row);
        await markReleased(db, row.object_key);
        result.abandoned += 1;
        result.bytesReclaimed += row.size_bytes;
      } catch (err) {
        pushErr(result, `abandoned:${row.object_key}`, err);
      }
    }
  } catch (err) {
    pushErr(result, 'abandoned:query', err);
  }
}

/**
 * 回收 retain_until 过期行（群图 90 天到期）。
 * 这类行：已加配额；decrement + delete bytes。
 */
async function gcExpiredRetain(
  env: Env,
  result: MediaGcResult,
  budget: ExternalDeleteBudget,
): Promise<void> {
  const db = resolveIdentityDb(env);
  const now = new Date().toISOString();
  try {
    const rows = await db
      .prepare(
        `SELECT object_key, backend, size_bytes
           FROM media_object_registry
          WHERE scope = 'messaging'
            AND storage_state = 'active'
            AND retain_until IS NOT NULL
            AND retain_until < ?
            AND released_at IS NULL
          LIMIT ?`,
      )
      .bind(now, GC_BATCH_LIMIT)
      .all<PendingRow>();
    for (const row of rows.results ?? []) {
      // 先占外部删除额度，再减计费；额度不足时整行保留到下一轮。
      if (!takeExternalDeleteSlot(budget, row.backend)) continue;
      try {
        if (row.size_bytes > 0) {
          await decrementUsage(env, row.backend, row.size_bytes);
        }
        await deleteBytes(env, row);
        await markReleased(db, row.object_key);
        result.expiredRetain += 1;
        result.bytesReclaimed += row.size_bytes;
      } catch (err) {
        pushErr(result, `expiredRetain:${row.object_key}`, err);
      }
    }
  } catch (err) {
    pushErr(result, 'expiredRetain:query', err);
  }
}

/**
 * 主入口：扫 + 回收 + 记账；任何步骤失败 fail-soft 记录到 result.errors，
 * 不抛出（cron 任务不应被 GC 失败拖垮）。
 *
 * `unreferenced`（dm_messages 引用计数归零）跨库 diff 性能成本高，
 * 留作 M-PENDING-AUDIT-2，本轮不实做。
 */
export async function gcMessagingMediaBlobs(env: Env): Promise<MediaGcResult> {
  const result: MediaGcResult = {
    pendingExpired: 0,
    abandoned: 0,
    expiredRetain: 0,
    unreferenced: 0,
    bytesReclaimed: 0,
    errors: [],
  };
  const budget = createExternalDeleteBudget();
  await gcOrphanBlobs(env, result, budget);
  await gcExpiredRetain(env, result, budget);
  return result;
}