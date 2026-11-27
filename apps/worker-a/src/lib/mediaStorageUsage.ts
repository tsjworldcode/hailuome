/**
 * M5-SR：媒体存储用量计数 + 满额自动路由。
 * 云存储（Filebase/B2）写入顺序按**首次配置先后**；满额再切下一库；R2/KV 固定垫底。
 */
import type { Env } from '../env';
import { resolveGovernanceDb, resolveIdentityDb } from '../db/bindings';
import { listB2BucketUsage } from './b2BucketUsage';
import { fetchR2CfUsageApi, listR2BindingUsage } from './r2BucketUsage';
import {
  isStoredB2ConfigComplete,
  isStoredFilebaseConfigComplete,
  parseStoredB2Config,
  readB2ProbeStatus,
  readFilebaseProbeStatus,
  readImagesStorage,
  resolveB2Config,
  resolveFilebaseConfig,
  toB2UploadConfig,
  type ImagesStorageBackend,
  type StoredB2Config,
  type StoredFilebaseConfig,
} from './mediaStorage';

export type MediaUsageBackend = 'filebase' | 'b2' | 'r2' | 'kv';
export type MediaStorageMode = 'router' | 'manual';
export type CloudUsageBackend = 'filebase' | 'b2';

/** 无历史配置时的默认云优先（Filebase 先于 B2）；有配置后以 D1 记录为准 */
export const DEFAULT_WRITE_PRIORITY: readonly MediaUsageBackend[] = ['filebase', 'b2', 'r2', 'kv'];

/** @deprecated 使用 readWritePriority；保留常量供文档/测试引用默认兜底 */
export const WRITE_PRIORITY = DEFAULT_WRITE_PRIORITY;

/** Filebase Free 5 GiB − 50 MiB */
export const FILEBASE_BYTES_LIMIT = 5_368_709_120;
export const FILEBASE_BYTES_BUFFER = 52_428_800;
export const FILEBASE_BYTES_THRESHOLD = FILEBASE_BYTES_LIMIT - FILEBASE_BYTES_BUFFER;

/** B2 10 GiB − 100 MiB */
export const B2_BYTES_LIMIT = 10_737_418_240;
export const B2_BYTES_BUFFER = 104_857_600;
export const B2_BYTES_THRESHOLD = B2_BYTES_LIMIT - B2_BYTES_BUFFER;

const KV_MAX_BYTES = 25 * 1024 * 1024;

/** M8-14-7：KV 优先写的大小阈值（≤ 10 MiB → KV；> 10 MiB → R2） */
export const KV_PREFERRED_MAX_BYTES = 10 * 1024 * 1024; // 10 MiB

/** M8-14-7：KV 软上限（1 GiB，与 Free Tier 平台约束对齐；用于水位检查） */
export const KV_SOFT_LIMIT_BYTES = 1024 * 1024 * 1024; // 1 GiB

/** M8-14-8：R2 软上限（10 GiB，与 Free Tier R2 约束对齐） */
export const R2_SOFT_LIMIT_BYTES = 10n * 1024n * 1024n * 1024n; // 10 GiB as bigint for safe comparison

const MODE_KEY = 'media_storage_mode';
const ACTIVE_BACKEND_KEY = 'media_active_write_backend';
const WRITE_PRIORITY_KEY = 'media_write_priority';

/** M8-14-7：D1 system_config 阈值配置键 */
const KV_WATERMARK_KEY = 'media_kv_high_watermark';
const KV_PREFERRED_MAX_KEY = 'media_kv_preferred_max_bytes';
const R2_HIGH_WATERMARK_KEY = 'media_r2_high_watermark';
const R2_TARGET_WATERMARK_KEY = 'media_r2_target_watermark';

/** 默认值（M8-14-7） */
const DEFAULT_KV_HIGH_WATERMARK = 0.90;
const DEFAULT_KV_PREFERRED_MAX = KV_PREFERRED_MAX_BYTES;
const DEFAULT_R2_HIGH_WATERMARK = 0.90;
const DEFAULT_R2_TARGET_WATERMARK = 0.70;

const TAIL_BACKENDS: readonly MediaUsageBackend[] = ['r2', 'kv'];

export interface MediaStorageUsageRow {
  backend: MediaUsageBackend;
  bytes_used: number;
  object_count: number;
  bytes_limit: number | null;
  bytes_buffer: number;
  last_calibrated_at: string | null;
  updated_at: string;
}

export type UsageStatus = 'ok' | 'warn' | 'full' | 'unconfigured';

export interface UsageApiShape {
  configured: boolean;
  bytes_used: number;
  bytes_limit: number | null;
  bytes_buffer: number;
  bytes_threshold: number | null;
  percent_of_threshold: number | null;
  object_count: number;
  last_calibrated_at: string | null;
  status: UsageStatus;
}

export interface PickWriteBackendResult {
  backend: MediaUsageBackend;
  filebaseStored?: StoredFilebaseConfig;
  b2Stored?: StoredB2Config;
}

export interface UsageAfterSnapshot {
  bytes_used: number;
  bytes_threshold: number | null;
}

function nowIso(): string {
  return new Date().toISOString();
}

export function isMediaUsageBackend(raw: string): raw is MediaUsageBackend {
  return raw === 'filebase' || raw === 'b2' || raw === 'r2' || raw === 'kv';
}

