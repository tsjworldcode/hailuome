/**
 * NCF-2A：纯函数 — 由计数决定 FeedRunResult.status（fixture / 核心共用）。
 */
import type { FeedRunStatus } from './types';

export function decideFeedRunStatus(input: {
  hardError?: boolean;
  fetched: number;
  failed: number;
  deferredCount: number;
}): FeedRunStatus {
  if (input.hardError) return 'error';
  // 预算耗尽导致未拉完 → deferred（即使本轮已有成功拉取）
  if (input.deferredCount > 0) return 'deferred';
  if (input.failed > 0) return 'partial';
  return 'completed';
}
