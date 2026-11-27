/**
 * 关注/取关接口（M4-0）。
 *
 * followsApp 挂在 /api/follows/*，JWT 鉴权由 index.ts 的 app.use('/api/follows/*') 保障。
 *
 * GET  /api/follows            — 查关注列表（D1 直读）
 * POST /api/follows            — 关注（body: {node_url}，D1 INSERT，禁 KV.put）
 * DELETE /api/follows/:nodeUrl — 取关（:nodeUrl URL-encoded，D1 DELETE，禁 KV.put）
 *
 * ⚠️ F-01 红线：关注/取关不允许任何 KV.put（D1 写即可）。
 */

import { resolveIdentityDb } from '../db/bindings';
import { Hono } from 'hono';
import type { Env, AppVariables } from '../env';
import { assertSafePeerWorkerBUrl, generateId, isPrivateProofTargetAllowed, nowISO } from '@hailuo/shared-utils';
import { fetchAndAggregateFeed } from '../services/feed';
import { upsertLookupCacheEntry } from '../lib/localNodeResolve';
import { resolveLocalPublicBaseUrl } from '../lib/localPublicBaseUrl';
import { cleanupFollowCachesAfterUnfollow } from '../lib/followCacheCleanup';
import { fetchTargetUserProfile } from '../lib/friendRequestOutboxFetcher';

type AppEnv = { Bindings: Env; Variables: AppVariables };

export const followsApp = new Hono<AppEnv>();

interface FollowProfileInput {
  handle?: string;
  display_name?: string;
  avatar_key?: string;
  worker_b_url?: string;
  pubkey?: string;
}

interface CachedFollowProfile {
  handle?: string;
  display_name?: string;
  avatar_key?: string;
  worker_b_url?: string;
  user_id?: string;
  registry_status?: string;
  health_status?: string;
  pubkey_fingerprint?: string;
}

function optionalString(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, maxLength);
}

function normalizeFollowProfile(body: { profile?: unknown; pubkey?: unknown }, nodeUrl: string): FollowProfileInput {
  const raw = body.profile;
  const profile = (raw && typeof raw === 'object') ? (raw as Record<string, unknown>) : {};
  const workerBUrl = optionalString(profile.worker_b_url, 2048) || nodeUrl;
  const rawPubkey = optionalString(profile.pubkey, 64) || optionalString(body.pubkey, 64);
  const pubkey = /^[0-9a-fA-F]{64}$/.test(rawPubkey) ? rawPubkey.toLowerCase() : '';
  return {
    handle: optionalString(profile.handle, 64),
    display_name: optionalString(profile.display_name, 100),
    avatar_key: optionalString(profile.avatar_key, 256),
    worker_b_url: workerBUrl,
    pubkey: pubkey || undefined,
  };
}

function readCachedFollowProfile(raw: string | null): CachedFollowProfile {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      handle: optionalString(parsed.handle, 64),
      display_name: optionalString(parsed.display_name, 100),
      avatar_key: optionalString(parsed.avatar_key, 256),
      worker_b_url: optionalString(parsed.worker_b_url, 2048) || optionalString(parsed.node_url, 2048),
      user_id: optionalString(parsed.user_id, 64),
      registry_status: optionalString(parsed.registry_status, 32),
      health_status: optionalString(parsed.health_status, 32),
      pubkey_fingerprint: optionalString(parsed.pubkey_fingerprint, 32),
    };
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// GET /api/follows — 查关注列表（D1 直读，按 followed_at DESC）
// ---------------------------------------------------------------------------

followsApp.get('/', async (c) => {
  let rows: Array<{
    id: string;
    follower_node_url: string;
    followed_at: string;
    last_active: string | null;
    fail_count: number;
    followed_handle: string | null;
    followed_display_name: string | null;
    followed_avatar_key: string | null;
    followed_worker_b_url: string | null;
    followed_pubkey: string | null;
    cached_profile_json: string | null;
  }>;

  try {
    const result = await resolveIdentityDb(c.env)
      .prepare(
        `SELECT f.id, f.follower_node_url, f.followed_at, f.last_active, f.fail_count,
                f.followed_handle, f.followed_display_name, f.followed_avatar_key, f.followed_worker_b_url, f.followed_pubkey,
                (
                  SELECT ce.response_json
                    FROM cache_entries ce
                   WHERE ce.node_url = f.follower_node_url OR ce.worker_b_url = f.follower_node_url
                   ORDER BY ce.fetched_at DESC
                   LIMIT 1
                ) AS cached_profile_json
           FROM follows f
          ORDER BY f.followed_at DESC`,
      )
      .all<{
        id: string;
        follower_node_url: string;
        followed_at: string;
        last_active: string | null;
        fail_count: number;
        followed_handle: string | null;
        followed_display_name: string | null;
        followed_avatar_key: string | null;
        followed_worker_b_url: string | null;
        followed_pubkey: string | null;
        cached_profile_json: string | null;
      }>();
    rows = result.results ?? [];
  } catch (err) {
    console.error('[follows] 查询关注列表失败', err);
    return c.json(
      { ok: false, error_code: 'FOLLOW_INTERNAL', message: '查询关注列表失败，请重试' },
      500,
    );
  }

  const items = rows.map((r: NonNullable<(typeof rows)[number]>) => {
    if (!r) return undefined;
    // 旧关注记录可能没有资料字段；优先从 lookup 缓存补齐，避免列表只剩 URL。
    const cached = readCachedFollowProfile(r.cached_profile_json);
    const handle = r.followed_handle || cached.handle || '';
    const workerBUrl = r.followed_worker_b_url || cached.worker_b_url || r.follower_node_url;
    return {
      id: r.id,
      node_url: r.follower_node_url,
      handle,
      display_name: r.followed_display_name || cached.display_name || handle,
      avatar_key: r.followed_avatar_key || cached.avatar_key || '',
      worker_b_url: workerBUrl,
      user_id: cached.user_id || '',
      registry_status: cached.registry_status || '',
      health_status: cached.health_status || '',
      pubkey_fingerprint: cached.pubkey_fingerprint || '',
      pubkey: r.followed_pubkey || '',
      followed_at: r.followed_at,
      last_active: r.last_active ?? null,
      fail_count: r.fail_count,
    };
  }).filter(Boolean);

  return c.json({ ok: true, data: { items, total: items.length } });
});

