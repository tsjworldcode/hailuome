// M-REFACTOR-1b：操作日志
import type { WorkerATransport } from './transport';
import type { WorkerAClient } from './types';
import type { OperationLogListResponse } from './types';

/** 操作日志 API 方法集 */
export function createOperationLogsApi(t: WorkerATransport): Pick<WorkerAClient, 'listOperationLogs' | 'cleanupOperationLogs'> {
  return {
    async listOperationLogs(params) {
      const qs = t.buildQuery({ limit: params?.limit, source: params?.source });
      const data = await t.callWithJwt<{ data: OperationLogListResponse }>(
        `/api/local/operation-logs${qs}`,
      );
      return data.data;
    },

    async cleanupOperationLogs() {
      const data = await t.callWithJwt<{ data: { deleted: number } }>(
        '/api/local/operation-logs/cleanup',
        { method: 'POST' },
      );
      return data.data;
    }
  };
}
