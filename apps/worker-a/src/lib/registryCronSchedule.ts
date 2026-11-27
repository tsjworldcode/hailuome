/**
 * 注册中心 Cron 周期 presence / policy / 推荐调度（错峰 salt：daily_sync_v4）。
 * 与 hailuo-registry dailySyncSchedule.ts 同源。
 */

export const SLOTS_PER_HOUR = 359;
export const SLOTS_PER_DAY = SLOTS_PER_HOUR * 24;
export const BUCKET_STEP_SEC = 10;
export const HOUR_FIRST_VALID_SEC = 10;
export const JITTER_MOD = 10;
export const SECONDS_PER_DAY = 86400;
/** 长周期 presence 错峰算法标签（salt 绑定；勿改，以免全网秒槽漂移） */
export const DAILY_SYNC_SCHEDULE_VERSION = 'daily_sync_v4';
/** R-MSG-2c：presence 协议 / system_config 语义版本（条件块；停周期 digest/推荐） */
export const DAILY_SYNC_PRESENCE_SCHEDULE_VERSION = 'daily_sync_v5';
export const DEFAULT_SYNC_INTERVAL_DAYS = 30;
export const SYNC_MIN_INTERVAL_FACTOR_HOURS = 12;
export const DEFAULT_POLICY_POLL_INTERVAL_DAYS = 7;
export const DEFAULT_RECOMMENDATION_POLL_INTERVAL_DAYS = 7;

const JITTER_SALT = ':daily_sync_jitter_v1';
const DAY_SALT = ':sync_day_v4';
const POLICY_DAY_SALT = ':policy_poll_day_v1';
const POLICY_SEED_SUFFIX = ':policy_poll_v1';
const RECOMMENDATION_DAY_SALT = ':recommendation_day_v1';
const RECOMMENDATION_SEED_SUFFIX = ':recommendation_poll_v1';

/** FNV-1a 32-bit；与 hailuo-registry dailySyncSchedule.stableHash 字节级一致。 */
export function stableHash(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** 10 秒桶索引 0..8615。 */
export function computeDailySync10SecSlot(seed: string): number {
  return stableHash(seed) % SLOTS_PER_DAY;
}

/** 桶内秒偏移 0..9。 */
export function computeDailySyncJitterSec(seed: string): number {
  return stableHash(`${seed}${JITTER_SALT}`) % JITTER_MOD;
}

/** UTC 日内秒 0..86399。 */
export function computeDailySyncUtcSecondOfDay(seed: string): number {
  const slot = computeDailySync10SecSlot(seed);
  const hour = Math.floor(slot / SLOTS_PER_HOUR);
  const slotInHour = slot % SLOTS_PER_HOUR;
  const baseSecond = hour * 3600 + HOUR_FIRST_VALID_SEC + slotInHour * BUCKET_STEP_SEC;
  return baseSecond + computeDailySyncJitterSec(seed);
}

/** policy 探测用日内秒（与 presence 错开）。 */
export function computePolicyPollUtcSecondOfDay(seed: string): number {
  return computeDailySyncUtcSecondOfDay(`${seed}${POLICY_SEED_SUFFIX}`);
}

/** 推荐拉取用日内秒（与 presence / policy 错开）。 */
export function computeRecommendationPollUtcSecondOfDay(seed: string): number {
  return computeDailySyncUtcSecondOfDay(`${seed}${RECOMMENDATION_SEED_SUFFIX}`);
}

/** 是否落在禁止区 XX:00:00–XX:00:09。 */
export function isForbiddenDailySyncSecondOfDay(secondOfDay: number): boolean {
  if (!Number.isInteger(secondOfDay) || secondOfDay < 0 || secondOfDay >= SECONDS_PER_DAY) {
    return true;
  }
  return secondOfDay % 3600 < HOUR_FIRST_VALID_SEC;
}

/** 由 UTC 日内秒得 Cron 应触发的 UTC 分钟索引 0..1439。 */
export function dailySyncAssignedUtcMinute(secondOfDay: number): number {
  return Math.floor(secondOfDay / 60);
}

/** 分钟内的延迟秒 0..59。 */
export function dailySyncDelaySecWithinMinute(secondOfDay: number): number {
  return secondOfDay % 60;
}

/**
 * presence 间隔规范化：最小值 30 天（与 registry dailySyncSchedule 同源）。
 * - 非法或小于 30 → 30
 * - 大于等于 30 → 用真实整日数
 */
export function normalizeSyncIntervalDays(raw: unknown, fallback = DEFAULT_SYNC_INTERVAL_DAYS): number {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw.trim()) : NaN;
  if (!Number.isFinite(n)) return fallback;
  const floored = Math.floor(n);
  // 中文注释：硬底线 30 天；低于一律按 30，高于按配置真实天数
  if (floored < DEFAULT_SYNC_INTERVAL_DAYS) return DEFAULT_SYNC_INTERVAL_DAYS;
  return floored;
}

