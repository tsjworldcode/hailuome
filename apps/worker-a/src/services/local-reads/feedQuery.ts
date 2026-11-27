/**
 * M-REFACTOR-1a：站主直读 feed_cache D1 查询（从 local-reads 路由层下沉）。
 *
 * M-F2：读时按「活跃关注集合 + 官方源」二次过滤。
 *   背景（站主 2026-10-22 口述「取关了帖子还在」）：`feed_cache` 里存着已取关
 *   节点的旧行（清理失败 / 迁址旧址残留 / 48h GC 未到），站主直读仍看得到。
 *   取关时主动清理（见 `lib/followCacheCleanup.ts`）是第一道防线；本处过滤是
 *   第二道防线，保证「即使清理失败也看不到已取关节点的帖子」。
 */
import { normalizeWorkerBOrigin } from '@hailuo/shared-utils';
import type { Env } from '../../env';
import { resolveRegisteredRegistryForSync } from '../../lib/registryRouter';
import { resolveGovernanceDb, resolveIdentityDb } from '../../db/bindings';
import {
  buildFeedVisibilitySets,
  isFeedRowVisible,
  type FeedVisibilitySets,
} from '../../lib/followFeedVisibility';

export interface FeedCacheRow {
  id: string;
  node_url: string;
  post_id: string;
  content: string;
  sig: string;
  image_urls: string;
  created_at: string;
  author_handle: string | null;
  post_kind?: string | null;
  repost_of_json?: string | null;
}

const LOCAL_FEED_SELECT = `id, node_url, post_id, content, sig, image_urls, created_at, author_handle,
  post_kind, repost_of_json`;

/** M-F2：单次扫描的取行数（覆盖 limit+1 的可见条目） */
const VISIBILITY_SCAN_CHUNK = 50;
/** M-F2：单次请求最多扫描多少个 chunk（防止极端脏数据把请求拖爆） */
const VISIBILITY_SCAN_MAX_CHUNKS = 5;

function parseFeedImageUrls(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    return [];
  }
}

function parseFeedRepostOf(raw: string | null | undefined): {
  node_url: string;
  post_id: string;
  author_handle: string;
} | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as {
      node_url?: string;
      post_id?: string;
      author_handle?: string;
    };
    if (!parsed.node_url || !parsed.post_id) return null;
    return {
      node_url: parsed.node_url,
      post_id: parsed.post_id,
      author_handle: parsed.author_handle?.trim() || 'unknown',
    };
  } catch {
    return null;
  }
}

function isRegistryOfficialFeedRow(nodeUrl: string, officialOrigins: readonly string[]): boolean {
  const target = normalizeWorkerBOrigin(nodeUrl);
  return officialOrigins.some((origin) => normalizeWorkerBOrigin(origin) === target);
}

/**
 * 官方源地址集合（注册中心）。
 * 三个来源：
 *   1. 已登记注册中心（registered_registries）
 *   2. env.REGISTRY_URL
 *   3. 上次官方公告实际落库的源地址（换址后可能与上面两个不同）
 */
async function resolveOfficialFeedOrigins(env: Env): Promise<string[]> {
  const origins: string[] = [];
  const registered = await resolveRegisteredRegistryForSync(env);
  if (registered?.registry_url) origins.push(registered.registry_url);
  const envUrl = env.REGISTRY_URL?.trim();
  if (envUrl) origins.push(envUrl);
  // system_config 在 IDENTITY_DB
  try {
    const row = await resolveIdentityDb(env)
      .prepare(
        `SELECT value FROM system_config
          WHERE key = 'registry_official_feed_last_source_url' LIMIT 1`,
      )
      .first<{ value: string }>();
    const sourceUrl = row?.value?.trim();
    if (sourceUrl) origins.push(sourceUrl);
  } catch {
    /* fail-soft：读不到就不加，不影响主流程 */
  }
  return origins;
}

function mapLocalFeedItem(row: FeedCacheRow, officialOrigins: readonly string[]) {
  const base = {
    id: row.id,
    node_url: row.node_url,
    post_id: row.post_id,
    content: row.content,
    sig: row.sig,
    image_urls: parseFeedImageUrls(row.image_urls),
    created_at: row.created_at,
    ...(row.author_handle ? { author_handle: row.author_handle } : {}),
    ...(isRegistryOfficialFeedRow(row.node_url, officialOrigins) ? { source_type: 'official' as const } : {}),
  };
  const repostOf = row.post_kind === 'repost' ? parseFeedRepostOf(row.repost_of_json) : null;
  if (repostOf) {
    return { ...base, post_kind: 'repost' as const, repost_of: repostOf };
  }
  return { ...base, post_kind: 'original' as const, repost_of: null };
}

export interface QueryLocalFeedResult {
  items: ReturnType<typeof mapLocalFeedItem>[];
  has_more: boolean;
  cursor: string | null;
}

