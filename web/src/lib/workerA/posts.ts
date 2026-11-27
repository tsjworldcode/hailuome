// M-REFACTOR-1b：帖子
import type { WorkerATransport } from './transport';
import type { WorkerAClient } from './types';
import type { LocalFeedListResponse, OwnerPost, OwnerPostListResponse, RepostPostResponse } from './types';

/** 帖子 API 方法集 */
export function createPostsApi(t: WorkerATransport): Pick<WorkerAClient, 'getMyPosts' | 'getLocalFeed' | 'createPost' | 'repostPost' | 'deletePost'> {
  return {
    async getMyPosts(params) {
      const qs = t.buildQuery({ before: params?.before });
      const data = await t.callWithJwt<{ data: OwnerPostListResponse }>(
        `/api/local/posts${qs}`,
      );
      return data.data;
    },

    async getLocalFeed(params) {
      const qs = t.buildQuery({ cursor: params?.cursor, limit: params?.limit });
      const data = await t.callWithJwt<{ data: LocalFeedListResponse }>(
        `/api/local/feed${qs}`,
      );
      return data.data;
    },

    async createPost(input) {
      const data = await t.callWithJwt<{ data: OwnerPost }>('/api/posts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: input.content, images: input.images ?? [] }),
      });
      return data.data;
    },

    async repostPost(input) {
      const body: Record<string, string> = {
        origin_node_url: input.origin_node_url.trim(),
        origin_post_id: input.origin_post_id.trim(),
      };
      if (input.origin_author_handle?.trim()) {
        body.origin_author_handle = input.origin_author_handle.trim();
      }
      const data = await t.callWithJwt<{ data: RepostPostResponse }>('/api/posts/repost', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return data.data;
    },

    async deletePost(id) {
      await t.callWithJwt<{ ok: true }>(`/api/posts/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      });
    },

    // ── 关注 ──────────────────────────────────────────────────────
  };
}