/** 规范化：去重、补全 r2/kv 尾、剔除非法项 */
export function normalizeWritePriority(raw: readonly string[]): MediaUsageBackend[] {
  const seen = new Set<MediaUsageBackend>();
  const out: MediaUsageBackend[] = [];
  for (const item of raw) {
    if (!isMediaUsageBackend(item) || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  for (const tail of TAIL_BACKENDS) {
    if (!seen.has(tail)) {
      seen.add(tail);
      out.push(tail);
    }
  }
  return out.length > 0 ? out : [...DEFAULT_WRITE_PRIORITY];
}

/** 纯函数：将新配置的云后端追加到已有链（插在 r2/kv 之前） */
export function appendCloudBackendToPriorityList(
  priority: readonly MediaUsageBackend[],
  backend: CloudUsageBackend,
): MediaUsageBackend[] {
  if (priority.includes(backend)) return [...priority];
  const r2Idx = priority.indexOf('r2');
  const kvIdx = priority.indexOf('kv');
  const insertAt = r2Idx >= 0 ? r2Idx : kvIdx >= 0 ? kvIdx : priority.length;
  const next = [...priority];
  next.splice(insertAt, 0, backend);
  return normalizeWritePriority(next);
}

export function removeCloudBackendFromPriorityList(
  priority: readonly MediaUsageBackend[],
  backend: CloudUsageBackend,
): MediaUsageBackend[] {
  return normalizeWritePriority(priority.filter((b) => b !== backend));
}

async function persistWritePriority(env: Env, priority: readonly MediaUsageBackend[]): Promise<void> {
  const db = resolveIdentityDb(env);
  await db
    .prepare(`INSERT OR REPLACE INTO system_config (key, value, updated_at) VALUES (?, ?, ?)`)
    .bind(WRITE_PRIORITY_KEY, JSON.stringify(normalizeWritePriority(priority)), nowIso())
    .run();
}

/** 从 media_storage_config.updated_at 推导历史配置顺序（仅缺 media_write_priority 时 bootstrap 一次）。
 * 注意：updated_at 会在编辑凭证时刷新，严格语义不是 first configured；M5-SR 上线前已双配云库的老节点顺序可能偏差。
 * 正向路径以 registerCloudBackendInPriority（首次探针通过保存）为准，bootstrap 后持久化不再覆盖。 */
export async function bootstrapWritePriorityFromConfig(env: Env): Promise<MediaUsageBackend[]> {
  // media_storage_config 在 GOVERNANCE_DB
  const govDb = resolveGovernanceDb(env);
  try {
    const rows = await govDb
      .prepare(`SELECT id, config_json, updated_at FROM media_storage_config WHERE id IN ('b2', 'filebase')`)
      .all<{ id: string; config_json: string; updated_at: string }>();
    const cloud: { id: CloudUsageBackend; updated_at: string }[] = [];
    for (const row of rows.results ?? []) {
      if (row.id !== 'b2' && row.id !== 'filebase') continue;
      if (isStoredB2ConfigComplete(parseStoredB2Config(row.config_json))) {
        cloud.push({ id: row.id, updated_at: row.updated_at });
      }
    }
    cloud.sort((a, b) => a.updated_at.localeCompare(b.updated_at));
    if (cloud.length === 0) return [...DEFAULT_WRITE_PRIORITY];
    const boot = normalizeWritePriority(cloud.map((c) => c.id));
    // system_config 写用 IDENTITY_DB
    await persistWritePriority(env, boot).catch((err) =>
      console.error('[mediaStorageUsage] 持久化 bootstrap write_priority 失败', err),
    );
    return boot;
  } catch (err) {
    console.error('[mediaStorageUsage] bootstrapWritePriorityFromConfig 失败', err);
    return [...DEFAULT_WRITE_PRIORITY];
  }
}

export async function readWritePriority(env: Env): Promise<MediaUsageBackend[]> {
  const db = resolveIdentityDb(env);
  try {
    const row = await db
      .prepare(`SELECT value FROM system_config WHERE key = ? LIMIT 1`)
      .bind(WRITE_PRIORITY_KEY)
      .first<{ value: string }>();
    if (row?.value) {
      const parsed = JSON.parse(row.value) as unknown;
      if (Array.isArray(parsed) && parsed.every((x) => typeof x === 'string')) {
        return normalizeWritePriority(parsed);
      }
    }
  } catch (err) {
    console.error('[mediaStorageUsage] 读 media_write_priority 失败', err);
  }
  const boot = await bootstrapWritePriorityFromConfig(env);
  return boot;
}

/** 首次保存某云后端凭证时，按配置先后顺序写入优先级链 */
export async function registerCloudBackendInPriority(
  env: Env,
  backend: CloudUsageBackend,
): Promise<void> {
  const current = await readWritePriority(env);
  if (current.includes(backend)) return;
  await persistWritePriority(env, appendCloudBackendToPriorityList(current, backend));
}

export async function unregisterCloudBackendFromPriority(
  env: Env,
  backend: CloudUsageBackend,
): Promise<void> {
  const current = await readWritePriority(env);
  if (!current.includes(backend)) return;
  await persistWritePriority(env, removeCloudBackendFromPriorityList(current, backend));
}

/** 从 KV 起步后首次配好云存储：自动开 router，新上传走云链而非 KV */
export async function maybeAutoEnableRouterOnCloudConfig(env: Env): Promise<void> {
  const identityDb = resolveIdentityDb(env);
  const mode = await readMediaStorageMode(env);
  if (mode === 'router') return;
  const [fb, b2, fbProbe, b2Probe] = await Promise.all([
    resolveFilebaseConfig(env),
    resolveB2Config(env),
    readFilebaseProbeStatus(env),
    readB2ProbeStatus(env),
  ]);
  const cloudReady =
    (isStoredB2ConfigComplete(fb) && fbProbe === 'ok') ||
    (isStoredB2ConfigComplete(b2) && b2Probe === 'ok');
  if (cloudReady) {
    await setMediaStorageMode(identityDb, 'router');
  }
}

/** M8-14-9b：阈值入参非法（NaN / 越界 / 业务关系错）。route catch 后转 400 响应。 */
export class MediaStorageThresholdError extends Error {
  readonly field: string;
  constructor(field: string, message: string) {
    super(message);
    this.name = 'MediaStorageThresholdError';
    this.field = field;
  }
}

/**
 * M8-14-9b：阈值块业务校验。仅校验 payload 中**实际给出**的字段；空字段不动。
 * - 数字字段必须 `Number.isFinite`(挡 NaN / Infinity / -Infinity)
 * - `kv_high_watermark` / `r2_high_watermark` / `r2_target_watermark` ∈ [0.01, 0.99]
 * - `kv_preferred_max_bytes` ≥ 1024
 * - 业务关系：`r2_target_watermark` 必须严格小于 `r2_high_watermark`（两者均提供时校验）
 * 返回 null 表示全部合法；否则返回首个错误的字段名+中文错误。
 */
export function validateMediaStorageThresholdsBody(
  input: Record<string, unknown> | null | undefined,
): { ok: true } | { ok: false; field: string; error: string } {
  if (input == null || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: true }; // 未提供 thresholds 字段，视为不动
  }
  // 浮点水位
  for (const key of ['kv_high_watermark', 'r2_high_watermark', 'r2_target_watermark'] as const) {
    if (!(key in input)) continue;
    const v = input[key];
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      return { ok: false, field: key, error: `${key} 必须是有限数字` };
    }
    if (v < 0.01 || v > 0.99) {
      return { ok: false, field: key, error: `${key} 必须在 0.01~0.99 之间` };
    }
  }
  // 字节阈值（≥1 KB）
  if ('kv_preferred_max_bytes' in input) {
    const v = input.kv_preferred_max_bytes;
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      return {
        ok: false,
        field: 'kv_preferred_max_bytes',
        error: 'kv_preferred_max_bytes 必须是有限数字',
      };
    }
    if (v < 1024) {
      return {
        ok: false,
        field: 'kv_preferred_max_bytes',
        error: 'kv_preferred_max_bytes 必须 ≥ 1024 字节（1 KB）',
      };
    }
  }
  // 业务关系：R2 目标水位必须严格小于 R2 高水位
  if (
    'r2_target_watermark' in input &&
    'r2_high_watermark' in input &&
    typeof input.r2_target_watermark === 'number' &&
    typeof input.r2_high_watermark === 'number' &&
    Number.isFinite(input.r2_target_watermark) &&
    Number.isFinite(input.r2_high_watermark) &&
    input.r2_target_watermark >= input.r2_high_watermark
  ) {
    return {
      ok: false,
      field: 'r2_target_watermark',
      error: 'r2_target_watermark 必须严格小于 r2_high_watermark',
    };
  }
  return { ok: true };
}

