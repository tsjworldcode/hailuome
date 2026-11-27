// M-REFACTOR-1b：私信
import type { WorkerATransport } from './transport';
import type { WorkerAClient } from './types';
import type { DmEnvelope, DmMessageListResponse, DmSendTicket, DmWrappedIdentityRecord, DmWrappedKeyItem } from './types';

/** 私信 API 方法集 */
export function createDmApi(t: WorkerATransport): Pick<WorkerAClient, 'setDmPubkey' | 'issueDmSendTicket' | 'deliverDmEnvelope' | 'saveDmOutbox' | 'getDmOutboxMessage' | 'patchDmOutboxDeliveryStatus' | 'listDmInbox' | 'listDmOutbox' | 'listDmWrappedKeys' | 'putDmWrappedKey' | 'getDmWrappedIdentity' | 'putDmWrappedIdentity' | 'getDmUnreadCount' | 'markDmMessageRead' | 'deleteDmMessage' | 'deleteDmConversation' | 'importDmMessages' | 'signDmEnvelope'> {
  return {
    async setDmPubkey(dmPubkey) {
      const data = await t.callWithJwt<{ data: { dm_pubkey: string } }>(
        '/api/me/dm-pubkey',
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dm_pubkey: dmPubkey }),
        },
      );
      return data.data;
    },

    async issueDmSendTicket(input) {
      const data = await t.callWithJwt<{ data: { ticket: DmSendTicket } }>(
        '/api/dm/send-ticket',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
        },
      );
      return data.data.ticket;
    },

    async deliverDmEnvelope(recipientWorkerBUrl, envelope) {
      // DM-PEER-PUBKEY-1：由本机 Worker A 服务端转发到收件节点 Worker B /dm/inbox，
      // 浏览器不再直连对端 workers.dev（绕开网络阻断与 CORS）。
      const data = await t.callWithJwt<{ data: { message_id: string } }>('/api/dm/deliver', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          recipient_worker_b_url: recipientWorkerBUrl,
          envelope,
        }),
      });
      return data.data;
    },

    async saveDmOutbox(envelope, opts) {
      const data = await t.callWithJwt<{ data: { message_id: string; delivery_status: string } }>(
        '/api/dm/outbox',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            envelope,
            // MSG-FIX-2：缺省 pending；投递成功再标 sent
            delivery_status: opts?.delivery_status ?? 'pending',
          }),
        },
      );
      return data.data;
    },

    async getDmOutboxMessage(messageId) {
      const id = encodeURIComponent(messageId.trim());
      const data = await t.callWithJwt<{ data: import('./types').DmMessageItem }>(
        `/api/dm/outbox/${id}`,
      );
      return data.data;
    },

    async patchDmOutboxDeliveryStatus(messageId, deliveryStatus) {
      const id = encodeURIComponent(messageId.trim());
      const data = await t.callWithJwt<{ data: { message_id: string; delivery_status: string } }>(
        `/api/dm/outbox/${id}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ delivery_status: deliveryStatus }),
        },
      );
      return data.data;
    },

    async listDmInbox(params) {
      const qs = t.buildQuery({ limit: params?.limit, cursor: params?.cursor });
      const data = await t.callWithJwt<{ data: DmMessageListResponse }>(`/api/dm/inbox${qs}`);
      return data.data;
    },

    async listDmOutbox(params) {
      const qs = t.buildQuery({ limit: params?.limit, cursor: params?.cursor });
      const data = await t.callWithJwt<{ data: DmMessageListResponse }>(`/api/dm/outbox${qs}`);
      return data.data;
    },

    async listDmWrappedKeys() {
      const data = await t.callWithJwt<{ data: { items: readonly DmWrappedKeyItem[] } }>(
        '/api/dm/wrapped-keys',
      );
      return data.data;
    },

    async putDmWrappedKey(input) {
      const data = await t.callWithJwt<{ data: { conversation_id: string; key_epoch: number } }>(
        '/api/dm/wrapped-keys',
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            conversation_id: input.conversation_id,
            key_epoch: input.key_epoch ?? 1,
            peer_handle: input.peer_handle,
            wrapped_key_json: input.wrapped_key_json,
          }),
        },
      );
      return data.data;
    },

    async getDmWrappedIdentity() {
      const data = await t.callWithJwt<{ data: DmWrappedIdentityRecord | null }>(
        '/api/dm/wrapped-identity',
      );
      return data.data;
    },

    async putDmWrappedIdentity(input) {
      const data = await t.callWithJwt<{
        data: { owner_handle: string; public_key_hex: string; updated_at: string };
      }>('/api/dm/wrapped-identity', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      return data.data;
    },

    async getDmUnreadCount() {
      const data = await t.callWithJwt<{ data: { unread_count: number } }>('/api/dm/unread-count');
      return data.data;
    },

    async markDmMessageRead(messageId) {
      const data = await t.callWithJwt<{ data: { message_id: string; read_at: string } }>(
        `/api/dm/messages/${encodeURIComponent(messageId)}/read`,
        { method: 'POST' },
      );
      return data.data;
    },

    async deleteDmMessage(messageId) {
      const data = await t.callWithJwt<{ data: { message_id: string; deleted: boolean } }>(
        `/api/dm/messages/${encodeURIComponent(messageId)}`,
        { method: 'DELETE' },
      );
      return data.data;
    },

    async deleteDmConversation(conversationId) {
      const data = await t.callWithJwt<{
        data: { conversation_id: string; deleted_messages: number };
      }>(
        `/api/dm/conversations/${encodeURIComponent(conversationId)}`,
        { method: 'DELETE' },
      );
      return data.data;
    },

    async importDmMessages(items) {
      const data = await t.callWithJwt<{
        data: { inserted: number; skipped: number; invalid: number; errors: readonly string[] };
      }>('/api/dm/import-messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items }),
      });
      return data.data;
    },

    async signDmEnvelope(envelope) {
      const data = await t.callWithJwt<{ data: { envelope: DmEnvelope } }>(
        '/api/dm/sign-envelope',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ envelope }),
        },
      );
      return data.data.envelope;
    }
  };
}
