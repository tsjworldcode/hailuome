/**
 * NCF-2B-3：GET /auth/login-params 核心（公开；未知用户返回 dummy salt 防枚举）。
 */
import type {
  OwnerLoginParamsCommand,
  OwnerLoginParamsDeps,
  OwnerLoginParamsResult,
} from './types';

export async function runGetOwnerLoginParams(
  command: OwnerLoginParamsCommand,
  deps: OwnerLoginParamsDeps,
): Promise<OwnerLoginParamsResult> {
  const username = command.username.trim();
  if (!username) {
    return {
      status: 'bad_request',
      httpStatus: 400,
      error_code: 'BAD_REQUEST',
      message: 'username 必填',
    };
  }

  const credEmpty = await deps.credentialsRepo.isEmpty();
  if (credEmpty) {
    return {
      status: 'no_credentials',
      httpStatus: 404,
      error_code: 'NO_CREDENTIALS',
      message: '节点尚未初始化站主凭证',
    };
  }

  const cred = await deps.credentialsRepo.loadByUsername(username);
  const params = cred
    ? deps.kdfParams.fromStored(cred.password_hash)
    : deps.kdfParams.dummy();
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
