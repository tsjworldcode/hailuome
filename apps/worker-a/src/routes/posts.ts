/**
 * 帖子接口（M2-2 / M2-3）。
 *
 * postsApp 挂在 /api/posts/* ，JWT 鉴权由 index.ts 的 app.use('/api/posts/*') 保障。
 *
 * POST /api/posts   — 发帖（D1 写 posts + dirty 置 true）
 * DELETE /api/posts/:id — 删帖（D1 软删除 + dirty 置 true）（M2-3）
 *
 * ⚠️ M2 红线：HTTP 同步路径禁止 KV.put。
 *   - posts 写入 D1 `posts` 表（CONTENT_DB）
 *   - dirty 标记写入 D1 `system_config`（IDENTITY_DB）
 *   - M-OPT-SPLIT-A6-6 方案 C：先 CONTENT 写帖 → 后 IDENTITY 置 dirty；
 *     dirty 失败则 waitUntil(refreshPostsCacheIfDirty({ force:true })) 兜底，
 *     cron 仍每分钟兜底（eventual stale KV 窗口 ≤ 节流/cron）
 *
 * M2-4 已完成：signPost（Ed25519 签名）入库 sig 字段；私钥无效时返回 POST_SIGN_FAILED(500)。
 * M2-5 已完成：POST /api/images 单独接口写 IMAGE_KV；POST /api/posts 接收 images[]。
 */

import { Hono } from 'hono';
import { withSpan, SpanName, writeCounter } from '@hailuo/otel';
import { resolveContentDb, resolveIdentityDb } from '../db/bindings';
import type { Env, AppVariables } from '../env';
import { generateId, nowISO } from '@hailuo/shared-utils';
import { signPost, signRepost } from '@hailuo/shared-crypto';
import { refreshPostsCacheIfDirty } from '../handlers/cron';
import { putPostIndividual, deletePostIndividual } from '../lib/publicCacheMeta';
import { parsePostImageKeys, releasePostImageKeys } from '../lib/mediaObjectRegistry';
import {
  findActiveRepostId,
  precheckRepostOrigin,
  RepostPrecheckError,
  resolveRepostAuthorHandle,
  validateRepostOriginNodeUrl,
  validateRepostOriginPostId,
} from '../lib/repostOrigin';
import { resolveLocalPublicBaseUrl } from '../lib/localPublicBaseUrl';

type AppEnv = { Bindings: Env; Variables: AppVariables };

export const postsApp = new Hono<AppEnv>();

/** 帖子内容最大字符数（Unicode 码点数，与 docs/worker-a-api.md 对齐） */
const MAX_CONTENT_LENGTH = 500;

// ---------------------------------------------------------------------------
// POST /api/posts — 发帖
// ---------------------------------------------------------------------------

