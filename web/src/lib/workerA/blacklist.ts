// M-REFACTOR-1b：黑名单
import type { WorkerATransport } from './transport';
import type { WorkerAClient } from './types';
import type { BlacklistCreateResponse, BlacklistListResponse } from './types';

/** 黑名单 API 方法集 */
export function createBlacklistApi(t: WorkerATransport): Pick<WorkerAClient, 'listBlacklist' | 'createBlacklist' | 'deleteBlacklist'> {
  return {
    async listBlacklist() {
      const data = await t.callWithJwt<{ data: BlacklistListResponse }>('/api/blacklist');
      return data.data;
    },

    async createBlacklist(input) {
      const body: { node_url: string; reason?: string } = { node_url: input.nodeUrl };
      if (input.reason !== undefined) body.reason = input.reason;
      const data = await t.callWithJwt<{ data: BlacklistCreateResponse }>('/api/blacklist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return data.data;
    },

    async deleteBlacklist(nodeUrl) {
      await t.callWithJwt<{ ok: true }>(
        `/api/blacklist/${encodeURIComponent(nodeUrl)}`,
        { method: 'DELETE' },
      );
    },

    // ── 查询 / 图片 ───────────────────────────────────────────────
  };
}