/** M8-14-9：写 KV 高水位阈值（0.01~0.99，存 D1 system_config） */
export async function setKvHighWatermark(env: Env, value: number): Promise<void> {
  // M8-14-9b：挡 NaN / ±Infinity；越界静默 return 作为最后兜底。route 层已前置校验，正常不会触达。
  if (!Number.isFinite(value) || value < 0.01 || value > 0.99) return;
  const db = resolveIdentityDb(env);
  await db
    .prepare(`INSERT OR REPLACE INTO system_config (key, value, updated_at) VALUES (?, ?, ?)`)
    .bind(KV_WATERMARK_KEY, String(value), nowIso())
    .run();
}

/** M8-14-9：写 KV 优先阈值（字节数，存 D1 system_config） */
export async function setKvPreferredMaxBytes(env: Env, value: number): Promise<void> {
  // M8-14-9b：挡 NaN / ±Infinity；< 1024 静默 return。route 层已前置校验。
  if (!Number.isFinite(value) || value < 1024) return;
  const db = resolveIdentityDb(env);
  await db
    .prepare(`INSERT OR REPLACE INTO system_config (key, value, updated_at) VALUES (?, ?, ?)`)
    .bind(KV_PREFERRED_MAX_KEY, String(value), nowIso())
    .run();
}

/** M8-14-9：写 R2 高水位阈值（0.01~0.99，存 D1 system_config） */
export async function setR2HighWatermark(env: Env, value: number): Promise<void> {
  if (!Number.isFinite(value) || value < 0.01 || value > 0.99) return;
  const db = resolveIdentityDb(env);
  await db
    .prepare(`INSERT OR REPLACE INTO system_config (key, value, updated_at) VALUES (?, ?, ?)`)
    .bind(R2_HIGH_WATERMARK_KEY, String(value), nowIso())
    .run();
}

/** M8-14-9：写 R2 目标水位阈值（0.01~0.99，存 D1 system_config） */
export async function setR2TargetWatermark(env: Env, value: number): Promise<void> {
  if (!Number.isFinite(value) || value < 0.01 || value > 0.99) return;
  const db = resolveIdentityDb(env);
  await db
    .prepare(`INSERT OR REPLACE INTO system_config (key, value, updated_at) VALUES (?, ?, ?)`)
    .bind(R2_TARGET_WATERMARK_KEY, String(value), nowIso())
    .run();
}

/** 读 KV 高水位阈值（默认 0.90） */
export async function readKvHighWatermark(env: Env): Promise<number> {
  const db = resolveIdentityDb(env);
  try {
    const row = await db
      .prepare(`SELECT value FROM system_config WHERE key = ? LIMIT 1`)
      .bind(KV_WATERMARK_KEY)
      .first<{ value: string }>();
    if (row?.value) {
      const v = parseFloat(row.value);
      if (v > 0 && v <= 1) return v;
    }
  } catch {
    // ignore
  }
  return DEFAULT_KV_HIGH_WATERMARK;
}

/** 读 KV 优先阈值（默认 10 MiB） */
export async function readKvPreferredMaxBytes(env: Env): Promise<number> {
  const db = resolveIdentityDb(env);
  try {
    const row = await db
      .prepare(`SELECT value FROM system_config WHERE key = ? LIMIT 1`)
      .bind(KV_PREFERRED_MAX_KEY)
      .first<{ value: string }>();
    if (row?.value) {
      const v = parseInt(row.value, 10);
      if (v > 0) return v;
    }
  } catch {
    // ignore
  }
  return DEFAULT_KV_PREFERRED_MAX;
}

/** M8-14-7：检查 KV 是否已超过高水位（≥ 水位比例）；超水位时新文件应改道 R2 */
export async function isKvHighWatermarkExceeded(env: Env): Promise<boolean> {
  const kvRow = await readUsageRow(env, 'kv');
  if (!kvRow || kvRow.bytes_limit == null) {
    // KV 用量行未初始化或无上限：不认为超过水位（保留容量）
    return false;
  }
  const watermark = await readKvHighWatermark(env);
  const threshold = kvRow.bytes_limit * watermark;
  return kvRow.bytes_used >= threshold;
}

/** 读 R2 高水位阈值（默认 0.90）— M8-14-8 GC 触发线 */
export async function readR2HighWatermark(env: Env): Promise<number> {
  const db = resolveIdentityDb(env);
  try {
    const row = await db
      .prepare(`SELECT value FROM system_config WHERE key = ? LIMIT 1`)
      .bind(R2_HIGH_WATERMARK_KEY)
      .first<{ value: string }>();
    if (row?.value) {
      const v = parseFloat(row.value);
      if (v > 0 && v <= 1) return v;
    }
  } catch {
    // ignore
  }
  return DEFAULT_R2_HIGH_WATERMARK;
}

