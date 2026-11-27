/**
 * M9-12：Worker A 只读快照内部端点（仅 Service Binding + HMAC，默认关闭由 B 侧开关控制）。
 */
import { Hono } from 'hono';
import { verifyRequest } from '@hailuo/shared-crypto';
import { resolveContentDb, resolveGovernanceDb } from '../db/bindings';
import type { Env, AppVariables } from '../env';

type AppEnv = { Bindings: Env; Variables: AppVariables };

export const internalCacheSnapshotApp = new Hono<AppEnv>();

async function verifyInternalGet(c: {
  env: Env;
  req: { header: (name: string) => string | undefined; text: () => Promise<string> };
}, path: string): Promise<boolean> {
  const configured = c.env.INTERNAL_FORWARD_SECRET;
  if (!configured) return false;
  const marker = c.req.header('X-Internal-Forward') ?? '';
  const timestamp = c.req.header('X-Timestamp') ?? '';
  const nonce = c.req.header('X-Nonce') ?? '';
  const signature = c.req.header('X-Signature') ?? '';
  if (marker !== 'hmac-v2' || !timestamp || !nonce || !signature) return false;
  return verifyRequest(
    { method: 'GET', path },
    '',
    { timestamp, nonce, signature },
    configured,
  );
}

// GET /internal/cache-snapshot/posts — D1 最近 50 条未删帖只读快照
// posts 归 CONTENT_DB；与后续 feed_cache 端点分开选 binding，禁止把两库语句混成 batch。
internalCacheSnapshotApp.get('/cache-snapshot/posts', async (c) => {
  if (!(await verifyInternalGet(c, '/internal/cache-snapshot/posts'))) {
    return c.json({ ok: false, error_code: 'INTERNAL_FORWARD_REJECTED', message: '内部转发头验证失败' }, 401);
  }
  const contentDb = resolveContentDb(c.env);
  const result = await contentDb
    .prepare(
      `SELECT id, content, sig, image_keys, created_at,
              post_kind, repost_of_node_url, repost_of_post_id, repost_of_author_handle
         FROM posts
        WHERE deleted_at IS NULL
        ORDER BY created_at DESC, id DESC
        LIMIT 50`,
    )
    .all<{
      id: string;
      content: string;
      sig: string;
      image_keys: string;
      created_at: string;
      post_kind: string;
      repost_of_node_url: string | null;
      repost_of_post_id: string | null;
      repost_of_author_handle: string | null;
    }>();
  const items = result.results ?? [];
  return c.json({
    ok: true,
    data: {
      items,
      generated_at: new Date().toISOString(),
    },
  });
});

// GET /internal/cache-snapshot/feed — feed_cache 最近 50 条只读快照
internalCacheSnapshotApp.get('/cache-snapshot/feed', async (c) => {
  if (!(await verifyInternalGet(c, '/internal/cache-snapshot/feed'))) {
    return c.json({ ok: false, error_code: 'INTERNAL_FORWARD_REJECTED', message: '内部转发头验证失败' }, 401);
  }
  const governanceDb = resolveGovernanceDb(c.env);
  const result = await governanceDb
    .prepare(
      `SELECT id, node_url, content, sig, image_urls, post_id, created_at, author_handle,
              post_kind, repost_of_json
         FROM feed_cache
        ORDER BY created_at DESC
        LIMIT 50`,
    )
    .all<{
      id: string;
      node_url: string;
      content: string;
      sig: string;
      image_urls: string;
      post_id: string;
      created_at: string;
      author_handle: string | null;
    }>();
  const items = (result.results ?? []).map((row: NonNullable<(typeof result.results)[number]>) => {
    if (!row) return undefined;
    return {
      ...row,
      ...(row.author_handle ? { author_handle: row.author_handle } : {}),
    };
  }).filter(Boolean);
  return c.json({
    ok: true,
    data: {
      items,
      generated_at: new Date().toISOString(),
      partial_failed_count: 0,
    },
  });
});
