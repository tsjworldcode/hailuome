/**
 * M34-2：Cron / Settings 用的站主参与度与 dormant Feed 策略。
 * M34-6：dormant+skip 仍保留 24h 地板——到期强制扫完一轮全部关注。
 */
import type { Env } from '../../env';
import { resolveIdentityDb } from '../../db/bindings';
import { readOwnerEngagementForCron } from './sessionLifecycle';
import { createOwnerSessionsRepo } from '../../db/ownerSessionsRepo';

export type OwnerEngagement = 'active' | 'dormant' | 'unknown';
export type OwnerDormantFeedPolicy = 'skip' | 'slow' | 'normal';

/** dormant 关注流最低刷新间隔（站主未登录也必须全量扫一轮） */
export const DORMANT_FEED_FLOOR_MS = 24 * 60 * 60 * 1000;

const KEY_FEED_PULL_LAST_OK = 'feed_pull_last_ok_at';
const KEY_FEED_PULL_CYCLE_OK = 'feed_pull_cycle_ok_at';
const KEY_FEED_DORMANT_SWEEP_ACTIVE = 'feed_dormant_sweep_active';
const KEY_FEED_DORMANT_SWEEP_DONE = 'feed_dormant_sweep_done';

/** unknown 按 dormant 节能（避免未配心跳前白跑 feed） */
export function effectiveEngagementForCron(e: OwnerEngagement): 'active' | 'dormant' {
  return e === 'active' ? 'active' : 'dormant';
}

export function parseOwnerDormantFeedPolicy(raw: string | undefined): OwnerDormantFeedPolicy {
  const v = (raw ?? 'skip').trim().toLowerCase();
  if (v === 'slow' || v === 'normal') return v;
  return 'skip';
}

/** 空串 / 非法 ISO 视为「从未成功」 */
export function parseSystemConfigIso(raw: string | null | undefined): string | null {
  const v = (raw ?? '').trim();
  if (!v) return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : v;
}

/**
 * dormant 时 feed-aggregate 是否仍应跑（已过偶数分钟门控之后再判）。
 * - skip：否（不含 24h 地板；地板见 dormantFeedAggregateShouldRun）
 * - slow：仅 UTC 整点（minute===0，且调用方已要求偶数分钟）
 * - normal：是
 */
export function dormantFeedAggregateAllowed(
  policy: OwnerDormantFeedPolicy,
  minute: number,
): boolean {
  if (policy === 'normal') return true;
  if (policy === 'slow') return minute === 0;
  return false;
}

/** 距上次「全关注扫完」是否已满地板间隔（含从未扫过） */
export function isDormantFeedFloorDue(
  cycleOkAt: string | null,
  nowMs: number = Date.now(),
  floorMs: number = DORMANT_FEED_FLOOR_MS,
): boolean {
  if (!cycleOkAt) return true;
  const t = Date.parse(cycleOkAt);
  if (Number.isNaN(t)) return true;
  return nowMs - t >= floorMs;
}

/**
 * dormant 时是否允许跑 feed（策略门控 ∪ 24h 地板 ∪ 扫尾中）。
 * 调用方须已保证偶数分钟。
 */
export function dormantFeedAggregateShouldRun(
  policy: OwnerDormantFeedPolicy,
  minute: number,
  opts: {
    cycleOkAt: string | null;
    sweepActive: boolean;
    nowMs?: number;
  },
): boolean {
  if (opts.sweepActive || isDormantFeedFloorDue(opts.cycleOkAt, opts.nowMs)) {
    return true;
  }
  return dormantFeedAggregateAllowed(policy, minute);
}

async function readSystemConfigValue(env: Env, key: string): Promise<string> {
  try {
    const row = await resolveIdentityDb(env)
      .prepare(`SELECT value FROM system_config WHERE key = ? LIMIT 1`)
      .bind(key)
      .first<{ value: string }>();
    return row?.value ?? '';
  } catch {
    return '';
  }
}

async function writeSystemConfigValue(env: Env, key: string, value: string): Promise<void> {
  const now = new Date().toISOString();
  await resolveIdentityDb(env)
    .prepare(
      `INSERT OR REPLACE INTO system_config (key, value, updated_at) VALUES (?, ?, ?)`,
    )
    .bind(key, value, now)
    .run();
}

