/**
 * 注册相关路由（M1-0a）。
 *
 * registerApp 挂在 /api/local/* ：
 *   POST /api/local/email-verify-request  — 代理注册中心发送邮箱验证码
 *   POST /api/local/email-verify-confirm  — 代理验证码校验，换取 email_verify_token
 *   POST /api/local/register              — 代理 precheck（创建注册 challenge）
 *   POST /api/local/register/bootstrap-outbound-template — 路径 D 邮件模板（加密+proof）
 *   前端须携带 handle / pubkey / node_url / email / terms_accepted / turnstile_token；
 *   email 必填且须通过内置白名单 v1
 *   2026-09-27：移除 age_over_18 要求
 *   R-MSG-3b-1：phone 停止采集/上送（旧 users.phone 列可留本地）
 *   R-MSG-3b-3：birth_date / country / gender 停止采集/上送
 *   SPILL-1c-node-a：登记 PATCH 不再接受人口学；公开资料/me/KV 不再投影人口学
 *
 * wellKnownApp 挂在 /.well-known/* ：
 *   GET  /.well-known/hailuo-proof        — 本地 CLI 联调（JSON）；生产注册中心回访 Worker B
 *
 * 生产 proof 暴露于 Worker B `GET /.well-known/hailuo-registry-proof`（纯文本），
 * 内容由本模块 register/complete 写入共享 STATE_KV。
 *
 * 转发策略：原样透传请求 body，原样透传响应 status + body。
 * 注册中心不可达时统一返回 502 REGISTRY_UNAVAILABLE。
 *
 * /.well-known/hailuo-proof 所需的 proof 数据由 scripts/register.mjs（M1-1a）
 * 在调用 challenge/verify 前写入 D1 system_config，无需额外表。
 */

import { resolveIdentityDb } from '../db/bindings';
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env } from '../env';
import { requireDevOnly } from '../ingress';
import { syncRegistryDailyOnRegistration } from '../handlers/registryDailySync';
import { prepareDailySyncSchedulePersist } from '../lib/dailySyncScheduleConfig';
import {
  activatePendingRegistryEndpoint,
  persistRegistryEndpoints0,
  readRegistryEndpoints,
  type RegistryIdentityPayload,
} from '../lib/registryEndpoints';
import { readRegisteredRegistry } from '../lib/registeredRegistries';
import { syncRegistryEndpointsToKv } from '../handlers/registryEndpointsKvSync';
import { resolveRegistrationRegistryUrl, withRegistrationIntakeRetry } from '../lib/registryRouter';
import { acceptPresentedBootstrapManifest } from '../lib/bootstrapIntake';
import { resolveBootstrapUrlCandidates } from '../lib/bootstrapIntakeTrustAnchor';
import {
  canonicalizeHandleQualified,
  formatQualifiedHandle,
} from '../lib/handleQualified';
import {
  buildOutboundEmailTemplate,
  computePubkeyFingerprint,
  signMessage,
  ed25519PubkeyHexToRegistryBase64,
  ed25519SignatureHexToRegistryBase64,
  pubkeyHexToDidV2,
} from '@hailuo/shared-crypto';
import {
  REGISTRY_PROOF_KV_KEY,
  REGISTRY_PROOF_KV_TTL_SEC,
} from '@hailuo/shared-types';
import {
  validateTermsAcceptance,
  validateRegisterPrecheckEmail,
  isValidRegisterHandleLocal,
  isReservedHandlePrefix,
  HANDLE_LOCAL_RULES_USER_MESSAGE_ZH,
  HANDLE_RESERVED_USER_MESSAGE_ZH,
  deriveCertInboundHostFromRegistryUrl,
} from '@hailuo/shared-utils';
import {
  executeRegisterComplete,
  createProductionRegisterCompleteDeps,
  type RegisterCompleteResult,
} from '../services/registration';
import { normalizePublicBaseUrl } from '../lib/localPublicBaseUrl';
import {
  hailuoClientIpHeaders,
  readRegistrationForwardClientIp,
} from '../lib/registrationClientIp';

// 转发超时：10 秒
const REGISTRY_TIMEOUT_MS = 10_000;

type RegisterPrecheckCompliance = {
  /** 2026-09-27：移除 age_over_18 */
  terms_accepted_at: string;
  terms_version: string;
};

/** 解析并校验注册合规字段。2026-09-27：仅校验 terms；移除 age_over_18。 */
function parseRegisterPrecheckCompliance(raw: {
  age_over_18?: unknown; // 保留兼容性：忽略旧客户端可能发送的字段
  terms_accepted?: unknown;
  terms_version?: unknown;
}): { ok: true; value: RegisterPrecheckCompliance } | { ok: false; error_code: string; message: string; status: number } {
  // 2026-09-27：不再校验 age_over_18
  const termsParsed = validateTermsAcceptance(raw.terms_accepted, raw.terms_version);
  if (!termsParsed.ok) {
    return {
      ok: false,
      error_code: termsParsed.error.code,
      message: termsParsed.error.message,
      status: termsParsed.error.status ?? 403,
    };
  }
  return {
    ok: true,
    value: {
      terms_accepted_at: termsParsed.terms_accepted_at,
      terms_version: termsParsed.terms_version,
    },
  };
}

