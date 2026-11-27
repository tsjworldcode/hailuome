/**
 * 注册中心已认证请求（M9-3-R2）：一律走 `registered_registries`（≤1，含 URL/token）。
 *
 * 覆盖：lookup / 官方 feed / 推荐 / 黑名单 GET /
 * registration-profile / email-certify / url-change 等。
 * 登记前未认证代理（register proxyPost）不经本模块。
 */

import { resolveIdentityDb } from '../db/bindings';
import type { Env } from '../env';
import {
  RegistryAllUnavailableError,
  RegistryFatalError,
  registryRouterFetchBound,
  resolvePrimaryRegistryUrl,
  resolveRegisteredRegistryForSync,
  type RegistryRouterFetchResult,
  type RegistryRouterProfile,
} from './registryRouter';
import {
  insertOutboundEvent,
  outboundKindFromRegistryPath,
  shouldLogRegistryFetchSuccess,
} from './outboundEvents';

export interface RegistryFetchOptions {
  method?: string;
  body?: string;
  headers?: Record<string, string>;
  /** cron=3×3s；sync=2×2s（默认，适合 lookup 等用户请求） */
  profile?: RegistryRouterProfile;
  /**
   * 若指定，必须等于已登记中心 registry_id；否则 fatal（不再地址簿 failover）。
   */
  targetRegistryId?: string;
}

function registryTargetUrl(endpointUrl: string, path: string): string {
  return `${endpointUrl.replace(/\/$/, '')}${path}`;
}

async function resolveAuditTargetUrl(env: Env, path: string): Promise<string> {
  const base = await resolvePrimaryRegistryUrl(env);
  return registryTargetUrl(base || 'https://registry.invalid', path);
}

async function logRegistryFetchSuccess(
  env: Env,
  path: string,
  targetUrl: string,
  result: RegistryRouterFetchResult,
): Promise<void> {
  if (!shouldLogRegistryFetchSuccess(path, result.router_detail, result.attempts)) {
    return;
  }
  await insertOutboundEvent(resolveIdentityDb(env), {
    kind: outboundKindFromRegistryPath(path),
    targetUrl,
    status: 'ok',
    httpCode: result.response.status,
    errCode: null,
    errMessage: null,
    registryId: result.endpoint.registry_id,
    routerAttempts: result.attempts,
    routerDetail: result.router_detail,
  });
}

async function logRegistryFetchFailure(
  env: Env,
  path: string,
  targetUrl: string,
  err: unknown,
): Promise<void> {
  const kind = outboundKindFromRegistryPath(path);
  if (err instanceof RegistryFatalError) {
    await insertOutboundEvent(resolveIdentityDb(env), {
      kind,
      targetUrl,
      status: 'failed',
      httpCode: null,
      errCode: err.code,
      errMessage: err.message,
      registryId: null,
      routerAttempts: 0,
      routerDetail: 'fatal_no_failover',
    });
    return;
  }

  const message = err instanceof Error ? err.message : String(err);
  await insertOutboundEvent(resolveIdentityDb(env), {
    kind,
    targetUrl,
    status: 'failed',
    httpCode: null,
    errCode: err instanceof RegistryAllUnavailableError ? 'REGISTRY_ALL_UNAVAILABLE' : 'REGISTRY_FETCH_FAILED',
    errMessage: message,
    registryId: null,
    routerAttempts: 0,
    routerDetail: message.slice(0, 500),
  });
}

/** 成功响应元数据（兼容旧 failover 字段；M9-3-R2 后 failoverSwitched 恒为 false）。 */
export interface RegistryFetchRouterMeta {
  response: Response;
  registryId: string;
  registryUrl: string;
  routerDetail: string;
  failoverSwitched: boolean;
}

/**
 * M9-3-R2：已认证注册中心请求绑定 `registered_registries` 唯一一家，
 * 不经 `registry_endpoints` 拼 token / 多中心 failover。
 */
export async function registryFetchWithRouterMeta(
  env: Env,
  path: string,
  opts?: RegistryFetchOptions,
): Promise<RegistryFetchRouterMeta> {
  // 中文注释：M-OPT-12 — 生产不再 POST /api/node/health；legacy 路径曾单独记 outbound，故跳过双记
  const auditOutbound = !path.startsWith('/api/node/health');

  try {
    const endpoint = await resolveRegisteredRegistryForSync(env);
    if (!endpoint?.node_api_token?.trim() || !endpoint.owner_user_id?.trim()) {
      throw new Error(
        '节点尚未注册：registered_registries 为空或缺少凭证，请先完成注册中心登记',
      );
    }

    const targetId = opts?.targetRegistryId?.trim();
    if (targetId && targetId !== endpoint.registry_id) {
      throw new RegistryFatalError(
        'REGISTRY_TARGET_MISMATCH',
        `目标注册中心 ${targetId} 与已登记中心 ${endpoint.registry_id} 不一致`,
      );
    }

    // 凭证来自 registered_registries，直连，无地址簿 failover
    const result = await registryRouterFetchBound(env, path, endpoint, {
      method: opts?.method,
      body: opts?.body,
      headers: opts?.headers,
      profile: opts?.profile ?? 'sync',
      skipOutboundAudit: !auditOutbound,
    });

    if (auditOutbound) {
      await logRegistryFetchSuccess(
        env,
        path,
        registryTargetUrl(result.endpoint.registry_url, path),
        result,
      );
    }

    return {
      response: result.response,
      registryId: result.endpoint.registry_id,
      registryUrl: result.endpoint.registry_url,
      routerDetail: result.router_detail,
      failoverSwitched: false,
    };
  } catch (err) {
    if (auditOutbound) {
      const targetUrl = await resolveAuditTargetUrl(env, path);
      await logRegistryFetchFailure(env, path, targetUrl, err);
    }
    throw err;
  }
}

export async function registryFetch(
  env: Env,
  path: string,
  opts?: RegistryFetchOptions,
): Promise<Response> {
  const { response } = await registryFetchWithRouterMeta(env, path, opts);
  return response;
}