export async function loadCronOwnerEngagementContext(env: Env): Promise<{
  ownerEngagement: OwnerEngagement;
  ownerDormantFeedPolicy: OwnerDormantFeedPolicy;
  ownerLastSeenAt: string | null;
  feedPullLastOkAt: string | null;
  feedPullCycleOkAt: string | null;
  feedDormantSweepActive: boolean;
}> {
  const ownerEngagement = await readOwnerEngagementForCron(env);
  const repo = createOwnerSessionsRepo(env);
  const snap = await repo.readEngagement();
  const [lastOkRaw, cycleOkRaw, sweepRaw] = await Promise.all([
    readSystemConfigValue(env, KEY_FEED_PULL_LAST_OK),
    readSystemConfigValue(env, KEY_FEED_PULL_CYCLE_OK),
    readSystemConfigValue(env, KEY_FEED_DORMANT_SWEEP_ACTIVE),
  ]);
  return {
    ownerEngagement,
    ownerDormantFeedPolicy: parseOwnerDormantFeedPolicy(env.OWNER_DORMANT_FEED_POLICY),
    ownerLastSeenAt: snap.last_seen_at,
    feedPullLastOkAt: parseSystemConfigIso(lastOkRaw),
    feedPullCycleOkAt: parseSystemConfigIso(cycleOkRaw),
    feedDormantSweepActive: sweepRaw.trim() === '1',
  };
}

/**
 * dormant 且地板到期时，把扫尾标记打开（后续偶数分钟持续允许 Feed，直到全量扫完）。
 * active 不写标记（仍靠 cycle 进度刷新 cycle_ok_at）。
 */
export async function ensureDormantFeedSweepIfNeeded(env: Env): Promise<{
  started: boolean;
  alreadyActive: boolean;
}> {
  const ctx = await loadCronOwnerEngagementContext(env);
  if (effectiveEngagementForCron(ctx.ownerEngagement) === 'active') {
    return { started: false, alreadyActive: false };
  }
  if (ctx.feedDormantSweepActive) {
    return { started: false, alreadyActive: true };
  }
  if (!isDormantFeedFloorDue(ctx.feedPullCycleOkAt)) {
    return { started: false, alreadyActive: false };
  }
  await writeSystemConfigValue(env, KEY_FEED_DORMANT_SWEEP_ACTIVE, '1');
  await writeSystemConfigValue(env, KEY_FEED_DORMANT_SWEEP_DONE, '0');
  return { started: true, alreadyActive: false };
}

/**
 * 本轮 Feed 尝试后累加扫进度；达到 totalFollows 则写 cycle_ok_at 并清扫尾标记。
 * attempted=0 且 totalFollows>0（全退避）不推进，避免假完成。
 */
export async function noteFeedPullBatchForCycle(
  env: Env,
  info: { attempted: number; totalFollows: number },
): Promise<{ cycleCompleted: boolean; progress: number }> {
  const total = Math.max(0, Math.floor(info.totalFollows));
  const attempted = Math.max(0, Math.floor(info.attempted));

  if (total <= 0) {
    const now = new Date().toISOString();
    await writeSystemConfigValue(env, KEY_FEED_PULL_CYCLE_OK, now);
    await writeSystemConfigValue(env, KEY_FEED_DORMANT_SWEEP_ACTIVE, '0');
    await writeSystemConfigValue(env, KEY_FEED_DORMANT_SWEEP_DONE, '0');
    return { cycleCompleted: true, progress: 0 };
  }

  if (attempted <= 0) {
    const doneRaw = await readSystemConfigValue(env, KEY_FEED_DORMANT_SWEEP_DONE);
    const progress = Math.max(0, Number.parseInt(doneRaw || '0', 10) || 0);
    return { cycleCompleted: false, progress };
  }

  const doneRaw = await readSystemConfigValue(env, KEY_FEED_DORMANT_SWEEP_DONE);
  const prev = Math.max(0, Number.parseInt(doneRaw || '0', 10) || 0);
  const progress = prev + attempted;

  if (progress >= total) {
    const now = new Date().toISOString();
    await writeSystemConfigValue(env, KEY_FEED_PULL_CYCLE_OK, now);
    await writeSystemConfigValue(env, KEY_FEED_DORMANT_SWEEP_ACTIVE, '0');
    await writeSystemConfigValue(env, KEY_FEED_DORMANT_SWEEP_DONE, '0');
    return { cycleCompleted: true, progress: 0 };
  }

  await writeSystemConfigValue(env, KEY_FEED_DORMANT_SWEEP_DONE, String(progress));
  // 站主活跃时也维持扫尾标记关闭；仅 dormant 地板路径会提前 ensure 打开
  return { cycleCompleted: false, progress };
}
