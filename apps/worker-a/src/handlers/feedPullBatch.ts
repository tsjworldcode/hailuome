/**
 * M9-14 / M13-7：关注节点 Feed 分批游标（>40 时每次 Cron 只拉一个 batch）。
 * M13-7：eligible 在 SQL 侧过滤（next_retry_at），totalFollows 用 COUNT(*)。
 * R-AUDIT-V3 2.4：totalFollows 模块级缓存 60s，避免同 isolate 内每分钟重复全表 COUNT。
 */
import { resolveIdentityDb } from '../db/bindings';
import type { Env } from '../env';

export const FEED_PULL_BATCH_SIZE = 20;

/** M7-30h-7：Cron 单轮外部 fetch 硬上限（留余量给迁址 well-known/users） */
/**
 * CRON-SCHEDULE-AUDIT：原 48 让偶数分钟的 Feed 最多用 48 次外部，叠加 probe-storage(3)
 * 会到 51。压到 40：resolveFeedTargetBatch(40)/2 = 20 关注，与 20 次外部估算一致，
 * 10/40 分钟仍给 storage 探测留 3 次余量。
 */
export const FEED_SUBREQUEST_HARD_CAP = 40;

/** R-AUDIT-V3 2.4：totalFollows 内存缓存 TTL（毫秒）。 */
export const TOTAL_FOLLOWS_CACHE_TTL_MS = 60_000;

/** M13-7：拉取 batch 用的 eligible 行（D1 过滤退避中节点） */
export const FOLLOW_PULL_ELIGIBLE_SQL = `SELECT f.id,
              COALESCE(NULLIF(f.followed_worker_b_url, ''), f.follower_node_url) AS fetch_url,
              f.followed_handle,
              f.fail_count,
              f.next_retry_at
         FROM follows f
        WHERE f.next_retry_at IS NULL OR f.next_retry_at <= ?
        ORDER BY f.last_active DESC`;

export interface FollowPullRow {
  id: string;
  fetch_url: string;
  followed_handle: string | null;
  fail_count: number;
  next_retry_at: string | null;
}

type TotalFollowsCacheEntry = { count: number; fetchedAt: number };

let totalFollowsCache: TotalFollowsCacheEntry | null = null;

/** 契约/单测：重置 isolate 内 totalFollows 缓存。 */
export function resetTotalFollowsCacheForTests(): void {
  totalFollowsCache = null;
}

/**
 * 读 follows 总数；命中模块级缓存则跳过 D1 COUNT。
 * @param nowMs 可注入，便于测试 TTL 过期
 */
export async function getTotalFollowsCached(
  env: Env,
  nowMs: number = Date.now(),
): Promise<number> {
  if (
    totalFollowsCache &&
    nowMs - totalFollowsCache.fetchedAt < TOTAL_FOLLOWS_CACHE_TTL_MS
  ) {
    return totalFollowsCache.count;
  }
  const countRow = await resolveIdentityDb(env)
    .prepare(`SELECT COUNT(*) AS cnt FROM follows`)
    .first<{ cnt: number }>();
  const count = countRow?.cnt ?? 0;
  totalFollowsCache = { count, fetchedAt: nowMs };
  return count;
}

/** 纯函数：从 eligible 列表按 cursor 轮转选取下一批（供单测）。 */
export function selectFollowBatchFromEligible(
  eligible: FollowPullRow[],
  cursorId: string,
  batchSize: number = FEED_PULL_BATCH_SIZE,
): FollowPullRow[] {
  if (eligible.length <= batchSize) return eligible;
  let startIdx = 0;
  if (cursorId) {
    const idx = eligible.findIndex((r) => r.id === cursorId);
    startIdx = idx >= 0 ? idx + 1 : 0;
  }
  const batch: FollowPullRow[] = [];
  for (let i = 0; i < batchSize; i++) {
    batch.push(eligible[(startIdx + i) % eligible.length]!);
  }
  return batch;
}

/** 拉取失败后的指数退避（5min 起，上限 30min）。 */
export function computeNextRetryAt(failCount: number, nowMs: number = Date.now()): string {
  const minutes = Math.min(30, 5 * 2 ** Math.max(0, failCount - 1));
  return new Date(nowMs + minutes * 60 * 1000).toISOString();
}

async function readSystemConfigValue(env: Env, key: string): Promise<string> {
  const row = await resolveIdentityDb(env)
    .prepare(`SELECT value FROM system_config WHERE key = ? LIMIT 1`)
    .bind(key)
    .first<{ value: string }>();
  return row?.value ?? '';
}

async function writeSystemConfigValue(env: Env, key: string, value: string): Promise<void> {
  const now = new Date().toISOString();
  await resolveIdentityDb(env)
    .prepare(`UPDATE system_config SET value = ?, updated_at = ? WHERE key = ?`)
    .bind(value, now, key)
    .run();
}

/**
 * 选取本轮 Cron 应拉取的关注节点 batch，并回写游标。
 * 官方 feed 子请求预算仍由 services/feed 聚合外层控制。
 */
export async function loadFollowBatchForPull(env: Env): Promise<{
  rows: FollowPullRow[];
  totalFollows: number;
  cursorAdvancedTo: string | null;
}> {
  const now = new Date().toISOString();

  const totalFollows = await getTotalFollowsCached(env);

  const eligibleResult = await resolveIdentityDb(env)
    .prepare(FOLLOW_PULL_ELIGIBLE_SQL)
    .bind(now)
    .all<FollowPullRow>();
  const eligible = eligibleResult.results ?? [];

  const cursorId = await readSystemConfigValue(env, 'feed_pull_cursor');
  const batch = selectFollowBatchFromEligible(eligible, cursorId, FEED_PULL_BATCH_SIZE);
  const cursorAdvancedTo = batch.length > 0 ? batch[batch.length - 1]!.id : null;
  if (cursorAdvancedTo) {
    await writeSystemConfigValue(env, 'feed_pull_cursor', cursorAdvancedTo);
  }
  return {
    rows: batch,
    totalFollows,
    cursorAdvancedTo,
  };
}

/** 本轮 batch 全部成功时更新 feed_pull_last_ok_at。 */
export async function markFeedPullBatchOk(env: Env): Promise<void> {
  await writeSystemConfigValue(env, 'feed_pull_last_ok_at', new Date().toISOString());
}

/**
 * M13-7 本地诊断（wrangler d1 execute）：
 *   EXPLAIN QUERY PLAN SELECT ... FROM follows WHERE next_retry_at IS NULL OR next_retry_at <= '<iso>';
 * 常态 ≤200 关注 SCAN 可接受；持续 SCAN 且关注 >200 时再评估 idx_follows_pull_eligible。
 */
