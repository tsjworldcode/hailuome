/**
 * M-F2：取关后的缓存清理（写层，零 KV 写）。
 *
 * 背景（站主 2026-10-22 口述「取关了帖子还在」）：
 *   取关只删了 `follows` 一行，`feed_cache`（关注流缓存）与 `cache_entries`
 *   （lookup 缓存）里的旧数据还在，站主直读 /api/local/feed 仍看得到对方帖子。
 *
 * 三条硬约束（来自 `docs/progress.md` M-F 执行约束）：
 *   1. **跨 D1 必须串行**：`feed_cache` 在 GOVERNANCE_DB，`cache_entries` /
 *      `system_config` 在 IDENTITY_DB。Workers 单次调用只能对一个 binding
 *      批量提交 → **禁止 JOIN、禁止合并单 binding batch**。
 *   2. **F-01 红线**：HTTP 路径**零 KV.put**（KV 写 1,000 次/天，D1 是
 *      100,000 次/天，差 100 倍）。清缓存只删 D1 行 + 置 D1 脏标记，
 *      由既有 Cron 刷 KV。
 *   3. **fail-soft**：清理失败**不能**让取关失败——关注关系已删是既成事实，
 *      缓存残留只是暂时多显示几条；读时还有第二道防线
 *      （`services/local-reads/feedQuery.ts` 的可见性过滤）。
 */
import { resolveGovernanceDb, resolveIdentityDb } from '../db/bindings';
import type { Env } from '../env';
import { normalizeFeedSourceUrl } from './followFeedVisibility';

/** `system_config` 脏标记 key：置 true → Cron 刷 feed:latest KV 后置 false */
export const FEED_LATEST_DIRTY_KEY = 'feed_latest_dirty';

export interface FollowCacheCleanupInput {
  /** `follows.follower_node_url`（被关注节点的 Worker B 地址） */
  readonly followerNodeUrl: string;
  /** `follows.followed_worker_b_url`（可能为空；迁址后可能与上面不同） */
  readonly followedWorkerBUrl?: string | null;
}

export interface FollowCacheCleanupResult {
  /** `feed_cache` 删除行数 */
  readonly feedCacheDeleted: number;
  /** `cache_entries` 删除行数 */
  readonly cacheEntriesDeleted: number;
  /** 是否成功置了 `feed_latest_dirty` 标记 */
  readonly dirtyMarked: boolean;
  /** 失败原因（fail-soft 收集，不抛） */
  readonly errors: readonly string[];
}

function collectUrls(input: FollowCacheCleanupInput): string[] {
  const urls: string[] = [];
  for (const raw of [input.followerNodeUrl, input.followedWorkerBUrl]) {
    const normalized = normalizeFeedSourceUrl(raw);
    if (normalized && !urls.includes(normalized)) urls.push(normalized);
  }
  return urls;
}

/**
 * 清 `feed_cache`（GOVERNANCE_DB）。
 * 按 `node_url` 命中：拉帖时写入的 `node_url` 可能是 `follower_node_url`，
 * 也可能是 `followed_worker_b_url`（迁址前后不同），两列都要查。
 */
async function clearFeedCache(
  env: Env,
  urls: readonly string[],
): Promise<{ deleted: number; error?: string }> {
  if (urls.length === 0) return { deleted: 0 };
  const placeholders = urls.map(() => '?').join(', ');
  try {
    const result = await resolveGovernanceDb(env)
      .prepare(`DELETE FROM feed_cache WHERE node_url IN (${placeholders})`)
      .bind(...urls)
      .run();
    return { deleted: result.meta?.changes ?? 0 };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[followCacheCleanup] 清 feed_cache 失败', message);
    return { deleted: 0, error: message };
  }
}

/**
 * 清 `cache_entries`（IDENTITY_DB）。
 * 该表主键是 handle，但按 `node_url` / `worker_b_url` 也能定位到被关注节点。
 */
async function clearCacheEntries(
  env: Env,
  urls: readonly string[],
): Promise<{ deleted: number; error?: string }> {
  if (urls.length === 0) return { deleted: 0 };
  const placeholders = urls.map(() => '?').join(', ');
  try {
    const result = await resolveIdentityDb(env)
      .prepare(
        `DELETE FROM cache_entries
          WHERE node_url IN (${placeholders})
             OR worker_b_url IN (${placeholders})`,
      )
      .bind(...urls, ...urls)
      .run();
    return { deleted: result.meta?.changes ?? 0 };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[followCacheCleanup] 清 cache_entries 失败', message);
    return { deleted: 0, error: message };
  }
}

/**
 * 置 `feed_latest_dirty`（IDENTITY_DB）——通知 Cron 刷 `feed:latest` KV。
 * 用 INSERT OR REPLACE：即使历史库没这个 key 也能自愈建行。
 */
async function markFeedLatestDirty(env: Env): Promise<{ ok: boolean; error?: string }> {
  try {
    await resolveIdentityDb(env)
      .prepare(
        `INSERT OR REPLACE INTO system_config (key, value, updated_at)
         VALUES (?, 'true', ?)`,
      )
      .bind(FEED_LATEST_DIRTY_KEY, new Date().toISOString())
      .run();
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[followCacheCleanup] 置 feed_latest_dirty 失败', message);
    return { ok: false, error: message };
  }
}

/**
 * 取关后清理缓存（**跨库串行**，禁 JOIN / 禁合并 batch）。
 *
 * 调用顺序固定：GOVERNANCE(feed_cache) → IDENTITY(cache_entries) →
 * IDENTITY(system_config dirty 标记)。
 */
export async function cleanupFollowCachesAfterUnfollow(
  env: Env,
  input: FollowCacheCleanupInput,
): Promise<FollowCacheCleanupResult> {
  const urls = collectUrls(input);
  const errors: string[] = [];

  const feedCache = await clearFeedCache(env, urls);
  if (feedCache.error) errors.push(`feed_cache:${feedCache.error}`);

  const cacheEntries = await clearCacheEntries(env, urls);
  if (cacheEntries.error) errors.push(`cache_entries:${cacheEntries.error}`);

  const dirty = await markFeedLatestDirty(env);
  if (!dirty.ok && dirty.error) errors.push(`dirty:${dirty.error}`);

  return {
    feedCacheDeleted: feedCache.deleted,
    cacheEntriesDeleted: cacheEntries.deleted,
    dirtyMarked: dirty.ok,
    errors,
  };
}
