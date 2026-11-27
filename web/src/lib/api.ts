// M7-1：Worker B 公开 API 客户端
//
// Worker B 是粉丝（含本人）访问数据的唯一公开入口（per §F-02）。
// 本模块仅访问 PUBLIC_WORKER_B_URL 环境变量；任何 Worker A 调用都在 workerA.ts 内。
//
// 设计要点：
// - 自动注入粉丝 Token（除拿 Token 接口本身），由 auth.ts 的 `ensureFollowerToken` 提供
// - 统一错误处理：非 2xx → 抛 ApiError；网络层失败 → 抛 ApiError(status=0)
// - 响应形态契约固定：成功体一律 `{ ok: true, data: ... }`，失败体一律 `{ ok: false, error_code, message }`
// - 路径来自 docs/worker-b-api.md，与 apps/worker-b/src/index.ts 实装对齐

import { ApiError } from './errors';
import {
  ensureFollowerToken,
  getOwnerJwt,
  getWorkerAUrl,
  type IssueFollowerTokenResponse,
  stripTrailingSlash,
} from './auth';
import { createWorkerAClient, type InteractionEnvelope } from './workerA';

// =====================================================================
// 响应类型
// =====================================================================

/** 列表分页响应通用形态（per worker-b-api.md） */
export interface PaginatedResponse<T> {
  readonly items: readonly T[];
  readonly has_more: boolean;
  readonly cursor: string | null;
}

/** 帖子摘要（GET /posts、GET /posts/:id 返回项） */
export interface PostItem {
  readonly id: string;
  readonly node_url?: string;
  readonly post_id?: string;
  readonly source_type?: 'official';
  /** Worker B 返回的作者 handle（本节点帖子 / 官方公告都可能有） */
  readonly author_handle?: string;
  readonly content: string;
  readonly sig: string;
  readonly image_urls: readonly string[];
  readonly created_at: string;
  /** M9-1：原创 / 纯转发 */
  readonly post_kind?: 'original' | 'repost';
  readonly repost_of?: {
    readonly node_url: string;
    readonly post_id: string;
    readonly author_handle: string;
  } | null;
}

/** Feed 项（GET /feed 返回项，多了 node_url + post_id） */
export interface FeedItem {
  readonly id: string;
  readonly node_url: string;
  readonly post_id: string;
  readonly source_type?: 'official';
  /** 关注对象注册 handle（Cron 聚合写入；缺失时前端从 node_url 派生占位） */
  readonly author_handle?: string;
  readonly content: string;
  readonly sig: string;
  readonly image_urls: readonly string[];
  readonly created_at: string;
  /** M9-1-4：纯转发 */
  readonly post_kind?: 'original' | 'repost';
  readonly repost_of?: {
    readonly node_url: string;
    readonly post_id: string;
    readonly author_handle: string;
  } | null;
}

/** 公开用户资料（GET /users/:handle） */
export interface PublicUserProfile {
  readonly handle: string;
  readonly pubkey: string;
  readonly dm_pubkey?: string;
  readonly worker_b_url: string;
}

/** 健康检查响应 */
export interface HealthResponse {
  readonly ok: true;
  readonly service: string;
  readonly version: string;
}

export interface InteractionSummary {
  readonly post_id: string;
  readonly like_count: number;
  readonly reply_count: number;
  readonly liked_by_me: boolean;
}

export interface PostReply {
  readonly id: string;
  readonly post_id: string;
  readonly actor_handle: string;
  readonly actor_node_url: string;
  readonly content: string;
  readonly created_at: string;
}

// =====================================================================
// 客户端构造
// =====================================================================

export interface WorkerBClientOptions {
  /** Worker B 基址；约定从 `import.meta.env.PUBLIC_WORKER_B_URL` 取 */
  readonly baseUrl: string;
  /**
   * 当前粉丝节点 URL；通常等于 `window.location.origin`，
   * 但 M7 阶段允许用户在设置页覆盖（例如本地开发跨域调试）。
   */
  readonly followerNodeUrl: string;
  /** 粉丝节点站主注册 handle；签发 Token 时写入 fan 字段 */
  readonly followerHandle?: string | null;
  /**
   * 可选的 fetch 实现注入；测试时可传入 mock。
   * 不传则使用全局 `fetch`。
   */
  readonly fetchFn?: typeof fetch;
}

