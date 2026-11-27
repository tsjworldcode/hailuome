/**
 * M9-15：D1 临时表水位感知 GC（分片 DELETE + 动态 retention）。
 *
 * 目标表：feed_cache / outbound_events / cache_entries（仍共用单 D1，不分库）。
 * 分库评估留后续里程碑，本模块只做体积控制与水位告警。
 *
 * SPILL-2-3：双口径阈值 — 行数 + 字节，任一超阈值即升级 retention tier。
 * 解决「5000 行 × 50 字节 ≈ 250 KB」与「5000 行 × 2 MB ≈ 10 GB」共用一行数阈值的盲区。
 */

import { insertOutboundEvent } from './outboundEvents';

/** 单次 Cron 每表最多删除批次数，避免整点 GC 与用户写争用 D1。 */
export const D1_GC_BATCH_SIZE = 200;
export const D1_GC_MAX_ROUNDS = 5;

export const FEED_CACHE_WATERMARK_ELEVATED = 5_000;
export const FEED_CACHE_WATERMARK_CRITICAL = 20_000;
/** SPILL-2-3：feed_cache 字节阈值（按 content + image_urls + repost_of_json 估算） */
export const FEED_CACHE_BYTES_ELEVATED = 50 * 1024 * 1024;   // 50 MB
export const FEED_CACHE_BYTES_CRITICAL = 500 * 1024 * 1024;  // 500 MB

export const FEED_CACHE_RETENTION_NORMAL_MS = 7 * 24 * 60 * 60 * 1000;
export const FEED_CACHE_RETENTION_ELEVATED_MS = 3 * 24 * 60 * 60 * 1000;
export const FEED_CACHE_RETENTION_CRITICAL_MS = 24 * 60 * 60 * 1000;

export const OUTBOUND_EVENTS_WATERMARK_ELEVATED = 10_000;
/** SPILL-2-3：outbound_events 字节阈值（按 router_detail + err_message 估算） */
export const OUTBOUND_EVENTS_BYTES_ELEVATED = 100 * 1024 * 1024; // 100 MB

export const OUTBOUND_EVENTS_RETENTION_NORMAL_MS = 7 * 24 * 60 * 60 * 1000;
export const OUTBOUND_EVENTS_RETENTION_ELEVATED_MS = 3 * 24 * 60 * 60 * 1000;

export const CACHE_ENTRIES_WATERMARK_ELEVATED = 5_000;
/** SPILL-2-3：cache_entries 字节阈值（按 response_json 估算） */
export const CACHE_ENTRIES_BYTES_ELEVATED = 25 * 1024 * 1024; // 25 MB

/** M-OPT-1c：与 lookup TTL≥7 日对齐，避免 GC 按 fetched_at 提前删掉仍有效缓存 */
export const CACHE_ENTRIES_RETENTION_NORMAL_MS = 8 * 24 * 60 * 60 * 1000;
export const CACHE_ENTRIES_RETENTION_ELEVATED_MS = 7 * 24 * 60 * 60 * 1000;

export type D1WaterTier = 'normal' | 'elevated' | 'critical';

export type D1TempTable = 'feed_cache' | 'outbound_events' | 'cache_entries';

export type D1TableStats = { rowCount: number; bytes: number };

/** SPILL-2-3：双口径阈值 tier 判定 — 行数 OR 字节任一超阈值即升级。 */
export function resolveFeedCacheWaterTier(rowCount: number, bytes = 0): D1WaterTier {
  if (rowCount > FEED_CACHE_WATERMARK_CRITICAL || bytes > FEED_CACHE_BYTES_CRITICAL) return 'critical';
  if (rowCount > FEED_CACHE_WATERMARK_ELEVATED || bytes > FEED_CACHE_BYTES_ELEVATED) return 'elevated';
  return 'normal';
}

/** SPILL-2-3：双口径阈值 tier 判定。 */
export function resolveOutboundEventsWaterTier(rowCount: number, bytes = 0): D1WaterTier {
  if (rowCount > OUTBOUND_EVENTS_WATERMARK_ELEVATED || bytes > OUTBOUND_EVENTS_BYTES_ELEVATED) {
    return 'elevated';
  }
  return 'normal';
}

/** SPILL-2-3：双口径阈值 tier 判定。 */
export function resolveCacheEntriesWaterTier(rowCount: number, bytes = 0): D1WaterTier {
  if (rowCount > CACHE_ENTRIES_WATERMARK_ELEVATED || bytes > CACHE_ENTRIES_BYTES_ELEVATED) {
    return 'elevated';
  }
  return 'normal';
}

