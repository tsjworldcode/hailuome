// M-REFACTOR-1b：关注
import type { WorkerATransport } from './transport';
import type { WorkerAClient } from './types';
import type {
  FeedAggregateRunResult,
  FollowCreateResponse,
  FollowListResponse,
  FollowPullProbeResult,
  FollowerTokenModeSetting,
  OnlineStatusSnapshot,
  OwnerSessionListResponse,
  OwnerSessionRevokeResult,
} from './types';

/** 关注 API 方法集 */
export function createFollowsApi(t: WorkerATransport): Pick<
  WorkerAClient,
  | 'listFollows'
  | 'createFollow'
  | 'deleteFollow'
  | 'getFollowerTokenMode'
  | 'setFollowerTokenMode'
  | 'createReadMutualProof'
  | 'probeFollowNodePulls'
  | 'getOnlineStatus'
  | 'runFeedAggregateNow'
  | 'listOwnerSessions'
  | 'revokeOwnerSession'
> {
  return {
    async listFollows() {
      const data = await t.callWithJwt<{ data: FollowListResponse }>('/api/follows');
      return data.data;
    },

    async createFollow(nodeUrl, profile) {
      const data = await t.callWithJwt<{ data: FollowCreateResponse }>('/api/follows', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          node_url: nodeUrl,
          ...(profile ? { profile } : {}),
        }),
      });
      return data.data;
    },

    async deleteFollow(nodeUrl) {
      // node_url 含 https:// 与斜杠，必须 encodeURIComponent 整体编码；
      // Worker A 路由用 `:nodeUrl{.+}` 通配 + decodeURIComponent 解码。
      await t.callWithJwt<{ ok: true }>(
        `/api/follows/${encodeURIComponent(nodeUrl)}`,
        { method: 'DELETE' },
      );
    },

    async getFollowerTokenMode() {
      const data = await t.callWithJwt<{ data: FollowerTokenModeSetting }>(
        '/api/node-settings/follower-token-mode',
      );
      return data.data;
    },

    async setFollowerTokenMode(mode) {
      const data = await t.callWithJwt<{ data: FollowerTokenModeSetting }>(
        '/api/node-settings/follower-token-mode',
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode }),
        },
      );
      return data.data;
    },

    async createReadMutualProof(input) {
      const body: Record<string, string> = {
        owner_worker_b_url: input.owner_worker_b_url.trim(),
      };
      if (input.owner_handle?.trim()) {
        body.owner_handle = input.owner_handle.trim().toLowerCase();
      }
      const data = await t.callWithJwt<{
        data: { proof: import('@hailuo/shared-types').ReadMutualProof };
      }>('/api/read/mutual-proof', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return data.data;
    },

    async probeFollowNodePulls() {
      const data = await t.callWithJwt<{ data: FollowPullProbeResult }>(
        '/api/local/follows/pull-probe',
        { method: 'POST' },
      );
      return data.data;
    },

    async getOnlineStatus() {
      const data = await t.callWithJwt<{ data: OnlineStatusSnapshot }>(
        '/api/local/online-status',
      );
      return data.data;
    },

    async runFeedAggregateNow() {
      const data = await t.callWithJwt<{ data: FeedAggregateRunResult }>(
        '/api/local/feed-aggregate/run',
        { method: 'POST' },
      );
      return data.data;
    },

    async listOwnerSessions(input) {
      const q =
        input?.limit != null && Number.isFinite(input.limit)
          ? `?limit=${encodeURIComponent(String(Math.floor(input.limit)))}`
          : '';
      const data = await t.callWithJwt<{ data: OwnerSessionListResponse }>(
        `/api/local/owner-sessions${q}`,
      );
      return data.data;
    },

    async revokeOwnerSession(sessionId) {
      const id = encodeURIComponent(sessionId.trim());
      const data = await t.callWithJwt<{ data: OwnerSessionRevokeResult }>(
        `/api/local/owner-sessions/${id}`,
        { method: 'DELETE' },
      );
      return data.data;
    },
  };
}
