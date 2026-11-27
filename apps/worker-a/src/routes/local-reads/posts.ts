/**
 * GET /api/local/posts — 站主直读 D1（M3-1a / M-REFACTOR-1a 子路由）
 */
import type { Hono } from 'hono';
import { queryLocalPosts } from '../../services/local-reads/postsQuery';
import type { LocalReadsAppEnv } from './app';

export function registerPostsRoutes(app: Hono<LocalReadsAppEnv>): void {
  app.get('/posts', async (c) => {
    const before = c.req.query('before') ?? null;
    const limitParam = parseInt(c.req.query('limit') ?? '20', 10);
    const limit = isNaN(limitParam) ? 20 : Math.min(Math.max(limitParam, 1), 50);

    try {
      const data = await queryLocalPosts(c.env, { before, limit });
      return c.json({ ok: true, data });
    } catch (err) {
      console.error('[local-reads/posts] D1 查询失败', err);
      return c.json(
        { ok: false, error_code: 'INTERNAL_ERROR', message: '查询失败，请重试' },
        500,
      );
    }
  });
}
