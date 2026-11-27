/**
 * M16-P4a：会话库 hard 水位时，新建群消息直接路由 MESSAGING_SHARD_1。
 * 存量群卸货见 P4b（Cron batch）；本模块仅处理建群钩子。
 */
import type { Env } from '../env';
import {
  estimateMessagingDbCapacity,
  type MessagingDbCapacityTier,
} from './messagingDbCapacity';
import { hasMessagingShard1, registerGroupMessageShardRoute } from './messagingShard';
import {
  countPrimaryPendingAutoShardGroups,
  finalizeGroupShardRouteIfEmpty,
  migrateGroupMessagesToShardBatch,
  pickLargestPrimaryGroupForAutoShard,
  readAutoShardProgress,
  resolveAutoShardBatchRows,
  writeAutoShardError,
  type AutoShardMigrationTickResult,
} from './messagingGroupShardMigrate';

export type { AutoShardMigrationTickResult };

export type MessagingAutoShardTierTrigger = 'hard' | 'warn';

/** P4c：GET /api/messaging/db-capacity 自动分片可观测字段。 */
export interface MessagingAutoShardObservability {
  auto_shard_enabled: boolean;
  auto_shard_tier_trigger: MessagingAutoShardTierTrigger;
  auto_shard_last_migrated_group_id: string | null;
  auto_shard_last_migrated_at: string | null;
  auto_shard_pending_groups_on_primary: number;
  auto_shard_last_error: string | null;
  auto_shard_last_error_at: string | null;
}

/** 汇总自动分片开关、进度与待迁移群数。 */
export async function getMessagingAutoShardObservability(
  env: Env,
): Promise<MessagingAutoShardObservability> {
  const [progress, pending] = await Promise.all([
    readAutoShardProgress(env),
    countPrimaryPendingAutoShardGroups(env),
  ]);
  return {
    auto_shard_enabled: isMessagingAutoShardEnabled(env),
    auto_shard_tier_trigger: resolveAutoShardTierTrigger(env),
    auto_shard_last_migrated_group_id: progress.lastGroupId,
    auto_shard_last_migrated_at: progress.lastAt,
    auto_shard_pending_groups_on_primary: pending,
    auto_shard_last_error: progress.lastError,
    auto_shard_last_error_at: progress.lastErrorAt,
  };
}

/** 有 shard binding 且未显式关闭时默认开启（§11 定案）。 */
export function isMessagingAutoShardEnabled(env: Env): boolean {
  if (!hasMessagingShard1(env)) return false;
  const flag = env.MESSAGING_AUTO_SHARD_ENABLED?.trim().toLowerCase();
  return flag !== 'false';
}

/** 默认 hard（400 MB）；仅运维显式 env 时可改为 warn。 */
export function resolveAutoShardTierTrigger(env: Env): MessagingAutoShardTierTrigger {
  const tier = env.MESSAGING_AUTO_SHARD_TIER?.trim().toLowerCase();
  return tier === 'warn' ? 'warn' : 'hard';
}

function tierMeetsTrigger(
  current: MessagingDbCapacityTier,
  trigger: MessagingAutoShardTierTrigger,
): boolean {
  if (trigger === 'hard') return current === 'hard';
  return current === 'hard' || current === 'warn';
}

/**
 * P4a：建群成功后调用。满足条件则登记 shard_1 路由。
 * @returns 是否已登记 shard_1
 */
export async function maybeAutoRouteNewGroupToShard(env: Env, groupId: string): Promise<boolean> {
  if (!isMessagingAutoShardEnabled(env)) return false;

  const trigger = resolveAutoShardTierTrigger(env);
  const snap = await estimateMessagingDbCapacity(env);
  if (!tierMeetsTrigger(snap.tier, trigger)) return false;

  await registerGroupMessageShardRoute(env, groupId, 'shard_1');
  return true;
}

/** P4b：Cron 单 tick — hard 水位下搬迁 primary 最大一群（batch 行数见 §11）。 */
export async function runMessagingAutoShardCron(env: Env): Promise<AutoShardMigrationTickResult> {
  try {
    if (!isMessagingAutoShardEnabled(env)) {
      return { skipped: true, reason: 'disabled_or_no_shard' };
    }

    const trigger = resolveAutoShardTierTrigger(env);
    const snap = await estimateMessagingDbCapacity(env);
    if (!tierMeetsTrigger(snap.tier, trigger)) {
      return { skipped: true, reason: 'tier_below_trigger', rowsMoved: 0 };
    }

    const groupId = await pickLargestPrimaryGroupForAutoShard(env);
    if (!groupId) {
      return { skipped: true, reason: 'no_candidate_group' };
    }

    const batchLimit = resolveAutoShardBatchRows(env);
    const rowsMoved = await migrateGroupMessagesToShardBatch(env, groupId, batchLimit);
    const routed = await finalizeGroupShardRouteIfEmpty(env, groupId);

    return { skipped: false, groupId, rowsMoved, routed };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await writeAutoShardError(env, message);
    console.error('[messaging-auto-shard] tick 失败', err);
    return { skipped: true, reason: 'error', rowsMoved: 0 };
  }
}