// ALL-AUDIT-Y-16-3：发帖路径挂 withSpan（OTEL_ENABLED 默认关 → 旁路）
postsApp.post('/', (c) =>
  withSpan(c, SpanName.PostCreate, async (span) => {
  span.setAttribute('http.method', 'POST');
  span.setAttribute('http.route', '/api/posts');
  // 解析请求体（JSON）
  let body: { content?: unknown; images?: unknown };
  try {
    body = await c.req.json() as { content?: unknown; images?: unknown };
  } catch {
    return c.json(
      { ok: false, error_code: 'INVALID_BODY', message: '请求体必须为 JSON' },
      400,
    );
  }

  // 内容校验：非空 + 不超过 500 字符
  const rawContent = typeof body.content === 'string' ? body.content : '';
  const content = rawContent.trim();
  if (!content) {
    return c.json(
      { ok: false, error_code: 'CONTENT_REQUIRED', message: '内容不能为空' },
      400,
    );
  }
  if ([...content].length > MAX_CONTENT_LENGTH) {
    // 用 [...str].length 统计 Unicode 码点数，正确处理 emoji / CJK 全角字符
    return c.json(
      { ok: false, error_code: 'CONTENT_TOO_LONG', message: `内容不能超过 ${MAX_CONTENT_LENGTH} 字符` },
      400,
    );
  }

  // 图片 key 校验：必须是 kv:img_ / r2:img_ / b2:img_ 开头（防止客户端传入任意 key）
  // M5-C9：M5-B2 引入 b2: 前缀后，posts.ts 必须同步接受，否则 B2 上传的图片无法发帖
  const ALLOWED_IMAGE_PREFIXES = ['kv:img_', 'r2:img_', 'b2:img_', 'filebase:img_'] as const;
  const rawImages = Array.isArray(body.images) ? body.images : [];
  const imageKeys: string[] = [];
  for (const k of rawImages) {
    if (typeof k !== 'string' || !ALLOWED_IMAGE_PREFIXES.some((p) => k.startsWith(p))) {
      return c.json(
        { ok: false, error_code: 'IMAGE_KEY_INVALID', message: `无效的图片 key：${String(k)}` },
        400,
      );
    }
    imageKeys.push(k);
  }

  // 生成帖子 ID 和时间戳
  const id = generateId('post');
  const createdAt = nowISO();

  // ------------------------------------------------------------------
  // Ed25519 签名（M2-4）：signPost(id, content, createdAt, privateKeyHex)
  // 签名内容：`${id}:${content}:${createdAt}`
  // 若私钥未设置/无效（PLACEHOLDER）则返回 500，不存未签名帖
  // ------------------------------------------------------------------
  let sig: string;
  try {
    sig = await signPost(id, content, createdAt, c.env.ED25519_PRIVATE_KEY);
  } catch (err) {
    console.error('[posts] Ed25519 签名失败（私钥未配置或格式错误）', err);
    return c.json(
      { ok: false, error_code: 'POST_SIGN_FAILED', message: '帖子签名失败，请检查节点私钥配置' },
      500,
    );
  }

  // ------------------------------------------------------------------
  // M-OPT-SPLIT-A6-6 方案 C：先 CONTENT INSERT posts → 后 IDENTITY 置 dirty。
  // dirty 失败不回滚帖；waitUntil force 刷新 + cron 兜底。
  // ------------------------------------------------------------------
  const contentDb = resolveContentDb(c.env);
  const identityDb = resolveIdentityDb(c.env);
  const dirtyAt = nowISO();
  let dirtyOk = false;
  try {
    await contentDb
      .prepare(
        `INSERT INTO posts (id, content, sig, image_keys, created_at)
           VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(id, content, sig, JSON.stringify(imageKeys), createdAt)
      .run();
  } catch (err) {
    console.error('[posts] D1 INSERT posts 失败', err);
    return c.json(
      { ok: false, error_code: 'POST_INTERNAL', message: '发帖写入失败，请重试' },
      500,
    );
  }
  try {
    await identityDb
      .prepare(
        `UPDATE system_config SET value = 'true', updated_at = ?
           WHERE key = 'posts_latest_dirty'`,
      )
      .bind(dirtyAt)
      .run();
    dirtyOk = true;
  } catch (err) {
    console.error('[posts] dirty 置位失败（帖已写入；waitUntil force 兜底）', err);
  }

  // 发帖成功后立即异步刷 KV，首页 Timeline 读 Worker B /posts 可立刻看到新帖。
  // M34-OPT-1：同步写单帖独立 key post:{id}，Worker B GET /posts/:id 可 O(1) 直接读取。
  const newPost = {
    id,
    content,
    sig,
    image_keys: JSON.stringify(imageKeys),
    created_at: createdAt,
  };
  c.executionCtx.waitUntil(
    Promise.all([
      refreshPostsCacheIfDirty(c.env, { bypassThrottle: true, force: !dirtyOk }).catch((err) => {
        console.error('[posts] waitUntil 刷新 posts:latest KV 失败', err);
      }),
      putPostIndividual(c.env, newPost).catch((err) => {
        console.error('[posts] waitUntil 写入 post:{} KV 失败', err);
      }),
    ]),
  );

  // image_urls：将 image_keys 转换为 Worker B 访问 URL（/img/:key）；基址读 D1 SSOT
  const publicBase = await resolveLocalPublicBaseUrl(c.env);
  const imageUrls = imageKeys.map((k) => `${publicBase}/img/${k}`);

  writeCounter(c.env, 'post.create.success');
  return c.json({
    ok: true,
    data: {
      id,
      content,
      sig,
      created_at: createdAt,
      image_urls: imageUrls,
    },
  });
  }),
);

// ---------------------------------------------------------------------------
// POST /api/posts/repost — 纯转发（M9-1-2）
// ---------------------------------------------------------------------------

postsApp.post('/repost', async (c) => {
  let body: {
    origin_node_url?: unknown;
    origin_post_id?: unknown;
    origin_author_handle?: unknown;
  };
  try {
    body = await c.req.json() as typeof body;
  } catch {
    return c.json(
      { ok: false, error_code: 'INVALID_BODY', message: '请求体必须为 JSON' },
      400,
    );
  }

  const urlCheck = validateRepostOriginNodeUrl(body.origin_node_url, c.env);
  if (!urlCheck.ok) {
    return c.json(
      { ok: false, error_code: urlCheck.error_code, message: urlCheck.message },
      400,
    );
  }

  const idCheck = validateRepostOriginPostId(body.origin_post_id);
  if (!idCheck.ok) {
    return c.json(
      { ok: false, error_code: idCheck.error_code, message: idCheck.message },
      400,
    );
  }

  const normalizedOrigin = urlCheck.normalized;
  const originPostId = idCheck.postId;

  const existingRepost = await findActiveRepostId(c.env, normalizedOrigin, originPostId);
  if (existingRepost) {
    return c.json(
      { ok: false, error_code: 'REPOST_ALREADY_EXISTS', message: '已转发过该帖，请先删除原转发帖' },
      409,
    );
  }

  try {
    await precheckRepostOrigin(c.env, normalizedOrigin, originPostId);
  } catch (err) {
    if (err instanceof RepostPrecheckError) {
      return c.json(
        { ok: false, error_code: err.errorCode, message: err.message },
        err.httpStatus as 400 | 403 | 404 | 502,
      );
    }
    console.error('[posts/repost] 原帖预检异常', err);
    return c.json(
      { ok: false, error_code: 'REPOST_ORIGIN_UNREACHABLE', message: '原帖节点不可达' },
      502,
    );
  }

  const authorHandle = await resolveRepostAuthorHandle(
    c.env,
    normalizedOrigin,
    body.origin_author_handle,
  );

  const id = generateId('post');
  const createdAt = nowISO();

  let sig: string;
  try {
    sig = await signRepost(id, normalizedOrigin, originPostId, createdAt, c.env.ED25519_PRIVATE_KEY);
  } catch (err) {
    console.error('[posts/repost] Ed25519 签名失败', err);
    return c.json(
      { ok: false, error_code: 'POST_SIGN_FAILED', message: '转发帖签名失败，请检查节点私钥配置' },
      500,
    );
  }

  const contentDb = resolveContentDb(c.env);
  const identityDb = resolveIdentityDb(c.env);
  const dirtyAt = nowISO();
  let dirtyOk = false;
  try {
    await contentDb
      .prepare(
        `INSERT INTO posts (
             id, content, sig, image_keys, created_at,
             post_kind, repost_of_node_url, repost_of_post_id, repost_of_author_handle
           ) VALUES (?, '', ?, '[]', ?, 'repost', ?, ?, ?)`,
      )
      .bind(id, sig, createdAt, normalizedOrigin, originPostId, authorHandle)
      .run();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('UNIQUE') || message.includes('unique')) {
      return c.json(
        { ok: false, error_code: 'REPOST_ALREADY_EXISTS', message: '已转发过该帖，请先删除原转发帖' },
        409,
      );
    }
    console.error('[posts/repost] D1 INSERT posts 失败', err);
    return c.json(
      { ok: false, error_code: 'POST_INTERNAL', message: '转发写入失败，请重试' },
      500,
    );
  }
  try {
    await identityDb
      .prepare(
        `UPDATE system_config SET value = 'true', updated_at = ?
           WHERE key = 'posts_latest_dirty'`,
      )
      .bind(dirtyAt)
      .run();
    dirtyOk = true;
  } catch (err) {
    console.error('[posts/repost] dirty 置位失败（帖已写入；waitUntil force 兜底）', err);
  }

  // M34-OPT-1：同步写单帖独立 key post:{id}，Worker B GET /posts/:id 可 O(1) 直接读取。
  const repostPost = {
    id,
    sig,
    created_at: createdAt,
    content: '',
    image_keys: '[]',
    post_kind: 'repost' as const,
    repost_of_node_url: normalizedOrigin,
    repost_of_post_id: originPostId,
    repost_of_author_handle: authorHandle,
  };
  c.executionCtx.waitUntil(
    Promise.all([
      refreshPostsCacheIfDirty(c.env, { bypassThrottle: true, force: !dirtyOk }).catch((err) => {
        console.error('[posts/repost] waitUntil 刷新 posts:latest KV 失败', err);
      }),
      putPostIndividual(c.env, repostPost).catch((err) => {
        console.error('[posts/repost] waitUntil 写入 post:{} KV 失败', err);
      }),
    ]),
  );

  return c.json({
    ok: true,
    data: {
      id,
      post_kind: 'repost' as const,
      repost_of: {
        node_url: normalizedOrigin,
        post_id: originPostId,
        author_handle: authorHandle,
      },
      sig,
      created_at: createdAt,
    },
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/posts/:id — 删帖（软删除）  ← M2-3 占位，路由结构在此预留
// ---------------------------------------------------------------------------

// ALL-AUDIT-Y-16-3：删帖路径挂 withSpan
postsApp.delete('/:id', (c) =>
  withSpan(c, SpanName.PostDelete, async (span) => {
  span.setAttribute('http.method', 'DELETE');
  span.setAttribute('http.route', '/api/posts/:id');
  const postId = c.req.param('id');

  // 查帖子是否存在（未软删除）— A-6-1 CONTENT；写路径 A-6-6 方案 C。
  const contentDb = resolveContentDb(c.env);
  const identityDb = resolveIdentityDb(c.env);
  const row = await contentDb
    .prepare(
      `SELECT id, image_keys FROM posts WHERE id = ? AND deleted_at IS NULL LIMIT 1`,
    )
    .bind(postId)
    .first<{ id: string; image_keys: string }>()
    .catch(() => null);

  if (!row) {
    return c.json(
      { ok: false, error_code: 'POST_NOT_FOUND', message: '帖子不存在或已删除' },
      404,
    );
  }

  // M-OPT-SPLIT-A6-6 方案 C：先 CONTENT 软删 → 后 IDENTITY 置 dirty
  const deletedAt = nowISO();
  let dirtyOk = false;
  try {
    await contentDb
      .prepare(`UPDATE posts SET deleted_at = ? WHERE id = ?`)
      .bind(deletedAt, postId)
      .run();
  } catch (err) {
    console.error('[posts] D1 软删 posts 失败', err);
    return c.json(
      { ok: false, error_code: 'POST_INTERNAL', message: '删帖失败，请重试' },
      500,
    );
  }
  try {
    await identityDb
      .prepare(
        `UPDATE system_config SET value = 'true', updated_at = ?
           WHERE key = 'posts_latest_dirty'`,
      )
      .bind(deletedAt)
      .run();
    dirtyOk = true;
  } catch (err) {
    console.error('[posts] dirty 置位失败（软删已生效；waitUntil force 兜底）', err);
  }

  const imageKeys = parsePostImageKeys(row.image_keys);

  c.executionCtx.waitUntil(
    Promise.all([
      // M13-16：删帖属安全路径，不消耗非安全 put 日预算
      refreshPostsCacheIfDirty(c.env, {
        bypassThrottle: true,
        force: !dirtyOk,
        priority: 'security',
      }),
      imageKeys.length > 0 ? releasePostImageKeys(c.env, imageKeys) : Promise.resolve(),
      // M34-OPT-1：删单帖独立 key post:{id}，Worker B O(1) 读取时返回 404
      deletePostIndividual(c.env, postId).catch((err) => {
        console.error('[posts] waitUntil 删除 post:{} KV 失败', err);
      }),
    ]).catch((err) => {
      console.error('[posts] waitUntil 删帖后收尾失败', err);
    }),
  );

  writeCounter(c.env, 'post.delete.success');
  return c.json({ ok: true });
  }),
);