// ---------------------------------------------------------------------------
// POST /api/follows — 关注一个节点（D1 INSERT，禁 KV.put）
// ---------------------------------------------------------------------------

followsApp.post('/', async (c) => {
  // 解析请求体
  let body: { node_url?: unknown; profile?: unknown; pubkey?: unknown };
  try {
    body = await c.req.json() as { node_url?: unknown; profile?: unknown; pubkey?: unknown };
  } catch {
    return c.json(
      { ok: false, error_code: 'INVALID_BODY', message: '请求体必须为 JSON' },
      400,
    );
  }

  const nodeUrl = typeof body.node_url === 'string' ? body.node_url.trim().replace(/\/+$/, '') : '';
  if (!nodeUrl) {
    return c.json(
      { ok: false, error_code: 'NODE_URL_REQUIRED', message: 'node_url 不能为空' },
      400,
    );
  }

  // 必须是允许的公开 https 地址（协议、端口、私网主机名）。站主会话被诱导时也不把脏地址写进关注表。
  const safePeer = assertSafePeerWorkerBUrl(nodeUrl, {
    allowPrivate: isPrivateProofTargetAllowed(c.env),
  });
  if (!safePeer.ok) {
    return c.json(
      { ok: false, error_code: 'NODE_URL_INVALID', message: 'node_url 须为允许的公开 https 地址' },
      400,
    );
  }

  // 防止关注自己（与本节点公开基址相同，忽略尾斜杠差异；D1 SSOT）
  const ownWorkerB = await resolveLocalPublicBaseUrl(c.env);
  if (ownWorkerB && nodeUrl === ownWorkerB) {
    return c.json(
      { ok: false, error_code: 'CANNOT_FOLLOW_SELF', message: '不能关注自己' },
      400,
    );
  }

  const id = generateId('follow');
  const followedAt = nowISO();
  const profile = normalizeFollowProfile(body, nodeUrl);

  try {
    await resolveIdentityDb(c.env)
      .prepare(
        `INSERT INTO follows
           (id, follower_node_url, followed_at,
            followed_handle, followed_display_name, followed_avatar_key, followed_worker_b_url, followed_pubkey)
         VALUES (?, ?, ?, NULLIF(?, ''), ?, ?, ?, NULLIF(?, ''))`,
      )
      .bind(
        id,
        nodeUrl,
        followedAt,
        profile.handle ?? '',
        profile.display_name ?? '',
        profile.avatar_key ?? '',
        profile.worker_b_url ?? nodeUrl,
        profile.pubkey ?? '',
      )
      .run();
  } catch (err) {
    // UNIQUE 约束冲突 → 已关注
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('UNIQUE') || message.includes('unique')) {
      return c.json(
        { ok: false, error_code: 'ALREADY_FOLLOWING', message: '已关注该节点' },
        409,
      );
    }
    console.error('[follows] INSERT 失败', err);
    return c.json(
      { ok: false, error_code: 'FOLLOW_INTERNAL', message: '关注操作失败，请重试' },
      500,
    );
  }

  // M-OPT-1c：有 handle 时预热 cache_entries，后续精确 lookup 走 L1 不计配额
  if (profile.handle) {
    c.executionCtx.waitUntil(
      upsertLookupCacheEntry(c.env, {
        handle: profile.handle,
        node_url: nodeUrl,
        worker_b_url: profile.worker_b_url ?? nodeUrl,
      }),
    );
  }

  // SEC-AUDIT-2026-10-13：请求体未带 pubkey 时异步取档回填 pin（不阻塞关注主路径）
  // SEC-AUDIT-2026-10-18：禁止回退本站 BOOTSTRAP_HANDLE——那是站主自己的短名，拿去对端
  // GET /users/:handle 会 404 或钉到同名路人公钥；handle 未知则留空，等前端带 pubkey / 后续验签路径再补。
  if (!profile.pubkey) {
    const pinHandle = (profile.handle ?? '').trim().toLowerCase();
    if (pinHandle) {
      c.executionCtx.waitUntil(
        (async () => {
          try {
            const peer = await fetchTargetUserProfile(nodeUrl, pinHandle, c.env);
            const pubkey = peer?.pubkey?.trim().toLowerCase() ?? '';
            if (!/^[0-9a-f]{64}$/.test(pubkey)) return;
            await resolveIdentityDb(c.env)
              .prepare(
                `UPDATE follows
                    SET followed_pubkey = ?
                  WHERE id = ?
                    AND (followed_pubkey IS NULL OR followed_pubkey = '')`,
              )
              .bind(pubkey, id)
              .run();
          } catch (err) {
            console.warn('[follows] 异步回填 followed_pubkey 失败', err);
          }
        })(),
      );
    }
  }

  // 新关注成功后立即异步聚合一次，避免用户必须等待下一轮 Cron 才看到对方帖子。
  c.executionCtx.waitUntil(
    fetchAndAggregateFeed(c.env).catch((err) => {
      console.error('[follows] initial feed aggregate after follow failed', err);
    }),
  );

  return c.json({
    ok: true,
    data: {
      id,
      node_url: nodeUrl,
      handle: profile.handle ?? '',
      display_name: profile.display_name ?? profile.handle ?? '',
      avatar_key: profile.avatar_key ?? '',
      worker_b_url: profile.worker_b_url ?? nodeUrl,
      pubkey: profile.pubkey ?? '',
      followed_at: followedAt,
    },
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/follows/:nodeUrl — 取关（:nodeUrl URL-encoded，D1 DELETE）
// ---------------------------------------------------------------------------

followsApp.delete('/:nodeUrl{.+}', async (c) => {
  // Hono 的 :nodeUrl{.+} 通配符可匹配含斜杠的路径段
  const encoded = c.req.param('nodeUrl');
  // 路径参数可能已被 Hono 部分解码，先 decodeURIComponent 确保完整解码
  let nodeUrl: string;
  try {
    nodeUrl = decodeURIComponent(encoded);
  } catch {
    nodeUrl = encoded;
  }

  // M5-P6 优化：原实现先 SELECT 检查存在 → 再 DELETE，两次 RTT。
  // 改为「直接 DELETE + meta.changes 判断」一次 RTT：
  //   - meta.changes === 0 → 不存在该关注关系，返回 404 FOLLOW_NOT_FOUND
  //   - meta.changes >= 1  → 删除成功
  //   - 异常             → 返回 500 FOLLOW_INTERNAL
  // 禁 KV.put（F-01 红线）。
  //
  // M-F2：用 RETURNING 一并取回 `followed_worker_b_url`——它是「清 feed_cache
  // 的另一个候选键」（迁址后可能与 follower_node_url 不同）。行删掉后就取不到了，
  // 故与 DELETE 同一条语句完成，仍是 1 次 RTT。
  let result: D1Result;
  let followedWorkerBUrl: string | null = null;
  try {
    result = await resolveIdentityDb(c.env)
      .prepare(
        `DELETE FROM follows
          WHERE follower_node_url = ?
          RETURNING followed_worker_b_url`,
      )
      .bind(nodeUrl)
      .run();
    const returned = result.results?.[0] as { followed_worker_b_url?: string | null } | undefined;
    if (returned?.followed_worker_b_url) {
      followedWorkerBUrl = returned.followed_worker_b_url;
    }
  } catch (err) {
    console.error('[follows] DELETE 失败', err);
    return c.json(
      { ok: false, error_code: 'FOLLOW_INTERNAL', message: '取关操作失败，请重试' },
      500,
    );
  }

  // D1 meta.changes 反映本次 SQL 实际影响行数（参考 Cloudflare D1 文档）。
  // changes 为 0 表示 WHERE 未命中任何记录。
  const changes = result.meta?.changes ?? 0;
  if (changes === 0) {
    return c.json(
      { ok: false, error_code: 'FOLLOW_NOT_FOUND', message: '未关注该节点或不存在' },
      404,
    );
  }

  // M-F2：清缓存（feed_cache + cache_entries），并置 dirty 标记交 Cron 刷 KV。
  //   - 跨 D1 **串行**（GOVERNANCE → IDENTITY），禁 JOIN / 禁合并 batch
  //   - HTTP 路径**零 KV.put**（F-01）
  //   - fail-soft：清理失败不阻断取关（关注关系已删是既成事实；
  //     读时还有第二道防线 `queryLocalFeed` 可见性过滤）
  const cleanup = await cleanupFollowCachesAfterUnfollow(c.env, {
    followerNodeUrl: nodeUrl,
    followedWorkerBUrl,
  });
  if (cleanup.errors.length > 0) {
    console.warn('[follows] M-F2 取关缓存清理部分失败（不影响取关结果）', cleanup.errors);
  } else {
    console.log(
      `[follows] M-F2 取关缓存清理完成：feed_cache=${cleanup.feedCacheDeleted} ` +
        `cache_entries=${cleanup.cacheEntriesDeleted}`,
    );
  }

  return c.json({ ok: true });
});
