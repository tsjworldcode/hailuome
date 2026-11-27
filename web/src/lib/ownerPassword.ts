/**
 * 站主密码：浏览器侧 PBKDF2 derive，Worker 只收 password_hash。
 */
import {
  derivePasswordHash,
  hashPassword,
  type PasswordKdfParams,
} from '@hailuo/shared-crypto/password';

export type { PasswordKdfParams };

import { ApiError } from './errors';

interface LoginParamsResponse {
  readonly ok: boolean;
  readonly data?: PasswordKdfParams;
  readonly error_code?: string;
  readonly message?: string;
}

interface PasswordParamsResponse {
  readonly ok: boolean;
  readonly data?: PasswordKdfParams;
  readonly error_code?: string;
  readonly message?: string;
}

/** GET /auth/login-params?username= */
export async function fetchLoginKdfParams(
  baseUrl: string,
  username: string,
): Promise<PasswordKdfParams> {
  const qs = new URLSearchParams({ username: username.trim() });
  let res: Response;
  try {
    res = await fetch(`${baseUrl.replace(/\/+$/, '')}/auth/login-params?${qs}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
  } catch {
    throw new ApiError(
      0,
      { error_code: 'INTERNAL_ERROR' },
      '无法连接节点 API 入口。请检查网络/VPN，并确认 Pages 的 PUBLIC_WORKER_B_URL 已正确绑定',
    );
  }
  let body: LoginParamsResponse;
  try {
    body = (await res.json()) as LoginParamsResponse;
  } catch {
    throw new ApiError(0, { error_code: 'INTERNAL_ERROR' }, '写层响应异常，请稍后重试或检查 CORS 配置');
  }
  if (!res.ok || !body.ok || !body.data) {
    throw new ApiError(res.status, body, '登录参数获取失败，请稍后再试');
  }
  return body.data;
}

/** GET /auth/password-params（需 JWT） */
export async function fetchPasswordKdfParams(
  baseUrl: string,
  jwt: string,
): Promise<PasswordKdfParams> {
  const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/auth/password-params`, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${jwt}`,
    },
  });
  const body = (await res.json()) as PasswordParamsResponse;
  if (!res.ok || !body.ok || !body.data) {
    throw new Error(body.message ?? body.error_code ?? `password-params HTTP ${res.status}`);
  }
  return body.data;
}

/** 登录：拉 salt → 浏览器 PBKDF2 → 返回完整 v1 字符串 */
export async function buildLoginPasswordHash(
  baseUrl: string,
  username: string,
  plainPassword: string,
): Promise<string> {
  const params = await fetchLoginKdfParams(baseUrl, username);
  return derivePasswordHash(plainPassword, params.salt_hex, params.iterations);
}

/** 改密 / TOTP 管理等已登录操作：JWT 拉 salt → derive */
export async function buildCurrentPasswordHash(
  baseUrl: string,
  jwt: string,
  plainPassword: string,
): Promise<string> {
  const params = await fetchPasswordKdfParams(baseUrl, jwt);
  return derivePasswordHash(plainPassword, params.salt_hex, params.iterations);
}

/** 改密：旧 hash 用当前 salt；新 hash 用新随机 salt（600k 默认） */
export async function buildChangePasswordHashes(
  baseUrl: string,
  jwt: string,
  oldPlainPassword: string,
  newPlainPassword: string,
): Promise<{ oldPasswordHash: string; newPasswordHash: string }> {
  const params = await fetchPasswordKdfParams(baseUrl, jwt);
  const oldPasswordHash = await derivePasswordHash(
    oldPlainPassword,
    params.salt_hex,
    params.iterations,
  );
  const newPasswordHash = await hashPassword(newPlainPassword);
  return { oldPasswordHash, newPasswordHash };
}

/** 老 secret 迁移：仅 derive 新密码 hash */
export async function buildNewPasswordHashForMigration(newPlainPassword: string): Promise<string> {
  return hashPassword(newPlainPassword);
}
