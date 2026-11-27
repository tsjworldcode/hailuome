/**
 * M9-12 / M13-3：Worker B 公开读 KV 读取 + stale 兜底 + 可选只读快照回源（默认关闭）。
 * M13-3：优先读 envelope 单次 get；回落 legacy 数组 + :meta 双读。
 * M34-OPT-1：新增单帖独立 key 读取（post:{id}），O(1) 路径。
 * M34-OPT-2：新增分页快照 key 读取（posts:page:{version}:{scope}:{cursor}:{limit}），翻页优化。
 * M13-15：废弃 feed:sorted 第二键——cursor 翻页改走有界 findIndex（≤50 条 / 轮，不额外 KV get）。
 * audit-v3 步骤 2.2：posts:latest 分桶时按 meta.bucket_count 合并 bucket:1..n-1。
 * audit-v3 步骤 2.5：posts:page lazy populate 同 key 并发 miss → 仅 1 次 KV put（inflight Map）。
 */
import {
  FEED_CACHE_META_KV_KEY,
  FEED_PAGE_KV_PREFIX,
  POSTS_CACHE_META_KV_KEY,
  POSTS_LATEST_BUCKET_PREFIX,
  POST_INDIVIDUAL_KV_PREFIX,
  POSTS_PAGE_KV_PREFIX,
  type PublicReadCacheMeta,
} from '@hailuo/shared-types';
import { isPublicReadCacheEnvelope } from '@hailuo/shared-utils';
import { signRequest } from '@hailuo/shared-crypto';
import type { Env } from '../env.d';
import {
  compareCreatedAtDesc,
  feedRowToPublicItem,
  isRegistryOfficialFeedRow,
  localPostToPublicItem,
  officialFeedRowToPublicItem,
  type PublicPostItem,
} from './publicPostMap';

/** feed Cron 周期 5 分钟；超过 3 个周期未刷新则标 stale */
const FEED_STALE_MS = 15 * 60 * 1000;

export interface PostsLatestRow {
  id: string;
  content: string;
  sig: string;
  image_keys: string;
  created_at: string;
  /** M9-1：默认 original；转发帖为 repost */
  post_kind?: string;
  repost_of_node_url?: string | null;
  repost_of_post_id?: string | null;
  repost_of_author_handle?: string | null;
}

export interface FeedLatestRow {
  id: string;
  node_url: string;
  content: string;
  sig: string;
  image_urls: string;
  post_id: string;
  created_at: string;
  author_handle?: string | null;
  /** M9-1-4：转发帖 */
  post_kind?: string;
  repost_of_json?: string | null;
}

function emptyMeta(stale: boolean): PublicReadCacheMeta {
  return { generated_at: null, stale };
}

function resolveStaleFromMeta(meta: PublicReadCacheMeta | null, isFeed: boolean): boolean {
  if (!meta?.generated_at) return true;
  const age = Date.now() - Date.parse(meta.generated_at);
  if (Number.isNaN(age)) return true;
  if (isFeed && age > FEED_STALE_MS) return true;
  if (isFeed && (meta.partial_failed_count ?? 0) > 0) return true;
  return meta.stale === true;
}

async function fetchSnapshotFromWorkerA<T>(
  env: Env,
  path: string,
): Promise<{ items: T[]; meta: PublicReadCacheMeta } | null> {
  if (env.READ_SNAPSHOT_ON_MISS !== 'true' || !env.WORKER_A || !env.INTERNAL_FORWARD_SECRET) {
    return null;
  }
  const internalPath = path;
  const signed = await signRequest(
    { method: 'GET', path: internalPath },
    '',
    env.INTERNAL_FORWARD_SECRET,
  );
  const headers = new Headers({
    'X-Internal-Forward': 'hmac-v2',
    'X-Timestamp': signed['X-Timestamp'],
    'X-Nonce': signed['X-Nonce'],
    'X-Signature': signed['X-Signature'],
  });
  let upstream: Response;
  try {
    upstream = await env.WORKER_A.fetch(
      new Request(`https://worker-a.internal${internalPath}`, { method: 'GET', headers }),
    );
  } catch (err) {
    console.warn('[public-cache] snapshot Service Binding 失败', err);
    return null;
  }
  if (!upstream.ok) return null;
  try {
    const json = await upstream.json() as {
      ok: boolean;
      data?: { items: T[]; generated_at?: string | null; partial_failed_count?: number };
    };
    if (!json.ok || !json.data) return null;
    return {
      items: json.data.items ?? [],
      meta: {
        generated_at: json.data.generated_at ?? null,
        stale: false,
        partial_failed_count: json.data.partial_failed_count,
      },
    };
  } catch {
    return null;
  }
}

