/**
 * NCF-2A Feed 深模块公开出口。
 */
export type {
  FeedAggregateBudget,
  FeedAggregateCommand,
  FeedAggregateDeps,
  FeedMigrateResult,
  FeedRunResult,
  FeedRunStatus,
  FollowPullTarget,
  KvPublishStatus,
  RemoteFeedFetchResult,
  RemoteFeedPost,
} from './types';
export { createExternalFetchBudget, budgetUsed } from './budget';
export { decideFeedRunStatus } from './decideStatus';
export { runFeedAggregation } from './runFeedAggregation';
export { runScheduledInvocation } from './runScheduledInvocation';
export type { CronRunResult } from './runScheduledInvocation';

import type { Env } from '../../env';
import { runScheduledInvocation } from './runScheduledInvocation';

/**
 * 兼容旧名：站主手动刷新 / 历史调用点。
 * 实现唯一路径：runScheduledInvocation → runFeedAggregation。
 */
export async function fetchAndAggregateFeed(env: Env): Promise<void> {
  await runScheduledInvocation(env);
}
