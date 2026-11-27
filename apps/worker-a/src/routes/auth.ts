/**
 * 认证路由（M2-1 + M2-1b）。
 *
 * authApp 挂在 /auth/* ：
 *   POST /auth/login            — 提交用户名/密码（或老节点 secret 回落）换取所有者 JWT
 *   GET  /auth/me               — JWT 鉴权，返回当前节点所有者信息
 *
 * --------------------------------------------------------------------------
 * M2-1b 安全补强（review 报告 §3.4 驱动）：
 *
 *   1. 凭证存储：D1 `owner_credentials` 表保存 PBKDF2-SHA256 hash 字符串；
 *      **PBKDF2 在浏览器 / 部署脚本完成**，Worker 仅 `comparePasswordHashProof`（零 PBKDF2 CPU）。
 *      签名密钥 `JWT_SECRET` 不再充当登录密码，回归"仅 HMAC 签名"单职责。
 *
 *   2. 失败频控：D1 `login_attempts` 表（PK 为客户端 IP）：
 *        - 15 分钟窗口内累计 5 次失败 → 锁定 5 分钟（返 429 LOGIN_LOCKED）
 *        - 成功登录 → DELETE 该 IP 行（清零计数）
 *        - cron 半小时清理一次 last_attempt_at < now-1d 的过期行（M2-1b 后续 step）
 *      走 D1 不走 KV：KV Free Tier 写 1k/天，频控行为可能突发刷量；D1 100k/天余量充足。
 *
 *   3. 错误码统一：用户名不存在 / 密码错误一律返 `AUTH_INVALID`，
 *      防止通过响应差异枚举站主用户名（M2-1b-7 文档同步）。
 *
 *   4. 兼容回落：当 `owner_credentials` 表为空（存量节点未跑 owner-bootstrap）时，
 *      退化到旧的 `body.secret === env.JWT_SECRET` 等值比较 + console.warn 提示。
 *      用户跑过 `scripts/owner-bootstrap.mjs` 写入凭证后自动切到密码哈希路径，
 *      老路径自动失效，无需配置开关。
 *
 *   5. 站主登录名存 D1 `owner_credentials.username`（可与 BOOTSTRAP_HANDLE、登记 handle 不同）；
 *      JWT `sub` 默认用 env.BOOTSTRAP_HANDLE（部署占位）；登记后 `/auth/me` 以 D1 `users.handle` 为准。
 *
 * --------------------------------------------------------------------------
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import { withSpan, SpanName, writeCounter } from '@hailuo/otel';
import type { Env, AppVariables } from '../env';
import {
  signOwnerJWT,
  comparePasswordHashProof,
  DUMMY_PASSWORD_HASH,
} from '@hailuo/shared-crypto';
import { requireOwnerJWT } from '../middleware/auth';
import { resolveIdentityDb } from '../db/bindings';
import { resolveTrustedClientIp } from '../lib/ownerGatewayIp';
import {
  executeOwnerLogin,
  executeOwnerChangePassword,
  executeGetOwnerLoginParams,
  executeGetOwnerPasswordParams,
  executeGetOwnerMe,
  executePatchOwnerProfile,
  resolveCredentialUsername,
} from '../services/auth';
import type {
  OwnerLoginResult,
  OwnerChangePasswordResult,
  OwnerLoginParamsResult,
  OwnerPasswordParamsResult,
  OwnerMeResult,
  OwnerPatchProfileResult,
} from '../services/auth';
import { registerAuthTotpRoutes } from './authTotp';

/** system_config：首次默认 admin/admin 登录后须改用户名+密码（key 定义见 ownerCredentials） */
type AppEnv = { Bindings: Env; Variables: AppVariables };
type Ctx = Context<AppEnv>;

export const authApp = new Hono<AppEnv>();

/** JWT TTL：24 小时（秒） */
const JWT_TTL_SEC = 86400;

/** 排障开关：LOGIN_DIAG=true 时输出分支日志（禁止记录密码/JWT_SECRET 明文） */
function loginDiagEnabled(env: Env): boolean {
  return env.LOGIN_DIAG === 'true' || env.LOGIN_DIAG === '1';
}

