/**
 * R-MSG-2c / daily_sync_v5：每分钟 UTC gate + 秒级 delay。
 * - presence：周期日（默认 30）+ 分配分钟（日常唯一出口）
 * - policy / 推荐：routine Cron **已停**；force / pull_hint 同 tick / 紧急（2e）另路径
 * - seed 优先 did_v2，回退 owner_user_id
 * - 错峰 salt 仍绑定 daily_sync_v4 常量名（避免全网秒槽漂移）
 */
import type { Env } from '../env';
import { resolveIdentityDb } from '../db/bindings';
import { syncRegistryDaily } from './registryDailySync';
import {
  CONFIG_DAILY_SYNC_UTC_SECOND_OF_DAY,
  dailySyncScheduleConfigBatchStatements,
  isValidDailySyncUtcSecondOfDay,
  parseSuggestedDailySyncUtcSecondOfDay,
  readSyncIntervalDays,
} from '../lib/dailySyncScheduleConfig';
import {
  computeDailySyncUtcSecondOfDay,
  dailySyncAssignedUtcMinute,
  dailySyncDelaySecWithinMinute,
  isSyncDueOnUtcDay,
} from '../lib/registryCronSchedule';

export type DailySyncCronContext = { hour: number; minute: number };

function sleepMs(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readSystemConfig(env: Env, key: string): Promise<string> {
  // A-5c-3：system_config 在 IDENTITY_DB，先解析
  const identityDb = resolveIdentityDb(env);
  const row = await identityDb
    .prepare(`SELECT value FROM system_config WHERE key = ?1 LIMIT 1`)
    .bind(key)
    .first<{ value: string }>();
  return row?.value?.trim() ?? '';
}

/** 优先 did_v2（与错峰口径一致）；回退 owner_user_id。 */
export async function resolveRegistryCronSeed(env: Env): Promise<string | null> {
  const didV2 = await readSystemConfig(env, 'did_v2');
  if (didV2.startsWith('did:hailuo:')) return didV2;
  const ownerUserId = await readSystemConfig(env, 'owner_user_id');
  if (ownerUserId) return ownerUserId;
  const fallback = env.BOOTSTRAP_HANDLE || env.WORKER_B_URL || env.REGISTRY_URL || '';
  return fallback.trim() || null;
}

/** 读落库秒；缺失或非法则按 seed 复算并 lazy 落库。 */
export async function readOrBackfillDailySyncUtcSecondOfDay(env: Env): Promise<number | null> {
  // A-5c-3：system_config 在 IDENTITY_DB；helper 内已解析，调用方 batch 也走 identityDb
  const identityDb = resolveIdentityDb(env);
  const seed = await resolveRegistryCronSeed(env);
  if (!seed) return null;

  const raw = await readSystemConfig(env, CONFIG_DAILY_SYNC_UTC_SECOND_OF_DAY);
  const parsed = parseSuggestedDailySyncUtcSecondOfDay(raw);
  if (parsed !== undefined && isValidDailySyncUtcSecondOfDay(parsed)) {
    return parsed;
  }

  const secondOfDay = computeDailySyncUtcSecondOfDay(seed);
  const intervalDays = await readSyncIntervalDays(env);
  const updatedAt = new Date().toISOString();
  await identityDb.batch(dailySyncScheduleConfigBatchStatements(env, secondOfDay, updatedAt, intervalDays));
  console.info('[cron/daily-sync/schedule] backfill daily_sync_utc_second_of_day', secondOfDay);
  return secondOfDay;
}

/**
 * 在 scheduled 每分钟调用（须早于 minute%5 早退）；
 * 命中周期日 + 分配分钟时 waitUntil 延迟到秒内再 sync。
 */
export async function maybeScheduleRegistryDailySync(
  env: Env,
  cronCtx: DailySyncCronContext,
  executionCtx: ExecutionContext,
): Promise<void> {
  const seed = await resolveRegistryCronSeed(env);
  if (!seed) return;

  const intervalDays = await readSyncIntervalDays(env);
  // 中文注释：非本节点 presence 周期日直接跳过（默认每 30 日一轮）
  if (!isSyncDueOnUtcDay(seed, intervalDays)) return;

  const secondOfDay = await readOrBackfillDailySyncUtcSecondOfDay(env);
  if (secondOfDay === null) return;

  const assignedMinute = dailySyncAssignedUtcMinute(secondOfDay);
  const currentMinute = cronCtx.hour * 60 + cronCtx.minute;
  if (assignedMinute !== currentMinute) return;

  const delaySec = dailySyncDelaySecWithinMinute(secondOfDay);
  executionCtx.waitUntil(
    sleepMs(delaySec * 1000).then(() => syncRegistryDaily(env)).catch((err) => {
      console.error('[cron/daily-sync/schedule] syncRegistryDaily 失败', err);
    }),
  );
  console.info(
    '[cron/daily-sync/schedule]',
    JSON.stringify({
      assigned_second_of_day: secondOfDay,
      delay_sec: delaySec,
      sync_interval_days: intervalDays,
      channel: 'presence',
      schedule: 'daily_sync_v5_routine',
    }),
  );
}

/**
 * @deprecated R-MSG-2c：routine Cron 已停；保留导出以免旧脚本/文档误引用炸编译。
 * 紧急旁路见 R-MSG-2e。
 */
export async function maybeScheduleRegistryPolicyPoll(
  _env: Env,
  _cronCtx: DailySyncCronContext,
  _executionCtx: ExecutionContext,
): Promise<void> {
  // no-op：日常不打 GET /api/node/policy-digest
}

/**
 * @deprecated R-MSG-2c：routine Cron 已停；推荐改走 presence 条件块 / force。
 */
export async function maybeScheduleRegistryRecommendations(
  _env: Env,
  _cronCtx: DailySyncCronContext,
  _executionCtx: ExecutionContext,
): Promise<void> {
  // no-op：日常不打 GET /api/recommendations/users
}
