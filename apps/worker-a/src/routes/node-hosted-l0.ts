/**
 * M9-8：托管 L0 隐私声明、状态与账号删除（站主 JWT + Owner Gateway）。
 */
import { resolveIdentityDb } from '../db/bindings';
import { Hono } from 'hono';
import type { Env, AppVariables } from '../env';
import {
  acceptHostedL0Privacy,
  deleteOwnerAccountData,
  getHostedL0PrivacyDeclaration,
  getHostedL0Status,
} from '../lib/hostedL0';
import { isHostedL0ModeEnabled } from '@hailuo/shared-utils';

type AppEnv = { Bindings: Env; Variables: AppVariables };

export const nodeHostedL0App = new Hono<AppEnv>();

nodeHostedL0App.get('/hosted-l0/status', async (c) => {
  const data = await getHostedL0Status(resolveIdentityDb(c.env), c.env);
  return c.json({ ok: true, data });
});

nodeHostedL0App.get('/hosted-l0/privacy', async (c) => {
  const data = getHostedL0PrivacyDeclaration();
  return c.json({ ok: true, data });
});

nodeHostedL0App.post('/hosted-l0/privacy/accept', async (c) => {
  let body: unknown = {};
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }

  try {
    const data = await acceptHostedL0Privacy(resolveIdentityDb(c.env), c.env, body);
    return c.json({ ok: true, data });
  } catch (err) {
    const code = err instanceof Error ? err.message : 'HOSTED_L0_PRIVACY_ACCEPT_FAILED';
    if (code === 'HOSTED_L0_NOT_ENABLED') {
      return c.json(
        { ok: false, error_code: 'HOSTED_L0_NOT_ENABLED', message: '当前节点未启用托管 L0 模式' },
        400,
      );
    }
    if (code === 'HOSTED_L0_PRIVACY_VERSION_MISMATCH') {
      return c.json(
        {
          ok: false,
          error_code: 'HOSTED_L0_PRIVACY_VERSION_MISMATCH',
          message: '隐私声明版本不匹配，请刷新页面后重试',
        },
        400,
      );
    }
    console.error('[node-hosted-l0] privacy accept 失败', err);
    return c.json(
      { ok: false, error_code: 'HOSTED_L0_PRIVACY_ACCEPT_FAILED', message: '保存隐私同意失败' },
      500,
    );
  }
});

nodeHostedL0App.post('/account/delete', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json(
      { ok: false, error_code: 'ACCOUNT_DELETE_INVALID', message: '请求体不是有效 JSON' },
      400,
    );
  }

  const record = body != null && typeof body === 'object' && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};
  const confirmPhrase = String(record.confirm_phrase ?? '').trim();
  const exportAcknowledged = record.export_acknowledged === true;
  const hostedL0Enabled = isHostedL0ModeEnabled(c.env.HOSTED_L0_MODE);

  try {
    const data = await deleteOwnerAccountData(resolveIdentityDb(c.env), {
      confirmPhrase,
      exportAcknowledged,
      hostedL0Only: false,
      hostedL0Enabled,
    });
    return c.json({ ok: true, data });
  } catch (err) {
    const code = err instanceof Error ? err.message : 'ACCOUNT_DELETE_FAILED';
    if (code === 'ACCOUNT_DELETE_CONFIRM_INVALID') {
      return c.json(
        {
          ok: false,
          error_code: 'ACCOUNT_DELETE_CONFIRM_INVALID',
          message: '确认口令不正确，请输入「删除我的账号」',
        },
        400,
      );
    }
    if (code === 'ACCOUNT_DELETE_EXPORT_ACK_REQUIRED') {
      return c.json(
        {
          ok: false,
          error_code: 'ACCOUNT_DELETE_EXPORT_ACK_REQUIRED',
          message: '请先确认已导出或不需要保留数据（export_acknowledged: true）',
        },
        400,
      );
    }
    console.error('[node-hosted-l0] account delete 失败', err);
    return c.json(
      { ok: false, error_code: 'ACCOUNT_DELETE_FAILED', message: '删除账号数据失败，请稍后重试' },
      500,
    );
  }
});