/** @deprecated 排障请用 services/auth logger.diag；保留给 diag-pbkdf2 等探测端点 */
function loginDiag(env: Env, step: string, detail: Record<string, unknown>): void {
  if (!loginDiagEnabled(env)) return;
  console.info('[auth/login/diag/full] ' + JSON.stringify({ outcome: 'probe', step, ...detail }));
}

/** LOGIN_DIAG：仅记录长度/分支，禁止输出 password 字节或 hash 材料 */
function passwordInputDiag(_env: Env, password: string): Record<string, unknown> {
  return { passwordLen: password.length };
}

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

/** M10-3 / M10-5c / M11-6：改密成功 re-wrap 提示已迁 services/auth production adapter。 */

/** JWT 内站主登录名（oun）优先，否则回落 BOOTSTRAP_HANDLE / sub。 */
// resolveCredentialUsername 已迁 services/auth/ownerAuthUtils

// ---------------------------------------------------------------------------
// POST /auth/login
// ---------------------------------------------------------------------------

interface LoginBody {
  username?: unknown;
  /** @deprecated 明文密码已弃用；请传 password_hash（浏览器 derive 后的完整 v1 字符串） */
  password?: unknown;
  /** 客户端 PBKDF2 结果：`v1:PBKDF2:<iterations>:SHA256:<saltHex>:<hashHex>` */
  password_hash?: unknown;
  /** M12-1：已启用 TOTP 时第二步登录提交 6 位动态码 */
  totp_code?: unknown;
  /** M12-1：或提交一次性恢复码（与 totp_code 同时存在时只校验 totp_code） */
  recovery_code?: unknown;
  secret?: unknown;
}

/** 统一的"凭证错误"响应，错误码刻意与"用户名不存在"合并防枚举。 */
function authInvalid(c: Ctx): Response {
  return c.json(
    { ok: false, error_code: 'AUTH_INVALID', message: '用户名或密码错误' },
    401,
  );
}

/**
 * GET /auth/login-params — 返回 PBKDF2 salt/iterations，供浏览器 derive（公开接口）。
 */
authApp.get('/login-params', async (c) => {
  const result = await executeGetOwnerLoginParams(c.env, {
    username: c.req.query('username') ?? '',
  });
  return ownerLoginParamsResultToResponse(c, result);
});

/** NCF-2B-3：login-params result → HTTP JSON */
function ownerLoginParamsResultToResponse(c: Ctx, result: OwnerLoginParamsResult): Response {
  if (result.status === 'ok' && result.data) {
    return c.json({ ok: true, data: result.data });
  }
  return c.json(
    {
      ok: false,
      error_code: result.error_code ?? 'INTERNAL_ERROR',
      message: result.message ?? '读取登录参数失败',
    },
    result.httpStatus as 400 | 404 | 500,
  );
}

/**
 * LOGIN_DIAG 专用：确认 Worker 不再跑 PBKDF2（仅字符串比对）。
 */
authApp.get('/diag-pbkdf2', async (c) => {
  if (!loginDiagEnabled(c.env)) {
    return c.json({ ok: false, error_code: 'NOT_FOUND' }, 404);
  }
  // M-OPT-SPLIT-A7-2：owner_credentials → IDENTITY_DB
  const row = await resolveIdentityDb(c.env)
    .prepare(`SELECT password_hash FROM owner_credentials LIMIT 1`)
    .first<{ password_hash: string }>()
    .catch(() => null);
  if (!row?.password_hash) {
    return c.json({ ok: false, error_code: 'NO_CREDENTIALS' }, 404);
  }
  const wrong = comparePasswordHashProof('v1:PBKDF2:0:SHA256:00:00', row.password_hash);
  const dummy = comparePasswordHashProof(DUMMY_PASSWORD_HASH, DUMMY_PASSWORD_HASH);
  return c.json({
    ok: true,
    data: {
      worker_pbkdf2: false,
      compare_only: true,
      probe_wrong_ok: wrong,
      dummy_self_ok: dummy,
      note: 'PBKDF2 runs in browser; Worker only comparePasswordHashProof',
    },
  });
});