/** feed_cache retention：默认 7 天；任一超阈值 3 天；双超 24 小时。 */
export function resolveFeedCacheRetentionMs(rowCount: number, bytes = 0): number {
  const tier = resolveFeedCacheWaterTier(rowCount, bytes);
  if (tier === 'critical') return FEED_CACHE_RETENTION_CRITICAL_MS;
  if (tier === 'elevated') return FEED_CACHE_RETENTION_ELEVATED_MS;
  return FEED_CACHE_RETENTION_NORMAL_MS;
}

/** outbound_events retention：默认 7 天；任一超阈值 3 天。 */
export function resolveOutboundEventsRetentionMs(rowCount: number, bytes = 0): number {
  const tier = resolveOutboundEventsWaterTier(rowCount, bytes);
  if (tier === 'elevated') return OUTBOUND_EVENTS_RETENTION_ELEVATED_MS;
  return OUTBOUND_EVENTS_RETENTION_NORMAL_MS;
}

/** cache_entries retention：默认 8 天；任一超阈值 7 天（仍 ≥ lookup TTL）。 */
export function resolveCacheEntriesRetentionMs(rowCount: number, bytes = 0): number {
  const tier = resolveCacheEntriesWaterTier(rowCount, bytes);
  if (tier === 'elevated') return CACHE_ENTRIES_RETENTION_ELEVATED_MS;
  return CACHE_ENTRIES_RETENTION_NORMAL_MS;
}

/**
 * SPILL-2-3：各表字节估算 SQL（整句硬编码，禁止拼列名/表名）。
 * 列名对齐真实 schema：feed_cache.content（非 content_json）、
 * cache_entries.response_json（非 payload）、outbound_events.router_detail + err_message。
 */
function bytesSumSql(table: D1TempTable): string {
  switch (table) {
    case 'feed_cache':
      return `SELECT COALESCE(SUM(
                COALESCE(LENGTH(content), 0)
              + COALESCE(LENGTH(image_urls), 0)
              + COALESCE(LENGTH(repost_of_json), 0)
              ), 0) AS b FROM feed_cache`;
    case 'outbound_events':
      return `SELECT COALESCE(SUM(
                COALESCE(LENGTH(router_detail), 0)
              + COALESCE(LENGTH(err_message), 0)
              ), 0) AS b FROM outbound_events`;
    case 'cache_entries':
      return `SELECT COALESCE(SUM(COALESCE(LENGTH(response_json), 0)), 0) AS b FROM cache_entries`;
  }
}

function countSql(table: D1TempTable): string {
  switch (table) {
    case 'feed_cache':
      return `SELECT COUNT(*) AS c FROM feed_cache`;
    case 'outbound_events':
      return `SELECT COUNT(*) AS c FROM outbound_events`;
    case 'cache_entries':
      return `SELECT COUNT(*) AS c FROM cache_entries`;
  }
}

async function sumTableBytes(db: D1Database, table: D1TempTable): Promise<number> {
  const row = await db.prepare(bytesSumSql(table)).first<{ b: number }>();
  return Number(row?.b ?? 0);
}

/** SPILL-2-3：取表行数 + 字节估算（双口径）。 */
export async function countD1TableStats(
  db: D1Database,
  table: D1TempTable,
): Promise<D1TableStats> {
  const [countRow, bytes] = await Promise.all([
    db.prepare(countSql(table)).first<{ c: number }>(),
    sumTableBytes(db, table),
  ]);
  return { rowCount: Number(countRow?.c ?? 0), bytes };
}

