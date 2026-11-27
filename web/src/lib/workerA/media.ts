// M-REFACTOR-1b：媒体与 lookup
import type { WorkerATransport } from './transport';
import type { WorkerAClient } from './types';
import type {
  DmPeerPubkeyResponse,
  ImageUploadResponse,
  LookupResponse,
  MediaStorageSetting,
} from './types';

/** 媒体与 lookup API 方法集 */
export function createMediaApi(
  t: WorkerATransport,
): Pick<
  WorkerAClient,
  'getMediaStorageSetting' | 'setMediaStorageSetting' | 'lookup' | 'getDmPeerPubkey' | 'uploadImage'
> {
  return {
    async getMediaStorageSetting() {
      const data = await t.callWithJwt<{ data: MediaStorageSetting }>(
        '/api/node-settings/media-storage',
      );
      return data.data;
    },

    async setMediaStorageSetting(input) {
      const data = await t.callWithJwt<{ data: MediaStorageSetting }>(
        '/api/node-settings/media-storage',
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
        },
      );
      return data.data;
    },

    // ── 黑名单 ────────────────────────────────────────────────────

    async lookup(handle) {
      const data = await t.callWithJwt<{ data: LookupResponse }>(
        `/api/lookup/${encodeURIComponent(handle)}`,
      );
      return data.data;
    },

    async getDmPeerPubkey(handle, nodeUrl) {
      const qs = t.buildQuery({ node_url: nodeUrl });
      const data = await t.callWithJwt<{ data: DmPeerPubkeyResponse }>(
        `/api/lookup/${encodeURIComponent(handle)}/dm-pubkey${qs}`,
      );
      return data.data;
    },

    async uploadImage(input) {
      const headers = new Headers();
      headers.set('Content-Type', input.contentType);
      // body 直传，不做 JSON 包装；Content-Length 是浏览器受限头，交给 fetch/平台自动生成。
      const data = await t.callWithJwt<{ data: ImageUploadResponse }>('/api/images', {
        method: 'POST',
        headers,
        body: input.body as BodyInit,
      });
      return data.data;
    }
  };
}
