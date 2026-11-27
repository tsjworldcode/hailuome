// M-REFACTOR-1b：URL 变更
import type { WorkerATransport } from './transport';
import type { WorkerAClient } from './types';
import type { UrlChangeConfirmResult, UrlChangePrecheckResult, UrlChangeStatusResult } from './types';

/** URL 变更 API 方法集 */
export function createUrlChangeApi(t: WorkerATransport): Pick<WorkerAClient, 'precheckUrlChange' | 'confirmUrlChange' | 'getUrlChangeStatus'> {
  return {
    async precheckUrlChange(input) {
      const data = await t.callWithJwt<{ data: UrlChangePrecheckResult }>(
        '/api/local/registry/url-change/precheck',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            new_node_url: input.newNodeUrl,
            new_worker_b_url: input.newWorkerBUrl,
          }),
        },
      );
      return data.data;
    },

    async confirmUrlChange(input) {
      const data = await t.callWithJwt<{ data: UrlChangeConfirmResult }>(
        '/api/local/registry/url-change/confirm',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            url_change_id: input.urlChangeId,
            nonce: input.nonce,
            step_up: {
              password_hash: input.passwordHash,
              ...(input.totpCode ? { totp_code: input.totpCode } : {}),
            },
          }),
        },
      );
      return data.data;
    },

    async getUrlChangeStatus(options) {
      const qs =
        options?.probeOld === true ? '?probe_old=1' : '';
      const data = await t.callWithJwt<{ data: UrlChangeStatusResult }>(
        `/api/local/registry/url-change/status${qs}`,
      );
      return data.data;
    }
  };
}