/** 读 R2 目标水位（默认 0.70）— M8-14-8 GC 清到的水位 */
export async function readR2TargetWatermark(env: Env): Promise<number> {
  const db = resolveIdentityDb(env);
  try {
    const row = await db
      .prepare(`SELECT value FROM system_config WHERE key = ? LIMIT 1`)
      .bind(R2_TARGET_WATERMARK_KEY)
      .first<{ value: string }>();
    if (row?.value) {
      const v = parseFloat(row.value);
      if (v > 0 && v <= 1) return v;
    }
  } catch {
    // ignore
  }
  return DEFAULT_R2_TARGET_WATERMARK;
}

/** M8-14-8：检查 R2 是否已超水位（≥ high watermark）；超水位时 GC 应触发 */
export async function isR2HighWatermarkExceeded(env: Env): Promise<boolean> {
  const r2Row = await readUsageRow(env, 'r2');
  if (!r2Row || r2Row.bytes_limit == null) {
    // R2 用量行未初始化或无上限：不认为超过水位（保留容量）
    return false;
  }
  const watermark = await readR2HighWatermark(env);
  const threshold = r2Row.bytes_limit * watermark;
  return r2Row.bytes_used >= threshold;
}

/** M8-14-7：lazy init kv/r2 用量行（确保 bytes_limit 非 null，避免 null 比较导致水位检查失效） */
export async function ensureKvAndR2UsageRowInitialized(env: Env): Promise<void> {
  const db = resolveIdentityDb(env);
  const iso = nowIso();

  // KV 行：确保 bytes_limit = KV_SOFT_LIMIT_BYTES（1 GiB）
  try {
    const existing = await db
      .prepare(`SELECT bytes_limit FROM media_storage_usage WHERE backend = 'kv' LIMIT 1`)
      .first<{ bytes_limit: number | null }>();
    if (!existing) {
      await db
        .prepare(
          `INSERT INTO media_storage_usage (backend, bytes_used, object_count, bytes_limit, bytes_buffer, updated_at)
           VALUES ('kv', 0, 0, ?, 0, ?)`,
        )
        .bind(KV_SOFT_LIMIT_BYTES, iso)
        .run();
    } else if (existing.bytes_limit == null) {
      await db
        .prepare(`UPDATE media_storage_usage SET bytes_limit = ? WHERE backend = 'kv'`)
        .bind(KV_SOFT_LIMIT_BYTES, iso)
        .run();
    }
  } catch (err) {
    console.error('[mediaStorageUsage] init kv usage row 失败', err);
  }

  // R2 行：确保 bytes_limit = Number(R2_SOFT_LIMIT_BYTES)（10 GiB）
  try {
    const existing = await db
      .prepare(`SELECT bytes_limit FROM media_storage_usage WHERE backend = 'r2' LIMIT 1`)
      .first<{ bytes_limit: number | null }>();
    const r2Limit = Number(R2_SOFT_LIMIT_BYTES);
    if (!existing) {
      await db
        .prepare(
          `INSERT INTO media_storage_usage (backend, bytes_used, object_count, bytes_limit, bytes_buffer, updated_at)
           VALUES ('r2', 0, 0, ?, 0, ?)`,
        )
        .bind(r2Limit, iso)
        .run();
    } else if (existing.bytes_limit == null) {
      await db
        .prepare(`UPDATE media_storage_usage SET bytes_limit = ? WHERE backend = 'r2'`)
        .bind(r2Limit, iso)
        .run();
    }
  } catch (err) {
    console.error('[mediaStorageUsage] init r2 usage row 失败', err);
  }
}

async function tryPickBackend(
  env: Env,
  backend: MediaUsageBackend,
  opts: { contentType: string; sizeBytes: number | null },
): Promise<PickWriteBackendResult | null> {
  const incoming = opts.sizeBytes ?? 0;

  if (backend === 'filebase') {
    const stored = await resolveFilebaseConfig(env);
    const probe = await readFilebaseProbeStatus(env);
    if (!stored || probe !== 'ok') return null;
    const row = await readUsageRow(env, 'filebase');
    if (row && wouldExceedThreshold(row, incoming)) return null;
    return { backend: 'filebase', filebaseStored: stored };
  }

  if (backend === 'b2') {
    const stored = await resolveB2Config(env);
    const probe = await readB2ProbeStatus(env);
    if (!stored || probe !== 'ok') return null;
    const row = await readUsageRow(env, 'b2');
    if (row && wouldExceedThreshold(row, incoming)) return null;
    return { backend: 'b2', b2Stored: stored };
  }

  if (backend === 'r2') {
    // M8-14-5-fix：读 IDENTITY 探针；unknown 时懒探测一次，避免「已绑定却永远拒写」
    if (!(await ensureR2Available(env))) return null;
    return { backend: 'r2' };
  }

  if (backend === 'kv') {
    // M10-P3：Messaging Media 短语音可走 KV；公开帖图仍由 images 路由自行拒绝非 image/*
    if (!opts.contentType.startsWith('image/') && !opts.contentType.startsWith('audio/')) {
      return null;
    }
    if (opts.sizeBytes != null && opts.sizeBytes > KV_MAX_BYTES) return null;

    // M8-14-7：大小阈值 — 超过 10 MiB 改道 R2（有绑定时）
    if (opts.sizeBytes != null && opts.sizeBytes > KV_PREFERRED_MAX_BYTES) {
      // 尝试让 R2 接住（含 unknown 懒探测）
      if (await ensureR2Available(env)) return { backend: 'r2' };
      // R2 不可用时：仍拒绝（大文件没有安全兜底）
      return null;
    }

    // M8-14-7：KV 高水位改道 — 用量 ≥ 水位时，新文件走 R2
    const kvHigh = await isKvHighWatermarkExceeded(env);
    if (kvHigh && (await ensureR2Available(env))) {
      return { backend: 'r2' };
    }

    return { backend: 'kv' };
  }

  return null;
}

export function computeBytesThreshold(
  bytesLimit: number | null,
  bytesBuffer: number,
): number | null {
  if (bytesLimit == null) return null;
  return bytesLimit - bytesBuffer;
}

