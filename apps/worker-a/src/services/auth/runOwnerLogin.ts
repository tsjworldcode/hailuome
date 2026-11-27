/**
 * NCF-2B：站主登录核心（窄 deps，无 Env / Hono）。
 */
import type { OwnerLoginCommand, OwnerLoginDeps, OwnerLoginResult } from './types';

const AUTH_INVALID_MSG = '用户名或密码错误';

function invalid(deps: OwnerLoginDeps): OwnerLoginResult {
  return {
    status: 'invalid',
    httpStatus: 401,
    error_code: 'AUTH_INVALID',
    message: AUTH_INVALID_MSG,
  };
}

export async function runOwnerLogin(
  command: OwnerLoginCommand,
  deps: OwnerLoginDeps,
): Promise<OwnerLoginResult> {
  const attemptKey = command.attemptKey;
  const username = command.username;
  const passwordHash = command.passwordHash;
  const passwordPlain = command.passwordPlain ?? '';
  const legacySecret = command.legacySecret ?? '';
  const totpCode = command.totpCode ?? '';
  const recoveryCode = command.recoveryCode ?? '';

  const lockStatus = await deps.lockoutRepo.check(attemptKey);
  if (lockStatus.locked) {
    return {
      status: 'locked',
      httpStatus: 429,
      error_code: 'LOGIN_LOCKED',
      message: '登录失败次数过多，请稍后再试',
      ...(lockStatus.lockedUntil ? { locked_until: lockStatus.lockedUntil } : {}),
    };
  }

  const credEmpty = await deps.credentialsRepo.isEmpty();
  const diagBase: Record<string, unknown> = {
    // 防身份关联：不把 attemptKey（多为真实 IP）写入对外响应；diag 仅本地开关
    usernameLen: username.length,
    passwordHashLen: passwordHash.length,
    rejectedPlaintextPassword: passwordPlain.length > 0 && !passwordHash,
    hasLegacySecretField: legacySecret.length > 0,
    jwtSecretConfigured: deps.bootstrap.jwtSecretConfigured(),
    credEmpty,
  };

  if (credEmpty) {
    deps.logger.warn(
      '[auth] owner_credentials 表为空，启用 M2-1 老 secret 回落；建议尽快执行 ' +
        'scripts/owner-bootstrap.mjs 升级到用户名+密码鉴权（M2-1b）',
    );

    const expected = deps.bootstrap.legacySecretExpected();
    const provided = legacySecret || passwordPlain;
    if (!provided || !expected || provided !== expected) {
      deps.logger.diag?.('reject', {
        route: 'legacy',
        reason: !provided
          ? 'no_password_or_secret'
          : !expected
            ? 'jwt_secret_not_configured'
            : 'secret_mismatch',
        providedLen: provided.length,
        expectedLen: expected.length,
        ...diagBase,
      });
      await deps.lockoutRepo.recordFailure(attemptKey);
      return invalid(deps);
    }

    deps.logger.diag?.('success', {
      route: 'legacy',
      ownerHandle: deps.bootstrap.ownerHandle('owner'),
      ...diagBase,
    });

    await deps.lockoutRepo.clearFailures(attemptKey);
    const handle = deps.bootstrap.ownerHandle('owner');
    const signed = await deps.jwtIssuer.sign(handle);
    const mustChange = await deps.credentialsRepo.getMustChange();
    return {
      status: 'ok',
      httpStatus: 200,
      data: {
        token: signed.token,
        expires_at: signed.expiresAtIso,
        legacy_mode: true,
        ...(mustChange ? { must_change_credentials: true } : {}),
      },
    };
  }

  if (!username || !passwordHash) {
    deps.logger.diag?.('reject', {
      route: 'client_hash',
      reason: !username ? 'missing_username' : 'missing_password_hash',
      ...diagBase,
    });
    await deps.lockoutRepo.recordFailure(attemptKey);
    return invalid(deps);
  }

  const cred = await deps.credentialsRepo.loadByUsername(username);
  const expectedHash = (cred?.password_hash ?? deps.passwordProof.dummyStoredHash()).trim();
  const ok = deps.passwordProof.compare(passwordHash, expectedHash);

  deps.logger.diag?.(ok && cred ? 'success' : 'reject', {
    route: 'client_hash',
    reason: !cred ? 'username_not_in_d1' : ok ? undefined : 'password_hash_mismatch',
    verifyOk: ok && Boolean(cred),
    storedHashLen: expectedHash.length,
    ...diagBase,
  });

  if (!cred || !ok) {
    await deps.lockoutRepo.recordFailure(attemptKey);
    return invalid(deps);
  }

  if (!deps.bootstrap.jwtSecretConfigured()) {
    deps.logger.error('[auth] JWT_SECRET 未配置，无法签发登录 JWT');
    return {
      status: 'misconfigured',
      httpStatus: 500,
      error_code: 'INTERNAL_ERROR',
      message: '节点未配置 JWT_SECRET，请重新运行 bootstrap 或 put-worker-secrets.mjs',
    };
  }

  const totpStep = await deps.totpGate.evaluate(cred.username, {
    totpCode: totpCode || undefined,
    recoveryCode: recoveryCode || undefined,
  });
  if (totpStep.kind === 'totp_required') {
    return {
      status: 'totp_required',
      httpStatus: 401,
      error_code: 'TOTP_REQUIRED',
      message: '请输入二次验证码',
      data: { totp_required: true },
    };
  }
  if (totpStep.kind === 'totp_invalid') {
    await deps.lockoutRepo.recordFailure(attemptKey);
    return {
      status: 'totp_invalid',
      httpStatus: 401,
      error_code: 'TOTP_INVALID',
      message: '二次验证码不正确',
    };
  }
  if (totpStep.kind === 'recovery_invalid') {
    await deps.lockoutRepo.recordFailure(attemptKey);
    return {
      status: 'recovery_invalid',
      httpStatus: 401,
      error_code: 'RECOVERY_CODE_INVALID',
      message: '恢复码无效或已使用',
    };
  }

  await deps.lockoutRepo.clearFailures(attemptKey);
  const handle = deps.bootstrap.ownerHandle(cred.username);
  const mustChange = await deps.credentialsRepo.getMustChange();
  const signed = await deps.jwtIssuer.sign(handle, { ownerUsername: cred.username });
  return {
    status: 'ok',
    httpStatus: 200,
    data: {
      token: signed.token,
      expires_at: signed.expiresAtIso,
      ...(mustChange ? { must_change_credentials: true } : {}),
    },
  };
}