// ALL-AUDIT-Y-16-3：登录路径挂 withSpan（计数只用 result.status 枚举，不含 IP/用户名）
authApp.post('/login', (c) =>
  withSpan(c, SpanName.AuthLogin, async (span) => {
  span.setAttribute('http.method', 'POST');
  span.setAttribute('http.route', '/auth/login');
  // ---- 1. 解析请求体（容错：JSON 解析失败也走标准错误码） ----
  let bodyText = '';
  try {
    bodyText = await c.req.text();
  } catch {
    return c.json(
      { ok: false, error_code: 'AUTH_INVALID', message: '请求体读取失败' },
      401,
    );
  }
  let body: LoginBody;
  try {
    body = JSON.parse(bodyText) as LoginBody;
  } catch {
    return c.json(
      { ok: false, error_code: 'AUTH_INVALID', message: '请求体必须为 JSON' },
      401,
    );
  }

  const username = typeof body.username === 'string' ? body.username : '';
  const passwordHash = typeof body.password_hash === 'string' ? body.password_hash.trim() : '';
  const passwordPlain = typeof body.password === 'string' ? body.password : '';
  const legacySecret = typeof body.secret === 'string' ? body.secret : '';
  const totpCode = typeof body.totp_code === 'string' ? body.totp_code.trim() : '';
  const recoveryCode = typeof body.recovery_code === 'string' ? body.recovery_code.trim() : '';

  // ---- 2. 可信 IP 仅作频控键；NCF-2B：判定下沉 services/auth runOwnerLogin ----
  // 防身份关联：attemptKey 不得写入对外 message / JSON 回显字段。
  const attemptKey = await resolveTrustedClientIp(c, bodyText);
  const clientMeta = {
    clientIp: attemptKey,
    ipCountry: (c.req.header('CF-IPCountry') ?? '').trim().slice(0, 2) || null,
    userAgent: c.req.header('User-Agent') ?? null,
  };
  const result = await executeOwnerLogin(c.env, {
    attemptKey,
    username,
    passwordHash,
    ...(passwordPlain ? { passwordPlain } : {}),
    ...(legacySecret ? { legacySecret } : {}),
    ...(totpCode ? { totpCode } : {}),
    ...(recoveryCode ? { recoveryCode } : {}),
  });
  // metric 仅记 status 枚举（ok / invalid / locked / …），禁止写 IP / username
  writeCounter(c.env, 'auth.login', { status: result.status });
  span.setAttribute('auth.login.status', result.status);
  return ownerLoginResultToResponse(c, result, {
    ...clientMeta,
    totpCode,
    recoveryCode,
  });
  }),
);

function extractBearerToken(c: Ctx): string | null {
  const h = c.req.header('Authorization') ?? '';
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m?.[1]?.trim() || null;
}

