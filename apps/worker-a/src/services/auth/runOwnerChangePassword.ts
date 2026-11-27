/**
 * NCF-2B-2：站主改密核心（窄 deps，无 Env / Hono）。
 * Worker 零 PBKDF2；日志禁止 dump 密码/hash。
 */
import type {
  OwnerChangePasswordCommand,
  OwnerChangePasswordDeps,
  OwnerChangePasswordResult,
} from './types';

function resolveLoginUser(command: OwnerChangePasswordCommand): string {
  if (command.jwtOwnerUsername && command.jwtOwnerUsername.length > 0) {
    return command.jwtOwnerUsername;
  }
  return command.bootstrapHandle ?? command.jwtSub;
}

export async function runOwnerChangePassword(
  command: OwnerChangePasswordCommand,
  deps: OwnerChangePasswordDeps,
): Promise<OwnerChangePasswordResult> {
  const oldPassword = command.oldPassword ?? '';
  const newPassword = command.newPassword ?? '';
  const oldPasswordHash = command.oldPasswordHash ?? '';
  const newPasswordHash = command.newPasswordHash ?? '';
  const newUsernameRaw = command.newUsername ?? '';

  const credEmpty = await deps.credentialsRepo.isEmpty();

  if (credEmpty) {
    if (!oldPassword || !newPasswordHash) {
      return {
        status: 'invalid',
        httpStatus: 400,
        error_code: 'AUTH_INVALID',
        message: '迁移路径须 old_password 与 new_password_hash',
      };
    }
  } else if (!oldPasswordHash || !newPasswordHash) {
    return {
      status: 'invalid',
      httpStatus: 400,
      error_code: 'AUTH_INVALID',
      message: 'old_password_hash 与 new_password_hash 均必填',
    };
  }

  if (!credEmpty && deps.passwordProof.compare(oldPasswordHash, newPasswordHash)) {
    return {
      status: 'same_password',
      httpStatus: 400,
      error_code: 'SAME_PASSWORD',
      message: '新密码与旧密码相同',
    };
  }

  const newHashFormat = deps.passwordFormat.validateNewHash(newPasswordHash);
  if (!newHashFormat.ok) {
    return {
      status: 'weak_password',
      httpStatus: 400,
      error_code: 'WEAK_PASSWORD',
      message: newHashFormat.reason ?? 'new_password_hash 无效',
    };
  }

  if (credEmpty && newPassword) {
    const strength = deps.passwordFormat.checkStrength(newPassword);
    if (!strength.ok) {
      return {
        status: 'weak_password',
        httpStatus: 400,
        error_code: 'WEAK_PASSWORD',
        message: strength.reason ?? '新密码强度不足',
      };
    }
    if (oldPassword === newPassword) {
      return {
        status: 'same_password',
        httpStatus: 400,
        error_code: 'SAME_PASSWORD',
        message: '新密码与旧密码相同',
      };
    }
  }

  const handle = deps.bootstrap.bootstrapHandle(command.jwtSub);
  const mustChange = await deps.mustChangeRepo.get();

  // OWNER-RENAME：首次强制设置必须给新用户名；普通改密时也允许一并改名（留空 = 不改）
  if (mustChange && !newUsernameRaw) {
    return {
      status: 'invalid',
      httpStatus: 400,
      error_code: 'AUTH_INVALID',
      message: '首次设置须填写新用户名',
    };
  }
  if (newUsernameRaw) {
    if (newUsernameRaw === 'admin') {
      return {
        status: 'invalid',
        httpStatus: 400,
        error_code: 'AUTH_INVALID',
        message: '不能使用默认用户名 admin，请另设用户名',
      };
    }
    const unameCheck = deps.usernameRules.validate(newUsernameRaw);
    if (!unameCheck.ok) {
      return {
        status: 'invalid',
        httpStatus: 400,
        error_code: 'AUTH_INVALID',
        message: unameCheck.reason,
      };
    }
  }

  if (credEmpty) {
    const expected = deps.bootstrap.legacySecretExpected();
    if (!expected || oldPassword !== expected) {
      return {
        status: 'invalid',
        httpStatus: 401,
        // OWNER-OLD-PWD：改密场景单独给码，避免前端笼统显示「账号或密码错误」
        error_code: 'OLD_PASSWORD_INCORRECT',
        message: '旧密码错误',
      };
    }
    const parsedNew = deps.passwordFormat.parseHash(newPasswordHash);
    if (!parsedNew) {
      return {
        status: 'weak_password',
        httpStatus: 400,
        error_code: 'WEAK_PASSWORD',
        message: 'new_password_hash 格式无效',
      };
    }
    try {
      await deps.credentialsRepo.insertCredential({
        username: handle,
        passwordHash: newPasswordHash,
        iterations: parsedNew.iterations,
        saltHex: parsedNew.saltHex,
      });
    } catch (err) {
      deps.logger.error('[auth] 迁移写入 owner_credentials 失败', err);
      return {
        status: 'internal_error',
        httpStatus: 500,
        error_code: 'INTERNAL_ERROR',
        message: '密码写入失败，请稍后重试',
      };
    }
    await deps.mustChangeRepo.clear();
    return {
      status: 'ok',
      httpStatus: 200,
      data: await deps.rewrapHints.buildSuccessData({ migrated_from_legacy: true }),
    };
  }

  const loginUser = resolveLoginUser(command);
  const cred = await deps.credentialsRepo.loadByUsername(loginUser);
  if (!cred) {
    return {
      status: 'invalid',
      httpStatus: 401,
      error_code: 'AUTH_INVALID',
      message: '当前登录态找不到对应凭证',
    };
  }
  if (!deps.passwordProof.compare(oldPasswordHash, cred.password_hash)) {
    return {
      status: 'invalid',
      httpStatus: 401,
      error_code: 'OLD_PASSWORD_INCORRECT',
      message: '旧密码错误',
    };
  }

  const parsedNew = deps.passwordFormat.parseHash(newPasswordHash);
  if (!parsedNew) {
    return {
      status: 'weak_password',
      httpStatus: 400,
      error_code: 'WEAK_PASSWORD',
      message: 'new_password_hash 格式无效',
    };
  }

  const targetUsername = newUsernameRaw || cred.username;

  if (targetUsername !== cred.username) {
    const existing = await deps.credentialsRepo.usernameExists(targetUsername);
    if (existing) {
      return {
        status: 'invalid',
        httpStatus: 400,
        error_code: 'AUTH_INVALID',
        message: '新用户名已被占用',
      };
    }
  }

  try {
    if (targetUsername !== cred.username) {
      await deps.credentialsRepo.replaceUsername({
        fromUsername: cred.username,
        toUsername: targetUsername,
        passwordHash: newPasswordHash,
        iterations: parsedNew.iterations,
        saltHex: parsedNew.saltHex,
      });
      await deps.totpMigration.migrateUsername(cred.username, targetUsername);
    } else {
      await deps.credentialsRepo.updatePassword({
        username: cred.username,
        passwordHash: newPasswordHash,
        iterations: parsedNew.iterations,
        saltHex: parsedNew.saltHex,
      });
    }
  } catch (err) {
    deps.logger.error('[auth] 更新 owner_credentials 失败', err);
    return {
      status: 'internal_error',
      httpStatus: 500,
      error_code: 'INTERNAL_ERROR',
      message: '密码更新失败，请稍后重试',
    };
  }

  if (mustChange) {
    await deps.mustChangeRepo.clear();
  }

  return {
    status: 'ok',
    httpStatus: 200,
    data: await deps.rewrapHints.buildSuccessData(
      targetUsername !== cred.username ? { username_changed_to: targetUsername } : {},
    ),
  };
}
