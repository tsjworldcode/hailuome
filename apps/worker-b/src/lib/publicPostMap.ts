/**
 * NCF-2E：Worker B 公开帖子 / feed 行 → API DTO 映射（无 Hono Context）。
 */
import type { PostKind, RepostOf } from '@hailuo/shared-types';
import type { Env } from '../env.d';

/** POSTS_CACHE_KV['posts:latest'] 本节点帖子 */
export interface PostRow {
  id: string;
  content: string;
  sig: string;
  image_keys: string;
  created_at: string;
  post_kind?: string;
  repost_of_node_url?: string | null;
  repost_of_post_id?: string | null;
  repost_of_author_handle?: string | null;
}

/** POSTS_CACHE_KV['feed:latest'] 聚合条目 */
export interface FeedRow {
  id: string;
  node_url: string;
  content: string;
  sig: string;
  image_urls: string;
  post_id: string;
  created_at: string;
  author_handle?: string | null;
  post_kind?: string;
  repost_of_json?: string | null;
}

export interface PublicPostItem {
  id: string;
  content: string;
  sig: string;
  image_urls: string[];
  created_at: string;
  node_url?: string;
  post_id?: string;
  source_type?: 'official';
  author_handle?: string;
  post_kind?: PostKind;
  repost_of?: RepostOf | null;
}

const DEFAULT_REGISTRY_URL = 'https://hailuo-registry.allovo.eu.org';

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

export function resolveRegistryUrl(env: Env): string {
  return stripTrailingSlash(env.REGISTRY_URL?.trim() || DEFAULT_REGISTRY_URL);
}

export function isRegistryOfficialFeedRow(row: FeedRow, env: Env): boolean {
  return stripTrailingSlash(row.node_url) === resolveRegistryUrl(env);
}

export function compareCreatedAtDesc(
  a: Pick<PublicPostItem, 'created_at'>,
  b: Pick<PublicPostItem, 'created_at'>,
): number {
  return b.created_at.localeCompare(a.created_at);
}

/** 解析 image_keys / image_urls JSON，失败回落空数组 */
export function parseImageKeys(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    return [];
  }
}

export function buildRepostOfFromRow(post: PostRow): RepostOf | null {
  if (post.post_kind !== 'repost' || !post.repost_of_node_url || !post.repost_of_post_id) {
    return null;
  }
  return {
    node_url: post.repost_of_node_url,
    post_id: post.repost_of_post_id,
    author_handle: post.repost_of_author_handle?.trim() || 'unknown',
  };
}

export function localPostToPublicItem(post: PostRow, origin: string): PublicPostItem {
  const repostOf = buildRepostOfFromRow(post);
  const item: PublicPostItem = {
    id: post.id,
    content: post.content,
    sig: post.sig,
    image_urls: parseImageKeys(post.image_keys).map((k) => `${origin}/img/${k}`),
    created_at: post.created_at,
  };
  if (repostOf) {
    return { ...item, post_kind: 'repost', repost_of: repostOf };
  }
  return { ...item, post_kind: 'original', repost_of: null };
}

export function buildRepostOfFromFeedRow(row: FeedRow): RepostOf | null {
  if (row.post_kind !== 'repost' || !row.repost_of_json) return null;
  try {
    const parsed = JSON.parse(row.repost_of_json) as {
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

export function feedRowToPublicItem(row: FeedRow, env: Env): PublicPostItem {
  const repostOf = buildRepostOfFromFeedRow(row);
  const item: PublicPostItem = {
    id: row.id,
    node_url: row.node_url,
    post_id: row.post_id,
    ...(isRegistryOfficialFeedRow(row, env) ? { source_type: 'official' as const } : {}),
    author_handle: row.author_handle ?? undefined,
    content: row.content,
    sig: row.sig,
    image_urls: parseImageKeys(row.image_urls),
    created_at: row.created_at,
  };
  if (repostOf) {
    return { ...item, post_kind: 'repost', repost_of: repostOf };
  }
  return { ...item, post_kind: 'original', repost_of: null };
}

export function officialFeedRowToPublicItem(row: FeedRow): PublicPostItem {
  return {
    id: row.id,
    node_url: row.node_url,
    post_id: row.post_id,
    // 官方公告必须显式打标，前端据此禁用「不感兴趣」
    source_type: 'official',
    content: row.content,
    sig: row.sig,
    image_urls: parseImageKeys(row.image_urls),
    created_at: row.created_at,
  };
}
