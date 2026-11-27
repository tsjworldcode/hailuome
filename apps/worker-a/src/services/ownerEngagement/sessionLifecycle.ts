/**
 * M34-1：站主会话生命周期（登录审计 / 心跳 / 登出）。
 * Cron dormant 门控见 M34-2；本模块只写 D1 与 system_config。
 */
import type { Env } from '../../env';
import { createOwnerSessionsRepo } from '../../db/ownerSessionsRepo';
import {
  hashClientIp,
  jwtFingerprint,
  jwtTokenHash,
  maskClientIp,
  newOwnerLoginEventId,
  newOwnerSessionId,
  parseUserAgentFamily,
  resolveOwnerSessionTtlSec,
  type OwnerLoginMethod,
} from '../../lib/ownerSessionCrypto';

export type OwnerSessionClientMeta = {
  /** 可信客户端 IP（哈希入库；脱敏形态可出站列表；禁止完整明文回显） */
  clientIp: string;
  ipCountry: string | null;
  userAgent: string | null;
};

function saltFromEnv(env: Env): string {
  return env.JWT_SECRET?.trim() || 'hailuo-owner-session-salt';
}

function loginMethodFromFlags(input: {
  legacyMode?: boolean;
  totpCode?: string;
  recoveryCode?: string;
}): OwnerLoginMethod {
  if (input.legacyMode) return 'legacy';
  if (input.totpCode) return 'totp';
  if (input.recoveryCode) return 'recovery';
  return 'password';
}

/** 登录成功：写审计 + 开会话 + engagement=active；返回 session_id */
export async function recordOwnerLoginSuccess(
  env: Env,
  input: {
    token: string;
    legacyMode?: boolean;
    totpCode?: string;
    recoveryCode?: string;
  } & OwnerSessionClientMeta,
): Promise<{ session_id: string }> {
  const repo = createOwnerSessionsRepo(env);
  const now = new Date().toISOString();
  const sessionId = newOwnerSessionId();
  const ipHash = await hashClientIp(saltFromEnv(env), input.clientIp);
  const ipMasked = maskClientIp(input.clientIp);
  const fp = await jwtFingerprint(input.token);
  const tokenHash = await jwtTokenHash(input.token);
  const uaFamily = parseUserAgentFamily(input.userAgent);
  const method = loginMethodFromFlags(input);

  await repo.insertSession({
    session_id: sessionId,
    created_at: now,
    last_seen_at: now,
    ended_at: null,
    jwt_fingerprint: fp,
    token_hash: tokenHash,
    ip_hash: ipHash,
    ip_masked: ipMasked,
    ip_country: input.ipCountry,
    user_agent_family: uaFamily,
    channel: 'web',
  });
  await repo.insertLoginEvent({
    id: newOwnerLoginEventId(),
    logged_in_at: now,
    success: true,
    login_method: method,
    ip_hash: ipHash,
    ip_country: input.ipCountry,
    user_agent_family: uaFamily,
    session_id: sessionId,
  });
  await repo.putEngagement('active', now);
  return { session_id: sessionId };
}

/** 登录失败审计（不含明文 IP） */
export async function recordOwnerLoginFailure(
  env: Env,
  input: {
    loginMethod: OwnerLoginMethod;
  } & OwnerSessionClientMeta,
): Promise<void> {
  const repo = createOwnerSessionsRepo(env);
  const now = new Date().toISOString();
  const ipHash = await hashClientIp(saltFromEnv(env), input.clientIp);
  await repo.insertLoginEvent({
    id: newOwnerLoginEventId(),
    logged_in_at: now,
    success: false,
    login_method: input.loginMethod,
    ip_hash: ipHash,
    ip_country: input.ipCountry,
    user_agent_family: parseUserAgentFamily(input.userAgent),
    session_id: null,
  });
}

export type HeartbeatResult =
  | { ok: true; session_id: string; owner_engagement: 'active'; last_seen_at: string }
  | { ok: false; error_code: string; message: string; httpStatus: number };

/** 按 JWT 指纹触达或新开活跃会话（旧窗超时则结束并重开） */
async function touchOrOpenSessionForJwt(
  env: Env,
  repo: ReturnType<typeof createOwnerSessionsRepo>,
  input: {
    token: string;
    fp: string;
    now: string;
    cutoff: string;
  } & OwnerSessionClientMeta,
): Promise<string> {
  const existing = await repo.findLatestOpenByFingerprint(input.fp);
  if (existing && existing.last_seen_at >= input.cutoff) {
    await repo.touchSession(existing.session_id, input.now);
    return existing.session_id;
  }
  if (existing) {
    await repo.endSession(existing.session_id, input.now, input.fp);
  }
  const sessionId = newOwnerSessionId();
  const ipHash = await hashClientIp(saltFromEnv(env), input.clientIp);
  const tokenHash = await jwtTokenHash(input.token);
  await repo.insertSession({
    session_id: sessionId,
    created_at: input.now,
    last_seen_at: input.now,
    ended_at: null,
    jwt_fingerprint: input.fp,
    token_hash: tokenHash,
    ip_hash: ipHash,
    ip_masked: maskClientIp(input.clientIp),
    ip_country: input.ipCountry,
    user_agent_family: parseUserAgentFamily(input.userAgent),
    channel: 'web',
  });
  return sessionId;
}