export interface WorkerBClient {
  /** 健康检查（无鉴权） */
  health(): Promise<HealthResponse>;
  /** 查询公开用户资料（无鉴权） */
  getUserByHandle(handle: string): Promise<PublicUserProfile>;
  /**
   * 显式签发粉丝 Token（无鉴权）。
   * 一般无需直接调用——其他读接口会自动通过 `ensureFollowerToken` 取 Token；
   * 暴露此方法供 M7-1 测试与未来"强制刷新 Token"运维场景使用。
   */
  issueFollowerToken(followerNodeUrl?: string): Promise<IssueFollowerTokenResponse>;
  /** 取帖子列表（带 Token） */
  getPosts(params?: { cursor?: string; limit?: number }): Promise<PaginatedResponse<PostItem>>;
  /** 取单条帖子（带 Token） */
  getPostById(id: string): Promise<PostItem>;
  /** 取 Feed（带 Token） */
  getFeed(params?: { cursor?: string; limit?: number }): Promise<PaginatedResponse<FeedItem>>;
  getInteractionSummary(postId: string): Promise<InteractionSummary>;
  likePost(postId: string): Promise<InteractionSummary>;
  unlikePost(postId: string): Promise<InteractionSummary>;
  replyToPost(postId: string, content: string): Promise<{ reply: PostReply; summary: InteractionSummary }>;
  listReplies(postId: string, params?: { limit?: number }): Promise<{ items: readonly PostReply[] }>;
  deliverDmEnvelope(envelope: import('./workerA').DmEnvelope): Promise<{ message_id: string }>;
  /**
   * 拼出图片 URL（不发起请求）。
   * /img/:key 端点本身要求 Token，但浏览器 `<img>` 标签无法直接带 Authorization 头——
   * 图片访问的 token 注入由 M7-6 PWA Service Worker 拦截实装；M7-1 本步仅返回 URL。
   */
  imageUrl(key: string): string;
}

