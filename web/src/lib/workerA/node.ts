// M-REFACTOR-1b：节点导入导出与托管
import type { WorkerATransport } from './transport';
import type { WorkerAClient } from './types';
import type { AccountDeleteResult, HostedL0PrivacyAcceptResult, HostedL0PrivacyDocument, HostedL0Status, NodeImportResult, NodeImportStatus } from './types';

/** 节点导入导出与托管 API 方法集 */
export function createNodeApi(t: WorkerATransport): Pick<WorkerAClient, 'exportNodeBundle' | 'importNodeBundle' | 'getNodeImportStatus' | 'getHostedL0Status' | 'getHostedL0Privacy' | 'acceptHostedL0Privacy' | 'deleteOwnerAccount'> {
  return {
    async exportNodeBundle() {
      return t.callWithJwtBlob('/api/node/export', { method: 'GET' });
    },

    async importNodeBundle(bundle, confirmOverwrite, unsafeInplaceImport = false) {
      const data = await t.callWithJwt<{ data: NodeImportResult }>('/api/node/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          bundle,
          confirm_overwrite: confirmOverwrite,
          // R-AUDIT-3：前端二次确认后才传 true
          unsafe_inplace_import: unsafeInplaceImport === true,
        }),
      });
      return data.data;
    },

    async getNodeImportStatus() {
      const data = await t.callWithJwt<{ data: NodeImportStatus }>('/api/node/import-status');
      return data.data;
    },

    async getHostedL0Status() {
      const data = await t.callWithJwt<{ data: HostedL0Status }>('/api/node/hosted-l0/status');
      return data.data;
    },

    async getHostedL0Privacy() {
      const data = await t.callWithJwt<{ data: HostedL0PrivacyDocument }>('/api/node/hosted-l0/privacy');
      return data.data;
    },

    async acceptHostedL0Privacy(privacyVersion) {
      const data = await t.callWithJwt<{ data: HostedL0PrivacyAcceptResult }>(
        '/api/node/hosted-l0/privacy/accept',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(
            privacyVersion?.trim()
              ? { privacy_version: privacyVersion.trim() }
              : {},
          ),
        },
      );
      return data.data;
    },

    async deleteOwnerAccount(input) {
      const data = await t.callWithJwt<{ data: AccountDeleteResult }>('/api/node/account/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          confirm_phrase: input.confirmPhrase,
          export_acknowledged: input.exportAcknowledged,
        }),
      });
      return data.data;
    },
  };
}
