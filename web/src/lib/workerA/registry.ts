// M-REFACTOR-1b：注册中心登记
import type { WorkerATransport } from './transport';
import type { WorkerAClient } from './types';
import type {
  BootstrapOutboundTemplateResponse,
  RegistryAppendRegisterCompleteResponse,
  RegistryRegisterCompleteResponse,
} from './types';

/** 交回节点前去掉领取令牌，避免凭证停在浏览器请求里。 */
function stripRegisterSecrets(body: unknown): unknown {
  if (!body || typeof body !== 'object') return body;
  let clone: unknown;
  try {
    clone = JSON.parse(JSON.stringify(body));
  } catch {
    return {};
  }
  const walk = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    const row = value as Record<string, unknown>;
    delete row.claim_token;
    delete row.node_api_token;
    for (const item of Object.values(row)) walk(item);
  };
  walk(clone);
  return clone;
}

/** 注册中心登记 API 方法集 */
export function createRegistryApi(
  t: WorkerATransport,
): Pick<
  WorkerAClient,
  | 'requestEmailVerify'
  | 'confirmEmailVerify'
  | 'completeRegistryRegister'
  | 'completeRegistryAppendRegister'
  | 'buildBootstrapOutboundTemplate'
  | 'fetchBootstrapTargets'
  | 'submitBootstrapIntake'
> {
  return {
    async requestEmailVerify(email) {
      await t.callWithJwt('/api/local/email-verify-request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
    },

    async confirmEmailVerify(email, code) {
      const data = await t.callWithJwt<{ data: { email_verify_token: string } }>(
        '/api/local/email-verify-confirm',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, code }),
        },
      );
      return { emailVerifyToken: data.data.email_verify_token };
    },

    async completeRegistryRegister(input) {
      const body: Record<string, unknown> = {
        handle: input.handle,
        display_name: input.display_name ?? '',
        turnstile_token: input.turnstileToken,
        terms_accepted: input.terms_accepted,
      };
      // 2026-09-27：不再上送 age_over_18
      if (input.terms_version?.trim()) body.terms_version = input.terms_version.trim();
      if (input.email?.trim()) body.email = input.email.trim();
      if (input.emailVerifyToken?.trim()) body.email_verify_token = input.emailVerifyToken.trim();
      if (input.browserRelay) {
        const relay: Record<string, unknown> = { phase: input.browserRelay.phase };
        if (input.browserRelay.upstreamStatus !== undefined) {
          relay.upstream_status = input.browserRelay.upstreamStatus;
        }
        if (input.browserRelay.upstreamBody !== undefined) {
          relay.upstream_body = stripRegisterSecrets(input.browserRelay.upstreamBody);
        }
        body.browser_relay = relay;
      }
      const data = await t.callWithJwt<{ data: RegistryRegisterCompleteResponse }>(
        '/api/local/register/complete',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      );
      return data.data;
    },

    async completeRegistryAppendRegister(input) {
      const body: Record<string, string> = {
        registry_id: input.registryId,
        turnstile_token: input.turnstileToken,
      };
      if (input.email?.trim()) body.email = input.email.trim();
      if (input.emailVerifyToken?.trim()) body.email_verify_token = input.emailVerifyToken.trim();
      const data = await t.callWithJwt<{ data: RegistryAppendRegisterCompleteResponse }>(
        '/api/local/register/append-complete',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      );
      return data.data;
    },

    async buildBootstrapOutboundTemplate(input) {
      const body: Record<string, string | boolean> = {
        handle: input.handle,
        email: input.email,
        terms_accepted: input.terms_accepted,
      };
      if (input.display_name?.trim()) body.display_name = input.display_name.trim();
      if (input.terms_version?.trim()) body.terms_version = input.terms_version.trim();
      const data = await t.callWithJwt<{ data: BootstrapOutboundTemplateResponse }>(
        '/api/local/register/bootstrap-outbound-template',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      );
      return data.data;
    },

    async fetchBootstrapTargets() {
      const data = await t.callWithJwt<{ data: { urls: string[] } }>(
        '/api/local/register/bootstrap-targets',
        { method: 'GET' },
      );
      return data.data.urls;
    },

    async submitBootstrapIntake(input: { manifest: string; avoidRegistryId?: string }) {
      const body: Record<string, string> = { manifest: input.manifest };
      if (input.avoidRegistryId) body.avoid_registry_id = input.avoidRegistryId;
      const data = await t.callWithJwt<{ data: { registry_id: string; registry_url: string } }>(
        '/api/local/register/intake',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      );
      return data.data;
    },
  };
}