/** 将深模块 result 映射为历史 HTTP JSON 契约；M34-1 成功时附带 session_id。 */
async function ownerLoginResultToResponse(
  c: Ctx,
  result: OwnerLoginResult,
  meta: {
    clientIp: string;
    ipCountry: string | null;
    userAgent: string | null;
    totpCode: string;
    recoveryCode: string;
  },
): Promise<Response> {
  if (result.status === 'ok' && result.data?.token) {
    const { token, expires_at, legacy_mode, must_change_credentials } = result.data;
    let sessionId: string | undefined;
    try {
      const { recordOwnerLoginSuccess } = await import('../services/ownerEngagement/sessionLifecycle');
      const sess = await recordOwnerLoginSuccess(c.env, {
        token,
        legacyMode: legacy_mode === true,
        ...(meta.totpCode ? { totpCode: meta.totpCode } : {}),
        ...(meta.recoveryCode ? { recoveryCode: meta.recoveryCode } : {}),
        clientIp: meta.clientIp,
        ipCountry: meta.ipCountry,
        userAgent: meta.userAgent,
      });
      sessionId = sess.session_id;
    } catch (err) {
      // 会话审计失败不阻断登录（JWT 已签发）
      console.warn('[auth/login] owner session record failed', err);
    }
    return c.json({
      ok: true,
      data: {
        token,
        expires_at,
        ...(legacy_mode ? { legacy_mode: true } : {}),
        ...(must_change_credentials ? { must_change_credentials: true } : {}),
        ...(sessionId ? { session_id: sessionId } : {}),
      },
    });
  }

  // M34-1：失败审计（TOTP_REQUIRED 不算失败；锁定也不记登录方法失败）
  if (
    result.status === 'invalid' ||
    result.status === 'totp_invalid' ||
    result.status === 'recovery_invalid'
  ) {
    try {
      const { recordOwnerLoginFailure } = await import('../services/ownerEngagement/sessionLifecycle');
      await recordOwnerLoginFailure(c.env, {
        loginMethod:
          result.status === 'totp_invalid'
            ? 'totp'
            : result.status === 'recovery_invalid'
              ? 'recovery'
              : 'password',
        clientIp: meta.clientIp,
        ipCountry: meta.ipCountry,
        userAgent: meta.userAgent,
      });
    } catch {
      /* 审计失败忽略 */
    }
  }

  if (result.status === 'locked') {
    return c.json(
      {
        ok: false,
        error_code: result.error_code ?? 'LOGIN_LOCKED',
        message: result.message ?? '登录失败次数过多，请稍后再试',
        ...(result.locked_until ? { locked_until: result.locked_until } : {}),
      },
      429,
    );
  }
  if (result.status === 'totp_required') {
    return c.json(
      {
        ok: false,
        error_code: 'TOTP_REQUIRED',
        message: result.message ?? '请输入二次验证码',
        data: { totp_required: true },
      },
      401,
    );
  }
  if (result.status === 'totp_invalid') {
    return c.json(
      { ok: false, error_code: 'TOTP_INVALID', message: result.message ?? '二次验证码不正确' },
      401,
    );
  }
  if (result.status === 'recovery_invalid') {
    return c.json(
      {
        ok: false,
        error_code: 'RECOVERY_CODE_INVALID',
        message: result.message ?? '恢复码无效或已使用',
      },
      401,
    );
  }
  if (result.status === 'misconfigured' || result.status === 'error') {
    return c.json(
      {
        ok: false,
        error_code: result.error_code ?? 'INTERNAL_ERROR',
        message: result.message ?? '登录暂时不可用',
      },
      500,
    );
  }
  return authInvalid(c);
}

registerAuthTotpRoutes(authApp);

// ---------------------------------------------------------------------------
// M34-1：站主会话心跳 / 登出
// ---------------------------------------------------------------------------

authApp.use('/session/heartbeat', requireOwnerJWT());
authApp.use('/logout', requireOwnerJWT());

authApp.post('/session/heartbeat', async (c) => {
  const token = extractBearerToken(c);
  if (!token) {
    return c.json({ ok: false, error_code: 'UNAUTHORIZED', message: '缺少登录凭证' }, 401);
  }
  let body: { session_id?: unknown } = {};
  try {
    body = (await c.req.json()) as { session_id?: unknown };
  } catch {
    body = {};
  }
  const sessionId = typeof body.session_id === 'string' ? body.session_id.trim() : '';
  const { heartbeatOwnerSession } = await import('../services/ownerEngagement/sessionLifecycle');
  const result = await heartbeatOwnerSession(c.env, {
    token,
    sessionId: sessionId || null,
    clientIp: await resolveTrustedClientIp(c, sessionId ? JSON.stringify(body) : '{}'),
    ipCountry: (c.req.header('CF-IPCountry') ?? '').trim().slice(0, 2) || null,
    userAgent: c.req.header('User-Agent') ?? null,
  });
  // M34-5：JWT 有效时心跳总会触达/重开会话；保留分支兼容历史 HeartbeatResult 联合类型
  if (!result.ok) {
    return c.json(
      { ok: false, error_code: result.error_code, message: result.message },
      result.httpStatus as 401 | 404,
    );
  }
  return c.json({
    ok: true,
    data: {
      session_id: result.session_id,
      owner_engagement: result.owner_engagement,
      last_seen_at: result.last_seen_at,
    },
  });
});

