/**
 * NCF-2A：Cron / scheduled 唯一 Feed 入口。
 * 路径：scheduled → runCronBudgeted(feed-aggregate) → runScheduledInvocation → runFeedAggregation
 */
import type { Env } from '../../env';
import { FEED_SUBREQUEST_HARD_CAP } from '../../handlers/feedPullBatch';
import { createProductionFeedDeps, FEED_PULL_BATCH_SIZE } from './adapters/production';
import { runFeedAggregation } from './runFeedAggregation';
import type { FeedAggregateCommand, FeedRunResult } from './types';

export type CronRunResult = {
  feed: FeedRunResult;
};

/**
 * 由 invocation 拥有预算：command.budget.externalFetchRemaining 默认 FEED_SUBREQUEST_HARD_CAP。
 * 可选 override 便于 fixture / 共享父级剩余预算。
 */
export async function runScheduledInvocation(
  env: Env,
  options?: {
    scheduledAt?: string;
    externalFetchRemaining?: number;
    wallMsDeadline?: number;
    runId?: string;
    targetBatch?: FeedAggregateCommand['targetBatch'];
  },
): Promise<CronRunResult> {
  const command: FeedAggregateCommand = {
    scheduledAt: options?.scheduledAt ?? new Date().toISOString(),
    cursorVersion: 1,
    targetBatch: options?.targetBatch ?? FEED_PULL_BATCH_SIZE,
    budget: {
      externalFetchRemaining: options?.externalFetchRemaining ?? FEED_SUBREQUEST_HARD_CAP,
      ...(options?.wallMsDeadline !== undefined
        ? { wallMsDeadline: options.wallMsDeadline }
        : {}),
    },
    ...(options?.runId ? { runId: options.runId } : {}),
  };

  const { deps } = createProductionFeedDeps(env, command);
  const feed = await runFeedAggregation(command, deps);
  return { feed };
}
