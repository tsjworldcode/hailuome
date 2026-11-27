/**
 * M-REFACTOR-1a：站主直读 posts D1 查询（从 local-reads 路由层下沉）。
 */
import type { Env } from '../../env';
import { resolveContentDb } from '../../db/bindings';

export interface PostRow {
  id: string;
  content: string;
  sig: string;
  image_keys: string;
  created_at: string;
  deleted_at: string | null;
  post_kind?: string | null;
  repost_of_node_url?: string | null;
  repost_of_post_id?: string | null;
  repost_of_author_handle?: string | null;
}

const LOCAL_POSTS_SELECT = `id, content, sig, image_keys, created_at, deleted_at,
  post_kind, repost_of_node_url, repost_of_post_id, repost_of_author_handle`;

/** 解析 image_keys JSON 字符串，失败时回落空数组 */
export function parseImageKeys(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    return [];
  }
}

/** 将 D1 行映射为 API 项（含 M9-1 转发字段） */
export function mapLocalPostItem(row: PostRow) {
  const base = {
    id: row.id,
    content: row.content,
    sig: row.sig,
    image_keys: parseImageKeys(row.image_keys),
    created_at: row.created_at,
    deleted_at: row.deleted_at,
  };
  if (row.post_kind === 'repost' && row.repost_of_node_url && row.repost_of_post_id) {
    return {
      ...base,
      post_kind: 'repost' as const,
      repost_of: {
        node_url: row.repost_of_node_url,
        post_id: row.repost_of_post_id,
        author_handle: row.repost_of_author_handle?.trim() || 'unknown',
      },
    };
  }
  return { ...base, post_kind: 'original' as const, repost_of: null };
}

export interface QueryLocalPostsResult {
  items: ReturnType<typeof mapLocalPostItem>[];
  next_cursor: string | null;
}

/** 站主直读 posts 分页（D1，强一致） */
export async function queryLocalPosts(
  env: Env,
  opts: { before: string | null; limit: number },
): Promise<QueryLocalPostsResult> {
  const { before, limit } = opts;
  const fetchN = limit + 1;
  let rows: PostRow[];
  // posts 表归 CONTENT_DB；本查询只访问这一张表，使用独立 resolver 避免再走旧 DB 观察别名。
  const contentDb = resolveContentDb(env);

  if (!before) {
    const result = await contentDb.prepare(
      `SELECT ${LOCAL_POSTS_SELECT}
       FROM posts
       WHERE deleted_at IS NULL
       ORDER BY created_at DESC, id DESC
       LIMIT ?`,
    )
      .bind(fetchN)
      .all<PostRow>();
    rows = result.results;
  } else {
    const cursorRow = await contentDb.prepare(`SELECT created_at FROM posts WHERE id = ? LIMIT 1`)
      .bind(before)
      .first<{ created_at: string }>();

    if (!cursorRow) {
      const result = await contentDb.prepare(
        `SELECT ${LOCAL_POSTS_SELECT}
         FROM posts
         WHERE deleted_at IS NULL
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
      )
        .bind(fetchN)
        .all<PostRow>();
      rows = result.results;
    } else {
      const cursorTime = cursorRow.created_at;
      const result = await contentDb.prepare(
        `SELECT ${LOCAL_POSTS_SELECT}
         FROM posts
         WHERE deleted_at IS NULL
           AND (created_at < ? OR (created_at = ? AND id < ?))
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
      )
        .bind(cursorTime, cursorTime, before, fetchN)
        .all<PostRow>();
      rows = result.results;
    }
  }

  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const items = pageRows.map((row) => mapLocalPostItem(row));
  const nextCursor = hasMore ? (items[items.length - 1]?.id ?? null) : null;
  return { items, next_cursor: nextCursor };
}
