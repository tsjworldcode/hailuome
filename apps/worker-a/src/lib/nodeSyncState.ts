/**
 * M16-GROUP-LIFECYCLE-V2-11/11a/14：节点 daily-sync 锚点 + 中心 INTERVAL_DAYS 缓存。
 * 表：IDENTITY `node_sync_state`（migration 0100）。仅 Worker A 私有。
 */
import type { Env } from '../env';
import { resolveIdentityDb } from '../db/bindings';

/** 与中心 GROUP_LIFECYCLE_INTERVAL_DAYS 硬底线/上限对齐 */
export const CONFIG_INTERVAL_DAYS_MIN = 30;
export const CONFIG_INTERVAL_DAYS_MAX = 90;

export async function readOwnerUserId(env: Env): Promise<string | null> {
  const row = await resolveIdentityDb(env)
    .prepare(`SELECT value FROM system_config WHERE key = 'owner_user_id' LIMIT 1`)
    .first<{ value: string }>();
  const v = row?.value?.trim();
  return v || null;
}

/** 规范化中心下发的 interval_days；非法 → null（不写缓存）。 */
export function normalizeConfigIntervalDays(raw: unknown): number | null {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number.parseInt(raw, 10) : NaN;
  if (!Number.isFinite(n)) return null;
  const floored = Math.floor(n);
  if (floored < CONFIG_INTERVAL_DAYS_MIN || floored > CONFIG_INTERVAL_DAYS_MAX) return null;
  return floored;
}

export async function getConfigIntervalDays(env: Env, userId: string): Promise<number | null> {
  const row = await resolveIdentityDb(env)
    .prepare(`SELECT config_interval_days AS d FROM node_sync_state WHERE user_id = ?1`)
    .bind(userId)
    .first<{ d: number | null }>();
  return normalizeConfigIntervalDays(row?.d ?? null);
}

export async function getLastDailySyncReportedAt(env: Env, userId: string): Promise<string | null> {
  const row = await resolveIdentityDb(env)
    .prepare(`SELECT last_daily_sync_reported_at AS anchor FROM node_sync_state WHERE user_id = ?1`)
    .bind(userId)
    .first<{ anchor: string | null }>();
  const a = row?.anchor?.trim();
  return a || null;
}

/**
 * 成功 presence 后写入：
 * - config_interval_days：始终可从响应 data.interval_days 学习（V2-11a）
 * - last_daily_sync_reported_at：仅当本轮实际上报了 group_lifecycle 时前进（V2-14）
 */
export async function upsertNodeSyncStateAfterSuccess(
  env: Env,
  userId: string,
  opts: {
    configIntervalDays?: number | null;
    lastDailySyncReportedAt?: string | null;
  },
): Promise<void> {
  const interval = opts.configIntervalDays != null
    ? normalizeConfigIntervalDays(opts.configIntervalDays)
    : null;
  const anchor = opts.lastDailySyncReportedAt?.trim() || null;
  if (interval == null && !anchor) return;

  const now = new Date().toISOString();
  const db = resolveIdentityDb(env);
  // COALESCE：未传入的列保留旧值（interval/anchor 可分次更新）
  await db
    .prepare(
      `INSERT INTO node_sync_state (user_id, last_daily_sync_reported_at, config_interval_days, updated_at)
       VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(user_id) DO UPDATE SET
         last_daily_sync_reported_at = COALESCE(excluded.last_daily_sync_reported_at, node_sync_state.last_daily_sync_reported_at),
         config_interval_days = COALESCE(excluded.config_interval_days, node_sync_state.config_interval_days),
         updated_at = excluded.updated_at`,
    )
    .bind(userId, anchor, interval, now)
    .run();
}

/** INTERVAL_MISMATCH 后清缓存，下次 omit group_lifecycle 再学中心值。 */
export async function clearConfigIntervalDays(env: Env, userId: string): Promise<void> {
  const now = new Date().toISOString();
  await resolveIdentityDb(env)
    .prepare(
      `UPDATE node_sync_state
       SET config_interval_days = NULL, updated_at = ?2
       WHERE user_id = ?1`,
    )
    .bind(userId, now)
    .run();
}
