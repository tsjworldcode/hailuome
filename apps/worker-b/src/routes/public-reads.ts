/**
 * NCF-2E：Worker B 公开读路由（users / posts / feed / img）。
 * Token、边缘缓存、迁址头在本子 app 内按路径挂载；父 index 只做 `app.route('/', publicReadsApp)`。
 */
import { Hono } from 'hono';
import { PUBLIC_PROFILE_KV_KEY } from '@hailuo/shared-types';
import { withProtoVersion } from '@hailuo/shared-utils';
import type { Env, WorkerBVariables } from '../env.d';
import { resolveCanonicalPublicBaseUrl } from '../lib/canonicalPublicBaseUrl';
import { readFeedLatestWithMeta, readFeedPageWithMeta, readPostIndividual, readPostsLatestWithMeta, readPostsPageWithMeta } from '../lib/publicCacheRead';
import {
  compareCreatedAtDesc,
  feedRowToPublicItem,
  isRegistryOfficialFeedRow,
  localPostToPublicItem,
  officialFeedRowToPublicItem,
  type PublicPostItem,
} from '../lib/publicPostMap';
import { isPublicOwnerProfile, omitPublicComplianceFields } from '../lib/publicOwnerProfile';
import { requireFollowerToken, type FollowerTokenVars } from '../middleware/follower-token';
import { requireMediaTicketOrFallthrough, type MediaTicketVars } from '../middleware/media-ticket';
import { nodeMovedHeaderMiddleware } from '../middleware/node-moved-header';
import {
  applyCachePolicy,
  EDGE_CACHE_TTL_POST_SEC,
  EDGE_CACHE_TTL_SEC,
  edgeCache,
  getReadCachePolicy,
  resolveTokenMode,
} from '../middleware/read-cache';

type AppEnv = { Bindings: Env; Variables: WorkerBVariables & FollowerTokenVars & MediaTicketVars };

export const publicReadsApp = new Hono<AppEnv>();

// ── M3-0：GET /users/:handle — 公开用户信息（pubkey / worker_b_url） ─────
publicReadsApp.get('/users/:handle', async (c) => {
  const handle = c.req.param('handle');
  const requestOrigin = new URL(c.req.url).origin;
  const workerBUrl = await resolveCanonicalPublicBaseUrl(c.env, requestOrigin);
  const cached = await c.env.STATE_KV.get(PUBLIC_PROFILE_KV_KEY, 'json').catch(() => null);
  if (isPublicOwnerProfile(cached) && (handle === cached.handle || handle === c.env.BOOTSTRAP_HANDLE)) {
    const publicProfile = omitPublicComplianceFields(cached);
    return c.json({
      ok: true,
      data: {
        ...publicProfile,
        // M7-30h-2：canonical（STATE_KV）优先；profile 仅作 canonical 缺失时回退
        worker_b_url: workerBUrl || cached.worker_b_url,
      },
    });
  }
  if (handle !== c.env.BOOTSTRAP_HANDLE) {
    return c.json(
      { ok: false, error_code: 'USER_NOT_FOUND', message: '用户不存在' },
      404,
    );
  }

  return c.json({
    ok: true,
    data: {
      handle: c.env.BOOTSTRAP_HANDLE,
      display_name: '',
      bio: '',
      pubkey: c.env.ED25519_PUBLIC_KEY,
      dm_pubkey: '',
      worker_b_url: workerBUrl,
      avatar_key: '',
      contact_email: '',
      created_at: '',
      updated_at: '',
      email_verified: false,
    },
  });
});

// 边缘缓存 → Token → 迁址头（顺序与拆分前 index 一致）
publicReadsApp.use('/posts', edgeCache(EDGE_CACHE_TTL_SEC));
publicReadsApp.use('/posts/:id', edgeCache(EDGE_CACHE_TTL_POST_SEC));
publicReadsApp.use('/feed', edgeCache(EDGE_CACHE_TTL_SEC));

