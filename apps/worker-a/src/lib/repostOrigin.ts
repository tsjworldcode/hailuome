/**
 * M9-1：纯转发原帖预检与 origin URL 校验（Worker A 写路径）。
 *
 * - 本节点 origin：直读 D1，避免 Worker A 同账号 fetch Worker B 的 CF 1042 问题。
 * - 跨节点：GET {origin}/posts/:id，401/403 时申请粉丝 Token 重试一次。
 */

import type { Env } from '../env';
import { assertSafePeerWorkerBUrl, isPrivateProofTargetAllowed, normalizeWorkerBOrigin } from '@hailuo/shared-utils';
import {
  isManualRedirectStatus,
  OUTBOUND_PEER_UA,
  resolveSafeOutboundPeerUrl,
} from './fetchOutboundPeer';
import { buildReadMutualProofForOwner } from '../routes/read-mutual-proof';
import { resolveLocalPublicBaseUrl } from './localPublicBaseUrl';
// M-OPT-SPLIT-A6-起步 / A-6-5：posts → CONTENT；users / follows → IDENTITY
import { resolveContentDb, resolveIdentityDb } from '../db/bindings';

const ORIGIN_FETCH_TIMEOUT_MS = 5_000;
const POST_ID_PATTERN = /^post_[a-zA-Z0-9_-]+$/;

export type RepostPrecheckErrorCode =
  | 'ORIGIN_POST_NOT_FOUND'
  | 'ORIGIN_POST_OFFICIAL'
  | 'ORIGIN_POST_IS_REPOST'
  | 'ORIGIN_POST_FORBIDDEN'
  | 'REPOST_ORIGIN_UNREACHABLE';

/** 预检失败：由路由映射为 API 错误响应。 */
export class RepostPrecheckError extends Error {
  readonly errorCode: RepostPrecheckErrorCode;
  readonly httpStatus: number;

  constructor(errorCode: RepostPrecheckErrorCode, message: string, httpStatus: number) {
    super(message);
    this.name = 'RepostPrecheckError';
    this.errorCode = errorCode;
    this.httpStatus = httpStatus;
  }
}

interface RemoteOriginPost {
  id: string;
  content?: string;
  post_kind?: string;
  source_type?: string;
}

interface WorkerBSinglePostResponse {
  ok: boolean;
  data?: RemoteOriginPost;
  error_code?: string;
}

function stripTrailingSlash(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

/** 与 feedFetch 一致：只取 Worker B 根 origin。 */
function resolveWorkerBBaseUrl(nodeUrl: string): string {
  const trimmed = stripTrailingSlash(nodeUrl);
  if (!trimmed) return trimmed;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return trimmed;
    }
    return parsed.origin;
  } catch {
    return trimmed;
  }
}

/** 拒绝 Worker A 红线 URL（dev 8787、典型写层路径）。 */
function isLikelyWorkerAUrl(raw: string): boolean {
  try {
    const parsed = new URL(raw);
    if (parsed.port === '8787') return true;
    if (/worker-a/i.test(parsed.hostname)) return true;
    const path = parsed.pathname.replace(/\/+$/, '') || '/';
    if (path.startsWith('/api/local') || path.startsWith('/auth/')) return true;
  } catch {
    return false;
  }
  return false;
}

export function validateRepostOriginNodeUrl(raw: unknown, env?: Env):
  | { ok: true; normalized: string }
  | { ok: false; error_code: string; message: string } {
  if (typeof raw !== 'string' || !raw.trim()) {
    return { ok: false, error_code: 'ORIGIN_NODE_URL_REQUIRED', message: 'origin_node_url 不能为空' };
  }
  const normalized = normalizeWorkerBOrigin(raw);
  const safe = assertSafePeerWorkerBUrl(normalized, {
    allowPrivate: isPrivateProofTargetAllowed(env),
  });
  if (!safe.ok) {
    return { ok: false, error_code: 'ORIGIN_NODE_URL_INVALID', message: 'origin_node_url 须为允许的公开 https 地址' };
  }
  if (isLikelyWorkerAUrl(safe.url.toString())) {
    return { ok: false, error_code: 'ORIGIN_NODE_URL_INVALID', message: 'origin_node_url 不能为 Worker A 地址' };
  }
  return { ok: true, normalized: resolveWorkerBBaseUrl(safe.url.origin) };
}

export function validateRepostOriginPostId(raw: unknown):
  | { ok: true; postId: string }
  | { ok: false; error_code: string; message: string } {
  if (typeof raw !== 'string' || !raw.trim()) {
    return { ok: false, error_code: 'ORIGIN_POST_ID_INVALID', message: 'origin_post_id 不能为空' };
  }
  const postId = raw.trim();
  if (!POST_ID_PATTERN.test(postId)) {
    return { ok: false, error_code: 'ORIGIN_POST_ID_INVALID', message: 'origin_post_id 格式无效' };
  }
  return { ok: true, postId };
}

