/**
 * notifications 列表 + mark-read（M9-20 / M-REFACTOR-1a）
 */
import type { Hono } from 'hono';
import {
  countUnreadLocalNotifications,
  listLocalNotifications,
  markLocalNotificationsRead,
} from '../../lib/localNotifications';
import type { LocalReadsAppEnv } from './app';

export function registerNotificationsRoutes(app: Hono<LocalReadsAppEnv>): void {
  app.get('/notifications', async (c) => {
    const limitParam = parseInt(c.req.query('limit') ?? '20', 10);
    const limit = isNaN(limitParam) ? 20 : Math.min(Math.max(limitParam, 1), 50);
    const before = c.req.query('before') ?? null;
    try {
      const [page, unread_count] = await Promise.all([
        listLocalNotifications(c.env, { limit, before }),
        countUnreadLocalNotifications(c.env),
      ]);
      return c.json({
        ok: true,
        data: {
          items: page.items,
          unread_count,
          has_more: page.has_more,
          cursor: page.next_cursor,
        },
      });
    } catch (err) {
      console.error('[local-reads/notifications] 通知列表查询失败', err);
      return c.json(
        { ok: false, error_code: 'INTERNAL_ERROR', message: '查询通知失败，请稍后重试' },
        500,
      );
    }
  });

  app.post('/notifications/mark-read', async (c) => {
    let body: { ids?: unknown } = {};
    try {
      body = (await c.req.json()) as { ids?: unknown };
    } catch {
      body = {};
    }
    const ids = Array.isArray(body.ids)
      ? body.ids.filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
      : undefined;
    try {
      const marked = await markLocalNotificationsRead(c.env, ids);
      const unread_count = await countUnreadLocalNotifications(c.env);
      return c.json({ ok: true, data: { marked, unread_count } });
    } catch (err) {
      console.error('[local-reads/notifications] 通知标记已读失败', err);
      return c.json(
        { ok: false, error_code: 'INTERNAL_ERROR', message: '标记通知已读失败，请稍后重试' },
        500,
      );
    }
  });
}
