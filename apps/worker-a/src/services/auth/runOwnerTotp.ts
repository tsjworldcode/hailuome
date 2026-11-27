/**
 * NCF-2B-6：站主 TOTP 管理核心（窄 deps，无 Env / Hono）。
 * 禁止日志输出 password_hash / secret / recovery_codes 明文。
 */
import type {
  OwnerTotpDisableCommand,
  OwnerTotpDisableResult,
  OwnerTotpEnableCommand,
  OwnerTotpEnableResult,
  OwnerTotpLibFailure,
  OwnerTotpManageDeps,
  OwnerTotpRotateCommand,
  OwnerTotpRotateResult,
  OwnerTotpSetupCommand,
  OwnerTotpSetupResult,
  OwnerTotpStatusCommand,
  OwnerTotpStatusResult,
} from './types';

function authInvalid(message = '当前密码错误'): {
  status: 'auth_invalid';
  httpStatus: 401;
  error_code: 'AUTH_INVALID';
  message: string;
} {
  return { status: 'auth_invalid', httpStatus: 401, error_code: 'AUTH_INVALID', message };
}

function mapLibFailure(fail: OwnerTotpLibFailure): {
  status: 'op_failed';
  httpStatus: number;
  error_code: string;
  message: string;
} {
  return {
    status: 'op_failed',
    httpStatus: fail.status,
    error_code: fail.error_code,
    message: fail.message,
  };
}

async function requirePassword(
  deps: OwnerTotpManageDeps,
  username: string,
  passwordHash: string,
): Promise<null | ReturnType<typeof authInvalid>> {
  const hash = passwordHash.trim();
  if (!hash) {
    return authInvalid('请提供当前密码');
  }
  const ok = await deps.passwordProof.verify(username, hash);
  if (!ok) return authInvalid('当前密码错误');
  return null;
}

export async function runGetOwnerTotpStatus(
  command: OwnerTotpStatusCommand,
  deps: OwnerTotpManageDeps,
): Promise<OwnerTotpStatusResult> {
  const data = await deps.totp.getStatus(command.username);
  return { status: 'ok', httpStatus: 200, data };
}

export async function runOwnerTotpSetup(
  command: OwnerTotpSetupCommand,
  deps: OwnerTotpManageDeps,
): Promise<OwnerTotpSetupResult> {
  const denied = await requirePassword(deps, command.username, command.passwordHash);
  if (denied) return denied;

  const result = await deps.totp.createSetup(command.username, command.label);
  if (!result.ok) return mapLibFailure(result);
  return {
    status: 'ok',
    httpStatus: 200,
    data: {
      secret_base32: result.secret_base32,
      otpauth_url: result.otpauth_url,
      expires_at: result.expires_at,
    },
  };
}

export async function runOwnerTotpEnable(
  command: OwnerTotpEnableCommand,
  deps: OwnerTotpManageDeps,
): Promise<OwnerTotpEnableResult> {
  const denied = await requirePassword(deps, command.username, command.passwordHash);
  if (denied) return denied;

  const totpCode = command.totpCode.trim();
  if (!totpCode) {
    return {
      status: 'bad_request',
      httpStatus: 400,
      error_code: 'BAD_REQUEST',
      message: '请填写验证码',
    };
  }

  const result = await deps.totp.enable(command.username, totpCode);
  if (!result.ok) return mapLibFailure(result);
  return {
    status: 'ok',
    httpStatus: 200,
    data: { enabled: true, recovery_codes: result.recovery_codes },
  };
}

export async function runOwnerTotpDisable(
  command: OwnerTotpDisableCommand,
  deps: OwnerTotpManageDeps,
): Promise<OwnerTotpDisableResult> {
  const denied = await requirePassword(deps, command.username, command.passwordHash);
  if (denied) return denied;

  const result = await deps.totp.disable(command.username, {
    totpCode: command.totpCode?.trim() || undefined,
    recoveryCode: command.recoveryCode?.trim() || undefined,
  });
  if (!result.ok) return mapLibFailure(result);
  return {
    status: 'ok',
    httpStatus: 200,
    data: { enabled: false, disabled_at: result.disabled_at },
  };
}

export async function runOwnerTotpRotateRecovery(
  command: OwnerTotpRotateCommand,
  deps: OwnerTotpManageDeps,
): Promise<OwnerTotpRotateResult> {
  const denied = await requirePassword(deps, command.username, command.passwordHash);
  if (denied) return denied;

  const result = await deps.totp.rotate(command.username, {
    totpCode: command.totpCode?.trim() || undefined,
    recoveryCode: command.recoveryCode?.trim() || undefined,
  });
  if (!result.ok) return mapLibFailure(result);
  return {
    status: 'ok',
    httpStatus: 200,
    data: { recovery_codes: result.recovery_codes },
  };
}
