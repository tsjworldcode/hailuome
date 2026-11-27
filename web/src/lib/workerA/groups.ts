// M-REFACTOR-1b：群组
import type { WorkerATransport } from './transport';
import type { WorkerAClient } from './types';
import type { GroupCreateResponse, GroupDissolveResponse, GroupInviteAcceptResponse, GroupInviteCreateResponse, GroupJoinRequestItem, GroupLeaveResponse, GroupLocalMessagesResponse, GroupLocalSettingsResponse, GroupMemberItem, GroupOwnerEpochKeyPutResult, GroupOwnerEpochKeyStatus, GroupOwnerRekeyResult, GroupOwnerSealPendingResult, GroupSendMessageResponse, GroupWrappedKeyItem, LocalGroupListResponse, MessagingDbCapacityResponse } from './types';
import type { GroupMessageEnvelope, GroupSyncDown } from '@hailuo/shared-types';

/** 群组 API 方法集 */
export function createGroupsApi(t: WorkerATransport): Pick<
  WorkerAClient,
  | 'listLocalGroups'
  | 'createGroup'
  | 'getGroupOwnerEpochKey'
  | 'putGroupOwnerEpochKey'
  | 'sealGroupPendingKeys'
  | 'ownerGroupRekey'
  | 'createGroupInvite'
  | 'acceptGroupInvite'
  | 'listGroupJoinRequests'
  | 'approveGroupJoinRequest'
  | 'rejectGroupJoinRequest'
  | 'revokeGroupInvite'
  | 'putGroupJoinPolicy'
  | 'putGroupMute'
  | 'putGroupName'
  | 'putGroupAnnouncement'
  | 'putGroupAdmin'
  | 'listGroupMembers'
  | 'kickGroupMember'
  | 'joinGroup'
  | 'listLocalGroupMessages'
  | 'listGroupWrappedKeys'
  | 'putGroupWrappedKey'
  | 'putGroupWrappedKeysBatch'
  | 'putGroupMemberDhPubkey'
  | 'commitGroupRekey'
  | 'fastPullGroupKey'
  | 'signGroupEnvelope'
  | 'sendGroupMessage'
  | 'syncGroup'
  | 'leaveGroup'
  | 'dissolveGroup'
  | 'putGroupLocalSettings'
  | 'getMessagingDbCapacity'