authApp.post('/logout', async (c) => {
  const token = extractBearerToken(c);
  if (!token) {
    return c.json({ ok: false, error_code: 'UNAUTHORIZED', message: '缺少登录凭证' }, 401);
  }
  let body: { session_id?: unknown } = {};
  try {
    body = (await c.req.json()) as { session_id?: unknown };
  } catch {
    body = {};
  }
  const sessionId = typeof body.session_id === 'string' ? body.session_id.trim() : '';
  const { logoutOwnerSession } = await import('../services/ownerEngagement/sessionLifecycle');
  const result = await logoutOwnerSession(c.env, {
    token,
    sessionId: sessionId || null,
  });
  return c.json({
    ok: true,
    data: {
      ended: result.ended,
      owner_engagement: result.owner_engagement,
    },
  });
});

// ---------------------------------------------------------------------------
// GET /auth/me（JWT 鉴权）
// ---------------------------------------------------------------------------

// 仅对 /me 应用 JWT 鉴权中间件（/login 是公开接口）
authApp.use('/me', requireOwnerJWT());

authApp.get('/me', async (c) => {
  const payload = c.get('ownerJwt');
  const result = await executeGetOwnerMe(c.env, { jwtSub: payload.sub });
  return ownerMeResultToResponse(c, result);
});

function ownerMeResultToResponse(c: Ctx, result: OwnerMeResult) {
  return c.json({ ok: true, data: result.data }, 200);
}

// ---------------------------------------------------------------------------
// PATCH /auth/profile — JWT 鉴权，更新站主公开资料（低频 D1 写）
// ---------------------------------------------------------------------------

authApp.use('/profile', requireOwnerJWT());

authApp.patch('/profile', async (c) => {
  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ ok: false, error_code: 'BAD_REQUEST', message: '请求体必须为 JSON' }, 400);
  }
  const result = await executePatchOwnerProfile(c.env, { body });
  return ownerPatchProfileResultToResponse(c, result);
});

/** NCF-2B-5：profile result → HTTP JSON */
function ownerPatchProfileResultToResponse(c: Ctx, result: OwnerPatchProfileResult): Response {
  if (result.status === 'ok' && result.data) {
    return c.json({ ok: true, data: result.data }, 200);
  }
  if (result.status === 'bad_request') {
    return c.json(
      {
        ok: false,
        error_code: result.error_code ?? 'BAD_REQUEST',
        message: result.message ?? '公开资料格式不正确',
      },
      400,
    );
  }
  if (result.status === 'use_registration_profile' || result.status === 'not_registered') {
    return c.json(
      {
        ok: false,
        error_code: result.error_code ?? 'USER_NOT_REGISTERED',
        message: result.message ?? '无法更新公开资料',
      },
      409,
    );
  }
  return c.json(
    {
      ok: false,
      error_code: result.error_code ?? 'INTERNAL_ERROR',
      message: result.message ?? '更新公开资料失败',
    },
    500,
  );
}

// ---------------------------------------------------------------------------
// GET /auth/password-params — JWT 鉴权，返回当前登录用户 PBKDF2 参数（改密用）
// ---------------------------------------------------------------------------

authApp.use('/password-params', requireOwnerJWT());

authApp.get('/password-params', async (c) => {
  const payload = c.get('ownerJwt');
  const result = await executeGetOwnerPasswordParams(c.env, {
    loginUser: resolveCredentialUsername(payload, c.env.BOOTSTRAP_HANDLE ?? payload.sub),
  });
  return ownerPasswordParamsResultToResponse(c, result);
});

/** NCF-2B-3：password-params result → HTTP JSON */
function ownerPasswordParamsResultToResponse(
  c: Ctx,
  result: OwnerPasswordParamsResult,
): Response {
  if (result.status === 'ok' && result.data) {
    return c.json({ ok: true, data: result.data });
  }
  return c.json(
    {
      ok: false,
      error_code: result.error_code ?? 'INTERNAL_ERROR',
      message: result.message ?? '读取改密参数失败',
    },
    result.httpStatus as 401 | 500,
  );
}

