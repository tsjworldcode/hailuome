/**
 * registry registration-profile + email-certify（M7-29 / M-REFACTOR-1a）
 */
import type { Hono } from 'hono';
import {
  prevalidateRegistrationProfilePatch,
  assertRegistrationEmailWritable,
  backfillLocalRegistrationEmailIfEmpty,
  resolveRegistrationEmailVerified,
  syncLocalRegistrationProfileFromPatch,
  syncLocalEmailVerifiedAfterEmailPatch,
  readLocalRegistrationProfileFallback,
  enrichRegistrationProfileData,
  readLocalNodeHandle,
  type RegistrationProfilePatchBody,
} from '../../handlers/registryRegistrationProfile';
import { readPublicProfileEmailVerified } from '../../handlers/publicProfileKv';
import {
  syncLocalEmailVerifiedAfterCertify,
  syncLocalEmailVerifiedFromCertificationContext,
  type EmailCertifyBody,
} from '../../handlers/registryEmailCertify';
import {
  resolveCertInboundPresentation,
  issueLocalCertInboundAddress,
  readOwnerUserIdForCertInbound,
} from '../../handlers/registryCertInbound';
import { registryFetch } from '../../lib/registryFetch';
import { persistRotatedNodeApiToken } from '../../lib/persistRotatedNodeApiToken';
import {
  RegistryAllUnavailableError,
  RegistryFatalError,
} from '../../lib/registryRouter';
import type { LocalReadsAppEnv } from './app';

/** 无 registered_registries / node_api_token 时 registryFetch 抛出的文案 */
function isUnregisteredNodeError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /节点尚未注册|registered_registries 为空|缺少凭证/.test(msg);
}

/** 登记档案读失败时的本地副本。有海螺名或许可版本才回落，避免把未登记节点伪装成已登记。 */
async function tryLocalRegistrationProfileFallback(
  env: LocalReadsAppEnv['Bindings'],
): Promise<{ ok: true; data: Record<string, unknown> } | null> {
  try {
    const local = await readLocalRegistrationProfileFallback(env);
    if (!local.handle_local && !local.terms_version) return null;
    let inbound: Record<string, string> = {};
    try {
      inbound = await resolveCertInboundPresentation(env);
    } catch (inboundErr) {
      console.error('[local-reads/registry-profile] 本地回落时收件域推导失败', inboundErr);
    }
    // SPILL-1c：本地回落不再伪造人口学 null 占位；HANDLE-SLIM：用 handle_*
    // M7-37：本地回落时把登记邮箱一并回传——让认证页在中心完全挂掉时也能显示"已填写"
    let emailVerified = false;
    try {
      emailVerified = await readPublicProfileEmailVerified(env);
    } catch {
      emailVerified = false;
    }
    return {
      ok: true,
      data: {
        user_id: '',
        handle_local: local.handle_local,
        handle_qualified: local.handle_qualified,
        email: local.registration_email,
        email_verified: emailVerified,
        terms_version: local.terms_version,
        terms_accepted_at: local.terms_accepted_at,
        registered_at: local.terms_accepted_at ?? '',
        updated_at: local.terms_accepted_at ?? '',
        profile_source: 'local_fallback',
        ...inbound,
      },
    };
  } catch (localErr) {
    console.error('[local-reads/registry-profile] 本地登记副本读取失败', localErr);
    return null;
  }
}