> {
  return {
    async listLocalGroups() {
      const data = await t.callWithJwt<{ data: LocalGroupListResponse }>('/api/groups/local');
      return data.data;
    },

    async createGroup(input) {
      const data = await t.callWithJwt<{ data: GroupCreateResponse }>('/api/groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: input.name,
          announcement: input.announcement,
        }),
      });
      return data.data;
    },

    async getGroupOwnerEpochKey(groupId, epoch) {
      const q =
        epoch != null && Number.isSafeInteger(epoch) && epoch > 0
          ? `?epoch=${encodeURIComponent(String(epoch))}`
          : '';
      const data = await t.callWithJwt<{ data: GroupOwnerEpochKeyStatus }>(
        `/api/groups/${encodeURIComponent(groupId)}/owner-epoch-key${q}`,
      );
      return data.data;
    },

    async putGroupOwnerEpochKey(groupId, input) {
      const data = await t.callWithJwt<{ data: GroupOwnerEpochKeyPutResult }>(
        `/api/groups/${encodeURIComponent(groupId)}/owner-epoch-key`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            epoch: input.epoch,
            group_key_hex: input.group_key_hex,
          }),
        },
      );
      return data.data;
    },

    async sealGroupPendingKeys(groupId, opts) {
      const data = await t.callWithJwt<{ data: GroupOwnerSealPendingResult }>(
        `/api/groups/${encodeURIComponent(groupId)}/owner-seal-pending`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...(opts?.limit != null ? { limit: opts.limit } : {}),
          }),
        },
      );
      return data.data;
    },

    async ownerGroupRekey(groupId, input) {
      const data = await t.callWithJwt<{ data: GroupOwnerRekeyResult }>(
        `/api/groups/${encodeURIComponent(groupId)}/owner-rekey`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...(input?.expected_epoch != null ? { expected_epoch: input.expected_epoch } : {}),
            ...(input?.commit === false ? { commit: false } : {}),
          }),
        },
      );
      return data.data;
    },

    async createGroupInvite(groupId, opts) {
      const data = await t.callWithJwt<{ data: GroupInviteCreateResponse }>(
        `/api/groups/${encodeURIComponent(groupId)}/invites`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...(opts?.ttl_days != null ? { ttl_days: opts.ttl_days } : {}),
            ...(typeof opts?.requires_approval === 'boolean'
              ? { requires_approval: opts.requires_approval }
              : {}),
          }),
        },
      );
      return data.data;
    },

    async acceptGroupInvite(groupId, input) {
      // M16-INVITE-SHORT：无 groupId 时走 /api/groups/invites/accept
      const path =
        groupId && groupId.trim()
          ? `/api/groups/${encodeURIComponent(groupId.trim())}/invites/accept`
          : '/api/groups/invites/accept';
      const data = await t.callWithJwt<{ data: GroupInviteAcceptResponse }>(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      return data.data;
    },

    async listGroupJoinRequests(groupId) {
      const data = await t.callWithJwt<{ data: { items: readonly GroupJoinRequestItem[] } }>(
        `/api/groups/${encodeURIComponent(groupId)}/join-requests`,
      );
      return data.data;
    },

    async approveGroupJoinRequest(groupId, memberWorkerBUrl) {
      const data = await t.callWithJwt<{
        data: { group_id: string; member_worker_b_url: string; status: string };
      }>(`/api/groups/${encodeURIComponent(groupId)}/join-requests/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ member_worker_b_url: memberWorkerBUrl }),
      });
      return data.data;
    },

    async rejectGroupJoinRequest(groupId, memberWorkerBUrl) {
      const data = await t.callWithJwt<{
        data: { group_id: string; member_worker_b_url: string; status: string };
      }>(`/api/groups/${encodeURIComponent(groupId)}/join-requests/reject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ member_worker_b_url: memberWorkerBUrl }),
      });
      return data.data;
    },

    async revokeGroupInvite(groupId, input) {
      const data = await t.callWithJwt<{
        data: { group_id: string; invite_token: string; revoked_at: string };
      }>(`/api/groups/${encodeURIComponent(groupId)}/invites/revoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      return data.data;
    },

    async putGroupJoinPolicy(groupId, policy) {
      const body =
        typeof policy === 'boolean'
          ? { join_requires_approval: policy }
          : { join_policy: policy };
      const data = await t.callWithJwt<{
        data: {
          group_id: string;
          join_policy?: 'closed' | 'approval' | 'open';
          join_requires_approval?: boolean;
        };
      }>(`/api/groups/${encodeURIComponent(groupId)}/join-policy`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return data.data;
    },

    async putGroupMute(groupId, membersMuted) {
      const data = await t.callWithJwt<{
        data: { group_id: string; members_muted: boolean };
      }>(`/api/groups/${encodeURIComponent(groupId)}/mute`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ members_muted: membersMuted }),
      });
      return data.data;
    },

    async putGroupName(groupId, name) {
      const data = await t.callWithJwt<{ data: { group_id: string; name: string } }>(
        `/api/groups/${encodeURIComponent(groupId)}/name`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name }),
        },
      );
      return data.data;
    },

    async putGroupAnnouncement(groupId, announcement) {
      const data = await t.callWithJwt<{ data: { group_id: string; announcement: string | null } }>(
        `/api/groups/${encodeURIComponent(groupId)}/announcement`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ announcement }),
        },
      );
      return data.data;
    },

    async putGroupAdmin(groupId, input) {
      const data = await t.callWithJwt<{
        data: { group_id: string; member_worker_b_url: string; is_admin: boolean };
      }>(`/api/groups/${encodeURIComponent(groupId)}/admins`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      return data.data;
    },

    async listGroupMembers(groupId, params) {
      // GRP-MEMBER-PAGE-1：展示侧传 limit/includeDh=false；不传则保持全量（换钥/补封）
      const qs = new URLSearchParams();
      if (params?.limit && params.limit > 0) qs.set('limit', String(params.limit));
      if (params?.offset && params.offset > 0) qs.set('offset', String(params.offset));
      if (params?.includeDh === false) qs.set('include_dh', '0');
      const suffix = qs.toString() ? `?${qs.toString()}` : '';
      const data = await t.callWithJwt<{
        data: {
          items: readonly GroupMemberItem[];
          total?: number;
          has_more?: boolean;
        };
      }>(`/api/groups/${encodeURIComponent(groupId)}/members${suffix}`);
      return data.data;
    },

    async kickGroupMember(groupId, memberWorkerBUrl, options) {
      // REKEY-1：踢人只隔绝，不附带 wrap（假 wrap 会被服务端 400）。
      const data = await t.callWithJwt<{
        data: {
          group_id: string;
          member_worker_b_url: string;
          status: string;
          new_epoch?: number;
          rekey_scheduled?: boolean;
        };
      }>(`/api/groups/${encodeURIComponent(groupId)}/kick`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          member_worker_b_url: memberWorkerBUrl,
          expected_epoch: options?.expected_epoch,
        }),
      });
      return data.data;
    },

    async joinGroup(input) {
      const data = await t.callWithJwt<{ data: GroupInviteAcceptResponse }>('/api/groups/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      return data.data;
    },

    async listLocalGroupMessages(groupId, params) {
      const qs = t.buildQuery({ limit: params?.limit, cursor: params?.cursor });
      const data = await t.callWithJwt<{ data: GroupLocalMessagesResponse }>(
        `/api/groups/local/${encodeURIComponent(groupId)}/messages${qs}`,
      );
      return data.data;
    },

    async fastPullGroupKey(groupId, epoch) {
      const data = await t.callWithJwt<{
        data: {
          group_id: string;
          epoch: number;
          member_worker_b_url: string;
          wrapped_key_json: string;
        };
      }>(`/api/groups/${encodeURIComponent(groupId)}/fast-pull-key`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ epoch }),
      });
      return data.data;
    },

    async listGroupWrappedKeys(groupId, epoch) {
      const qs = epoch != null ? t.buildQuery({ epoch }) : '';
      const data = await t.callWithJwt<{
        data: { group_id: string; key_state: string; items: readonly GroupWrappedKeyItem[] };
      }>(`/api/groups/${encodeURIComponent(groupId)}/wrapped-keys${qs}`);
      return data.data;
    },

    async putGroupWrappedKey(groupId, input) {
      const wrapped =
        typeof input.wrapped_key_json === 'string'
          ? input.wrapped_key_json
          : JSON.stringify(input.wrapped_key_json);
      const data = await t.callWithJwt<{
        data: { group_id: string; epoch: number; member_worker_b_url: string };
      }>(`/api/groups/${encodeURIComponent(groupId)}/wrapped-keys`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          epoch: input.epoch,
          wrapped_key_json: wrapped,
          member_worker_b_url: input.member_worker_b_url,
          key_fingerprint: input.key_fingerprint,
        }),
      });
      return data.data;
    },

    /** SEC-AUDIT-2026-10-16：真 batch ≤32 + 同源 fingerprint */
    async putGroupWrappedKeysBatch(groupId, input) {
      const items = input.items.map((it) => ({
        member_worker_b_url: it.member_worker_b_url,
        wrapped_key_json:
          typeof it.wrapped_key_json === 'string'
            ? it.wrapped_key_json
            : JSON.stringify(it.wrapped_key_json),
      }));
      const data = await t.callWithJwt<{
        data: {
          group_id: string;
          epoch: number;
          written: number;
          key_fingerprint: string | null;
          replaced: boolean;
        };
      }>(`/api/groups/${encodeURIComponent(groupId)}/wrapped-keys/batch`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          epoch: input.epoch,
          key_fingerprint: input.key_fingerprint,
          replace_key: input.replace_key === true,
          items,
        }),
      });
      return data.data;
    },

    async putGroupMemberDhPubkey(groupId, memberDhPubkey) {
      const data = await t.callWithJwt<{
        data: { group_id: string; member_worker_b_url: string; member_dh_pubkey: string };
      }>(`/api/groups/${encodeURIComponent(groupId)}/dh-pubkey`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ member_dh_pubkey: memberDhPubkey }),
      });
      return data.data;
    },

    async commitGroupRekey(groupId, input) {
      const data = await t.callWithJwt<{
        data: {
          group_id: string;
          previous_epoch: number;
          new_epoch: number;
          rekey_scheduled: false;
          wrapped_count: number;
        };
      }>(`/api/groups/${encodeURIComponent(groupId)}/rekey-commit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expected_epoch: input.expected_epoch }),
      });
      return data.data;
    },

    async signGroupEnvelope(envelope) {
      const data = await t.callWithJwt<{ data: { envelope: GroupMessageEnvelope } }>(
        '/api/groups/sign-envelope',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ envelope }),
        },
      );
      return data.data.envelope;
    },

    async sendGroupMessage(groupId, envelope) {
      const data = await t.callWithJwt<{ data: GroupSendMessageResponse }>(
        `/api/groups/${encodeURIComponent(groupId)}/messages`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ envelope }),
        },
      );
      return data.data;
    },

    async syncGroup(groupId, input) {
      const data = await t.callWithJwt<{ data: GroupSyncDown }>(
        `/api/groups/${encodeURIComponent(groupId)}/sync`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(input ?? {}),
        },
      );
      return data.data;
    },

    async leaveGroup(groupId) {
      const data = await t.callWithJwt<{ data: GroupLeaveResponse }>(
        `/api/groups/${encodeURIComponent(groupId)}/leave`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        },
      );
      return data.data;
    },

    async dissolveGroup(groupId) {
      const data = await t.callWithJwt<{ data: GroupDissolveResponse }>(
        `/api/groups/${encodeURIComponent(groupId)}/dissolve`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        },
      );
      return data.data;
    },

    async putGroupLocalSettings(groupId, input) {
      const data = await t.callWithJwt<{ data: GroupLocalSettingsResponse }>(
        `/api/groups/local/${encodeURIComponent(groupId)}/settings`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
        },
      );
      return data.data;
    },

    async getMessagingDbCapacity() {
      const data = await t.callWithJwt<{ data: MessagingDbCapacityResponse }>('/api/messaging/db-capacity');
      return data.data;
    }
  };
}