/** 读取 posts:latest；envelope 单次 KV get；分桶时合并；legacy 双读；miss 可选 snapshot。 */
export async function readPostsLatestWithMeta(env: Env): Promise<{
  posts: PostsLatestRow[];
  meta: PublicReadCacheMeta;
}> {
  const raw = await env.POSTS_CACHE_KV.get('posts:latest', 'json') as
    | PostsLatestRow[]
    | { items: PostsLatestRow[]; meta: PublicReadCacheMeta }
    | null;

  if (isPublicReadCacheEnvelope<PostsLatestRow>(raw)) {
    let posts = raw.items;
    const bucketCount =
      typeof raw.meta.bucket_count === 'number' && raw.meta.bucket_count > 1
        ? Math.floor(raw.meta.bucket_count)
        : 1;

    // audit-v3 2.2：分桶合并（主 key 为第 0 桶）
    if (bucketCount > 1) {
      const sideKeys = [];
      for (let i = 1; i < bucketCount; i++) {
        sideKeys.push(`${POSTS_LATEST_BUCKET_PREFIX}${i}`);
      }
      try {
        const sides = await Promise.all(
          sideKeys.map((key) =>
            env.POSTS_CACHE_KV.get(key, 'json') as Promise<
              | { items: PostsLatestRow[]; meta: PublicReadCacheMeta }
              | PostsLatestRow[]
              | null
            >,
          ),
        );
        for (const side of sides) {
          if (!side) continue;
          if (isPublicReadCacheEnvelope<PostsLatestRow>(side)) {
            posts = posts.concat(side.items);
          } else if (Array.isArray(side)) {
            posts = posts.concat(side);
          }
        }
      } catch (err) {
        console.warn('[publicCache] posts:latest 分桶合并失败，仅返回主桶', err);
      }
    }

    return {
      posts,
      meta: { ...raw.meta, stale: resolveStaleFromMeta(raw.meta, false) },
    };
  }

  if (Array.isArray(raw)) {
    const metaRaw = await env.POSTS_CACHE_KV.get(POSTS_CACHE_META_KV_KEY, 'json') as PublicReadCacheMeta | null;
    const meta = metaRaw ?? { generated_at: null, stale: false };
    return {
      posts: raw,
      meta: { ...meta, stale: resolveStaleFromMeta(meta, false) },
    };
  }

  const snapshot = await fetchSnapshotFromWorkerA<PostsLatestRow>(env, '/internal/cache-snapshot/posts');
  if (snapshot) return { posts: snapshot.items, meta: snapshot.meta };
  return { posts: [], meta: emptyMeta(true) };
}

/** 读取 feed:latest；envelope 单次 KV get；legacy 双读；miss 可选 snapshot。 */
export async function readFeedLatestWithMeta(env: Env): Promise<{
  rows: FeedLatestRow[];
  meta: PublicReadCacheMeta;
}> {
  const raw = await env.POSTS_CACHE_KV.get('feed:latest', 'json') as
    | FeedLatestRow[]
    | { items: FeedLatestRow[]; meta: PublicReadCacheMeta }
    | null;

  if (isPublicReadCacheEnvelope<FeedLatestRow>(raw)) {
    return {
      rows: raw.items,
      meta: {
        ...raw.meta,
        stale: resolveStaleFromMeta(raw.meta, true),
        partial_failed_count: raw.meta.partial_failed_count ?? 0,
      },
    };
  }

  if (Array.isArray(raw)) {
    const metaRaw = await env.POSTS_CACHE_KV.get(FEED_CACHE_META_KV_KEY, 'json') as PublicReadCacheMeta | null;
    const meta = metaRaw ?? { generated_at: null, stale: false };
    return {
      rows: raw,
      meta: {
        ...meta,
        stale: resolveStaleFromMeta(meta, true),
        partial_failed_count: meta.partial_failed_count ?? 0,
      },
    };
  }

  const snapshot = await fetchSnapshotFromWorkerA<FeedLatestRow>(env, '/internal/cache-snapshot/feed');
  if (snapshot) {
    return {
      rows: snapshot.items,
      meta: {
        ...snapshot.meta,
        partial_failed_count: snapshot.meta.partial_failed_count ?? 0,
      },
    };
  }
  return { rows: [], meta: { ...emptyMeta(true), partial_failed_count: 0 } };
}