// ---------------------------------------------------------------------------
// POST /auth/change-password（M2-1b-4）
//
// 需求：
//   1. JWT 鉴权：必须先登录态（防止仅靠旧密码就能改密的弱口令场景）。
//   2. 旧密码二次校验（不能仅靠 JWT，避免 JWT 被盗即可改密）。
//   3. 新密码强度检查（checkPasswordStrength：≥8 字符 + 字母+数字）。
//   4. 新密码 PBKDF2-SHA256 600k 重哈希 → UPDATE D1 owner_credentials。
//   5. 兼容路径：owner_credentials 表为空时（仍处于老 secret 回落态），
//      本接口要求 oldPassword 必须等于 JWT_SECRET，校验通过后 INSERT
//      一条 owner_credentials 行（username = BOOTSTRAP_HANDLE / cred.username
//      未确定时取 ctx.ownerJwt.sub），完成从老路径到新路径的"无痛迁移"。
//
// 错误码：
//   AUTH_INVALID    — 旧密码错误
//   WEAK_PASSWORD   — 新密码强度不足（携带 reason 字段）
//   SAME_PASSWORD   — 新旧密码相同（防一些低质量"轮换"）
//   INTERNAL_ERROR  — D1 写入失败（500）
//
// 不在本接口做粉丝 Token 吊销 / 现有 JWT 吊销：站主级强制重新登录设计
// 留给独立的"全量登出"接口（M10+），本步聚焦凭证替换最小闭环。
// ---------------------------------------------------------------------------

authApp.use('/change-password', requireOwnerJWT());

interface ChangePasswordBody {
  /** 老 secret 迁移路径：明文旧 secret */
  old_password?: unknown;
  /** @deprecated 明文新密码；请传 new_password_hash */
  new_password?: unknown;
  /** 客户端 derive 的旧凭证完整 v1 字符串 */
  old_password_hash?: unknown;
  /** 客户端 derive 的新凭证完整 v1 字符串（须含新随机 salt） */
  new_password_hash?: unknown;
  /** OWNER-RENAME：新登录用户名。首次强制设置必填；普通改密可留空（留空=不改） */
  new_username?: unknown;
}

authApp.post('/change-password', async (c) => {
  let body: ChangePasswordBody;
  try {
    body = (await c.req.json()) as ChangePasswordBody;
  } catch {
    return c.json(
      { ok: false, error_code: 'AUTH_INVALID', message: '请求体必须为 JSON' },
      400,
    );
  }

  const payload = c.get('ownerJwt');
  // NCF-2B-2：改密判定下沉 services/auth runOwnerChangePassword
  const result = await executeOwnerChangePassword(c.env, {
    jwtSub: payload.sub,
    jwtOwnerUsername: payload.oun,
    bootstrapHandle: c.env.BOOTSTRAP_HANDLE,
    oldPassword: typeof body.old_password === 'string' ? body.old_password : '',
    newPassword: typeof body.new_password === 'string' ? body.new_password : '',
    oldPasswordHash:
      typeof body.old_password_hash === 'string' ? body.old_password_hash.trim() : '',
    newPasswordHash:
      typeof body.new_password_hash === 'string' ? body.new_password_hash.trim() : '',
    newUsername: typeof body.new_username === 'string' ? body.new_username.trim() : '',
  });
  return ownerChangePasswordResultToResponse(c, result);
});

/** NCF-2B-2：result → 既有 HTTP JSON */
function ownerChangePasswordResultToResponse(
  c: Ctx,
  result: OwnerChangePasswordResult,
): Response {
  if (result.status === 'ok' && result.data) {
    return c.json({ ok: true, data: result.data });
  }
  return c.json(
    {
      ok: false,
      error_code: result.error_code ?? 'INTERNAL_ERROR',
      message: result.message ?? '密码更新失败，请稍后重试',
    },
    result.httpStatus as 400 | 401 | 500,
  );
}