/**
 * JWT 心跳：更新 last_seen_at；无会话则按指纹续开。
 * M34-5：客户端带着已超时/已结束的 session_id 时，在 JWT 仍有效前提下自动重开会话，
 * 不再返回 SESSION_EXPIRED / SESSION_NOT_FOUND（避免「还登录着却永久 dormant」）。
 */
export async function heartbeatOwnerSession(
  env: Env,
  input: {
    token: string;
    sessionId?: string | null;
  } & OwnerSessionClientMeta,
): Promise<HeartbeatResult> {
  const repo = createOwnerSessionsRepo(env);
  const now = new Date().toISOString();
  const fp = await jwtFingerprint(input.token);
  const ttlSec = resolveOwnerSessionTtlSec(env.OWNER_SESSION_TTL_SEC);
  const cutoff = new Date(Date.now() - ttlSec * 1000).toISOString();
  const clientMeta = {
    clientIp: input.clientIp,
    ipCountry: input.ipCountry,
    userAgent: input.userAgent,
  };

  let sessionId = (input.sessionId ?? '').trim();
  if (sessionId) {
    const row = await repo.findOpenById(sessionId);
    if (row && row.jwt_fingerprint === fp && row.last_seen_at >= cutoff) {
      await repo.touchSession(sessionId, now);
    } else {
      // 旧 id 失效或指纹不符：结束本行（若仍 open）并按 JWT 重开，不卡死 dormant
      if (row && row.jwt_fingerprint === fp) {
        await repo.endSession(sessionId, now, fp);
      }
      sessionId = await touchOrOpenSessionForJwt(env, repo, {
        token: input.token,
        fp,
        now,
        cutoff,
        ...clientMeta,
      });
    }
  } else {
    sessionId = await touchOrOpenSessionForJwt(env, repo, {
      token: input.token,
      fp,
      now,
      cutoff,
      ...clientMeta,
    });
  }

  await repo.putEngagement('active', now);
  return {
    ok: true,
    session_id: sessionId,
    owner_engagement: 'active',
    last_seen_at: now,
  };
}

export type LogoutResult = {
  ended: boolean;
  owner_engagement: 'active' | 'dormant';
};

/** 结束当前会话；若无其它活跃会话则 engagement→dormant */
export async function logoutOwnerSession(
  env: Env,
  input: { token: string; sessionId?: string | null },
): Promise<LogoutResult> {
  const repo = createOwnerSessionsRepo(env);
  const now = new Date().toISOString();
  const fp = await jwtFingerprint(input.token);
  const ttlSec = resolveOwnerSessionTtlSec(env.OWNER_SESSION_TTL_SEC);
  const cutoff = new Date(Date.now() - ttlSec * 1000).toISOString();

  let ended = false;
  const sid = (input.sessionId ?? '').trim();
  if (sid) {
    ended = await repo.endSession(sid, now, fp);
  } else {
    const row = await repo.findLatestOpenByFingerprint(fp);
    if (row) {
      ended = await repo.endSession(row.session_id, now, fp);
    }
  }

  const stillActive = await repo.countOpenSessionsSeenAfter(cutoff);
  const engagement = stillActive > 0 ? 'active' : 'dormant';
  await repo.putEngagement(engagement, stillActive > 0 ? now : null);
  return { ended, owner_engagement: engagement };
}

/** M34-2 Cron 将调用：无心跳窗口内会话 → dormant */
export async function readOwnerEngagementForCron(env: Env): Promise<'active' | 'dormant' | 'unknown'> {
  const repo = createOwnerSessionsRepo(env);
  const ttlSec = resolveOwnerSessionTtlSec(env.OWNER_SESSION_TTL_SEC);
  const cutoff = new Date(Date.now() - ttlSec * 1000).toISOString();
  const n = await repo.countOpenSessionsSeenAfter(cutoff);
  if (n > 0) return 'active';
  const snap = await repo.readEngagement();
  if (snap.engagement === 'unknown' && !snap.last_seen_at) return 'unknown';
  return 'dormant';
}