/** 按 cursor 取一批 feed_cache 行（未做可见性过滤）；cursor 为空则从头取。 */
async function fetchFeedChunk(
  env: Env,
  cursor: string | null,
  chunkSize: number,
): Promise<FeedCacheRow[]> {
  const governanceDb = resolveGovernanceDb(env);
  if (!cursor) {
    const result = await governanceDb.prepare(
      `SELECT ${LOCAL_FEED_SELECT}
         FROM feed_cache
        ORDER BY created_at DESC, id DESC
        LIMIT ?`,
    )
      .bind(chunkSize)
      .all<FeedCacheRow>();
    return result.results ?? [];
  }

  const cursorRow = await governanceDb
    .prepare(`SELECT created_at FROM feed_cache WHERE id = ? LIMIT 1`)
    .bind(cursor)
    .first<{ created_at: string }>();

  if (!cursorRow) {
    // cursor 行已被清理（取关删缓存）→ 从头取，避免整页空
    const result = await governanceDb.prepare(
      `SELECT ${LOCAL_FEED_SELECT}
         FROM feed_cache
        ORDER BY created_at DESC, id DESC
        LIMIT ?`,
    )
      .bind(chunkSize)
      .all<FeedCacheRow>();
    return result.results ?? [];
  }

  const cursorTime = cursorRow.created_at;
  const result = await governanceDb.prepare(
    `SELECT ${LOCAL_FEED_SELECT}
       FROM feed_cache
      WHERE created_at < ? OR (created_at = ? AND id < ?)
      ORDER BY created_at DESC, id DESC
      LIMIT ?`,
  )
    .bind(cursorTime, cursorTime, cursor, chunkSize)
    .all<FeedCacheRow>();
  return result.results ?? [];
}

/**
 * 站主直读 feed_cache 分页（M-F2：读时按活跃关注集合 + 官方源二次过滤）。
 *
 * 可见性集合读取失败 → 跳过过滤（fail-soft，保持旧行为，不因判读失败而空列表）。
 */
export async function queryLocalFeed(
  env: Env,
  opts: { cursor: string | null; limit: number },
): Promise<QueryLocalFeedResult> {
  const { cursor, limit } = opts;

  // 官方源只需解析一次（同时用于可见性判定与 source_type 打标）
  let officialOrigins: string[] = [];
  try {
    officialOrigins = await resolveOfficialFeedOrigins(env);
  } catch (err) {
    console.error('[local-reads/feed] 解析官方源失败', err);
  }

  // 可见性集合（活跃关注 + 官方源）；读失败则不过滤
  let visibility: FeedVisibilitySets | null = null;
  try {
    const followResult = await resolveIdentityDb(env)
      .prepare(`SELECT follower_node_url, followed_worker_b_url FROM follows`)
      .all<{ follower_node_url: string; followed_worker_b_url: string | null }>();
    visibility = buildFeedVisibilitySets(followResult.results ?? [], officialOrigins);
  } catch (err) {
    console.error('[local-reads/feed] 读取关注集合失败，跳过可见性过滤', err);
  }

  const visibleRows: FeedCacheRow[] = [];
  let scanCursor = cursor;
  let exhausted = false;
  let scannedChunks = 0;

  // 扫到 limit+1 条可见行即可判断 has_more
  while (visibleRows.length <= limit && scannedChunks < VISIBILITY_SCAN_MAX_CHUNKS && !exhausted) {
    const chunk = await fetchFeedChunk(env, scanCursor, VISIBILITY_SCAN_CHUNK);
    scannedChunks += 1;
    if (chunk.length === 0) {
      exhausted = true;
      break;
    }
    for (const row of chunk) {
      if (!visibility || isFeedRowVisible(row.node_url, visibility)) {
        visibleRows.push(row);
      }
      // 扫描游标推进到最后一行（含被过滤掉的）：被过滤的行本就在上一页可见行之后，
      // 下一轮从可见行之后重扫它们也不会产生可见条目重复。
      scanCursor = row.id;
    }
    if (chunk.length < VISIBILITY_SCAN_CHUNK) {
      exhausted = true;
    }
  }

  // M-F2b：可见行超过 limit → 常规分页；或扫描预算用尽且未耗尽源表 → 仍有后续（可能全是被过滤行）
  const hitScanBudget = scannedChunks >= VISIBILITY_SCAN_MAX_CHUNKS && !exhausted;
  const hasMoreVisible = visibleRows.length > limit;
  const hasMore = hasMoreVisible || hitScanBudget;
  const pageRows = hasMoreVisible ? visibleRows.slice(0, limit) : visibleRows;
  // 可见行够一页：cursor = 本页最后可见行（既有契约）；
  // 仅因扫描预算截断：cursor = 已扫到的最后一行（含被过滤），便于下一页从该点继续扫
  const nextCursor = hasMoreVisible
    ? (pageRows[pageRows.length - 1]?.id ?? null)
    : hitScanBudget
      ? scanCursor
      : null;

  const items = pageRows.map((row) => mapLocalFeedItem(row, officialOrigins));
  return { items, has_more: hasMore, cursor: nextCursor };
}
