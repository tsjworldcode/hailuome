// M-VAULT-2：站主保险箱外层包裹 API
import { ApiError } from '../errors';
import type { WorkerATransport } from './transport';
import type { OwnerWrappedVaultRecord, WorkerAClient } from './types';

/** 保险箱外层 GET/PUT */
export function createOwnerVaultApi(
  t: WorkerATransport,
): Pick<WorkerAClient, 'getOwnerWrappedVault' | 'putOwnerWrappedVault'> {
  return {
    async getOwnerWrappedVault() {
      try {
        const data = await t.callWithJwt<{ data: OwnerWrappedVaultRecord }>(
          '/api/owner/wrapped-vault',
        );
        return data.data;
      } catch (err) {
        // 404：尚无包裹 → ensureVault 新建
        // 409 USER_NOT_REGISTERED：登记前无 users.handle，外层无法落库 → 与「无包裹」同路径（调用方勿当致命）
        if (
          err instanceof ApiError &&
          (err.code === 'VAULT_NOT_FOUND' ||
            err.code === 'USER_NOT_REGISTERED' ||
            err.status === 404)
        ) {
          return null;
        }
        throw err;
      }
    },

    async putOwnerWrappedVault(input) {
      const data = await t.callWithJwt<{ data: OwnerWrappedVaultRecord }>(
        '/api/owner/wrapped-vault',
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            wrapped_vault_json: input.wrapped_vault_json,
            key_version: input.key_version,
          }),
        },
      );
      return data.data;
    },
  };
}