publicReadsApp.use('/posts', requireFollowerToken());
publicReadsApp.use('/posts/:id', requireFollowerToken());
publicReadsApp.use('/feed', requireFollowerToken());
// ⚠️ `/img/:key` 的鉴权顺序（SEC-AUDIT-2026-10-6a）：
//   票据中间件必须在 `requireFollowerToken` **之前**执行——它会在合法票据时
//   设置 `mediaTicketAuthorized` 标记，让后续 Authorization 校验跳过。
//   但 `use()` 阶段 Hono 尚未解析路径参数（`c.req.param('key')` 为空），
//   票据必须精确绑定 key，故票据中间件挂在**路由级**（见下方 `get('/img/:key', ...)`），
//   而 `requireFollowerToken` 仍在 `use()` 阶段——两者顺序由 Hono 的
//   「路由级中间件先于 use 级匹配」保证不了，故这里改为把 `requireFollowerToken`
//   也放到路由级，最终顺序为：票据 → Authorization → handler。

publicReadsApp.use('/posts', nodeMovedHeaderMiddleware);
publicReadsApp.use('/posts/:id', nodeMovedHeaderMiddleware);
publicReadsApp.use('/feed', nodeMovedHeaderMiddleware);

// ── M3-1：GET /posts ───────────────────────────────────────────────────
publicReadsApp.get('/posts', async (c) => {
  const cursor = c.req.query('cursor') ?? null;
  const scope = c.req.query('scope') ?? 'merged';
  const limitParam = parseInt(c.req.query('limit') ?? '20', 10);
  const limit = isNaN(limitParam) ? 20 : Math.min(Math.max(limitParam, 1), 50);
  const origin = await resolveCanonicalPublicBaseUrl(c.env, new URL(c.req.url).origin);

  // M34-OPT-2：有 cursor 的翻页请求优先读 KV 分页缓存，避免每次都读 posts:latest 全量
  if (cursor) {
    const { posts: rawPosts, meta: postsMeta } = await readPostsLatestWithMeta(c.env);
    const { rows: rawFeed } = scope === 'merged' ? await readFeedLatestWithMeta(c.env) : { rows: null };

    const { items, has_more, next_cursor } = await readPostsPageWithMeta(
      c.env,
      rawPosts,
      postsMeta,
      rawFeed,
      { scope: scope as 'local' | 'merged', cursor, limit, origin },
    );

    return c.json({
      ok: true,
      data: withProtoVersion({
        items,
        has_more,
        cursor: next_cursor,
        generated_at: postsMeta.generated_at,
        stale: postsMeta.stale === true,
      }),
    });
  }

  // 无 cursor（首页）：保持原逻辑，边缘缓存 + 直接读 posts:latest 全量
  const { posts: rawPosts, meta: postsMeta } = await readPostsLatestWithMeta(c.env);
  const localPosts = rawPosts.map((p) => localPostToPublicItem(p, origin));
  let posts: PublicPostItem[];
  if (scope === 'local') {
    posts = [...localPosts].sort(compareCreatedAtDesc);
  } else {
    const { rows: rawFeed } = await readFeedLatestWithMeta(c.env);
    const officialPosts = rawFeed
      .filter((row) => isRegistryOfficialFeedRow(row, c.env))
      .map(officialFeedRowToPublicItem);
    posts = [...localPosts, ...officialPosts].sort(compareCreatedAtDesc);
  }

  const slice = posts.slice(0, limit);
  const hasMore = limit < posts.length;
  const nextCursor = hasMore ? slice[slice.length - 1]?.id ?? null : null;

  return c.json({
    ok: true,
    data: withProtoVersion({
      items: slice,
      has_more: hasMore,
      cursor: nextCursor,
      generated_at: postsMeta.generated_at,
      stale: postsMeta.stale === true,
    }),
  });
});

// ── M3-1：GET /posts/:id ───────────────────────────────────────────────
publicReadsApp.get('/posts/:id', async (c) => {
  const postId = c.req.param('id');
  const origin = await resolveCanonicalPublicBaseUrl(c.env, new URL(c.req.url).origin);

  // M34-OPT-1：O(1) 优先读 post:{id} 独立 key；miss 回落到 posts:latest 全量扫描
  const post = await readPostIndividual(c.env, postId);

  if (!post) {
    return c.json(
      { ok: false, error_code: 'POST_NOT_FOUND', message: '帖子不存在或已删除' },
      404,
    );
  }

  return c.json({
    ok: true,
    data: localPostToPublicItem(post, origin),
  });
});