export function registerRegistryProfileRoutes(app: Hono<LocalReadsAppEnv>): void {
  app.get('/registry/registration-profile', async (c) => {
    try {
      const res = await registryFetch(c.env, '/api/node/registration-profile');
      let payload: unknown;
      try {
        payload = await res.json();
      } catch {
        return c.json(
          {
            ok: false,
            error_code: 'REGISTRY_REGISTRATION_PROFILE_INVALID',
            message: '注册中心响应无法解析',
          },
          502,
        );
      }
      const status = res.status;
      const inbound = await resolveCertInboundPresentation(c.env);
      const local = await readLocalRegistrationProfileFallback(c.env);
      if (
        payload &&
        typeof payload === 'object' &&
        (payload as { ok?: boolean }).ok === true &&
        (payload as { data?: unknown }).data &&
        typeof (payload as { data: unknown }).data === 'object'
      ) {
        // 中文注释：中心若缺 handle_* / terms_*，用本节点登记落盘副本补齐，避免设置页只读栏空白
        const enriched = enrichRegistrationProfileData(
          (payload as { data: Record<string, unknown> }).data,
          local,
        );
        // M7-41：中心有邮箱、本地空 → 回填 users.registration_email，供 /auth/me 与个人主页只读展示
        try {
          await backfillLocalRegistrationEmailIfEmpty(c.env, enriched.email);
        } catch (backfillErr) {
          console.error(
            '[local-reads/registry-profile] 登记邮箱本地回填失败（不影响 GET 响应）',
            backfillErr,
          );
        }
        // M7-41b：合并认证态，供设置页「认证后只读」判定
        let localVerified = false;
        try {
          localVerified = await readPublicProfileEmailVerified(c.env);
        } catch (verifiedErr) {
          console.error('[local-reads/registry-profile] 读本地邮箱认证蓝标失败', verifiedErr);
        }
        const emailVerified = resolveRegistrationEmailVerified(enriched, localVerified);
        const merged = {
          ...(payload as { ok: true; data: Record<string, unknown> }),
          data: {
            ...enriched,
            ...inbound,
            email_verified: emailVerified,
          },
        };
        return c.json(merged, status as 200 | 401 | 403 | 404 | 500 | 502 | 503);
      }
      return c.json(payload, status as 200 | 401 | 403 | 404 | 500 | 502 | 503);
    } catch (err) {
      // 中文注释：未登记无凭证 → 明确 USER_NOT_REGISTERED，勿包装成「读取登记资料失败」
      if (isUnregisteredNodeError(err)) {
        return c.json(
          { ok: false, error_code: 'USER_NOT_REGISTERED', message: '节点尚未完成登记' },
          409,
        );
      }
      console.error('[local-reads/registry-profile] 登记信息读取失败', err);
      // 中文注释：中心不可用、凭证包裹失败等任意异常，都先回落本地海螺名/许可版本
      const localResponse = await tryLocalRegistrationProfileFallback(c.env);
      if (localResponse) return c.json(localResponse);
      if (err instanceof RegistryAllUnavailableError) {
        return c.json(
          { ok: false, error_code: 'REGISTRY_ALL_UNAVAILABLE', message: '注册中心暂不可用，请稍后重试' },
          503,
        );
      }
      if (err instanceof RegistryFatalError) {
        return c.json({ ok: false, error_code: err.code, message: err.message }, 503);
      }
      return c.json(
        { ok: false, error_code: 'REGISTRATION_PROFILE_READ_FAILED', message: '读取登记信息失败，请稍后重试' },
        500,
      );
    }
  });

  app.patch('/registry/registration-profile', async (c) => {
    let body: RegistrationProfilePatchBody;
    try {
      body = (await c.req.json()) as RegistrationProfilePatchBody;
    } catch {
      return c.json(
        { ok: false, error_code: 'REGISTRATION_PROFILE_INVALID', message: '请求体须为有效 JSON' },
        400,
      );
    }

    const precheck = prevalidateRegistrationProfilePatch(body);
    if (!precheck.ok) {
      return c.json(
        { ok: false, error_code: precheck.error_code, message: precheck.message },
        precheck.status as 400 | 403,
      );
    }

    // M7-41：本地已有登记邮箱则硬锁，禁止再改（同值幂等放行）
    const emailLock = await assertRegistrationEmailWritable(c.env, body);
    if (!emailLock.ok) {
      return c.json(
        { ok: false, error_code: emailLock.error_code, message: emailLock.message },
        emailLock.status as 409,
      );
    }

    try {
      const res = await registryFetch(c.env, '/api/node/registration-profile', {
        method: 'PATCH',
        body: JSON.stringify(body),
        headers: { 'Content-Type': 'application/json' },
      });
      let payload: { ok: boolean; data?: unknown; error_code?: string; message?: string };
      try {
        payload = (await res.json()) as typeof payload;
      } catch {
        return c.json(
          {
            ok: false,
            error_code: 'REGISTRY_REGISTRATION_PROFILE_INVALID',
            message: '注册中心响应无法解析',
          },
          502,
        );
      }
      if (payload.ok) {
        try {
          await syncLocalRegistrationProfileFromPatch(c.env, body);
          await syncLocalEmailVerifiedAfterEmailPatch(c.env, body);
        } catch (syncErr) {
          console.error('[local-reads/registry-profile] 登记信息本地同步失败（registry 已成功）', syncErr);
        }
        const inbound = await resolveCertInboundPresentation(c.env);
        if (payload.data && typeof payload.data === 'object') {
          payload.data = { ...payload.data as Record<string, unknown>, ...inbound };
        }
      }
      const status = res.status;
      return c.json(payload, status as 200 | 400 | 401 | 403 | 404 | 500 | 502 | 503);
    } catch (err) {
      console.error('[local-reads/registry-profile] 登记信息更新失败', err);
      if (err instanceof RegistryAllUnavailableError) {
        return c.json(
          { ok: false, error_code: 'REGISTRY_ALL_UNAVAILABLE', message: '注册中心暂不可用，请稍后重试' },
          503,
        );
      }
      if (err instanceof RegistryFatalError) {
        return c.json({ ok: false, error_code: err.code, message: err.message }, 503);
      }
      return c.json(
        { ok: false, error_code: 'REGISTRATION_PROFILE_UPDATE_FAILED', message: '更新登记信息失败，请稍后重试' },
        500,
      );
    }
  });

  app.post('/registry/email-certify', async (c) => {
    let body: EmailCertifyBody;
    try {
      body = (await c.req.json()) as EmailCertifyBody;
    } catch {
      return c.json(
        { ok: false, error_code: 'EMAIL_CERTIFY_INVALID', message: '请求体须为有效 JSON' },
        400,
      );
    }
    if (typeof body.email !== 'string' || !body.email.trim()) {
      return c.json(
        { ok: false, error_code: 'EMAIL_CERTIFY_INVALID', message: '请提供登记邮箱' },
        400,
      );
    }
    if (typeof body.email_verify_token !== 'string' || !body.email_verify_token.trim()) {
      return c.json(
        { ok: false, error_code: 'REGISTER_EMAIL_VERIFY_TOKEN_INVALID', message: '请提供有效的 email_verify_token' },
        400,
      );
    }

    try {
      // M7-39：handle 必带——handle 全域唯一（与 user_id 同级），必须显式随认证请求上送。
      // 取本节点 D1 的 handle（权威源），本节点无 handle 则拒绝签发。
      const localHandle = await readLocalNodeHandle(c.env);
      if (!localHandle) {
        return c.json(
          { ok: false, error_code: 'NODE_HANDLE_MISSING', message: '节点海螺名缺失，无法完成邮箱认证' },
          503,
        );
      }
      const certifyBody: Record<string, string> = {
        email: body.email.trim(),
        email_verify_token: body.email_verify_token.trim(),
        handle: localHandle,
      };

      const res = await registryFetch(c.env, '/api/node/email-certify', {
        method: 'POST',
        body: JSON.stringify(certifyBody),
        headers: { 'Content-Type': 'application/json' },
      });
      let payload: unknown;
      try {
        payload = await res.json();
      } catch {
        return c.json(
          {
            ok: false,
            error_code: 'REGISTRY_EMAIL_CERTIFY_INVALID',
            message: '注册中心响应无法解析',
          },
          502,
        );
      }
      const parsed = payload as { ok?: boolean };
      if (parsed.ok === true) {
        try {
          await syncLocalEmailVerifiedAfterCertify(c.env);
        } catch (syncErr) {
          console.error('[local-reads/registry-profile] email_verified KV 同步失败（registry 已成功）', syncErr);
        }
      }
      const status = res.status;
      return c.json(payload, status as 200 | 400 | 401 | 403 | 409 | 500 | 502 | 503);
    } catch (err) {
      console.error('[local-reads/registry-profile] 邮箱认证失败', err);
      if (err instanceof RegistryAllUnavailableError) {
        return c.json(
          { ok: false, error_code: 'REGISTRY_ALL_UNAVAILABLE', message: '注册中心暂不可用，请稍后重试' },
          503,
        );
      }
      if (err instanceof RegistryFatalError) {
        return c.json({ ok: false, error_code: err.code, message: err.message }, 503);
      }
      return c.json(
        { ok: false, error_code: 'EMAIL_CERTIFY_FAILED', message: '邮箱认证失败，请稍后重试' },
        500,
      );
    }
  });

  app.get('/registry/cert-purge-status', async (c) => {
    try {
      const res = await registryFetch(c.env, '/api/node/cert-purge-status');
      let payload: unknown;
      try {
        payload = await res.json();
      } catch {
        return c.json(
          {
            ok: false,
            error_code: 'REGISTRY_CERT_PURGE_STATUS_INVALID',
            message: '注册中心响应无法解析',
          },
          502,
        );
      }
      const status = res.status;
      return c.json(payload, status as 200 | 401 | 403 | 500 | 502 | 503);
    } catch (err) {
      console.error('[local-reads/registry-profile] 清号提醒状态读取失败', err);
      if (err instanceof RegistryAllUnavailableError) {
        return c.json(
          { ok: false, error_code: 'REGISTRY_ALL_UNAVAILABLE', message: '注册中心暂不可用，请稍后重试' },
          503,
        );
      }
      if (err instanceof RegistryFatalError) {
        return c.json({ ok: false, error_code: err.code, message: err.message }, 503);
      }
      return c.json(
        { ok: false, error_code: 'CERT_PURGE_STATUS_READ_FAILED', message: '读取清号提醒状态失败，请稍后重试' },
        500,
      );
    }
  });

  app.get('/registry/certification-context', async (c) => {
    try {
      const res = await registryFetch(c.env, '/api/node/certification-context');
      let payload: unknown;
      try {
        payload = await res.json();
      } catch {
        return c.json(
          { ok: false, error_code: 'REGISTRY_CERT_CONTEXT_INVALID', message: '注册中心响应无法解析' },
          502,
        );
      }
      const parsed = payload as {
        ok?: boolean;
        data?: Record<string, unknown> & { email_verified?: boolean; email_status?: string };
      };
      if (parsed.ok === true && parsed.data) {
        try {
          await syncLocalEmailVerifiedFromCertificationContext(c.env, parsed.data);
        } catch (syncErr) {
          console.error('[local-reads/registry-profile] 认证上下文蓝标同步失败', syncErr);
        }
        try {
          const inbound = await resolveCertInboundPresentation(c.env);
          parsed.data = { ...parsed.data, ...inbound };
        } catch (deriveErr) {
          console.error('[local-reads/registry-profile] 认证收件域推导失败', deriveErr);
        }
      }
      return c.json(parsed, res.status as 200 | 401 | 403 | 500 | 502 | 503);
    } catch (err) {
      console.error('[local-reads/registry-profile] 认证上下文读取失败', err);
      if (err instanceof RegistryAllUnavailableError) {
        return c.json(
          { ok: false, error_code: 'REGISTRY_ALL_UNAVAILABLE', message: '注册中心暂不可用，请稍后重试' },
          503,
        );
      }
      if (err instanceof RegistryFatalError) {
        return c.json({ ok: false, error_code: err.code, message: err.message }, 503);
      }
      return c.json(
        { ok: false, error_code: 'CERTIFICATION_CONTEXT_READ_FAILED', message: '读取认证上下文失败，请稍后重试' },
        500,
      );
    }
  });

  app.post('/registry/cert-inbound-address', async (c) => {
    try {
      const ownerUserId = await readOwnerUserIdForCertInbound(c.env);
      if (!ownerUserId) {
        return c.json(
          { ok: false, error_code: 'NODE_NOT_REGISTERED', message: '节点尚未完成登记，无法签发认证收件地址' },
          503,
        );
      }

      const [ctxRes, profileRes] = await Promise.all([
        registryFetch(c.env, '/api/node/certification-context'),
        registryFetch(c.env, '/api/node/registration-profile'),
      ]);

      let ctxPayload: { ok?: boolean; data?: Record<string, unknown>; error_code?: string; message?: string };
      let profilePayload: { ok?: boolean; data?: { email?: string }; error_code?: string; message?: string };
      try {
        ctxPayload = (await ctxRes.json()) as typeof ctxPayload;
        profilePayload = (await profileRes.json()) as typeof profilePayload;
      } catch {
        return c.json(
          { ok: false, error_code: 'REGISTRY_CERT_INBOUND_INVALID', message: '注册中心响应无法解析' },
          502,
        );
      }

      if (!ctxPayload.ok) {
        return c.json(
          {
            ok: false,
            error_code: ctxPayload.error_code ?? 'REGISTRY_CERT_CONTEXT_INVALID',
            message: ctxPayload.message ?? '读取认证上下文失败',
          },
          ctxRes.status as 400 | 401 | 403 | 409 | 500 | 502 | 503,
        );
      }

      if (!profilePayload.ok) {
        return c.json(
          {
            ok: false,
            error_code: profilePayload.error_code ?? 'REGISTRY_REGISTRATION_PROFILE_INVALID',
            message: profilePayload.message ?? '读取登记信息失败',
          },
          profileRes.status as 400 | 401 | 403 | 404 | 500 | 502 | 503,
        );
      }

      const ctx = ctxPayload.data ?? {};
      if (!ctx.channel_a_enabled) {
        return c.json(
          { ok: false, error_code: 'CERT_INBOUND_CHANNEL_DISABLED', message: '主动发信认证通道已关闭' },
          403,
        );
      }
      if (ctx.email_verified === true || ctx.email_status === 'verified') {
        return c.json(
          { ok: false, error_code: 'CERTIFY_ALREADY_VERIFIED', message: '邮箱已认证，无需重复签发' },
          409,
        );
      }

      const localProfile = await readLocalRegistrationProfileFallback(c.env);
      // SPILL-1c 后中心 `/api/node/registration-profile` 的 DTO 已删掉 email 明文；
      // 登记邮箱的权威是本节点 users.registration_email（登记成功时写入）。
      // 中心 email 仅在旧版本节点上可能仍有值，保留作兼容回落，不能当主判据。
      const registeredEmail =
        localProfile.registration_email?.trim() || profilePayload.data?.email?.trim() || '';
      if (!registeredEmail) {
        return c.json(
          {
            ok: false,
            error_code: 'CERTIFY_EMAIL_REQUIRED',
            message: '请先在设置中保存登记邮箱后再签发认证收件地址',
          },
          400,
        );
      }

      const localInbound = await resolveCertInboundPresentation(c.env);
      const certInboundHost = localInbound.cert_inbound_host;
      if (!certInboundHost) {
        return c.json(
          { ok: false, error_code: 'CERT_INBOUND_HOST_MISSING', message: '认证收件域未配置，请稍后重试' },
          503,
        );
      }

      const ttlHours =
        typeof ctx.cert_inbound_token_ttl_hours === 'number' && Number.isFinite(ctx.cert_inbound_token_ttl_hours)
          ? Math.max(1, Math.min(ctx.cert_inbound_token_ttl_hours, 168))
          : 24;

      try {
        // M7-39：v3 收件地址内嵌 handle——读本节点 handle 传入签发
        const localHandle = await readLocalNodeHandle(c.env);
        if (!localHandle) {
          return c.json(
            { ok: false, error_code: 'NODE_HANDLE_MISSING', message: '节点海螺名缺失，无法签发认证收件地址' },
            503,
          );
        }
        const data = await issueLocalCertInboundAddress(c.env, {
          userId: ownerUserId,
          handle: localHandle,
          certInboundHost: certInboundHost,
          certInboundAddressExample: localInbound.cert_inbound_address_example,
          certInboundPurpose: localInbound.cert_inbound_purpose,
          ttlHours,
        });
        return c.json({ ok: true, data }, 200);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message === 'ED25519_PRIVATE_KEY_MISSING') {
          return c.json(
            { ok: false, error_code: 'ED25519_PRIVATE_KEY_MISSING', message: '节点签名密钥未配置，无法签发认证地址' },
            503,
          );
        }
        console.error('[local-reads/registry-profile] 本地签发认证收件地址失败', err);
        return c.json(
          { ok: false, error_code: 'CERT_INBOUND_ADDRESS_FAILED', message: '签发认证收件地址失败，请稍后重试' },
          500,
        );
      }
    } catch (err) {
      console.error('[local-reads/registry-profile] 签发认证收件地址失败', err);
      if (err instanceof RegistryAllUnavailableError) {
        return c.json(
          { ok: false, error_code: 'REGISTRY_ALL_UNAVAILABLE', message: '注册中心暂不可用，请稍后重试' },
          503,
        );
      }
      if (err instanceof RegistryFatalError) {
        return c.json({ ok: false, error_code: err.code, message: err.message }, 503);
      }
      return c.json(
        { ok: false, error_code: 'CERT_INBOUND_ADDRESS_FAILED', message: '签发认证收件地址失败，请稍后重试' },
        500,
      );
    }
  });

  app.post('/registry/esp-verify-request', async (c) => {
    try {
      // M7-39：handle 必带——从本节点 D1 读 handle 注入转发 body
      // （handle 全域唯一，与 user_id 同级；中心侧显式校验归属）
      const localHandle = await readLocalNodeHandle(c.env);
      if (!localHandle) {
        return c.json(
          { ok: false, error_code: 'NODE_HANDLE_MISSING', message: '节点海螺名缺失，无法发送认证验证码' },
          503,
        );
      }
      let forwardBody: string | undefined;
      const contentType = c.req.header('content-type') ?? '';
      if (contentType.includes('application/json')) {
        const raw = await c.req.text();
        if (raw.trim()) {
          forwardBody = raw;
        }
      }
      // 中文注释：保留前端原字段（request_id 等），仅补 handle
      const merged: Record<string, unknown> = {};
      if (forwardBody) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(forwardBody) as unknown;
        } catch {
          return c.json(
            { ok: false, error_code: 'ESP_VERIFY_REQUEST_INVALID', message: '请求体须为有效 JSON' },
            400,
          );
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return c.json(
            { ok: false, error_code: 'ESP_VERIFY_REQUEST_INVALID', message: '请求体须为 JSON 对象' },
            400,
          );
        }
        Object.assign(merged, parsed as Record<string, unknown>);
      }
      merged.handle = localHandle;
      const res = await registryFetch(c.env, '/api/node/esp-verify-request', {
        method: 'POST',
        body: JSON.stringify(merged),
        headers: { 'Content-Type': 'application/json' },
      });
      let payload: unknown;
      try {
        payload = await res.json();
      } catch {
        return c.json(
          { ok: false, error_code: 'REGISTRY_ESP_VERIFY_INVALID', message: '注册中心响应无法解析' },
          502,
        );
      }
      return c.json(payload, res.status as 200 | 400 | 401 | 402 | 403 | 409 | 429 | 500 | 502 | 503);
    } catch (err) {
      console.error('[local-reads/registry-profile] ESP 发码失败', err);
      if (err instanceof RegistryAllUnavailableError) {
        return c.json(
          { ok: false, error_code: 'REGISTRY_ALL_UNAVAILABLE', message: '注册中心暂不可用，请稍后重试' },
          503,
        );
      }
      if (err instanceof RegistryFatalError) {
        return c.json({ ok: false, error_code: err.code, message: err.message }, 503);
      }
      return c.json(
        { ok: false, error_code: 'ESP_VERIFY_REQUEST_FAILED', message: 'ESP 发码失败，请稍后重试' },
        500,
      );
    }
  });

  // R-MSG-1b：站主自助轮换注册中心通行证（代理 POST /api/node/rotate-token + 本地原子落盘）
  app.post('/registry/rotate-token', async (c) => {
    try {
      const res = await registryFetch(c.env, '/api/node/rotate-token', {
        method: 'POST',
        body: '',
      });
      let payload: {
        ok?: boolean;
        data?: {
          user_id?: string;
          node_api_token?: string;
          node_api_token_display?: string;
          rotated_at?: string;
        };
        error_code?: string;
        message?: string;
      };
      try {
        payload = (await res.json()) as typeof payload;
      } catch {
        return c.json(
          {
            ok: false,
            error_code: 'REGISTRY_ROTATE_TOKEN_INVALID',
            message: '注册中心响应无法解析',
          },
          502,
        );
      }

      if (!res.ok || !payload.ok) {
        return c.json(
          {
            ok: false,
            error_code: payload.error_code ?? 'ROTATE_TOKEN_FAILED',
            message: payload.message ?? '凭证轮换失败',
          },
          res.status as 400 | 401 | 403 | 429 | 500 | 502 | 503,
        );
      }

      const newToken = payload.data?.node_api_token?.trim() ?? '';
      if (!newToken.startsWith('nat_')) {
        return c.json(
          {
            ok: false,
            error_code: 'ROTATE_TOKEN_MALFORMED',
            message: '注册中心未返回有效新凭证',
          },
          502,
        );
      }

      try {
        const persisted = await persistRotatedNodeApiToken(
          c.env,
          newToken,
          payload.data?.rotated_at,
        );
        // 中文注释：浏览器只拿 display，明文仅存 Worker A D1
        return c.json({
          ok: true,
          data: {
            user_id: payload.data?.user_id ?? null,
            node_api_token_display: persisted.node_api_token_display,
            rotated_at: persisted.rotated_at,
          },
        });
      } catch (persistErr) {
        console.error('[local-reads/rotate-token] 中心已轮换但本地落盘失败', persistErr);
        return c.json(
          {
            ok: false,
            error_code: 'ROTATE_PERSIST_FAILED',
            message:
              '注册中心已签发新凭证，但本节点写入失败。请稍后重试「更换凭证」或联系运维检查 D1',
          },
          500,
        );
      }
    } catch (err) {
      console.error('[local-reads/rotate-token] 失败', err);
      if (err instanceof RegistryAllUnavailableError) {
        return c.json(
          { ok: false, error_code: 'REGISTRY_ALL_UNAVAILABLE', message: '注册中心暂不可用，请稍后重试' },
          503,
        );
      }
      if (err instanceof RegistryFatalError) {
        return c.json({ ok: false, error_code: err.code, message: err.message }, 503);
      }
      return c.json(
        { ok: false, error_code: 'ROTATE_TOKEN_FAILED', message: '凭证轮换失败，请稍后重试' },
        500,
      );
    }
  });
}
