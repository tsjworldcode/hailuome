/**
 * M12-1 / NCF-2B-6：站主 TOTP 管理路由（挂载于 /auth/totp/*）。
 * 路由只做 JWT / JSON 解析与 HTTP 映射；判定走 services/auth execute*。
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env, AppVariables } from '../env';
import { requireOwnerJWT } from '../middleware/auth';
import {
  executeGetOwnerTotpStatus,
  executeOwnerTotpDisable,
  executeOwnerTotpEnable,
  executeOwnerTotpRotateRecovery,
  executeOwnerTotpSetup,
  resolveCredentialUsername,
} from '../services/auth';
import type {
  OwnerTotpDisableResult,
  OwnerTotpEnableResult,
  OwnerTotpRotateResult,
  OwnerTotpSetupResult,
} from '../services/auth';

type AppEnv = { Bindings: Env; Variables: AppVariables };
type Ctx = Context<AppEnv>;

interface PasswordBody {
  password_hash?: unknown;
}

interface EnableBody extends PasswordBody {
  totp_code?: unknown;
}

interface DisableBody extends PasswordBody {
  totp_code?: unknown;
  recovery_code?: unknown;
}

function readPasswordHash(body: PasswordBody): string {
  return typeof body.password_hash === 'string' ? body.password_hash.trim() : '';
}

function totpFailJson(
  c: Ctx,
  result: OwnerTotpSetupResult | OwnerTotpEnableResult | OwnerTotpDisableResult | OwnerTotpRotateResult,
): Response {
  if (result.status === 'ok') {
    // 类型收窄：成功不走此分支
    return c.json({ ok: false, error_code: 'INTERNAL_ERROR', message: '内部错误' }, 500);
  }
  const status = result.httpStatus as 400 | 401 | 500;
  return c.json(
    { ok: false, error_code: result.error_code, message: result.message },
    status,
  );
}

export function registerAuthTotpRoutes(authApp: Hono<AppEnv>): void {
  authApp.use('/totp/*', requireOwnerJWT());

  authApp.get('/totp/status', async (c) => {
    const payload = c.get('ownerJwt');
    const username = resolveCredentialUsername(payload, c.env.BOOTSTRAP_HANDLE ?? payload.sub);
    const result = await executeGetOwnerTotpStatus(c.env, { username });
    return c.json({ ok: true, data: result.data }, 200);
  });

  authApp.post('/totp/setup', async (c) => {
    let body: PasswordBody;
    try {
      body = (await c.req.json()) as PasswordBody;
    } catch {
      return c.json({ ok: false, error_code: 'BAD_REQUEST', message: '请求体必须为 JSON' }, 400);
    }
    const payload = c.get('ownerJwt');
    const username = resolveCredentialUsername(payload, c.env.BOOTSTRAP_HANDLE ?? payload.sub);
    const result = await executeOwnerTotpSetup(c.env, {
      username,
      label: username,
      passwordHash: readPasswordHash(body),
    });
    if (result.status !== 'ok') return totpFailJson(c, result);
    return c.json({ ok: true, data: result.data }, 200);
  });

  authApp.post('/totp/enable', async (c) => {
    let body: EnableBody;
    try {
      body = (await c.req.json()) as EnableBody;
    } catch {
      return c.json({ ok: false, error_code: 'BAD_REQUEST', message: '请求体必须为 JSON' }, 400);
    }
    const payload = c.get('ownerJwt');
    const username = resolveCredentialUsername(payload, c.env.BOOTSTRAP_HANDLE ?? payload.sub);
    const result = await executeOwnerTotpEnable(c.env, {
      username,
      passwordHash: readPasswordHash(body),
      totpCode: typeof body.totp_code === 'string' ? body.totp_code.trim() : '',
    });
    if (result.status !== 'ok') return totpFailJson(c, result);
    return c.json({ ok: true, data: result.data }, 200);
  });

  authApp.post('/totp/disable', async (c) => {
    let body: DisableBody;
    try {
      body = (await c.req.json()) as DisableBody;
    } catch {
      return c.json({ ok: false, error_code: 'BAD_REQUEST', message: '请求体必须为 JSON' }, 400);
    }
    const payload = c.get('ownerJwt');
    const username = resolveCredentialUsername(payload, c.env.BOOTSTRAP_HANDLE ?? payload.sub);
    const result = await executeOwnerTotpDisable(c.env, {
      username,
      passwordHash: readPasswordHash(body),
      totpCode: typeof body.totp_code === 'string' ? body.totp_code.trim() : undefined,
      recoveryCode: typeof body.recovery_code === 'string' ? body.recovery_code.trim() : undefined,
    });
    if (result.status !== 'ok') return totpFailJson(c, result);
    return c.json({ ok: true, data: result.data }, 200);
  });

  authApp.post('/totp/recovery-codes/rotate', async (c) => {
    let body: DisableBody;
    try {
      body = (await c.req.json()) as DisableBody;
    } catch {
      return c.json({ ok: false, error_code: 'BAD_REQUEST', message: '请求体必须为 JSON' }, 400);
    }
    const payload = c.get('ownerJwt');
    const username = resolveCredentialUsername(payload, c.env.BOOTSTRAP_HANDLE ?? payload.sub);
    const result = await executeOwnerTotpRotateRecovery(c.env, {
      username,
      passwordHash: readPasswordHash(body),
      totpCode: typeof body.totp_code === 'string' ? body.totp_code.trim() : undefined,
      recoveryCode: typeof body.recovery_code === 'string' ? body.recovery_code.trim() : undefined,
    });
    if (result.status !== 'ok') return totpFailJson(c, result);
    return c.json({ ok: true, data: result.data }, 200);
  });
}