function assertOriginPostAllowed(post: RemoteOriginPost): void {
  if (post.source_type === 'official') {
    throw new RepostPrecheckError('ORIGIN_POST_OFFICIAL', '官方公告不可转发', 403);
  }
  if (post.post_kind === 'repost') {
    throw new RepostPrecheckError('ORIGIN_POST_IS_REPOST', '不能转发一条转发帖', 400);
  }
  // 远程节点尚未透传 post_kind 时，空正文视为转发帖（原创帖发帖接口禁止空 content）
  const hasContent = typeof post.content === 'string' && post.content.length > 0;
  if (!hasContent && post.post_kind !== 'original') {
    throw new RepostPrecheckError('ORIGIN_POST_IS_REPOST', '不能转发一条转发帖', 400);
  }
}

/** 本节点 D1 预检（origin 等于本站公开基址）。 */
async function precheckLocalOriginPost(env: Env, originPostId: string): Promise<void> {
  // M-OPT-SPLIT-A6-起步：posts 表在 CONTENT_DB · migration 0001/0038；
  // 本函数单表单库按表真切无副作用；follows / users 走 IDENTITY_DB 的部分
  // （resolveRepostAuthorHandle 中 users / follows 读）留 A-6-5。
  const contentDb = resolveContentDb(env);
  const row = await contentDb
    .prepare(
      `SELECT id, post_kind, content, deleted_at
         FROM posts
        WHERE id = ?
        LIMIT 1`,
    )
    .bind(originPostId)
    .first<{ id: string; post_kind: string | null; content: string; deleted_at: string | null }>()
    .catch(() => null);

  if (!row || row.deleted_at) {
    throw new RepostPrecheckError('ORIGIN_POST_NOT_FOUND', '原帖不存在或已删除', 404);
  }
  assertOriginPostAllowed({
    id: row.id,
    content: row.content,
    post_kind: row.post_kind ?? 'original',
  });
}

async function fetchRemoteFollowerToken(
  env: Env,
  targetWorkerBUrl: string,
  followerNodeUrl: string,
  followerHandle?: string,
): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ORIGIN_FETCH_TIMEOUT_MS);
  const base = resolveWorkerBBaseUrl(targetWorkerBUrl);
  try {
    const body: Record<string, unknown> = {
      follower_node_url: stripTrailingSlash(followerNodeUrl),
    };
    if (followerHandle) {
      body.follower_handle = followerHandle;
    }
    const tokenUrl = resolveSafeOutboundPeerUrl(env, `${base}/api/follower-tokens`);
    if (!tokenUrl) return null;
    let res = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': OUTBOUND_PEER_UA,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
      redirect: 'manual',
    });
    if (isManualRedirectStatus(res.status)) return null;
    if (res.ok) {
      const json = await res.json() as { ok?: boolean; data?: { token?: string } };
      const token = json.ok && typeof json.data?.token === 'string' ? json.data.token : '';
      return token || null;
    }
    if (res.status === 403) {
      let errorCode = '';
      try {
        const errJson = await res.json() as { error_code?: string };
        errorCode = typeof errJson.error_code === 'string' ? errJson.error_code : '';
      } catch {
        errorCode = '';
      }
      if (errorCode === 'NOT_MUTUAL_FOLLOW') {
        const proof = await buildReadMutualProofForOwner(env, base);
        if (proof) {
          body.read_mutual_proof = proof;
          res = await fetch(tokenUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Accept: 'application/json',
              'User-Agent': OUTBOUND_PEER_UA,
            },
            body: JSON.stringify(body),
            signal: controller.signal,
            redirect: 'manual',
          });
          if (isManualRedirectStatus(res.status)) return null;
          if (res.ok) {
            const json = await res.json() as { ok?: boolean; data?: { token?: string } };
            const token = json.ok && typeof json.data?.token === 'string' ? json.data.token : '';
            return token || null;
          }
        }
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchRemoteOriginPost(
  env: Env,
  originNodeUrl: string,
  originPostId: string,
): Promise<RemoteOriginPost> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ORIGIN_FETCH_TIMEOUT_MS);
  const base = resolveWorkerBBaseUrl(originNodeUrl);
  const postsUrl = resolveSafeOutboundPeerUrl(env, `${base}/posts/${encodeURIComponent(originPostId)}`);
  let tokenRetried = false;

  const doFetch = (token?: string) => {
    if (!postsUrl) return Promise.resolve(null);
    return fetch(postsUrl, {
      headers: {
        Accept: 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        'User-Agent': OUTBOUND_PEER_UA,
      },
      signal: controller.signal,
      redirect: 'manual',
    });
  };

  try {
    let res = await doFetch();
    if (!res || isManualRedirectStatus(res.status)) {
      throw new RepostPrecheckError('REPOST_ORIGIN_UNREACHABLE', '原帖节点不可达', 502);
    }

    if ((res.status === 401 || res.status === 403) && !tokenRetried) {
      const identityDb = resolveIdentityDb(env);
      const ownerRow = await identityDb
        .prepare(`SELECT handle FROM users LIMIT 1`)
        .first<{ handle: string }>()
        .catch(() => null);
      const token = await fetchRemoteFollowerToken(
        env,
        base,
        await resolveLocalPublicBaseUrl(env),
        ownerRow?.handle,
      );
      tokenRetried = Boolean(token);
      if (token) {
        const retried = await doFetch(token);
        if (!retried || isManualRedirectStatus(retried.status)) {
          throw new RepostPrecheckError('REPOST_ORIGIN_UNREACHABLE', '原帖节点不可达', 502);
        }
        res = retried;
      }
    }

    if (res.status === 404) {
      throw new RepostPrecheckError('ORIGIN_POST_NOT_FOUND', '原帖不存在或已删除', 404);
    }
    if (res.status === 403) {
      throw new RepostPrecheckError('ORIGIN_POST_FORBIDDEN', '无权访问原帖', 403);
    }
    if (!res.ok) {
      throw new RepostPrecheckError(
        'REPOST_ORIGIN_UNREACHABLE',
        `原帖节点不可达（HTTP ${res.status}）`,
        502,
      );
    }

    const json = await res.json() as WorkerBSinglePostResponse;
    if (!json.ok || !json.data?.id) {
      throw new RepostPrecheckError('REPOST_ORIGIN_UNREACHABLE', '原帖节点响应格式异常', 502);
    }
    return json.data;
  } catch (err) {
    if (err instanceof RepostPrecheckError) throw err;
    if (err instanceof Error && err.name === 'AbortError') {
      throw new RepostPrecheckError('REPOST_ORIGIN_UNREACHABLE', '原帖节点请求超时', 502);
    }
    throw new RepostPrecheckError('REPOST_ORIGIN_UNREACHABLE', '原帖节点不可达', 502);
  } finally {
    clearTimeout(timer);
  }
}