// ── M4-5：GET /feed ────────────────────────────────────────────────────
publicReadsApp.get('/feed', async (c) => {
  const cursor = c.req.query('cursor') ?? null;
  const limitParam = parseInt(c.req.query('limit') ?? '20', 10);
  const limit = isNaN(limitParam) ? 20 : Math.min(Math.max(limitParam, 1), 50);

  const { rows, meta } = await readFeedLatestWithMeta(c.env);

  // M34-OPT-4：有 cursor 的翻页请求优先读 KV 分页缓存，避免每次都读 feed:latest 全量
  if (cursor) {
    const page = await readFeedPageWithMeta(c.env, rows, meta, cursor, limit);
    return c.json({
      ok: true,
      data: withProtoVersion({
        items: page.items,
        has_more: page.has_more,
        cursor: page.next_cursor,
        generated_at: meta.generated_at,
        stale: meta.stale === true,
        partial_failed_count: meta.partial_failed_count ?? 0,
      }),
    });
  }

  // 无 cursor（首页）：保持原逻辑，边缘缓存 + 直接读 feed:latest 全量
  const items = rows.map((r) => feedRowToPublicItem(r, c.env));
  const slice = items.slice(0, limit);
  const hasMore = limit < items.length;
  const nextCursor = hasMore ? (slice[slice.length - 1] as { id: string } | undefined)?.id ?? null : null;

  return c.json({
    ok: true,
    data: withProtoVersion({
      items: slice,
      has_more: hasMore,
      cursor: nextCursor,
      generated_at: meta.generated_at,
      stale: meta.stale === true,
      partial_failed_count: meta.partial_failed_count ?? 0,
    }),
  });
});

