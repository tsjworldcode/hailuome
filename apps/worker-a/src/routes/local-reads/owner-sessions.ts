/**
 * M34-4：GET /api/local/owner-sessions · DELETE /api/local/owner-sessions/:sessionId
 */
import type { Hono } from 'hono';
import type { LocalReadsAppEnv } from './app';

function extractBearer(c: { req: { header: (n: string) => string | undefined } }): string | null {
  const auth = c.req.header('Authorization') ?? '';
  return auth.startsWith('Bearer ') ? auth.slice(7) : null;
}

export function registerOwnerSessionsRoutes(app: Hono<LocalReadsAppEnv>): void {
  app.get('/owner-sessions', async (c) => {
    const token = extractBearer(c);
    if (!token) {
      return c.json({ ok: false, error_code: 'UNAUTHORIZED', message: '缺少登录凭证' }, 401);
    }
    const limitRaw = c.req.query('limit');
    const limit = limitRaw ? Number.parseInt(limitRaw, 10) : 20;
    try {
      const { listOwnerSessionsForSettings } = await import(
        '../../services/ownerEngagement/sessionAdmin'
      );
      const data = await listOwnerSessionsForSettings(c.env, {
        token,
        limit: Number.isFinite(limit) ? limit : 20,
      });
      return c.json({ ok: true, data });
    } catch (err) {
      console.error('[local-reads/owner-sessions] 列表失败', err);
      return c.json(
        { ok: false, error_code: 'OWNER_SESSIONS_LIST_FAILED', message: '读取登录设备失败，请稍后重试' },
        500,
      );
    }
  });

  app.delete('/owner-sessions/:sessionId', async (c) => {
    const token = extractBearer(c);
    if (!token) {
      return c.json({ ok: false, error_code: 'UNAUTHORIZED', message: '缺少登录凭证' }, 401);
    }
    const sessionId = c.req.param('sessionId') ?? '';
    try {
      const { revokeOwnerSessionById } = await import(
        '../../services/ownerEngagement/sessionAdmin'
      );
      const result = await revokeOwnerSessionById(c.env, { token, sessionId });
      if (!result.ok) {
        // M34-4d：SESSION_REVOKE_FAILED 使用 503（吊销强一致点失败，可重试）；
        // SESSION_NOT_FOUND / SESSION_ID_REQUIRED 保持 400 / 404。
        const status = (result.httpStatus === 400 || result.httpStatus === 404 || result.httpStatus === 503)
          ? result.httpStatus
          : 500;
        return c.json(
          { ok: false, error_code: result.error_code, message: result.message },
          status as 400 | 404 | 503,
        );
      }
      return c.json({
        ok: true,
        data: {
          ended: result.ended,
          jwt_revoked: result.jwt_revoked,
          is_current: result.is_current,
          owner_engagement: result.owner_engagement,
        },
      });
    } catch (err) {
      console.error('[local-reads/owner-sessions] 注销失败', err);
      return c.json(
        { ok: false, error_code: 'OWNER_SESSION_REVOKE_FAILED', message: '注销会话失败，请稍后重试' },
        500,
      );
    }
  });
}
