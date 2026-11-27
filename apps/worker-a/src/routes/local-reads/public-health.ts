/**
 * GET /api/local/public-health-probe — M-DS-3（M-REFACTOR-1a 子路由）
 */
import type { Hono } from 'hono';
import { probeWorkerBPublicHealth } from '../../handlers/publicHealthProbe';
import type { LocalReadsAppEnv } from './app';

export function registerPublicHealthRoutes(app: Hono<LocalReadsAppEnv>): void {
  app.get('/public-health-probe', async (c) => {
    try {
      const result = await probeWorkerBPublicHealth(c.env);
      return c.json({ ok: true, data: result });
    } catch (err) {
      console.error('[local-reads/public-health] public-health-probe 失败', err);
      return c.json(
        { ok: false, error_code: 'PROBE_FAILED', message: '公开层探活失败，请稍后重试' },
        500,
      );
    }
  });
}
