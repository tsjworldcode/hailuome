/**
 * M17-4-3：好友动态 Feed 过滤（纯函数，便于契约测试）
 *
 * 数据源与「关注」tab 相同（feed_cache / Worker B /feed），
 * 仅保留 node_url ∈ 互粉集合的帖子。不与右栏 FoF 推荐混用。
 */

export type MutualUrlSource = {
  readonly node_url?: string | null;
  readonly worker_b_url?: string | null;
};

/** 与 Timeline 一致：去尾斜杠；比对时再 toLowerCase */
export function normalizeFriendNodeUrl(url: string): string {
  return url.trim().replace(/\/+$/, '').toLowerCase();
}

/** 从互粉列表构建可比对 URL 集合（node_url + worker_b_url） */
export function buildMutualNodeUrlSet(
  items: readonly MutualUrlSource[],
): ReadonlySet<string> {
  const set = new Set<string>();
  for (const item of items) {
    for (const raw of [item.node_url, item.worker_b_url]) {
      if (!raw || typeof raw !== 'string') continue;
      const n = normalizeFriendNodeUrl(raw);
      if (n) set.add(n);
    }
  }
  return set;
}

export function isFeedItemFromMutualFriend(
  nodeUrl: string,
  mutualUrls: ReadonlySet<string>,
): boolean {
  if (mutualUrls.size === 0) return false;
  return mutualUrls.has(normalizeFriendNodeUrl(nodeUrl));
}

/** 过滤 Feed 项：只保留互粉节点帖子 */
export function filterFeedItemsByMutual<T extends { readonly node_url: string }>(
  items: readonly T[],
  mutualUrls: ReadonlySet<string>,
): T[] {
  if (mutualUrls.size === 0) return [];
  return items.filter((item) => isFeedItemFromMutualFriend(item.node_url, mutualUrls));
}

/**
 * 从多页关注流中凑够目标条数的好友帖。
 * 返回 collected + 底层关注流游标，供下次 append 续翻。
 */
export function accumulateFriendsFromFollowingPages<T extends { readonly node_url: string }>(
  pages: readonly {
    readonly items: readonly T[];
    readonly nextCursor: string | null;
    readonly hasMore: boolean;
  }[],
  mutualUrls: ReadonlySet<string>,
  targetCount: number,
): {
  readonly items: T[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
} {
  const collected: T[] = [];
  let nextCursor: string | null = null;
  let hasMore = false;

  for (const page of pages) {
    collected.push(...filterFeedItemsByMutual(page.items, mutualUrls));
    nextCursor = page.nextCursor;
    hasMore = page.hasMore;
    if (collected.length >= targetCount || !page.hasMore) break;
  }

  return { items: collected, nextCursor, hasMore };
}

/** 单次 loadFeed 最多翻底层关注流页数，防止过滤过严时空转撞子请求 */
export const FRIENDS_FEED_MAX_PAGES = 5;
