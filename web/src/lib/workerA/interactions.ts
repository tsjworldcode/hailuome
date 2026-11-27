// M-REFACTOR-1b：互动与通知
import type { WorkerATransport } from './transport';
import type { WorkerAClient } from './types';
import type { InteractionEnvelope, LocalNotificationListResponse } from './types';

/** 互动与通知 API 方法集 */
export function createInteractionsApi(t: WorkerATransport): Pick<WorkerAClient, 'signInteractionEnvelope' | 'listNotifications' | 'markNotificationsRead'> {
  return {
    async signInteractionEnvelope(input) {
      const data = await t.callWithJwt<{ data: { envelope: InteractionEnvelope } }>(
        '/api/interactions/sign-envelope',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
        },
      );
      return data.data.envelope;
    },

    async listNotifications(params) {
      const qs = t.buildQuery({ limit: params?.limit, before: params?.before });
      const data = await t.callWithJwt<{ data: LocalNotificationListResponse }>(
        `/api/local/notifications${qs}`,
      );
      return data.data;
    },

    async markNotificationsRead(ids) {
      const data = await t.callWithJwt<{ data: { marked: number; unread_count: number } }>(
        '/api/local/notifications/mark-read',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(ids && ids.length > 0 ? { ids } : {}),
        },
      );
      return data.data;
    }
  };
}