/**
 * M34-OPT-2：GET /posts 翻页 KV 读取优化（lazy populate）。
 *
 * 缓存策略：
 *   - 缓存 key：`posts:page:{posts:latest generated_at}:{scope}:{cursor}:{limit}`
 *   - `generated_at` 作为 version；新帖写入后 `posts:latest` 版本变化，旧缓存自然失效
 *   - TTL：60 秒，与边缘缓存 TTL（EDGE_CACHE_TTL_SEC）对齐（R-AUDIT-V3 P2-3）
 *   - 有 cursor 的翻页请求优先读 KV；miss 时从 posts:latest 全量计算并写缓存
 *   - R-AUDIT-V3 2.5：同 cacheKey 并发 miss 经 inflight Map 去重，只 put 一次
 *
 * 注意：`scope=merged` 与 `scope=local` 排序结果不同（official posts 参与合并排序），
 * 因此按 scope 单独缓存。
 */
export interface PostsPageCached {
  items: PublicPostItem[];
  has_more: boolean;
  next_cursor: string | null;
}

export interface ReadPostsPageOptions {
  scope: 'local' | 'merged';
  cursor: string | null;
  limit: number;
  origin: string;
}

/** R-AUDIT-V3 2.5：同 cacheKey 并发 miss 共用一次 KV put。 */
const postsPageInflightWrites = new Map<string, Promise<void>>();

/**
 * M13-16：分页 lazy KV put 默认关闭（省 put）；显式 `PUBLIC_PAGE_LAZY_KV_PUT=true` 才写。
 * 关闭时仍从 posts:latest / feed:latest 内存切片响应，只是不再二次 put。
 */
export function isPublicPageLazyKvPutEnabled(env: Pick<Env, 'PUBLIC_PAGE_LAZY_KV_PUT'>): boolean {
  return env.PUBLIC_PAGE_LAZY_KV_PUT === 'true';
}

/** 契约/单测：清空 inflight 表。 */
export function resetPostsPageInflightWritesForTests(): void {
  postsPageInflightWrites.clear();
}

/**
 * lazy populate 写 KV；同 key 并发只发起 1 次 put（Free Tier 写额度保护）。
 * 先同步登记 inflight，再 await put，避免 check-then-set 竞态。
 */
export async function putPostsPageCacheDeduped(
  env: Env,
  cacheKey: string,
  result: PostsPageCached,
): Promise<void> {
  const existing = postsPageInflightWrites.get(cacheKey);
  if (existing) {
    await existing;
    return;
  }

  let settle!: () => void;
  const gate = new Promise<void>((resolve) => {
    settle = resolve;
  });
  postsPageInflightWrites.set(cacheKey, gate);

  try {
    await env.POSTS_CACHE_KV.put(cacheKey, JSON.stringify(result), {
      expirationTtl: 60,
    });
  } catch {
    // 写缓存失败不影响正常响应；仍 release waiters
  } finally {
    postsPageInflightWrites.delete(cacheKey);
    settle();
  }
}

export async function readPostsPageWithMeta(
  env: Env,
  postsLatestPosts: PostsLatestRow[],
  postsMeta: PublicReadCacheMeta,
  feedLatestRows: FeedLatestRow[] | null,
  options: ReadPostsPageOptions,
): Promise<PostsPageCached & { meta: PublicReadCacheMeta }> {
  const { scope, cursor, limit, origin } = options;
  const version = postsMeta.generated_at ?? '';
  const cacheKey = `${POSTS_PAGE_KV_PREFIX}${version}:${scope}:${cursor ?? '_'}:${limit}`;

  // 1. 尝试读 KV 缓存（命中则直接返回，避免读 posts:latest）
  if (version) {
    try {
      const cached = await env.POSTS_CACHE_KV.get(cacheKey, 'json') as PostsPageCached | null;
      if (cached && Array.isArray(cached.items)) {
        return { ...cached, meta: postsMeta };
      }
    } catch {
      // KV 读取失败，正常回落计算
    }
  }

  // 2. Miss：从全量 posts:latest 计算分页
  const localPosts = postsLatestPosts.map((p) => localPostToPublicItem(p, origin));
  let allPosts: PublicPostItem[];

  if (scope === 'local') {
    allPosts = [...localPosts].sort(compareCreatedAtDesc);
  } else if (feedLatestRows) {
    const officialPosts = feedLatestRows
      .filter((row) => isRegistryOfficialFeedRow(row, env))
      .map(officialFeedRowToPublicItem);
    allPosts = [...localPosts, ...officialPosts].sort(compareCreatedAtDesc);
  } else {
    allPosts = localPosts;
  }

  let startIdx = 0;
  if (cursor) {
    const idx = allPosts.findIndex((p) => p.id === cursor);
    startIdx = idx >= 0 ? idx + 1 : 0;
  }
  const slice = allPosts.slice(startIdx, startIdx + limit);
  const hasMore = startIdx + limit < allPosts.length;
  const nextCursor = hasMore ? slice[slice.length - 1]?.id ?? null : null;

  const result: PostsPageCached = {
    items: slice,
    has_more: hasMore,
    next_cursor: nextCursor,
  };

  // 3. M13-16：默认不 lazy put；开启开关时才写（TTL=60s；并发 miss 去重）
  if (version && isPublicPageLazyKvPutEnabled(env)) {
    await putPostsPageCacheDeduped(env, cacheKey, result);
  }

  return { ...result, meta: postsMeta };
}

