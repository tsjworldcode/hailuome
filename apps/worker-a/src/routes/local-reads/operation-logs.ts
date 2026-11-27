/**
 * operation-logs 查询 + cleanup（M-REFACTOR-1a）
 */
import type { Hono } from 'hono';
import { cleanupOperationLogs } from '../../lib/operationLog';
import { queryOperationLogs } from '../../services/local-reads/operationLogsQuery';
import type { LocalReadsAppEnv } from './app';

export function registerOperationLogsRoutes(app: Hono<LocalReadsAppEnv>): void {
  app.get('/operation-logs', async (c) => {
    const limitParam = parseInt(c.req.query('limit') ?? '80', 10);
    const limit = isNaN(limitParam) ? 80 : Math.min(Math.max(limitParam, 1), 200);
    const source = c.req.query('source')?.trim() ?? '';

    try {
      const items = await queryOperationLogs(c.env, {
        limit,
        source: source || undefined,
      });
      return c.json({ ok: true, data: { items } });
    } catch (err) {
      console.error('[local-reads/operation-logs] 运行日志查询失败', err);
      return c.json(
        { ok: false, error_code: 'INTERNAL_ERROR', message: '查询运行日志失败，请稍后重试' },
        500,
      );
    }
  });

  app.post('/operation-logs/cleanup', async (c) => {
    try {
      const deleted = await cleanupOperationLogs(c.env);
      return c.json({ ok: true, data: { deleted } });
    } catch (err) {
      console.error('[local-reads/operation-logs] 运行日志清理失败', err);
      return c.json(
        { ok: false, error_code: 'INTERNAL_ERROR', message: '清理运行日志失败，请稍后重试' },
        500,
      );
    }
  });
}
