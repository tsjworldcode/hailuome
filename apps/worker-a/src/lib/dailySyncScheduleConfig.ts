/**
 * M-DS-V2-1c / M-OPT-2n：登记 verify 后解析并落库周期 sync 调度配置。
 *
 * V2-15 口径澄清：本文件的 `sync_interval_days` / `readSyncIntervalDays` 只服务
 * **presence 调度间隔**（中心 `data.sync_interval_days`）。群号上报窗基数
 * `INTERVAL_DAYS` 不走本文件——见 `nodeSyncState.config_interval_days`
 *（由 daily-sync 成功响应 `data.interval_days` 缓存，V2-11a）。
 * 计划旧写 `env.DAILY_SYNC_INTERVAL_DAYS` 已作废，勿再引入同名 env。
 */
import type { D1PreparedStatement } from '@cloudflare/workers-types';
import type { Env } from '../env';
import { resolveIdentityDb } from '../db/bindings';
import { writeOperationLog } from './operationLog';
import {
  computeDailySyncUtcSecondOfDay,
  DAILY_SYNC_PRESENCE_SCHEDULE_VERSION,
  DEFAULT_SYNC_INTERVAL_DAYS,
  isForbiddenDailySyncSecondOfDay,
  normalizeSyncIntervalDays,
  SECONDS_PER_DAY,
} from './registryCronSchedule';

export const CONFIG_DAILY_SYNC_UTC_SECOND_OF_DAY = 'daily_sync_utc_second_of_day';
export const CONFIG_DAILY_SYNC_SCHEDULE_VERSION_KEY = 'daily_sync_schedule_version';
export const CONFIG_SYNC_INTERVAL_DAYS = 'sync_interval_days';

export function parseSuggestedDailySyncUtcSecondOfDay(raw: unknown): number | undefined {
  if (typeof raw === 'number' && Number.isInteger(raw)) return raw;
  if (typeof raw === 'string' && /^\d+$/.test(raw.trim())) {
    const n = Number.parseInt(raw.trim(), 10);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

export function isValidDailySyncUtcSecondOfDay(secondOfDay: number): boolean {
  return Number.isInteger(secondOfDay)
    && secondOfDay >= 0
    && secondOfDay < SECONDS_PER_DAY
    && !isForbiddenDailySyncSecondOfDay(secondOfDay);
}

export type DailySyncScheduleResolveResult = {
  secondOfDay: number;
  expected: number;
  registryProvided: boolean;
  mismatch: boolean;
  invalidSuggested: boolean;
  syncIntervalDays: number;
};

/** 登记落库：有合法 registry 建议则用建议值；缺字段或非法则回退本地复算。 */
export function resolveDailySyncUtcSecondOfDayForPersist(
  userId: string,
  suggestedRaw: unknown,
  syncIntervalRaw?: unknown,
): DailySyncScheduleResolveResult {
  const expected = computeDailySyncUtcSecondOfDay(userId);
  const syncIntervalDays = normalizeSyncIntervalDays(syncIntervalRaw, DEFAULT_SYNC_INTERVAL_DAYS);
  const parsed = parseSuggestedDailySyncUtcSecondOfDay(suggestedRaw);
  if (parsed === undefined) {
    return {
      secondOfDay: expected,
      expected,
      registryProvided: false,
      mismatch: false,
      invalidSuggested: false,
      syncIntervalDays,
    };
  }
  if (!isValidDailySyncUtcSecondOfDay(parsed)) {
    return {
      secondOfDay: expected,
      expected,
      registryProvided: true,
      mismatch: true,
      invalidSuggested: true,
      syncIntervalDays,
    };
  }
  return {
    secondOfDay: parsed,
    expected,
    registryProvided: true,
    mismatch: parsed !== expected,
    invalidSuggested: false,
    syncIntervalDays,
  };
}

export function dailySyncScheduleConfigBatchStatements(
  env: Env,
  secondOfDay: number,
  updatedAt: string,
  syncIntervalDays: number = DEFAULT_SYNC_INTERVAL_DAYS,
): D1PreparedStatement[] {
  // A-5c-3：system_config 在 IDENTITY_DB（migration 0090）；先解析再 prepare
  const identityDb = resolveIdentityDb(env);
  const interval = normalizeSyncIntervalDays(syncIntervalDays);
  return [
    identityDb.prepare(`INSERT OR REPLACE INTO system_config(key, value, updated_at) VALUES(?, ?, ?)`)
      .bind(CONFIG_DAILY_SYNC_UTC_SECOND_OF_DAY, String(secondOfDay), updatedAt),
    identityDb.prepare(`INSERT OR REPLACE INTO system_config(key, value, updated_at) VALUES(?, ?, ?)`)
      // R-MSG-2c：落库语义版本 v5；错峰算法常量仍为 daily_sync_v4（见 registryCronSchedule）
      .bind(CONFIG_DAILY_SYNC_SCHEDULE_VERSION_KEY, DAILY_SYNC_PRESENCE_SCHEDULE_VERSION, updatedAt),
    identityDb.prepare(`INSERT OR REPLACE INTO system_config(key, value, updated_at) VALUES(?, ?, ?)`)
      .bind(CONFIG_SYNC_INTERVAL_DAYS, String(interval), updatedAt),
  ];
}

/** verify 成功后写 system_config；mismatch 时记 operation_logs（fail-soft）。 */
export async function prepareDailySyncSchedulePersist(
  env: Env,
  userId: string,
  suggestedRaw: unknown,
  updatedAt: string,
  context: { route: string },
  syncIntervalRaw?: unknown,
): Promise<{ statements: D1PreparedStatement[]; secondOfDay: number; syncIntervalDays: number }> {
  const resolved = resolveDailySyncUtcSecondOfDayForPersist(userId, suggestedRaw, syncIntervalRaw);
  if (resolved.mismatch || resolved.invalidSuggested) {
    await writeOperationLog(env, {
      source: 'worker-a',
      level: 'warn',
      event: 'daily_sync_schedule_mismatch',
      message: resolved.invalidSuggested
        ? '登记 verify 建议日同步秒非法，已回退本地复算'
        : '登记 verify 建议日同步秒与本地复算不一致，以注册中心为准',
      details: {
        route: context.route,
        user_id: userId,
        expected: resolved.expected,
        suggested: parseSuggestedDailySyncUtcSecondOfDay(suggestedRaw) ?? null,
        persisted: resolved.secondOfDay,
        invalid_suggested: resolved.invalidSuggested,
        sync_interval_days: resolved.syncIntervalDays,
      },
    }).catch((err) => {
      console.warn('[daily-sync-schedule] operation_logs 写入失败', err);
    });
  }
  return {
    secondOfDay: resolved.secondOfDay,
    syncIntervalDays: resolved.syncIntervalDays,
    statements: dailySyncScheduleConfigBatchStatements(
      env,
      resolved.secondOfDay,
      updatedAt,
      resolved.syncIntervalDays,
    ),
  };
}

/** 读取已落库 presence 间隔；缺省 30。 */
export async function readSyncIntervalDays(env: Env): Promise<number> {
  // A-5c-3：system_config 在 IDENTITY_DB，先解析
  const identityDb = resolveIdentityDb(env);
  const row = await identityDb
    .prepare(`SELECT value FROM system_config WHERE key = ?1 LIMIT 1`)
    .bind(CONFIG_SYNC_INTERVAL_DAYS)
    .first<{ value: string }>();
  return normalizeSyncIntervalDays(row?.value, DEFAULT_SYNC_INTERVAL_DAYS);
}
