// M-REFACTOR-1b：鉴权
import type { WorkerATransport } from './transport';
import type { WorkerAClient } from './types';
import type { OwnerChangePasswordResponse, OwnerLoginResponse, OwnerLogoutResponse, OwnerProfile, OwnerSessionHeartbeatResponse, OwnerTotpDisableResponse, OwnerTotpEnableResponse, OwnerTotpRotateRecoveryResponse, OwnerTotpSetupResponse, OwnerTotpStatus } from './types';

/** 鉴权 API 方法集 */
export function createAuthApi(t: WorkerATransport): Pick<
  WorkerAClient,
  | 'login'
  | 'getMe'
  | 'updateProfile'
  | 'changePassword'
  | 'sessionHeartbeat'
  | 'logout'
  | 'getTotpStatus'
  | 'setupTotp'
  | 'enableTotp'
  | 'disableTotp'
  | 'rotateTotpRecoveryCodes'
> {
  return {
    async login(input) {
      const body: Record<string, string> =
        typeof input === 'string'
          ? { secret: input }
          : input.passwordHash
            ? {
                ...(input.username ? { username: input.username } : {}),
                password_hash: input.passwordHash,
                ...(input.totpCode ? { totp_code: input.totpCode } : {}),
                ...(input.recoveryCode ? { recovery_code: input.recoveryCode } : {}),
              }
            : input.username
              ? { username: input.username, password: input.password ?? '' }
              : { password: input.password ?? '' };
      const data = await t.callPublic<{ data: OwnerLoginResponse }>('/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return data.data;
    },

    async getMe() {
      const data = await t.callWithJwt<{ data: OwnerProfile }>('/auth/me');
      return data.data;
    },

    async sessionHeartbeat(input) {
      const data = await t.callWithJwt<{ data: OwnerSessionHeartbeatResponse }>(
        '/auth/session/heartbeat',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...(input?.sessionId ? { session_id: input.sessionId } : {}),
          }),
        },
      );
      return data.data;
    },

    async logout(input) {
      const data = await t.callWithJwt<{ data: OwnerLogoutResponse }>('/auth/logout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(input?.sessionId ? { session_id: input.sessionId } : {}),
        }),
      });
      return data.data;
    },

    async updateProfile(input) {
      const data = await t.callWithJwt<{ data: OwnerProfile }>('/auth/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          display_name: input.display_name,
          bio: input.bio,
          avatar_key: input.avatar_key,
          contact_email: input.contact_email,
        }),
      });
      return data.data;
    },

    async changePassword(input) {
      // 与 Worker A POST /auth/change-password 字段名（snake_case）对齐
      const data = await t.callWithJwt<{ data: OwnerChangePasswordResponse }>(
        '/auth/change-password',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...(input.oldPassword ? { old_password: input.oldPassword } : {}),
            ...(input.newPassword ? { new_password: input.newPassword } : {}),
            ...(input.oldPasswordHash ? { old_password_hash: input.oldPasswordHash } : {}),
            ...(input.newPasswordHash ? { new_password_hash: input.newPasswordHash } : {}),
            ...(input.newUsername ? { new_username: input.newUsername } : {}),
          }),
        },
      );
      return data.data;
    },

    async getTotpStatus() {
      const data = await t.callWithJwt<{ data: OwnerTotpStatus }>('/auth/totp/status');
      return data.data;
    },

    async setupTotp(passwordHash) {
      const data = await t.callWithJwt<{ data: OwnerTotpSetupResponse }>('/auth/totp/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password_hash: passwordHash }),
      });
      return data.data;
    },

    async enableTotp(input) {
      const data = await t.callWithJwt<{ data: OwnerTotpEnableResponse }>('/auth/totp/enable', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          password_hash: input.passwordHash,
          totp_code: input.totpCode,
        }),
      });
      return data.data;
    },

    async disableTotp(input) {
      const data = await t.callWithJwt<{ data: OwnerTotpDisableResponse }>('/auth/totp/disable', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          password_hash: input.passwordHash,
          ...(input.totpCode ? { totp_code: input.totpCode } : {}),
          ...(input.recoveryCode ? { recovery_code: input.recoveryCode } : {}),
        }),
      });
      return data.data;
    },

    async rotateTotpRecoveryCodes(input) {
      const data = await t.callWithJwt<{ data: OwnerTotpRotateRecoveryResponse }>(
        '/auth/totp/recovery-codes/rotate',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            password_hash: input.passwordHash,
            ...(input.totpCode ? { totp_code: input.totpCode } : {}),
            ...(input.recoveryCode ? { recovery_code: input.recoveryCode } : {}),
          }),
        },
      );
      return data.data;
    },

    // ── 注册中心 ──────────────────────────────────────────────────
  };
}
