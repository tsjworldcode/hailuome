/**
 * NCF-2B-3：GET /auth/password-params 核心（JWT 后；当前登录用户 KDF 参数）。
 */
import type {
  OwnerPasswordParamsCommand,
  OwnerPasswordParamsDeps,
  OwnerPasswordParamsResult,
} from './types';

export async function runGetOwnerPasswordParams(
  command: OwnerPasswordParamsCommand,
  deps: OwnerPasswordParamsDeps,
): Promise<OwnerPasswordParamsResult> {
  const cred = await deps.credentialsRepo.loadByUsername(command.loginUser);
  if (!cred) {
    return {
      status: 'invalid',
      httpStatus: 401,
      error_code: 'AUTH_INVALID',
      message: '当前登录态找不到对应凭证',
    };
  }

  const params = deps.kdfParams.fromStored(cred.password_hash);
  if (!params) {
    return {
      status: 'internal_error',
      httpStatus: 500,
      error_code: 'INTERNAL_ERROR',
      message: '凭证格式异常',
    };
  }

  return {
    status: 'ok',
    httpStatus: 200,
    data: params,
  };
}