/** 向后兼容旧接口 — 仅返回行数。 */
export async function countD1TableRows(db: D1Database, table: D1TempTable): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS c FROM ${table}`)
    .first<{ c: number }>();
  return Number(row?.c ?? 0);
}

interface ShardDeleteSpec {
  table: D1TempTable;
  cutoffIso: string;
}

function buildShardDeleteSql(table: D1TempTable): string {
  if (table === 'outbound_events') {
    return `DELETE FROM outbound_events WHERE status = 'ok' AND created_at < ? LIMIT ${D1_GC_BATCH_SIZE}`;
  }
  return `DELETE FROM ${table} WHERE fetched_at < ? LIMIT ${D1_GC_BATCH_SIZE}`;
}

/** 分片 DELETE：每轮最多 D1_GC_BATCH_SIZE 行，整点 Cron 最多 D1_GC_MAX_ROUNDS 轮。 */
export async function deleteExpiredRowsInShards(db: D1Database, spec: ShardDeleteSpec): Promise<number> {
  const sql = buildShardDeleteSql(spec.table);
  let totalDeleted = 0;

  for (let round = 0; round < D1_GC_MAX_ROUNDS; round += 1) {
    const result = await db.prepare(sql).bind(spec.cutoffIso).run();
    const deleted = result.meta.changes ?? 0;
    totalDeleted += deleted;
    if (deleted < D1_GC_BATCH_SIZE) break;
  }

  return totalDeleted;
}

async function readSystemConfig(db: D1Database, key: string): Promise<string | null> {
  const row = await db
    .prepare('SELECT value FROM system_config WHERE key = ? LIMIT 1')
    .bind(key)
    .first<{ value: string }>();
  return row?.value ?? null;
}

async function writeSystemConfig(db: D1Database, key: string, value: string): Promise<void> {
  const now = new Date().toISOString();
  await db
    .prepare('INSERT OR REPLACE INTO system_config (key, value, updated_at) VALUES (?, ?, ?)')
    .bind(key, value, now)
    .run();
}

/**
 * 水位超 normal 时写 outbound_events(kind='d1/watermark')；
 * tier 变化或 elevated/critical 下每 24h 最多一条，避免 D1 写膨胀。
 */
export async function maybeRecordFeedCacheWatermark(
  db: D1Database,
  rowCount: number,
  bytes = 0,
): Promise<void> {
  const tier = resolveFeedCacheWaterTier(rowCount, bytes);
  if (tier === 'normal') return;

  const lastTier = await readSystemConfig(db, 'd1_watermark_feed_cache_tier');
  const lastAt = await readSystemConfig(db, 'd1_watermark_feed_cache_at');
  const lastMs = lastAt ? Date.parse(lastAt) : 0;
  const nowMs = Date.now();
  const shouldWrite = lastTier !== tier || Number.isNaN(lastMs) || nowMs - lastMs >= 24 * 60 * 60 * 1000;
  if (!shouldWrite) return;

  const retentionMs = resolveFeedCacheRetentionMs(rowCount, bytes);
  await insertOutboundEvent(db, {
    kind: 'd1/watermark',
    targetUrl: 'd1://feed_cache',
    status: 'ok',
    httpCode: null,
    errCode: null,
    errMessage: null,
    routerDetail: JSON.stringify({
      table: 'feed_cache',
      row_count: rowCount,
      bytes,
      tier,
      retention_hours: Math.round(retentionMs / (60 * 60 * 1000)),
    }),
  });

  await writeSystemConfig(db, 'd1_watermark_feed_cache_tier', tier);
  await writeSystemConfig(db, 'd1_watermark_feed_cache_at', new Date().toISOString());
}

export async function gcFeedCacheWithWaterLevel(db: D1Database): Promise<{
  rowCount: number;
  bytes: number;
  tier: D1WaterTier;
  deleted: number;
  retentionMs: number;
}> {
  const stats = await countD1TableStats(db, 'feed_cache');
  await maybeRecordFeedCacheWatermark(db, stats.rowCount, stats.bytes);
  const retentionMs = resolveFeedCacheRetentionMs(stats.rowCount, stats.bytes);
  const cutoffIso = new Date(Date.now() - retentionMs).toISOString();
  const deleted = await deleteExpiredRowsInShards(db, { table: 'feed_cache', cutoffIso });
  return {
    rowCount: stats.rowCount,
    bytes: stats.bytes,
    tier: resolveFeedCacheWaterTier(stats.rowCount, stats.bytes),
    deleted,
    retentionMs,
  };
}

export async function gcOutboundEventsWithWaterLevel(db: D1Database): Promise<{
  rowCount: number;
  bytes: number;
  tier: D1WaterTier;
  deleted: number;
  retentionMs: number;
}> {
  const stats = await countD1TableStats(db, 'outbound_events');
  const retentionMs = resolveOutboundEventsRetentionMs(stats.rowCount, stats.bytes);
  const cutoffIso = new Date(Date.now() - retentionMs).toISOString();
  const deleted = await deleteExpiredRowsInShards(db, { table: 'outbound_events', cutoffIso });
  return {
    rowCount: stats.rowCount,
    bytes: stats.bytes,
    tier: resolveOutboundEventsWaterTier(stats.rowCount, stats.bytes),
    deleted,
    retentionMs,
  };
}

export async function gcCacheEntriesWithWaterLevel(db: D1Database): Promise<{
  rowCount: number;
  bytes: number;
  tier: D1WaterTier;
  deleted: number;
  retentionMs: number;
}> {
  const stats = await countD1TableStats(db, 'cache_entries');
  const retentionMs = resolveCacheEntriesRetentionMs(stats.rowCount, stats.bytes);
  const cutoffIso = new Date(Date.now() - retentionMs).toISOString();
  const deleted = await deleteExpiredRowsInShards(db, { table: 'cache_entries', cutoffIso });
  return {
    rowCount: stats.rowCount,
    bytes: stats.bytes,
    tier: resolveCacheEntriesWaterTier(stats.rowCount, stats.bytes),
    deleted,
    retentionMs,
  };
}