export async function readMediaStorageMode(env: Env): Promise<MediaStorageMode> {
  const db = resolveIdentityDb(env);
  try {
    const row = await db
      .prepare(`SELECT value FROM system_config WHERE key = ? LIMIT 1`)
      .bind(MODE_KEY)
      .first<{ value: string }>();
    if (row?.value === 'router') return 'router';
  } catch (err) {
    console.error('[mediaStorageUsage] 读 media_storage_mode 失败，回落 manual', err);
  }
  return 'manual';
}

export async function setMediaStorageMode(db: D1Database, mode: MediaStorageMode): Promise<void> {
  // caller 必须传 resolveIdentityDb(env)，因为 system_config 在 IDENTITY_DB
  await db
    .prepare(`INSERT OR REPLACE INTO system_config (key, value, updated_at) VALUES (?, ?, ?)`)
    .bind(MODE_KEY, mode, nowIso())
    .run();
}

export async function readActiveWriteBackend(env: Env): Promise<MediaUsageBackend> {
  const db = resolveIdentityDb(env);
  try {
    const row = await db
      .prepare(`SELECT value FROM system_config WHERE key = ? LIMIT 1`)
      .bind(ACTIVE_BACKEND_KEY)
      .first<{ value: string }>();
    if (
      row?.value === 'filebase' ||
      row?.value === 'b2' ||
      row?.value === 'r2' ||
      row?.value === 'kv'
    ) {
      return row.value;
    }
  } catch (err) {
    console.error('[mediaStorageUsage] 读 media_active_write_backend 失败', err);
  }
  return 'kv';
}

export async function setActiveWriteBackend(env: Env, backend: MediaUsageBackend): Promise<void> {
  const db = resolveIdentityDb(env);
  await db
    .prepare(`INSERT OR REPLACE INTO system_config (key, value, updated_at) VALUES (?, ?, ?)`)
    .bind(ACTIVE_BACKEND_KEY, backend, nowIso())
    .run();
}

export async function readUsageRow(
  env: Env,
  backend: MediaUsageBackend,
): Promise<MediaStorageUsageRow | null> {
  const db = resolveIdentityDb(env);
  try {
    const row = await db
      .prepare(
        `SELECT backend, bytes_used, object_count, bytes_limit, bytes_buffer, last_calibrated_at, updated_at
         FROM media_storage_usage WHERE backend = ? LIMIT 1`,
      )
      .bind(backend)
      .first<MediaStorageUsageRow>();
    return row ?? null;
  } catch (err) {
    console.error('[mediaStorageUsage] 读用量行失败', backend, err);
    return null;
  }
}

export function wouldExceedThreshold(
  row: MediaStorageUsageRow,
  incomingBytes: number,
): boolean {
  const threshold = computeBytesThreshold(row.bytes_limit, row.bytes_buffer);
  if (threshold == null) return false;
  return row.bytes_used + incomingBytes > threshold;
}

export function isBackendFull(row: MediaStorageUsageRow, incomingBytes = 0): boolean {
  const threshold = computeBytesThreshold(row.bytes_limit, row.bytes_buffer);
  if (threshold == null) return false;
  return row.bytes_used + incomingBytes >= threshold;
}

export function formatUsageForApi(
  row: MediaStorageUsageRow | null,
  configured: boolean,
): UsageApiShape {
  if (!row) {
    return {
      configured,
      bytes_used: 0,
      bytes_limit: null,
      bytes_buffer: 0,
      bytes_threshold: null,
      percent_of_threshold: null,
      object_count: 0,
      last_calibrated_at: null,
      status: configured ? 'ok' : 'unconfigured',
    };
  }

  const bytes_threshold = computeBytesThreshold(row.bytes_limit, row.bytes_buffer);
  let percent_of_threshold: number | null = null;
  if (bytes_threshold != null && bytes_threshold > 0) {
    percent_of_threshold = Math.round((row.bytes_used / bytes_threshold) * 1000) / 10;
  }

  let status: UsageStatus = configured ? 'ok' : 'unconfigured';
  if (configured && bytes_threshold != null) {
    if (row.bytes_used >= bytes_threshold) status = 'full';
    else if (bytes_threshold > 0 && row.bytes_used >= bytes_threshold * 0.85) status = 'warn';
  }

  return {
    configured,
    bytes_used: row.bytes_used,
    bytes_limit: row.bytes_limit,
    bytes_buffer: row.bytes_buffer,
    bytes_threshold,
    percent_of_threshold,
    object_count: row.object_count,
    last_calibrated_at: row.last_calibrated_at,
    status,
  };
}

export async function decrementUsage(
  env: Env,
  backend: MediaUsageBackend,
  deltaBytes: number,
): Promise<void> {
  if (deltaBytes <= 0) return;
  const db = resolveIdentityDb(env);
  const iso = nowIso();
  try {
    await db
      .prepare(
        `UPDATE media_storage_usage
         SET bytes_used = CASE WHEN bytes_used > ? THEN bytes_used - ? ELSE 0 END,
             object_count = CASE WHEN object_count > 0 THEN object_count - 1 ELSE 0 END,
             updated_at = ?
         WHERE backend = ?`,
      )
      .bind(deltaBytes, deltaBytes, iso, backend)
      .run();
  } catch (err) {
    console.error('[mediaStorageUsage] decrement 失败', backend, err);
  }
}

export async function incrementUsage(
  env: Env,
  backend: MediaUsageBackend,
  deltaBytes: number,
): Promise<MediaStorageUsageRow | null> {
  if (deltaBytes <= 0) return readUsageRow(env, backend);
  // 防止用量行尚未 lazy-init 时 UPDATE 0 行导致账本永远为 0
  if (backend === 'kv' || backend === 'r2') {
    await ensureKvAndR2UsageRowInitialized(env);
  }
  const db = resolveIdentityDb(env);
  const iso = nowIso();
  try {
    await db
      .prepare(
        `UPDATE media_storage_usage
         SET bytes_used = bytes_used + ?, object_count = object_count + 1, updated_at = ?
         WHERE backend = ?`,
      )
      .bind(deltaBytes, iso, backend)
      .run();
    return readUsageRow(env, backend);
  } catch (err) {
    console.error('[mediaStorageUsage] increment 失败', backend, err);
    return null;
  }
}

