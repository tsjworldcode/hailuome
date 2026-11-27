// M-REFACTOR-1b：消息媒体
import type { WorkerATransport } from './transport';
import type { WorkerAClient } from './types';
import type { MessagingMediaUploadResponse } from './types';

/** 消息媒体 API 方法集 */
export function createMessagingMediaApi(t: WorkerATransport): Pick<WorkerAClient, 'uploadMessagingMedia' | 'fetchMessagingMediaByStorageKey' | 'fetchMessagingMediaProxy' | 'getMessagingCloudCapability'> {
  return {
    async uploadMessagingMedia(input) {
      const headers = new Headers();
      headers.set('Content-Type', 'application/octet-stream');
      headers.set('X-Hailuo-Plain-Mime', input.plainMime);
      if (input.mediaId) {
        headers.set('X-Hailuo-Media-Id', input.mediaId);
      }
      const body =
        input.body instanceof Blob
          ? input.body
          : input.body instanceof Uint8Array
            ? input.body
            : new Uint8Array(input.body);
      const data = await t.callWithJwt<{ data: MessagingMediaUploadResponse }>(
        `/api/messaging/media?purpose=${encodeURIComponent(input.purpose)}`,
        {
          method: 'PUT',
          headers,
          body: body as BodyInit,
        },
      );
      return data.data;
    },

    async fetchMessagingMediaByStorageKey(storageKey) {
      return t.callWithJwtBlob(
        `/api/messaging/media/${encodeURIComponent(storageKey)}`,
        { method: 'GET' },
      );
    },

    async fetchMessagingMediaProxy(input) {
      const qs = t.buildQuery({
        message_id: input.message_id,
        media_id: input.media_id,
        conversation_id: input.conversation_id,
        group_id: input.group_id,
      });
      return t.callWithJwtBlob(`/api/messaging/media/proxy${qs}`, { method: 'GET' });
    },

    async getMessagingCloudCapability() {
      const data = await t.callWithJwt<{
        data: {
          can_send_group_media: boolean;
          can_mirror_group_media: boolean;
          default_view_mode: 'mirror' | 'stream_only';
        };
      }>('/api/messaging/cloud-capability');
      return data.data;
    }
  };
}
