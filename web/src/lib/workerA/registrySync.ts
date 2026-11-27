// M-REFACTOR-1b：注册中心同步与资料
import type { WorkerATransport } from './transport';
import type { WorkerAClient } from './types';
import type { EmailCertifyResult, PublicHealthProbeResult, RegistrationProfile, RegistryDailySyncDiagnostics, RegistryDailySyncRunResult, RegistryOfficialFeedPullResult, RegistryOfficialFeedStatus, RegistryRecommendedUsersResponse, CertPurgeStatus, CertificationContext, CertInboundAddressResult, EspVerifyRequestResult } from './types';

/** 注册中心同步与资料 API 方法集 */
export function createRegistrySyncApi(t: WorkerATransport): Pick<WorkerAClient, 'getRegistryOfficialFeedStatus' | 'getRegistryDailySyncStatus' | 'runRegistryDailySync' | 'probePublicHealth' | 'pullRegistryOfficialFeedNow' | 'getRegistryRecommendedUsers' | 'getRegistrationProfile' | 'updateRegistrationProfile' | 'certifyEmail' | 'getCertPurgeStatus' | 'getCertificationContext' | 'issueCertInboundAddress' | 'requestEspVerify' | 'rotateRegistryToken'> {
  return {
    async getRegistryOfficialFeedStatus() {
      const data = await t.callWithJwt<{ data: RegistryOfficialFeedStatus }>(
        '/api/local/registry-official-feed-status',
      );
      return data.data;
    },

    async getRegistryDailySyncStatus() {
      const data = await t.callWithJwt<{ data: RegistryDailySyncDiagnostics }>(
        '/api/local/registry-daily-sync-status',
      );
      return data.data;
    },

    async runRegistryDailySync() {
      const data = await t.callWithJwt<{ data: RegistryDailySyncRunResult }>(
        '/api/local/registry-daily-sync/run',
        { method: 'POST' },
      );
      return data.data;
    },

    async probePublicHealth() {
      const data = await t.callWithJwt<{ data: PublicHealthProbeResult }>(
        '/api/local/public-health-probe',
      );
      return data.data;
    },

    async pullRegistryOfficialFeedNow() {
      const data = await t.callWithJwt<{ data: RegistryOfficialFeedPullResult }>(
        '/api/local/registry-official-feed/pull',
        { method: 'POST' },
      );
      return data.data;
    },

    async getRegistryRecommendedUsers() {
      const data = await t.callWithJwt<{ data: RegistryRecommendedUsersResponse }>(
        '/api/local/registry-recommended-users',
      );
      return data.data;
    },

    async getRegistrationProfile() {
      const data = await t.callWithJwt<{ data: RegistrationProfile }>(
        '/api/local/registry/registration-profile',
      );
      return data.data;
    },

    async updateRegistrationProfile(input) {
      const data = await t.callWithJwt<{ data: RegistrationProfile }>(
        '/api/local/registry/registration-profile',
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
        },
      );
      return data.data;
    },

    async certifyEmail(input) {
      const data = await t.callWithJwt<{ data: EmailCertifyResult }>(
        '/api/local/registry/email-certify',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: input.email,
            email_verify_token: input.emailVerifyToken,
          }),
        },
      );
      return data.data;
    },

    async getCertPurgeStatus() {
      const data = await t.callWithJwt<{ data: CertPurgeStatus }>(
        '/api/local/registry/cert-purge-status',
      );
      return data.data;
    },

    async getCertificationContext() {
      const data = await t.callWithJwt<{ data: CertificationContext }>(
        '/api/local/registry/certification-context',
      );
      return data.data;
    },

    async issueCertInboundAddress() {
      const data = await t.callWithJwt<{ data: CertInboundAddressResult }>(
        '/api/local/registry/cert-inbound-address',
        { method: 'POST' },
      );
      return data.data;
    },

    async requestEspVerify(options?: { readonly request_id?: string }) {
      const body =
        options?.request_id !== undefined
          ? JSON.stringify({ request_id: options.request_id })
          : undefined;
      const data = await t.callWithJwt<{ data: EspVerifyRequestResult }>(
        '/api/local/registry/esp-verify-request',
        {
          method: 'POST',
          headers: body ? { 'Content-Type': 'application/json' } : undefined,
          body,
        },
      );
      return data.data;
    },

    async rotateRegistryToken() {
      const data = await t.callWithJwt<{
        data: {
          user_id: string | null;
          node_api_token_display: string;
          rotated_at: string;
        };
      }>('/api/local/registry/rotate-token', { method: 'POST' });
      return data.data;
    },
  };
}