export function createWorkerBClient(opts: WorkerBClientOptions): WorkerBClient {
  const baseUrl = stripTrailingSlash(opts.baseUrl);
  const followerNodeUrl = opts.followerNodeUrl;
  const followerHandle = opts.followerHandle ?? null;
  const fetchFn: typeof fetch = opts.fetchFn ?? globalThis.fetch.bind(globalThis);

  async function callPublic<T>(path: string, init?: RequestInit): Promise<T> {
    return requestJson<T>(fetchFn, `${baseUrl}${path}`, init);
  }

  async function callWithToken<T>(path: string, init?: RequestInit): Promise<T> {
    const token = await ensureFollowerToken(baseUrl, followerNodeUrl, followerHandle);
    const headers = new Headers(init?.headers);
    headers.set('Authorization', `Bearer ${token}`);
    return requestJson<T>(fetchFn, `${baseUrl}${path}`, { ...init, headers });
  }

  async function signInteractionEnvelope(
    type: InteractionEnvelope['type'],
    postId: string,
    content?: string,
    replyId?: string,
  ): Promise<InteractionEnvelope> {
    const workerAUrl = getWorkerAUrl();
    if (!workerAUrl) {
      throw new ApiError(503, { error_code: 'OWNER_ENDPOINT_MISSING', message: '写层地址未配置，无法签发互动签名' });
    }
    const client = createWorkerAClient({ baseUrl: workerAUrl, getJwt: getOwnerJwt });
    return client.signInteractionEnvelope({
      type,
      post_id: postId,
      content,
      reply_id: replyId,
    });
  }

  return {
    async health() {
      const data = await callPublic<HealthResponse>('/health');
      return data;
    },
    async getUserByHandle(handle: string) {
      const data = await callPublic<{ data: PublicUserProfile }>(
        `/users/${encodeURIComponent(handle)}`,
      );
      return data.data;
    },
    async issueFollowerToken(overrideFollowerNodeUrl?: string) {
      const bodyPayload: Record<string, string> = {
        follower_node_url: overrideFollowerNodeUrl ?? followerNodeUrl,
      };
      if (followerHandle) {
        bodyPayload.follower_handle = followerHandle;
      }
      const body = JSON.stringify(bodyPayload);
      const envelope = await callPublic<{ ok?: boolean; data?: IssueFollowerTokenResponse }>(
        '/api/follower-tokens',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
        },
      );
      if (envelope && typeof envelope === 'object' && envelope.data) {
        return envelope.data;
      }
      return envelope as unknown as IssueFollowerTokenResponse;
    },
    async getPosts(params) {
      const qs = buildQuery({ cursor: params?.cursor, limit: params?.limit });
      const data = await callWithToken<{ data: PaginatedResponse<PostItem> }>(
        `/posts${qs}`,
      );
      return data.data;
    },
    async getPostById(id: string) {
      const data = await callWithToken<{ data: PostItem }>(
        `/posts/${encodeURIComponent(id)}`,
      );
      return data.data;
    },
    async getFeed(params) {
      const qs = buildQuery({ cursor: params?.cursor, limit: params?.limit });
      const data = await callWithToken<{ data: PaginatedResponse<FeedItem> }>(
        `/feed${qs}`,
      );
      return data.data;
    },
    async getInteractionSummary(postId: string) {
      const data = await callWithToken<{ data: InteractionSummary }>(
        `/interactions/posts/${encodeURIComponent(postId)}/summary`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
      );
      return data.data;
    },
    async likePost(postId: string) {
      const envelope = await signInteractionEnvelope('like', postId);
      const data = await callWithToken<{ data: InteractionSummary }>(
        `/interactions/posts/${encodeURIComponent(postId)}/like`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ envelope }),
        },
      );
      return data.data;
    },
    async unlikePost(postId: string) {
      const envelope = await signInteractionEnvelope('unlike', postId);
      const data = await callWithToken<{ data: InteractionSummary }>(
        `/interactions/posts/${encodeURIComponent(postId)}/like`,
        {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ envelope }),
        },
      );
      return data.data;
    },
    async replyToPost(postId: string, content: string) {
      const envelope = await signInteractionEnvelope('reply', postId, content);
      const data = await callWithToken<{ data: { reply: PostReply; summary: InteractionSummary } }>(
        `/interactions/posts/${encodeURIComponent(postId)}/replies`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ envelope, content }),
        },
      );
      return data.data;
    },
    async listReplies(postId: string, params) {
      const qs = buildQuery({ limit: params?.limit });
      const data = await callWithToken<{ data: { items: readonly PostReply[] } }>(
        `/interactions/posts/${encodeURIComponent(postId)}/replies${qs}`,
      );
      return data.data;
    },
    async deliverDmEnvelope(envelope) {
      const data = await callPublic<{ data: { message_id: string } }>(
        '/dm/inbox',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ envelope }),
        },
      );
      return data.data;
    },
    imageUrl(key: string) {
      return `${baseUrl}/img/${encodeURIComponent(key)}`;
    },
  };
}

// =====================================================================
// 内部工具
// =====================================================================

async function requestJson<T>(
  fetchFn: typeof fetch,
  url: string,
  init?: RequestInit,
): Promise<T> {
  let resp: Response;
  try {
    resp = await fetchFn(url, init);
  } catch {
    throw new ApiError(0, { error_code: 'INTERNAL_ERROR' }, '网络异常，请检查连接');
  }

  const text = await resp.text();
  let parsed: unknown = null;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }

  if (!resp.ok) {
    const body = (parsed ?? null) as { error_code?: string; message?: string } | null;
    throw new ApiError(resp.status, body);
  }
  return parsed as T;
}

function buildQuery(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  const qs = search.toString();
  return qs.length > 0 ? `?${qs}` : '';
}