/** 预检原帖是否可转发（本节点 D1 或跨节点 fetch）。 */
export async function precheckRepostOrigin(
  env: Env,
  normalizedOriginUrl: string,
  originPostId: string,
): Promise<void> {
  const ownWorkerB = await resolveLocalPublicBaseUrl(env);
  if (ownWorkerB && normalizedOriginUrl === ownWorkerB) {
    await precheckLocalOriginPost(env, originPostId);
    return;
  }

  const post = await fetchRemoteOriginPost(env, normalizedOriginUrl, originPostId);
  assertOriginPostAllowed(post);
}

/** 解析展示用原作者 handle（客户端未传时从 D1 回落）。 */
export async function resolveRepostAuthorHandle(
  env: Env,
  normalizedOriginUrl: string,
  clientHandle: unknown,
): Promise<string> {
  const trimmed = typeof clientHandle === 'string' ? clientHandle.trim().replace(/^@+/, '') : '';
  if (trimmed) return trimmed.slice(0, 64);

  const ownWorkerB = await resolveLocalPublicBaseUrl(env);
  if (ownWorkerB && normalizedOriginUrl === ownWorkerB) {
    const identityDb = resolveIdentityDb(env);
    const row = await identityDb
      .prepare(`SELECT handle FROM users LIMIT 1`)
      .first<{ handle: string }>()
      .catch(() => null);
    return row?.handle?.trim() || 'unknown';
  }

  const identityDb = resolveIdentityDb(env);
  const follow = await identityDb
    .prepare(
      `SELECT followed_handle FROM follows WHERE follower_node_url = ? LIMIT 1`,
    )
    .bind(normalizedOriginUrl)
    .first<{ followed_handle: string | null }>()
    .catch(() => null);
  const fromFollow = follow?.followed_handle?.trim();
  return fromFollow || 'unknown';
}

/** 是否已有有效转发（唯一索引冲突前快速判定）。 */
export async function findActiveRepostId(
  env: Env,
  normalizedOriginUrl: string,
  originPostId: string,
): Promise<string | null> {
  // M-OPT-SPLIT-A6-起步：posts 单表单库 → resolveContentDb(env)。
  const contentDb = resolveContentDb(env);
  const row = await contentDb
    .prepare(
      `SELECT id FROM posts
        WHERE post_kind = 'repost'
          AND repost_of_node_url = ?
          AND repost_of_post_id = ?
          AND deleted_at IS NULL
        LIMIT 1`,
    )
    .bind(normalizedOriginUrl, originPostId)
    .first<{ id: string }>()
    .catch(() => null);
  return row?.id ?? null;
}