export async function setUsageBytes(
  env: Env,
  backend: MediaUsageBackend,
  bytesUsed: number,
  calibratedAt?: string,
): Promise<void> {
  const db = resolveIdentityDb(env);
  const iso = nowIso();
  const cal = calibratedAt ?? iso;
  await db
    .prepare(
      `UPDATE media_storage_usage
       SET bytes_used = CASE WHEN ? > bytes_used THEN ? ELSE bytes_used END,
           last_calibrated_at = ?,
           updated_at = ?
       WHERE backend = ?`,
    )
    .bind(bytesUsed, bytesUsed, cal, iso, backend)
    .run();
}

/** 校准写入：bytes/object_count 均取 max(local, 外部值)，保守高估 */
export async function setUsageAfterCalibration(
  env: Env,
  backend: MediaUsageBackend,
  bytesUsed: number,
  objectCount: number,
  calibratedAt?: string,
): Promise<void> {
  const db = resolveIdentityDb(env);
  const iso = nowIso();
  const cal = calibratedAt ?? iso;
  await db
    .prepare(
      `UPDATE media_storage_usage
       SET bytes_used = CASE WHEN ? > bytes_used THEN ? ELSE bytes_used END,
           object_count = CASE WHEN ? > object_count THEN ? ELSE object_count END,
           last_calibrated_at = ?,
           updated_at = ?
       WHERE backend = ?`,
    )
    .bind(bytesUsed, bytesUsed, objectCount, objectCount, cal, iso, backend)
    .run();
}

/** 从 media_object_registry 聚合未释放对象的用量（M5-SR-P2d；M8-14-10b 起含 kv） */
export async function aggregateRegistryUsage(
  env: Env,
): Promise<Partial<Record<'filebase' | 'b2' | 'r2' | 'kv', { bytes: number; count: number }>>> {
  const db = resolveIdentityDb(env);
  const out: Partial<Record<'filebase' | 'b2' | 'r2' | 'kv', { bytes: number; count: number }>> = {};
  try {
    const rows = await db
      .prepare(
        `SELECT backend, COALESCE(SUM(size_bytes), 0) AS bytes, COUNT(*) AS cnt
         FROM media_object_registry
         WHERE released_at IS NULL AND backend IN ('filebase', 'b2', 'r2', 'kv')
         GROUP BY backend`,
      )
      .all<{ backend: string; bytes: number; cnt: number }>();
    for (const row of rows.results ?? []) {
      if (
        row.backend === 'filebase' ||
        row.backend === 'b2' ||
        row.backend === 'r2' ||
        row.backend === 'kv'
      ) {
        out[row.backend] = { bytes: row.bytes, count: row.cnt };
      }
    }
  } catch (err) {
    console.error('[mediaStorageUsage] aggregateRegistryUsage 失败', err);
  }
  return out;
}

/**
 * 设置页手动 backfill：登记表白名单聚合 + Filebase/R2/KV 校准。
 * 仅提升本地计数（KV 以 list 为真值可下调到实际）。
 */
export async function backfillUsageFromRegistry(env: Env): Promise<void> {
  const iso = nowIso();
  // 先扫 IMAGE_KV，把孤儿 key 补进登记表并写用量（否则旧对象永远显示 0）
  await calibrateKvUsage(env);
  const agg = await aggregateRegistryUsage(env);
  for (const backend of ['filebase', 'b2', 'r2', 'kv'] as const) {
    const row = agg[backend];
    if (!row || (row.bytes <= 0 && row.count <= 0)) continue;
    await setUsageAfterCalibration(env, backend, row.bytes, row.count, iso);
  }
  await calibrateFilebaseUsage(env);
  await calibrateR2Usage(env);
}

/**
 * M8-14-10b：列举 IMAGE_KV（prefix `kv:`）校准用量，并 INSERT OR IGNORE 补登记孤儿对象。
 * 以 list + metadata.size 为真值写入（可下调），对齐 Free Tier 软上限守护。
 */
export async function calibrateKvUsage(
  env: Env,
  opts?: { maxPages?: number },
): Promise<boolean> {
  if (!env.IMAGE_KV) return false;
  await ensureKvAndR2UsageRowInitialized(env);

  const db = resolveIdentityDb(env);
  const iso = nowIso();
  const maxPages = opts?.maxPages ?? 20;
  let bytes = 0;
  let objectCount = 0;
  let cursor: string | undefined;
  let truncated = false;

  try {
    for (let page = 0; page < maxPages; page++) {
      const listed = await env.IMAGE_KV.list({
        prefix: 'kv:',
        limit: 1000,
        ...(cursor ? { cursor } : {}),
      });
      for (const key of listed.keys) {
        const meta = key.metadata as { size?: unknown } | undefined;
        const size =
          typeof meta?.size === 'number' && Number.isFinite(meta.size) && meta.size >= 0
            ? Math.floor(meta.size)
            : 0;
        bytes += size;
        objectCount += 1;
        // 补登记：旧上传可能只 put 了 KV、未写 media_object_registry
        try {
          await db
            .prepare(
              `INSERT OR IGNORE INTO media_object_registry (object_key, backend, size_bytes, created_at)
               VALUES (?, 'kv', ?, ?)`,
            )
            .bind(key.name, size > 0 ? size : 0, iso)
            .run();
        } catch (err) {
          console.error('[mediaStorageUsage] KV 校准登记失败', key.name, err);
        }
      }
      if (listed.list_complete) {
        cursor = undefined;
        break;
      }
      cursor = listed.cursor;
      if (!cursor) break;
      if (page === maxPages - 1) truncated = true;
    }

    // 以 list 为真值覆盖写入（允许下调，否则删对象后水位永远虚高）
    await db
      .prepare(
        `UPDATE media_storage_usage
         SET bytes_used = ?, object_count = ?, last_calibrated_at = ?, updated_at = ?
         WHERE backend = 'kv'`,
      )
      .bind(bytes, objectCount, iso, iso)
      .run();

    if (truncated) {
      console.warn(
        `[mediaStorageUsage] KV list 校准分页截断 bytes=${bytes} objects=${objectCount}`,
      );
    } else {
      console.log(
        `[mediaStorageUsage] KV 用量校准 ok bytes=${bytes} objects=${objectCount}`,
      );
    }
    return true;
  } catch (err) {
    console.error('[mediaStorageUsage] KV 用量校准异常', err);
    return false;
  }
}

