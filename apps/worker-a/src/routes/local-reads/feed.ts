/**
 * GET /api/local/feed — 站主直读 D1 feed_cache（M14-10 / M-REFACTOR-1a）
 */
import type { Hono } from 'hono';
import { queryLocalFeed } from '../../services/local-reads/feedQuery';
import type { LocalReadsAppEnv } from './app';

export function registerFeedRoutes(app: Hono<LocalReadsAppEnv>): void {
  app.get('/feed', async (c) => {
    const cursor = c.req.query('cursor') ?? null;
    const limitParam = parseInt(c.req.query('limit') ?? '20', 10);
    const limit = isNaN(limitParam) ? 20 : Math.min(Math.max(limitParam, 1), 50);

    try {
      const data = await queryLocalFeed(c.env, { cursor, limit });
      return c.json({ ok: true, data });
    } catch (err) {
      console.error('[local-reads/feed] feed_cache 查询失败', err);
      return c.json(
        { ok: false, error_code: 'INTERNAL_ERROR', message: '查询关注流失败，请重试' },
        500,
      );
    }
  });
}