export function normalizePolicyPollIntervalDays(
  raw: unknown,
  fallback = DEFAULT_POLICY_POLL_INTERVAL_DAYS,
): number {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw.trim()) : NaN;
  if (!Number.isFinite(n)) return fallback;
  const floored = Math.floor(n);
  // 中文注释：与 registry 一致；7 为 Free 十万级默认
  if (floored === 1 || floored === 2 || floored === 3 || floored === 7) return floored;
  return fallback;
}

export function normalizeRecommendationPollIntervalDays(
  raw: unknown,
  fallback = DEFAULT_RECOMMENDATION_POLL_INTERVAL_DAYS,
): number {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw.trim()) : NaN;
  if (!Number.isFinite(n)) return fallback;
  const floored = Math.floor(n);
  if (floored === 1 || floored === 2 || floored === 3 || floored === 7) return floored;
  return fallback;
}

export function computeSyncDayOfCycle(seed: string, intervalDays = DEFAULT_SYNC_INTERVAL_DAYS): number {
  const interval = normalizeSyncIntervalDays(intervalDays);
  return stableHash(`${seed}${DAY_SALT}`) % interval;
}

export function computePolicyPollDayOfCycle(
  seed: string,
  intervalDays = DEFAULT_POLICY_POLL_INTERVAL_DAYS,
): number {
  const interval = normalizePolicyPollIntervalDays(intervalDays);
  return stableHash(`${seed}${POLICY_DAY_SALT}`) % interval;
}

export function computeRecommendationPollDayOfCycle(
  seed: string,
  intervalDays = DEFAULT_RECOMMENDATION_POLL_INTERVAL_DAYS,
): number {
  const interval = normalizeRecommendationPollIntervalDays(intervalDays);
  return stableHash(`${seed}${RECOMMENDATION_DAY_SALT}`) % interval;
}

export function utcEpochDay(nowMs = Date.now()): number {
  return Math.floor(nowMs / (SECONDS_PER_DAY * 1000));
}

export function isSyncDueOnUtcDay(
  seed: string,
  intervalDays: number,
  nowMs = Date.now(),
): boolean {
  const interval = normalizeSyncIntervalDays(intervalDays);
  return utcEpochDay(nowMs) % interval === computeSyncDayOfCycle(seed, interval);
}

export function isPolicyPollDueOnUtcDay(
  seed: string,
  intervalDays: number = DEFAULT_POLICY_POLL_INTERVAL_DAYS,
  nowMs = Date.now(),
): boolean {
  const interval = normalizePolicyPollIntervalDays(intervalDays);
  return utcEpochDay(nowMs) % interval === computePolicyPollDayOfCycle(seed, interval);
}

export function isRecommendationPollDueOnUtcDay(
  seed: string,
  intervalDays: number = DEFAULT_RECOMMENDATION_POLL_INTERVAL_DAYS,
  nowMs = Date.now(),
): boolean {
  const interval = normalizeRecommendationPollIntervalDays(intervalDays);
  return utcEpochDay(nowMs) % interval === computeRecommendationPollDayOfCycle(seed, interval);
}

export function syncMinIntervalMs(intervalDays = DEFAULT_SYNC_INTERVAL_DAYS): number {
  return normalizeSyncIntervalDays(intervalDays) * SYNC_MIN_INTERVAL_FACTOR_HOURS * 60 * 60 * 1000;
}