/**
 * 读 R2 探针。system_config.r2_probe_status 权威在 IDENTITY_DB（与 probeR2 Cron 写入同库）。
 * 曾误读 GOVERNANCE_DB → 永远 unknown → 大于 10MB 上传恒拒（M8-14-5-fix）。
 */
async function readR2ProbeStatus(env: Env): Promise<string> {
  const db = resolveIdentityDb(env);
  try {
    const row = await db
      .prepare(`SELECT value FROM system_config WHERE key = 'r2_probe_status' LIMIT 1`)
      .first<{ value: string }>();
    return row?.value ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

async function writeR2ProbeStatus(env: Env, status: 'ok' | 'fail' | 'unavailable'): Promise<void> {
  const db = resolveIdentityDb(env);
  await db
    .prepare(
      `INSERT OR REPLACE INTO system_config (key, value, updated_at) VALUES ('r2_probe_status', ?, ?)`,
    )
    .bind(status, nowIso())
    .run()
    .catch((err) => console.error('[mediaStorageUsage] 写 r2_probe_status 失败', err));
}

/**
 * 上传路径用：binding 在且探针可用则 true。
 * - ok → 直接可用
 * - unavailable / fail → 不可用（需修绑定或等 Cron 再探）
 * - unknown → 懒探测一次写/删探针对象，避免等 30 分钟 Cron 才能发大图
 */
async function ensureR2Available(env: Env): Promise<boolean> {
  if (!env.HAILUO_IMAGE_R2) return false;
  const probe = await readR2ProbeStatus(env);
  if (probe === 'ok') return true;
  if (probe === 'unavailable' || probe === 'fail') return false;

  // unknown / 其它：懒探测（与 handlers/cron.probeR2 同形）
  const probeKey = `_probe_upload_${Date.now()}`;
  try {
    await env.HAILUO_IMAGE_R2.put(probeKey, new Uint8Array([0x00]));
    await env.HAILUO_IMAGE_R2.delete(probeKey);
    await writeR2ProbeStatus(env, 'ok');
    return true;
  } catch (err) {
    console.error('[mediaStorageUsage] R2 懒探针失败', err);
    await writeR2ProbeStatus(env, 'fail');
    return false;
  }
}

/** router 模式：按 D1 media_write_priority（配置先后）选写入后端 */
export async function pickWriteBackend(
  env: Env,
  opts: { contentType: string; sizeBytes: number | null },
): Promise<PickWriteBackendResult | null> {
  const priority = await readWritePriority(env);
  for (const backend of priority) {
    const picked = await tryPickBackend(env, backend, opts);
    if (picked) return picked;
  }
  return null;
}

/** manual 模式：先尝试所选 backend，满额后按 write_priority 溢出到其它已配库 */
export async function resolveManualUploadBackend(
  env: Env,
  opts: { contentType: string; sizeBytes: number | null },
): Promise<PickWriteBackendResult | null> {
  const imagesStorage = await readImagesStorage(env);
  const primary: MediaUsageBackend =
    imagesStorage === 'filebase' || imagesStorage === 'b2' || imagesStorage === 'r2'
      ? imagesStorage
      : 'kv';
  const chain = await readWritePriority(env);
  const seen = new Set<MediaUsageBackend>();
  const tryOrder: MediaUsageBackend[] = [];
  for (const b of [primary, ...chain]) {
    if (seen.has(b)) continue;
    seen.add(b);
    tryOrder.push(b);
  }
  for (const backend of tryOrder) {
    const picked = await tryPickBackend(env, backend, opts);
    if (picked) return picked;
  }
  return null;
}

export async function resolveUploadBackend(
  env: Env,
  opts: { contentType: string; sizeBytes: number | null },
): Promise<PickWriteBackendResult | null> {
  // M8-14-7：lazy init kv/r2 用量行（确保 bytes_limit 非 null，水位检查有效）
  await ensureKvAndR2UsageRowInitialized(env);
  const mode = await readMediaStorageMode(env);
  if (mode === 'router') return pickWriteBackend(env, opts);
  return resolveManualUploadBackend(env, opts);
}

const MESSAGING_CLOUD_BACKENDS: readonly ('filebase' | 'b2' | 'r2')[] = [
  'filebase',
  'b2',
  'r2',
];

/**
 * MM-2：群图上传专用 — 仅 filebase/b2/r2；**禁止** KV fallback。
 * 满额或 probe≠ok 时返回 null（路由层映射 GROUP_MEDIA_CLOUD_REQUIRED）。
 */
export async function resolveMessagingCloudBackend(
  env: Env,
  opts: { contentType: string; sizeBytes: number | null },
): Promise<PickWriteBackendResult | null> {
  const priority = await readWritePriority(env);
  const seen = new Set<MediaUsageBackend>();
  const tryOrder: ('filebase' | 'b2' | 'r2')[] = [];
  for (const backend of priority) {
    if (backend !== 'filebase' && backend !== 'b2' && backend !== 'r2') continue;
    if (seen.has(backend)) continue;
    seen.add(backend);
    tryOrder.push(backend);
  }
  for (const backend of MESSAGING_CLOUD_BACKENDS) {
    if (seen.has(backend)) continue;
    tryOrder.push(backend);
  }
  for (const backend of tryOrder) {
    const picked = await tryPickBackend(env, backend, opts);
    if (picked) return picked;
  }
  return null;
}

/** 是否至少有一个可用云后端（probe ok 且未超阈值；incoming=0 探容量）。 */
export async function hasMessagingCloudCapability(env: Env): Promise<boolean> {
  return (
    (await resolveMessagingCloudBackend(env, {
      contentType: 'image/jpeg',
      sizeBytes: 0,
    })) !== null
  );
}

export async function finalizeMediaUpload(
  env: Env,
  backend: MediaUsageBackend,
  sizeBytes: number,
): Promise<UsageAfterSnapshot | null> {
  const row = await incrementUsage(env, backend, sizeBytes);
  await setActiveWriteBackend(env, backend);
  if (!row) return null;
  return {
    bytes_used: row.bytes_used,
    bytes_threshold: computeBytesThreshold(row.bytes_limit, row.bytes_buffer),
  };
}

export async function buildUsageMapForApi(
  env: Env,
): Promise<Partial<Record<'filebase' | 'b2' | 'r2' | 'kv', UsageApiShape>>> {
  // M8-14-10：展示前确保 kv/r2 用量行与 soft limit 已初始化
  await ensureKvAndR2UsageRowInitialized(env);

  const [filebaseCfg, b2Cfg, r2Probe] = await Promise.all([
    resolveFilebaseConfig(env),
    resolveB2Config(env),
    readR2ProbeStatus(env),
  ]);
  const [filebaseRow, b2Row, r2Row, kvRow] = await Promise.all([
    readUsageRow(env, 'filebase'),
    readUsageRow(env, 'b2'),
    readUsageRow(env, 'r2'),
    readUsageRow(env, 'kv'),
  ]);

  const usage: Partial<Record<'filebase' | 'b2' | 'r2' | 'kv', UsageApiShape>> = {};
  // IMAGE_KV 为 Worker A 必需 binding；用量为 D1 自记账（非 Cloudflare 官方仪表）
  usage.kv = formatUsageForApi(kvRow, Boolean(env.IMAGE_KV));
  if (isStoredFilebaseConfigComplete(filebaseCfg)) {
    usage.filebase = formatUsageForApi(filebaseRow, true);
  }
  if (isStoredB2ConfigComplete(b2Cfg)) {
    usage.b2 = formatUsageForApi(b2Row, true);
  }
  if (env.HAILUO_IMAGE_R2 && r2Probe === 'ok') {
    usage.r2 = formatUsageForApi(r2Row, true);
  }
  return usage;
}

/** Filebase Platform API：校准 bucket 用量（fail-soft；max(local,api) 保守高估，删除后 API 降低不会回落） */
export async function calibrateFilebaseUsage(env: Env): Promise<boolean> {
  const stored = await resolveFilebaseConfig(env);
  if (!isStoredFilebaseConfigComplete(stored)) return false;

  const auth = btoa(`${stored.key_id}:${stored.app_key}`);
  const url = `https://api.filebase.io/v1/usage/storage/${encodeURIComponent(stored.bucket_name)}`;

  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${auth}` },
    });
    if (!res.ok) {
      console.error('[mediaStorageUsage] Filebase 用量 API 失败', res.status, (await res.text()).slice(0, 200));
      return false;
    }
    const json = (await res.json()) as { storage?: { bytes?: number } };
    const apiBytes = json.storage?.bytes;
    if (typeof apiBytes !== 'number' || apiBytes < 0) {
      console.error('[mediaStorageUsage] Filebase 用量 API 响应缺 storage.bytes');
      return false;
    }
    const row = await readUsageRow(env, 'filebase');
    const objectCount = row?.object_count ?? 0;
    await setUsageAfterCalibration(env, 'filebase', apiBytes, objectCount, nowIso());
    console.log(`[mediaStorageUsage] Filebase 用量校准 ok bytes=${apiBytes}`);
    return true;
  } catch (err) {
    console.error('[mediaStorageUsage] Filebase 用量校准异常', err);
    return false;
  }
}

/**
 * B2 S3 ListObjectsV2 低频校准（fail-soft；max(local,listed) 保守高估）。
 * 大 bucket 可能因 maxPages 截断，日志标记 truncated。
 */
export async function calibrateB2Usage(env: Env, opts?: { maxPages?: number }): Promise<boolean> {
  const stored = await resolveB2Config(env);
  if (!isStoredB2ConfigComplete(stored)) return false;
  const probe = await readB2ProbeStatus(env);
  if (probe !== 'ok') return false;

  try {
    const listed = await listB2BucketUsage(toB2UploadConfig(stored), opts);
    await setUsageAfterCalibration(env, 'b2', listed.bytes, listed.objectCount, nowIso());
    if (listed.truncated) {
      console.warn(
        `[mediaStorageUsage] B2 用量校准分页截断 pages=${listed.pages} bytes=${listed.bytes}`,
      );
    } else {
      console.log(
        `[mediaStorageUsage] B2 用量校准 ok bytes=${listed.bytes} objects=${listed.objectCount}`,
      );
    }
    return true;
  } catch (err) {
    console.error('[mediaStorageUsage] B2 用量校准异常', err);
    return false;
  }
}

/**
 * R2 用量校准（M5-SR-P2c）：优先 CF REST /usage；未配 token 时回落 HAILUO_IMAGE_R2 list。
 * max(local, api) 保守高估；R2 无 bytes_limit，仅用于路由可见性与兜底展示。
 */
export async function calibrateR2Usage(env: Env, opts?: { maxPages?: number }): Promise<boolean> {
  if (!env.HAILUO_IMAGE_R2) return false;
  // M8-14-5-fix：校准前先确保探针可读且可用（含 unknown 懒探测）
  if (!(await ensureR2Available(env))) return false;

  const accountId = env.R2_USAGE_ACCOUNT_ID?.trim();
  const bucketName = env.R2_USAGE_BUCKET_NAME?.trim();
  const apiToken = env.R2_USAGE_API_TOKEN?.trim();
  const canUseCfApi = Boolean(accountId && bucketName && apiToken);

  let bytes = 0;
  let objectCount = 0;
  let truncated = false;
  let usedCfApi = false;

  if (canUseCfApi) {
    try {
      const api = await fetchR2CfUsageApi(accountId!, bucketName!, apiToken!);
      bytes = api.payloadBytes + api.metadataBytes;
      objectCount = api.objectCount;
      usedCfApi = true;
    } catch (err) {
      console.warn('[mediaStorageUsage] R2 CF usage API 失败，回落 binding list', err);
    }
  }

  if (!usedCfApi) {
    try {
      const listed = await listR2BindingUsage(env.HAILUO_IMAGE_R2, opts);
      bytes = listed.bytes;
      objectCount = listed.objectCount;
      truncated = listed.truncated;
    } catch (err) {
      console.error('[mediaStorageUsage] R2 binding list 校准异常', err);
      return false;
    }
  }

  await setUsageAfterCalibration(env, 'r2', bytes, objectCount, nowIso());
  if (truncated) {
    console.warn(`[mediaStorageUsage] R2 list 校准分页截断 bytes=${bytes}`);
  } else {
    console.log(
      `[mediaStorageUsage] R2 用量校准 ok via=${usedCfApi ? 'cf-api' : 'binding-list'} bytes=${bytes} objects=${objectCount}`,
    );
  }
  return true;
}

export function backendToImagesStorage(backend: MediaUsageBackend): ImagesStorageBackend {
  return backend;
}
