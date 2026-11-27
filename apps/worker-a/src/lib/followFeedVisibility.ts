/**
 * M-F2：关注流可见性判定（纯函数，便于契约测试）。
 *
 * 背景（站主 2026-10-22 口述「取关了帖子还在」）：
 *   `feed_cache`（GOVERNANCE_DB）是关注流缓存。取关时该节点的旧行若没被清掉
 *   （清理失败 / 迁址旧址残留 / 48h GC 未到），站主直读 feed 仍会看到已取关节点的帖子。
 *
 * 口径（与 `normalizeWorkerBOrigin` 一致：trim + 去尾斜杠）：
 *   - 「活跃关注集合」= `follows.follower_node_url` ∪ `follows.followed_worker_b_url`
 *     （两条都收：`followed_worker_b_url` 可能与 `follower_node_url` 不同，
 *      且旧数据可能带尾斜杠 —— 迁移时统一归一化再比较）
 *   - 「官方源」= 注册中心地址（registered registry / env.REGISTRY_URL /
 *     上次官方拉取落库的 `registry_official_feed_last_source_url`）；
 *     官方公告不属于任何关注关系，必须单独放行。
 *
 * 说明：本文件**不读写 D1**，纯计算；调用方负责提供 follow 行与官方源。
 */
import { normalizeWorkerBOrigin } from '@hailuo/shared-utils';

/** `follows` 表中参与可见性判定的最小字段集 */
export interface FollowSourceRow {
  readonly follower_node_url: string;
  readonly followed_worker_b_url?: string | null;
}

/** 可见性判定所需的两个 URL 集合（均已归一化） */
export interface FeedVisibilitySets {
  readonly followUrls: ReadonlySet<string>;
  readonly officialUrls: ReadonlySet<string>;
}

/** URL 归一化：trim + 去尾斜杠（与 shared-utils 同口径，不做大小写变换） */
export function normalizeFeedSourceUrl(raw: string | null | undefined): string {
  return normalizeWorkerBOrigin((raw ?? '').trim());
}

/**
 * 构建可见性集合。
 * @param followRows `follows` 表行（活跃关注）
 * @param officialOrigins 官方源地址列表（注册中心）
 */
export function buildFeedVisibilitySets(
  followRows: readonly FollowSourceRow[],
  officialOrigins: readonly string[],
): FeedVisibilitySets {
  const followUrls = new Set<string>();
  for (const row of followRows) {
    for (const candidate of [row.follower_node_url, row.followed_worker_b_url]) {
      const normalized = normalizeFeedSourceUrl(candidate);
      if (normalized) followUrls.add(normalized);
    }
  }

  const officialUrls = new Set<string>();
  for (const origin of officialOrigins) {
    const normalized = normalizeFeedSourceUrl(origin);
    if (normalized) officialUrls.add(normalized);
  }

  return { followUrls, officialUrls };
}

/**
 * 单行可见性：官方源恒可见；其余必须在活跃关注集合内。
 * @param nodeUrl `feed_cache.node_url`（帖子来源节点）
 */
export function isFeedRowVisible(nodeUrl: string, sets: FeedVisibilitySets): boolean {
  const normalized = normalizeFeedSourceUrl(nodeUrl);
  if (!normalized) return false;
  if (sets.officialUrls.has(normalized)) return true;
  return sets.followUrls.has(normalized);
}