/**
 * M34-OPT-1：O(1) 单帖独立 KV 读取。
 * 优先读 `post:{id}` key；miss 时回落 posts:latest 全量扫描。
 * 回落路径不额外写缓存（posts:latest 刷新时已包含最新数据）。
 */
export async function readPostIndividual(
  env: Env,
  postId: string,
): Promise<PostsLatestRow | null> {
  try {
    const raw = await env.POSTS_CACHE_KV.get(`${POST_INDIVIDUAL_KV_PREFIX}${postId}`, 'json');
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      return raw as PostsLatestRow;
    }
  } catch (err) {
    console.warn('[publicCache] readPostIndividual KV 读取失败，回落全量列表', err);
  }

  // Miss：回落 posts:latest 全量扫描（向后兼容，posts:latest 刷新时已包含最新状态）
  const { posts } = await readPostsLatestWithMeta(env);
  return posts.find((p) => p.id === postId) ?? null;
}

/** feed 翻页缓存结构（与 posts:page 模式一致） */
export interface FeedPageCached {
  items: unknown[];
  has_more: boolean;
  next_cursor: string | null;
}

/**
 * M13-15：在已载入的 feed:latest 行上做有界 cursor 定位（≤50，无第二键 get）。
 * 导出供契约测直接断言，与 readFeedPageWithMeta 行为一致。
 */
export function resolveFeedCursorStartIndex(
  rows: ReadonlyArray<{ id: string }>,
  cursor: string | null,
): number {
  if (!cursor) return 0;
  const idx = rows.findIndex((r) => r.id === cursor);
  return idx >= 0 ? idx + 1 : 0;
}

/**
 * M34-OPT-4 / M13-15：GET /feed 翻页（可选 lazy populate feed:page）。
 *
 * 缓存策略：
 *   - 缓存 key：`feed:page:{feed:latest generated_at}:{cursor}:{limit}`
 *   - `generated_at` 作为 version；feed 刷新后版本变化，旧缓存自然失效
 *   - TTL：60 秒，与边缘缓存 TTL（EDGE_CACHE_TTL_SEC）对齐（R-AUDIT-V3 P2-3）
 *   - 有 cursor 的翻页请求优先读 KV；miss 时从 feed:latest 全量计算并写缓存
 *
 * M13-15：废弃 `feed:sorted` 第二键——cursor 仅对内存 rows 做有界 findIndex（≤50）。
 * M13-16：feed:page lazy put 默认关（`PUBLIC_PAGE_LAZY_KV_PUT=true` 才写）。
 */
export async function readFeedPageWithMeta(
  env: Env,
  rows: FeedLatestRow[],
  meta: PublicReadCacheMeta,
  cursor: string | null,
  limit: number,
): Promise<{ items: unknown[]; has_more: boolean; next_cursor: string | null }> {
  const version = meta.generated_at ?? '';
  const cacheKey = `${FEED_PAGE_KV_PREFIX}${version}:${cursor ?? '_'}:${limit}`;

  // 1. 尝试读 KV 分页缓存
  if (version) {
    try {
      const cached = await env.POSTS_CACHE_KV.get(cacheKey, 'json') as FeedPageCached | null;
      if (cached && Array.isArray(cached.items)) {
        return { items: cached.items, has_more: cached.has_more, next_cursor: cached.next_cursor };
      }
    } catch {
      // KV 读取失败，正常回落计算
    }
  }

  // 2. Miss：从全量 feed:latest 计算分页（有界 findIndex，不再 get feed:sorted）
  const startIdx = resolveFeedCursorStartIndex(rows, cursor);
  const slice = rows.slice(startIdx, startIdx + limit);
  const hasMore = startIdx + limit < rows.length;
  const nextCursor = hasMore ? (slice[slice.length - 1] as FeedLatestRow | undefined)?.id ?? null : null;

  const result: FeedPageCached = {
    items: slice.map((r) => feedRowToPublicItem(r, env)),
    has_more: hasMore,
    next_cursor: nextCursor,
  };

  // 3. M13-16：默认不 lazy put；开启开关时才写
  if (version && isPublicPageLazyKvPutEnabled(env)) {
    try {
      await env.POSTS_CACHE_KV.put(cacheKey, JSON.stringify(result), {
        expirationTtl: 60,
      });
    } catch {
      // 写缓存失败不影响正常响应
    }
  }

  return { items: result.items, has_more: result.has_more, next_cursor: result.next_cursor };
}
