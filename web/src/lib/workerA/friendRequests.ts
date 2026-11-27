// M17-2：加好友 Worker A 客户端
import type { WorkerATransport } from './transport';
import { buildQuery } from './transport';
import type { WorkerAClient } from './types';
import type {
  FriendRequestListResponse,
  FriendRequestSetting,
  FriendRequestSendResult,
  MutualFollowListResponse,
} from './types';

export function createFriendRequestsApi(t: WorkerATransport): Pick<
  WorkerAClient,
  | 'listFriendRequests'
  | 'sendFriendRequest'
  | 'acceptFriendRequest'
  | 'rejectFriendRequest'
  | 'cancelFriendRequest'
  | 'getFriendRequestsSetting'
  | 'setFriendRequestsSetting'
  | 'listMutualFollows'
> {
  return {
    async listFriendRequests(params) {
      const q = buildQuery({
        direction: params?.direction,
        status: params?.status,
        limit: params?.limit,
        cursor: params?.cursor,
      });
      const data = await t.callWithJwt<{ data: FriendRequestListResponse }>(
        `/api/friend-requests${q}`,
      );
      return data.data;
    },

    async sendFriendRequest(input) {
      const data = await t.callWithJwt<{ data: FriendRequestSendResult }>('/api/friend-requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          target_node_url: input.target_node_url,
          target_handle: input.target_handle,
          ...(input.message != null ? { message: input.message } : {}),
        }),
      });
      return data.data;
    },

    async acceptFriendRequest(id) {
      const data = await t.callWithJwt<{ data: { id: string; status: string } }>(
        `/api/friend-requests/${encodeURIComponent(id)}/accept`,
        { method: 'POST' },
      );
      return data.data;
    },

    async rejectFriendRequest(id, reason) {
      const data = await t.callWithJwt<{ data: { id: string; status: string } }>(
        `/api/friend-requests/${encodeURIComponent(id)}/reject`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(reason != null ? { reason } : {}),
        },
      );
      return data.data;
    },

    async cancelFriendRequest(id) {
      await t.callWithJwt<{ ok: true }>(`/api/friend-requests/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      });
    },

    async getFriendRequestsSetting() {
      const data = await t.callWithJwt<{ data: FriendRequestSetting }>(
        '/api/node-settings/friend-requests',
      );
      return data.data;
    },

    async setFriendRequestsSetting(allowIncoming) {
      const data = await t.callWithJwt<{ data: FriendRequestSetting }>(
        '/api/node-settings/friend-requests',
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ allow_incoming: allowIncoming }),
        },
      );
      return data.data;
    },

    async listMutualFollows() {
      const data = await t.callWithJwt<{ data: MutualFollowListResponse }>(
        '/api/local/mutual-follows',
      );
      return data.data;
    },
  };
}