// ── M3-3 + M5-1：GET /img/:key ─────────────────────────────────────────
// SEC-AUDIT-2026-10-6a：路由级挂载，保证「票据 → Authorization → handler」顺序。
//   - 票据中间件在合法票据时设置 `mediaTicketAuthorized` 标记并放行；
//   - `requireFollowerToken` 见该标记则跳过（票据已是授权）；
//   - 无票据 / 票据非法 → 走原 Authorization 路径（票据非法则 403，不回落）。
publicReadsApp.get('/img/:key', requireMediaTicketOrFallthrough(), requireFollowerToken(), async (c) => {
  const key = c.req.param('key');

  const imagePolicy = getReadCachePolicy(
    resolveTokenMode(c),
    'public, max-age=31536000, immutable',
  );

  // 上传侧是 kv:img_ 加 32 位十六进制。其它 kv: 字符串直接 404，不打 IMAGE_KV。
  if (key.startsWith('kv:')) {
    if (!/^kv:img_[a-f0-9]{32}$/.test(key)) {
      return c.json(
        { ok: false, error_code: 'IMAGE_NOT_FOUND', message: '图片不存在' },
        404,
      );
    }
    const result = await c.env.IMAGE_KV.getWithMetadata<{ contentType: string }>(
      key,
      'arrayBuffer',
    );
    if (!result.value) {
      return c.json(
        { ok: false, error_code: 'IMAGE_NOT_FOUND', message: '图片不存在' },
        404,
      );
    }
    const contentType = result.metadata?.contentType ?? 'application/octet-stream';
    const headers = new Headers({ 'Content-Type': contentType });
    applyCachePolicy(headers, imagePolicy);
    return new Response(result.value as ArrayBuffer, { headers });
  }

  if (key.startsWith('r2:')) {
    if (!c.env.HAILUO_IMAGE_R2) {
      return c.json(
        { ok: false, error_code: 'IMAGE_NOT_FOUND', message: '图片不存在（R2 未配置）' },
        404,
      );
    }
    const obj = await c.env.HAILUO_IMAGE_R2.get(key).catch(() => null);
    if (!obj) {
      return c.json(
        { ok: false, error_code: 'IMAGE_NOT_FOUND', message: '图片不存在' },
        404,
      );
    }
    const contentType = obj.httpMetadata?.contentType ?? 'application/octet-stream';
    const headers = new Headers({ 'Content-Type': contentType });
    applyCachePolicy(headers, imagePolicy);
    return new Response(obj.body, { headers });
  }

  if (key.startsWith('filebase:')) {
    const {
      MEDIA_FILEBASE_CONFIG_KV_KEY,
      fetchFilebaseObject,
      parseFilebaseImageObjectKey,
      parseFilebaseReadConfig,
      pickSafeUpstreamHeaders,
    } = await import('../lib/filebasefetch');

    const objectKey = parseFilebaseImageObjectKey(key);
    if (!objectKey) {
      return c.json(
        { ok: false, error_code: 'IMAGE_NOT_FOUND', message: '图片不存在' },
        404,
      );
    }

    const rawConfig = await c.env.STATE_KV.get(MEDIA_FILEBASE_CONFIG_KV_KEY);
    const filebaseConfig = parseFilebaseReadConfig(rawConfig);
    if (!filebaseConfig) {
      return c.json(
        { ok: false, error_code: 'IMAGE_NOT_FOUND', message: '图片不存在' },
        404,
      );
    }

    let upstream: Response;
    try {
      upstream = await fetchFilebaseObject(filebaseConfig, objectKey);
    } catch (err) {
      console.error('[worker-b/img] Filebase 上游请求失败', err);
      return c.json(
        { ok: false, error_code: 'IMAGE_NOT_FOUND', message: '图片不存在' },
        404,
      );
    }

    if (upstream.status === 404 || upstream.status === 403) {
      return c.json(
        { ok: false, error_code: 'IMAGE_NOT_FOUND', message: '图片不存在' },
        404,
      );
    }

    if (!upstream.ok || !upstream.body) {
      console.error('[worker-b/img] Filebase 上游非预期状态', upstream.status);
      return c.json(
        { ok: false, error_code: 'IMAGE_NOT_FOUND', message: '图片不存在' },
        404,
      );
    }

    const headers = pickSafeUpstreamHeaders(upstream.headers);
    applyCachePolicy(headers, imagePolicy);
    return new Response(upstream.body, { status: 200, headers });
  }

  if (key.startsWith('b2:')) {
    const {
      MEDIA_B2_CONFIG_KV_KEY,
      fetchB2Object,
      parseB2ImageObjectKey,
      parseB2ReadConfig,
      pickSafeUpstreamHeaders,
    } = await import('../lib/b2fetch');

    const objectKey = parseB2ImageObjectKey(key);
    if (!objectKey) {
      return c.json(
        { ok: false, error_code: 'IMAGE_NOT_FOUND', message: '图片不存在' },
        404,
      );
    }

    const rawConfig = await c.env.STATE_KV.get(MEDIA_B2_CONFIG_KV_KEY);
    const b2Config = parseB2ReadConfig(rawConfig);
    if (!b2Config) {
      return c.json(
        { ok: false, error_code: 'IMAGE_NOT_FOUND', message: '图片不存在' },
        404,
      );
    }

    let upstream: Response;
    try {
      upstream = await fetchB2Object(b2Config, objectKey);
    } catch (err) {
      console.error('[worker-b/img] B2 上游请求失败', err);
      return c.json(
        { ok: false, error_code: 'IMAGE_NOT_FOUND', message: '图片不存在' },
        404,
      );
    }

    if (upstream.status === 404 || upstream.status === 403) {
      return c.json(
        { ok: false, error_code: 'IMAGE_NOT_FOUND', message: '图片不存在' },
        404,
      );
    }

    if (!upstream.ok || !upstream.body) {
      console.error('[worker-b/img] B2 上游非预期状态', upstream.status);
      return c.json(
        { ok: false, error_code: 'IMAGE_NOT_FOUND', message: '图片不存在' },
        404,
      );
    }

    const headers = pickSafeUpstreamHeaders(upstream.headers);
    applyCachePolicy(headers, imagePolicy);
    return new Response(upstream.body, { status: 200, headers });
  }

  return c.json(
    { ok: false, error_code: 'IMAGE_NOT_FOUND', message: '图片不存在' },
    404,
  );
});