function appendPrecheckCompliance(
  target: Record<string, string | boolean>,
  compliance: RegisterPrecheckCompliance,
): void {
  // 2026-09-27：不再上送 age_over_18
  target.terms_accepted = true;
  target.terms_version = compliance.terms_version;
}

export const registerApp = new Hono<{ Bindings: Env }>();
export const wellKnownApp = new Hono<{ Bindings: Env }>();

// ---------------------------------------------------------------------------
// 代理助手
// ---------------------------------------------------------------------------

/**
 * 将 body 以 POST 方式转发给注册中心指定路径，返回 { status, data }。
 * fetch 失败（超时 / 网络错误）时返回 502 REGISTRY_UNAVAILABLE。
 */
async function proxyPost(
  registryUrl: string,
  path: string,
  body: unknown,
  extraHeaders?: Record<string, string>,
): Promise<{ status: number; data: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REGISTRY_TIMEOUT_MS);
  try {
    const upstream = await fetch(`${registryUrl}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(extraHeaders ?? {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const data: unknown = await upstream.json();
    return { status: upstream.status, data };
  } catch (err) {
    console.error(`[register/proxy] ${path} failed`, err);
    return {
      status: 502,
      data: { ok: false, error_code: 'REGISTRY_UNAVAILABLE', message: 'registry is unreachable' },
    };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// POST /api/local/email-verify-request
// 向注册邮箱发送 6 位验证码（代理注册中心，60s 冷却）
// ---------------------------------------------------------------------------
registerApp.post('/email-verify-request', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error_code: 'BAD_REQUEST', message: 'invalid JSON body' }, 400);
  }
  const { status, data } = await withRegistrationIntakeRetry(c.env, (registryUrl) =>
    proxyPost(registryUrl, '/api/register/email-verify-request', body),
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return c.json(data, status as any);
});

// ---------------------------------------------------------------------------
// POST /api/local/email-verify-confirm
// 校验 6 位验证码，返回 email_verify_token（10 分钟有效）
// ---------------------------------------------------------------------------
registerApp.post('/email-verify-confirm', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error_code: 'BAD_REQUEST', message: 'invalid JSON body' }, 400);
  }
  const { status, data } = await withRegistrationIntakeRetry(c.env, (registryUrl) =>
    proxyPost(registryUrl, '/api/register/email-verify-confirm', body),
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return c.json(data, status as any);
});

// ---------------------------------------------------------------------------
// 浏览器直接向入口领取接待说明后，把原文交给节点再验签。节点不代拉入口。
// ---------------------------------------------------------------------------
registerApp.get('/register/bootstrap-targets', (c) => {
  const urls = resolveBootstrapUrlCandidates(c.env.BOOTSTRAP_URL_CANDIDATES ?? null);
  return c.json({ ok: true, data: { urls } });
});

registerApp.post('/register/intake', async (c) => {
  let body: { manifest?: unknown; avoid_registry_id?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error_code: 'BAD_REQUEST', message: 'invalid JSON body' }, 400);
  }
  if (typeof body.manifest !== 'string') {
    return c.json({ ok: false, error_code: 'BAD_REQUEST', message: '缺少入口说明原文' }, 400);
  }
  const avoid = typeof body.avoid_registry_id === 'string' ? body.avoid_registry_id.trim() : '';
  if (avoid.includes('://') || avoid.includes('/')) {
    return c.json({ ok: false, error_code: 'BOOTSTRAP_AVOID_REGISTRY_INVALID', message: '避开参数无效' }, 400);
  }
  const result = await acceptPresentedBootstrapManifest({
    db: resolveIdentityDb(c.env),
    manifestText: body.manifest,
    avoidRegistryId: avoid || undefined,
    urlCandidatesOverride: c.env.BOOTSTRAP_URL_CANDIDATES ?? null,
  });
  if (!result.ok) {
    return c.json({ ok: false, error_code: result.error_code, message: result.message }, 400);
  }
  return c.json({
    ok: true,
    data: {
      registry_id: result.intake.registry_id,
      registry_url: result.intake.registry_url,
    },
  });
});

// ---------------------------------------------------------------------------
// POST /api/local/register
// 代理注册中心 precheck：创建注册 challenge
// 方案 B：前端须携带 handle / pubkey / node_url / email / turnstile_token；email_verify_token 可选且默认不传
// ---------------------------------------------------------------------------
registerApp.post('/register', async (c) => {
  let bodyText = '';
  try {
    bodyText = await c.req.text();
  } catch {
    return c.json({ ok: false, error_code: 'BAD_REQUEST', message: 'invalid JSON body' }, 400);
  }
  let body: unknown;
  try {
    body = JSON.parse(bodyText) as unknown;
  } catch {
    return c.json({ ok: false, error_code: 'BAD_REQUEST', message: 'invalid JSON body' }, 400);
  }
  const clientIp = await readRegistrationForwardClientIp(c, bodyText);
  const { status, data } = await withRegistrationIntakeRetry(c.env, (registryUrl) =>
    proxyPost(
      registryUrl,
      '/api/register/precheck',
      body,
      hailuoClientIpHeaders(clientIp),
    ),
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return c.json(data, status as any);
});

// ---------------------------------------------------------------------------
// POST /api/local/setup-proof
// 将 precheck 返回的 challenge_id + nonce + pubkey_fingerprint 写入 D1
// 供 /.well-known/hailuo-proof 在注册中心回访时响应。
//
// NCF-INGRESS-1：dev-only — requireDevOnly（WORKER_A_DEV_ORIGIN）；禁止挂站主 JWT。
// ---------------------------------------------------------------------------
registerApp.use('/setup-proof', requireDevOnly());
registerApp.post('/setup-proof', async (c) => {
  let body: { challenge_id?: string; nonce?: string; pubkey_fingerprint?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error_code: 'BAD_REQUEST', message: 'invalid JSON body' }, 400);
  }
  const { challenge_id, nonce, pubkey_fingerprint } = body;
  if (!challenge_id || !nonce || !pubkey_fingerprint) {
    return c.json({ ok: false, error_code: 'BAD_REQUEST', message: '缺少必填字段：challenge_id / nonce / pubkey_fingerprint' }, 400);
  }
  const isoNow = new Date().toISOString();
  const db = resolveIdentityDb(c.env);
  await db.batch([
    db.prepare(`INSERT OR REPLACE INTO system_config(key, value, updated_at) VALUES('proof_challenge_id', ?, ?)`)
      .bind(challenge_id, isoNow),
    db.prepare(`INSERT OR REPLACE INTO system_config(key, value, updated_at) VALUES('proof_nonce', ?, ?)`)
      .bind(nonce, isoNow),
    db.prepare(`INSERT OR REPLACE INTO system_config(key, value, updated_at) VALUES('proof_pubkey_fingerprint', ?, ?)`)
      .bind(pubkey_fingerprint, isoNow),
  ]);
  await c.env.STATE_KV.put(REGISTRY_PROOF_KV_KEY, `${challenge_id}.${nonce}`, {
    expirationTtl: REGISTRY_PROOF_KV_TTL_SEC,
  });
  return c.json({ ok: true, message: 'proof 数据已写入 D1 system_config 与 STATE_KV' });
});

// ---------------------------------------------------------------------------
// POST /api/local/save-node-creds
// 注册成功后将 node_api_token + owner_user_id 写入 D1 system_config。
//
// NCF-INGRESS-1：dev-only — requireDevOnly；生产请用 wrangler d1 execute。
// ---------------------------------------------------------------------------
registerApp.use('/save-node-creds', requireDevOnly());
registerApp.post('/save-node-creds', async (c) => {
  let body: {
    user_id?: string;
    node_api_token?: string;
    registry_identity?: RegistryIdentityPayload;
    registry_signature?: string;
    suggested_daily_sync_utc_second_of_day?: number;
    sync_interval_days?: number;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error_code: 'BAD_REQUEST', message: 'invalid JSON body' }, 400);
  }
  const {
    user_id,
    node_api_token,
    registry_identity,
    registry_signature,
    suggested_daily_sync_utc_second_of_day,
    sync_interval_days,
  } = body;
  if (!user_id || !node_api_token) {
    return c.json({ ok: false, error_code: 'BAD_REQUEST', message: '缺少必填字段：user_id / node_api_token' }, 400);
  }
  const isoNow = new Date().toISOString();
  try {
    if (registry_identity && registry_signature) {
      const registryUrl = await resolveRegistrationRegistryUrl(c.env);
      if (!registryUrl) {
        return c.json(
          { ok: false, error_code: 'BOOTSTRAP_INTAKE_REQUIRED', message: '请先由浏览器向入口领取接待说明' },
          409,
        );
      }
      await persistRegistryEndpoints0(
        c.env,
        resolveIdentityDb(c.env),
        registry_identity,
        registry_signature,
        user_id,
        node_api_token,
        isoNow,
        registryUrl,
      );
      await syncRegistryEndpointsToKv(c.env);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === 'REGISTRY_IDENTITY_INVALID') {
      return c.json(
        { ok: false, error_code: 'REGISTRY_IDENTITY_INVALID', message: '注册中心身份签名无效' },
        400,
      );
    }
    if (msg === 'REGISTRY_TRUST_ANCHOR_MISMATCH') {
      return c.json(
        {
          ok: false,
          error_code: 'REGISTRY_TRUST_ANCHOR_MISMATCH',
          message: '注册中心身份与节点钉死的主中心信任锚不匹配',
        },
        400,
      );
    }
    console.error('[register/save-node-creds] persist registry_endpoints failed', err);
    return c.json({ ok: false, error_code: 'INTERNAL_ERROR', message: '写入 registry_endpoints 失败' }, 500);
  }
  const schedulePersist = await prepareDailySyncSchedulePersist(
    c.env,
    user_id,
    suggested_daily_sync_utc_second_of_day,
    isoNow,
    { route: 'save-node-creds' },
    sync_interval_days,
  );
  // system_config 同库 batch（含 schedulePersist.statements，均走 IDENTITY）
  const { prepareNodeApiTokenForDb } = await import('../lib/nodeApiTokenAtRest');
  const sealedToken = await prepareNodeApiTokenForDb(c.env, node_api_token);
  const db = resolveIdentityDb(c.env);
  await db.batch([
    db.prepare(`INSERT OR REPLACE INTO system_config(key, value, updated_at) VALUES('node_api_token', ?, ?)`)
      .bind(sealedToken, isoNow),
    db.prepare(`INSERT OR REPLACE INTO system_config(key, value, updated_at) VALUES('owner_user_id', ?, ?)`)
      .bind(user_id, isoNow),
    ...schedulePersist.statements,
  ]);
  return c.json({ ok: true, message: 'node_api_token + owner_user_id 已写入 D1 system_config' });
});

// ---------------------------------------------------------------------------
// POST /api/local/register/complete
// JWT 鉴权：站主在 Web 端完成注册中心全流程（precheck → proof → challenge/verify → 写 users）
// 私钥仅在 Worker A 边缘签名，不下发浏览器。
// ---------------------------------------------------------------------------
registerApp.post('/register/complete', async (c) => {
  // 中间件在 index.ts 对 /api/local/register/complete 单独挂 requireOwnerJWT
  // NCF-2C：HTTP 解析留在路由；编排进 services/registration
  // 先读原始正文，站主通道验签才能对上客户地址。
  let bodyText = '';
  try {
    bodyText = await c.req.text();
  } catch {
    return c.json({ ok: false, error_code: 'BAD_REQUEST', message: 'invalid JSON body' }, 400);
  }
  let body: {
    handle?: string;
    display_name?: string;
    email?: string;
    email_verify_token?: string;
    turnstile_token?: string;
    /** 2026-09-27：忽略此字段，不再校验 */
    age_over_18?: boolean;
    terms_accepted?: boolean;
    terms_version?: string;
    browser_relay?: {
      phase?: string;
      upstream_status?: number;
      upstream_body?: unknown;
    };
  };
  try {
    body = JSON.parse(bodyText) as typeof body;
  } catch {
    return c.json({ ok: false, error_code: 'BAD_REQUEST', message: 'invalid JSON body' }, 400);
  }
  if (!body || typeof body !== 'object') {
    return c.json({ ok: false, error_code: 'BAD_REQUEST', message: 'invalid JSON body' }, 400);
  }

  const handleRaw = body.handle?.trim();
  const turnstile_token = body.turnstile_token?.trim();
  const display_name = (body.display_name ?? '').trim();

  if (!handleRaw || !turnstile_token) {
    return c.json(
      { ok: false, error_code: 'BAD_REQUEST', message: '缺少必填字段：handle / turnstile_token' },
      400,
    );
  }

  const emailParsed = validateRegisterPrecheckEmail(body.email);
  if (!emailParsed.ok) {
    return c.json(
      {
        ok: false,
        error_code: emailParsed.error.code,
        message: emailParsed.error.message,
      },
      (emailParsed.error.status ?? 400) as 400 | 403,
    );
  }
  const email = emailParsed.value;
  const email_verify_token = body.email_verify_token?.trim() || undefined;

  const complianceParsed = parseRegisterPrecheckCompliance(body);
  if (!complianceParsed.ok) {
    return c.json(
      { ok: false, error_code: complianceParsed.error_code, message: complianceParsed.message },
      complianceParsed.status as 400 | 403,
    );
  }

  // 与注册中心 HANDLE_RE 对齐：小写，下划线转连字符
  const handle = handleRaw.toLowerCase().replace(/_/g, '-');

  // M9-PH-4b：登记写路径本地预检（保留前缀 + 格式）；权威仍在注册中心
  if (isReservedHandlePrefix(handle)) {
    return c.json(
      {
        ok: false,
        error_code: 'REGISTER_HANDLE_RESERVED',
        message: HANDLE_RESERVED_USER_MESSAGE_ZH,
      },
      400,
    );
  }
  if (!isValidRegisterHandleLocal(handle)) {
    return c.json(
      {
        ok: false,
        error_code: 'REGISTER_HANDLE_INVALID',
        message: HANDLE_LOCAL_RULES_USER_MESSAGE_ZH,
      },
      400,
    );
  }

  const relayPhase = body.browser_relay?.phase;
  const browser = relayPhase === 'prepare' || relayPhase === 'precheck_result' || relayPhase === 'verify_result'
    ? {
      phase: relayPhase as 'prepare' | 'precheck_result' | 'verify_result',
      upstreamStatus: body.browser_relay?.upstream_status,
      upstreamBody: body.browser_relay?.upstream_body,
    }
    : undefined;

  const clientIp = await readRegistrationForwardClientIp(c, bodyText);
  const result = await executeRegisterComplete(c.env, {
    handle,
    displayName: display_name,
    email,
    emailVerifyToken: email_verify_token,
    turnstileToken: turnstile_token,
    compliance: complianceParsed.value,
    browser,
  }, clientIp);

  if (result.status === 'ok' && result.flags?.needInitialDailySync) {
    // M-DS-1：登记完成后立即 daily-sync；失败不影响登记结果。ExecutionContext 仅在路由层。
    c.executionCtx.waitUntil(
      syncRegistryDailyOnRegistration(c.env).catch((err) => {
        console.error('[register/complete] registry daily-sync initial failed', err);
      }),
    );
  }

  return registerCompleteResultToResponse(c, result);
});

/** NCF-2C：result → 既有 HTTP JSON（含上游透传） */
function registerCompleteResultToResponse(
  c: Context<{ Bindings: Env }>,
  result: RegisterCompleteResult,
): Response {
  if (result.status === 'ok' && result.data) {
    return c.json({ ok: true, data: result.data });
  }
  if (result.status === 'browser_relay' && result.relay) {
    return c.json({ ok: true, data: { relay: result.relay } });
  }
  if (result.status === 'registry_upstream' && result.upstreamBody !== undefined) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return c.json(result.upstreamBody, result.httpStatus as any);
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return c.json(
    {
      ok: false,
      error_code: result.error_code ?? 'INTERNAL_ERROR',
      message: result.message ?? '登记失败',
    },
    result.httpStatus as any,
  );
}
// ---------------------------------------------------------------------------
// POST /api/local/register/append-complete
// 站主已在主注册中心登记后，向 pending 备用中心追加 access 登记（M9-3-7 / M9-3-I3）。
// ---------------------------------------------------------------------------
registerApp.post('/register/append-complete', async (c) => {
  let body: {
    registry_id?: string;
    turnstile_token?: string;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error_code: 'BAD_REQUEST', message: 'invalid JSON body' }, 400);
  }

  const registry_id = body.registry_id?.trim();
  const turnstile_token = body.turnstile_token?.trim();

  if (!registry_id || !turnstile_token) {
    return c.json(
      { ok: false, error_code: 'BAD_REQUEST', message: '缺少必填字段：registry_id / turnstile_token' },
      400,
    );
  }

  const pubkeyHex = c.env.ED25519_PUBLIC_KEY;
  const privateKey = c.env.ED25519_PRIVATE_KEY;
  const node_url = c.env.WORKER_B_URL;
  if (!pubkeyHex || !privateKey || !node_url) {
    return c.json(
      { ok: false, error_code: 'MISCONFIGURED', message: '节点密钥或 Worker B 地址未配置' },
      500,
    );
  }

  const userRow = await resolveIdentityDb(c.env).prepare(
    `SELECT handle, display_name FROM users LIMIT 1`,
  ).first<{ handle: string; display_name: string }>().catch(() => null);
  if (!userRow) {
    return c.json(
      { ok: false, error_code: 'NOT_REGISTERED', message: '请先在主注册中心完成登记' },
      409,
    );
  }

  const homeReg = await readRegisteredRegistry(resolveIdentityDb(c.env));
  if (!homeReg) {
    return c.json(
      { ok: false, error_code: 'NOT_REGISTERED', message: '缺少已登记主注册中心，无法追加 access' },
      409,
    );
  }

  const endpoints = await readRegistryEndpoints(resolveIdentityDb(c.env));
  const pending = endpoints.find((e) => e.registry_id === registry_id);
  if (!pending) {
    return c.json(
      { ok: false, error_code: 'REGISTRY_ENDPOINT_NOT_FOUND', message: '未找到该注册中心配置' },
      404,
    );
  }
  if (pending.status !== 'pending') {
    return c.json(
      { ok: false, error_code: 'REGISTRY_ALREADY_ACTIVE', message: '该注册中心已完成登记或不可追加' },
      409,
    );
  }

  const handle = userRow.handle;
  const display_name = userRow.display_name ?? '';

  let pubkeyRegistryB64: string;
  try {
    pubkeyRegistryB64 = ed25519PubkeyHexToRegistryBase64(pubkeyHex);
  } catch (err) {
    console.error('[register/append-complete] invalid ED25519_PUBLIC_KEY', err);
    return c.json(
      { ok: false, error_code: 'MISCONFIGURED', message: '节点公钥格式无效（须为 32 字节 raw hex）' },
      500,
    );
  }

  let did_v2: string;
  try {
    did_v2 = await pubkeyHexToDidV2(pubkeyHex);
  } catch (err) {
    console.error('[register/append-complete] did_v2 derive failed', err);
    return c.json({ ok: false, error_code: 'INTERNAL_ERROR', message: 'DID v2 派生失败' }, 500);
  }

  // M9-3-I3：备用中心走 access，不在对方中心创建第二份权威 users
  const registryUrl = pending.registry_url.replace(/\/$/, '');
  const pre = await proxyPost(registryUrl, '/api/register/access/precheck', {
    handle,
    pubkey: pubkeyRegistryB64,
    node_url,
    did_v2,
    home_registry_id: homeReg.registry_id,
    home_user_id: homeReg.owner_user_id,
    turnstile_token,
  });
  if (pre.status < 200 || pre.status >= 300) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return c.json(pre.data, pre.status as any);
  }

  const preData = pre.data as { ok?: boolean; data?: { challenge_id?: string; nonce?: string } };
  const challenge_id = preData.data?.challenge_id;
  const nonce = preData.data?.nonce;
  if (!challenge_id || !nonce) {
    return c.json(
      { ok: false, error_code: 'REGISTRY_ERROR', message: 'access/precheck 未返回 challenge_id / nonce' },
      502,
    );
  }

  const proofBody = `${challenge_id}.${nonce}`;
  try {
    await c.env.STATE_KV.put(REGISTRY_PROOF_KV_KEY, proofBody, {
      expirationTtl: REGISTRY_PROOF_KV_TTL_SEC,
    });
  } catch (err) {
    console.error('[register/append-complete] STATE_KV proof write failed', err);
    return c.json(
      { ok: false, error_code: 'INTERNAL_ERROR', message: 'proof 暂存失败，请稍后重试' },
      500,
    );
  }

  let signatureHex: string;
  try {
    signatureHex = await signMessage(`${challenge_id}.${nonce}`, privateKey);
  } catch (err) {
    console.error('[register/append-complete] sign failed', err);
    return c.json({ ok: false, error_code: 'SIGN_FAILED', message: 'challenge 签名失败' }, 500);
  }

  let signatureRegistryB64: string;
  try {
    signatureRegistryB64 = ed25519SignatureHexToRegistryBase64(signatureHex);
  } catch (err) {
    console.error('[register/append-complete] signature encode failed', err);
    return c.json({ ok: false, error_code: 'SIGN_FAILED', message: 'challenge 签名编码失败' }, 500);
  }

  const verify = await proxyPost(registryUrl, '/api/register/access/verify', {
    challenge_id,
    signature: signatureRegistryB64,
    did_v2,
    home_user_id: homeReg.owner_user_id,
  });
  if (verify.status < 200 || verify.status >= 300) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return c.json(verify.data, verify.status as any);
  }

  await c.env.STATE_KV.delete(REGISTRY_PROOF_KV_KEY).catch((err) => {
    console.error('[register/append-complete] STATE_KV proof cleanup failed', err);
  });

  const verifyData = verify.data as {
    ok?: boolean;
    data?: {
      user_id?: string;
      credential_id?: string;
      principal_id?: string;
      registration_mode?: string;
      home_registry_id?: string;
      handle_qualified?: string;
      node_api_token?: string;
      did_v2?: string;
      registry_identity?: RegistryIdentityPayload;
      registry_signature?: string;
    };
  };
  const credential_id = verifyData.data?.credential_id ?? verifyData.data?.principal_id ?? verifyData.data?.user_id;
  const node_api_token = verifyData.data?.node_api_token;
  const registry_identity = verifyData.data?.registry_identity;
  const registry_signature = verifyData.data?.registry_signature;
  if (!credential_id || !node_api_token) {
    return c.json(
      { ok: false, error_code: 'REGISTRY_ERROR', message: 'access/verify 未返回 credential_id / node_api_token' },
      502,
    );
  }
  if (!registry_identity || !registry_signature) {
    return c.json(
      { ok: false, error_code: 'REGISTRY_ERROR', message: 'access/verify 未返回 registry_identity / registry_signature' },
      502,
    );
  }
  if (verifyData.data?.did_v2 && verifyData.data.did_v2 !== did_v2) {
    return c.json(
      { ok: false, error_code: 'REGISTRY_DID_MISMATCH', message: '注册中心返回的 did_v2 与本地派生不一致' },
      502,
    );
  }

  const isoNow = new Date().toISOString();
  try {
    await activatePendingRegistryEndpoint(
      c.env,
      resolveIdentityDb(c.env),
      registry_id,
      registry_identity,
      registry_signature,
      credential_id,
      node_api_token,
      isoNow,
      {
        registration_mode: 'access',
        home_registry_id: verifyData.data?.home_registry_id ?? homeReg.registry_id,
        principal_id: credential_id,
        principal_did: did_v2,
      },
    );
    await syncRegistryEndpointsToKv(c.env);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === 'REGISTRY_IDENTITY_INVALID') {
      return c.json(
        { ok: false, error_code: 'REGISTRY_IDENTITY_INVALID', message: '注册中心身份签名无效，登记已中止' },
        502,
      );
    }
    if (msg === 'REGISTRY_IDENTITY_MISMATCH') {
      return c.json(
        { ok: false, error_code: 'REGISTRY_IDENTITY_MISMATCH', message: '注册中心身份与节点配置不一致' },
        502,
      );
    }
    console.error('[register/append-complete] persist registry_endpoints failed', err);
    return c.json({ ok: false, error_code: 'INTERNAL_ERROR', message: '更新 registry_endpoints 失败' }, 500);
  }

  {
    const db = resolveIdentityDb(c.env);
    await db.batch([
      db.prepare(`INSERT OR REPLACE INTO system_config(key, value, updated_at) VALUES('did_v2', ?, ?)`)
        .bind(did_v2, isoNow),
    ]);
  }
  return c.json({
    ok: true,
    data: {
      registry_id,
      registry_url: registryUrl,
      handle,
      display_name,
      credential_id,
      registration_mode: 'access',
      handle_qualified: verifyData.data?.handle_qualified
        ? canonicalizeHandleQualified(verifyData.data.handle_qualified)
        : null,
      did_v2,
      message: '备用注册中心 access 登记完成（未创建第二份权威 users）',
    },
  });
});

// ---------------------------------------------------------------------------
// POST /api/local/register/bootstrap-outbound-template
// M9-PH-BO-1 / 路径 D：Worker A 持有 Ed25519 私钥，组 RSA-OAEP+AES-GCM 密文邮件模板；
// 同时写入 proof（D1 + STATE_KV），供中心 J1-a1 后 fetchNodeProof 回访。
// ---------------------------------------------------------------------------
registerApp.post('/register/bootstrap-outbound-template', async (c) => {
  let body: {
    handle?: string;
    email?: string;
    display_name?: string;
    terms_accepted?: unknown;
    terms_version?: unknown;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error_code: 'BAD_REQUEST', message: 'invalid JSON body' }, 400);
  }

  const handleRaw = (body.handle ?? '').trim();
  if (!handleRaw) {
    return c.json({ ok: false, error_code: 'BAD_REQUEST', message: '缺少必填字段：handle' }, 400);
  }
  const handle = handleRaw.toLowerCase().replace(/_/g, '-');
  if (isReservedHandlePrefix(handle)) {
    return c.json(
      { ok: false, error_code: 'REGISTER_HANDLE_RESERVED', message: HANDLE_RESERVED_USER_MESSAGE_ZH },
      400,
    );
  }
  if (!isValidRegisterHandleLocal(handle)) {
    return c.json(
      { ok: false, error_code: 'REGISTER_HANDLE_INVALID', message: HANDLE_LOCAL_RULES_USER_MESSAGE_ZH },
      400,
    );
  }

  const emailParsed = validateRegisterPrecheckEmail(body.email);
  if (!emailParsed.ok) {
    return c.json(
      {
        ok: false,
        error_code: emailParsed.error.code,
        message: emailParsed.error.message,
      },
      (emailParsed.error.status ?? 400) as 400 | 403,
    );
  }
  const email = emailParsed.value;

  const complianceParsed = parseRegisterPrecheckCompliance({
    terms_accepted: body.terms_accepted,
    terms_version: body.terms_version,
  });
  if (!complianceParsed.ok) {
    return c.json(
      { ok: false, error_code: complianceParsed.error_code, message: complianceParsed.message },
      complianceParsed.status as 400 | 403,
    );
  }
  const display_name = (body.display_name ?? '').trim();

  const pubkeyHex = (c.env.ED25519_PUBLIC_KEY ?? '').trim();
  const privateKeyHex = (c.env.ED25519_PRIVATE_KEY ?? '').trim();
  if (!pubkeyHex || !privateKeyHex) {
    return c.json(
      { ok: false, error_code: 'ED25519_PRIVATE_KEY_MISSING', message: '节点签名密钥未配置' },
      500,
    );
  }

  const worker_b_url = normalizePublicBaseUrl(c.env.WORKER_B_URL);
  if (!worker_b_url || !/^https:\/\//i.test(worker_b_url)) {
    return c.json(
      { ok: false, error_code: 'WORKER_B_URL_MISSING', message: 'WORKER_B_URL 未配置或非 https' },
      500,
    );
  }
  // 公开 Worker A 基址：优先 CORS Origin（Pages/自定义域）；无则回落 Worker B（短 TTL 过程表兜底）
  const workerAOrigin = normalizePublicBaseUrl(c.env.WORKER_A_ORIGIN);
  const worker_a_url =
    workerAOrigin && /^https:\/\//i.test(workerAOrigin) ? workerAOrigin : worker_b_url;

  let cert_inbound_host: string;
  try {
    const registryUrl = await resolveRegistrationRegistryUrl(c.env);
    if (!registryUrl) {
      return c.json(
        { ok: false, error_code: 'BOOTSTRAP_INTAKE_REQUIRED', message: '请先由浏览器向入口领取接待说明' },
        409,
      );
    }
    cert_inbound_host = deriveCertInboundHostFromRegistryUrl(registryUrl);
  } catch (err) {
    console.error('[bootstrap-outbound-template] cert_inbound_host derive failed', err);
    return c.json(
      { ok: false, error_code: 'CERT_INBOUND_HOST_MISSING', message: '无法推导认证收件域' },
      500,
    );
  }

  let template: Awaited<ReturnType<typeof buildOutboundEmailTemplate>>;
  try {
    template = await buildOutboundEmailTemplate({
      handle,
      email,
      worker_a_url,
      worker_b_url,
      pubkey_hex: pubkeyHex,
      private_key_hex: privateKeyHex,
      cert_inbound_host,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[bootstrap-outbound-template] build failed', err);
    return c.json(
      { ok: false, error_code: 'BOOTSTRAP_OUTBOUND_TEMPLATE_FAILED', message: msg },
      500,
    );
  }

  // 与路径 A complete 同源：pubkey fingerprint 对 registry base64 字符串做 SHA-256 短指纹
  const pubkeyRegistryB64 = ed25519PubkeyHexToRegistryBase64(pubkeyHex);
  const pubkeyFingerprint = await computePubkeyFingerprint(pubkeyRegistryB64);
  const isoNow = new Date().toISOString();
  const db = resolveIdentityDb(c.env);
  try {
    await db.batch([
      db
        .prepare(
          `INSERT OR REPLACE INTO system_config(key, value, updated_at) VALUES('proof_challenge_id', ?, ?)`,
        )
        .bind(template.challenge_id, isoNow),
      db
        .prepare(
          `INSERT OR REPLACE INTO system_config(key, value, updated_at) VALUES('proof_nonce', ?, ?)`,
        )
        .bind(template.browser_nonce, isoNow),
      db
        .prepare(
          `INSERT OR REPLACE INTO system_config(key, value, updated_at) VALUES('proof_pubkey_fingerprint', ?, ?)`,
        )
        .bind(pubkeyFingerprint, isoNow),
    ]);
    await c.env.STATE_KV.put(
      REGISTRY_PROOF_KV_KEY,
      `${template.challenge_id}.${template.browser_nonce}`,
      { expirationTtl: REGISTRY_PROOF_KV_TTL_SEC },
    );
  } catch (err) {
    console.error('[bootstrap-outbound-template] proof write failed', err);
    return c.json(
      { ok: false, error_code: 'INTERNAL_ERROR', message: '写入路径 D proof 失败' },
      500,
    );
  }

  // M9-PH-BO-2：写入 registry_accepted，便于发信后 complete / claim 续跑 status/ack
  try {
    const did_v2 = await pubkeyHexToDidV2(pubkeyHex);
    const deps = createProductionRegisterCompleteDeps(c.env);
    await deps.syncState.writeAccepted(
      {
        challenge_id: template.challenge_id,
        claim_token: template.claim_token,
        handle,
        display_name,
        registration_email: email,
        did_v2,
        pubkey_hex: pubkeyHex,
        node_url: worker_b_url,
        compliance: complianceParsed.value,
      },
      isoNow,
    );
  } catch (err) {
    console.error('[bootstrap-outbound-template] sync_state accepted write failed', err);
    return c.json(
      { ok: false, error_code: 'INTERNAL_ERROR', message: '写入路径 D 领取暂存失败' },
      500,
    );
  }

  return c.json({
    ok: true,
    data: {
      to: template.to,
      subject: template.subject,
      body: template.body,
      challenge_id: template.challenge_id,
      browser_nonce: template.browser_nonce,
      issued_at: template.issued_at,
      fingerprint_short: template.fingerprint_short,
      tag8: template.tag8,
      claim_token: template.claim_token,
      cert_inbound_host,
      ttl_hint_minutes: 30,
    },
  });
});

// ---------------------------------------------------------------------------
// GET /.well-known/hailuo-proof
// 注册中心在 POST /api/register/challenge/verify 时回访此端点验证节点归属。
//
// 数据来源：scripts/register.mjs（M1-1a）在调用 challenge/verify 前
// 通过 D1 batch 写入 system_config 三条记录：
//   proof_challenge_id  / proof_nonce / proof_pubkey_fingerprint
//
// 读取策略：单次 D1 查询同时取三个 key（节省 RTT）；
// 任一缺失时返回 404，表明节点尚未处于注册流程中。
// ---------------------------------------------------------------------------
wellKnownApp.get('/hailuo-proof', async (c) => {
  const db = resolveIdentityDb(c.env);
  try {
    const { results } = await db
      .prepare(
        `SELECT key, value FROM system_config
          WHERE key IN ('proof_challenge_id', 'proof_nonce', 'proof_pubkey_fingerprint')`,
      )
      .all<{ key: string; value: string }>();

    // 构建 key→value 映射
    const map: Record<string, string> = {};
    for (const row of results ?? []) {
      map[row.key] = row.value;
    }

    const challenge_id = map['proof_challenge_id'];
    const nonce = map['proof_nonce'];
    const pubkey_fingerprint = map['proof_pubkey_fingerprint'];

    if (!challenge_id || !nonce || !pubkey_fingerprint) {
      return c.json(
        { ok: false, error_code: 'PROOF_NOT_READY', message: 'no pending registration proof' },
        404,
      );
    }

    return c.json({ ok: true, data: { challenge_id, nonce, pubkey_fingerprint } });
  } catch (err) {
    console.error('[/.well-known/hailuo-proof] D1 error', err);
    return c.json({ ok: false, error_code: 'INTERNAL_ERROR', message: 'failed to read proof' }, 500);
  }
});
