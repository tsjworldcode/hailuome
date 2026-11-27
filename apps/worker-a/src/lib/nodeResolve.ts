/**
 * M-OPT-8 / 8b / 8c：节点统一 handle 解析入口（L0 → L1 → L2 → L3 → L4）。
 *
 * 分层（计划 r3 §3.2）：
 *   L0  本站站主正式名（不计配额）
 *   L1  follows → cache_entries（不计配额）
 *   L2  互粉协助 — M-OPT-8b（默认开；不计 lookup_day）
 *   L3  有限 FoF — M-OPT-8c（默认开；1 跳；不计 lookup_day）
 *   L4  注册中心精确 lookup（扣 lookup_day 配额）
 *
 * 热路径（Timeline/Feed/资料/消息）不得调用本函数回源；仅显式搜人 / 站主 lookup 走此入口。
 */

import type { Env } from '../env';
import {
  LOOKUP_CACHE_TTL_SECONDS,
  resolveHandleFromL1,
  resolveOwnNodeByHandle,
  upsertLookupCacheEntry,
  type LocalLookupData,
  type NodeLookupSource,
} from './localNodeResolve';
import {
  isLookupL2MutualAssistEnabled,
  isLookupL3FofEnabled,
  tryResolveHandleViaL2Mutual,
  tryResolveHandleViaL3Fof,
} from './lookupAssist';
import { writeFederationLastLookup } from './federationLastLookup';
import { recordLookupResolve } from './lookupResolveStats';
import { registryFetch } from './registryFetch';
import { tryConsumeRegistryQuota } from './registryQuota';

export type NodeResolveSource = NodeLookupSource;

export interface NodeResolveSuccess {
  ok: true;
  data: LocalLookupData & {
    cache_ttl_seconds?: number;
  };
}

export interface NodeResolveFailure {
  ok: false;
  error_code: string;
  message: string;
  /** M9-3-CL1：503 联邦 home 不可达不得降成 404 */
  status: 404 | 429 | 500 | 503;
}

export type NodeResolveResult = NodeResolveSuccess | NodeResolveFailure;

interface RegistryLookupData {
  user_id: string;
  handle: string;
  node_url: string;
  worker_b_url?: string | null;
  registry_status?: string | null;
  health_status?: string | null;
  pubkey_fingerprint: string;
  /** M9-3-CL1 / M23-12L */
  home_registry_id?: string | null;
  resolved_via_registry_id?: string | null;
  route_version?: number | null;
  route_stale?: boolean;
  [key: string]: unknown;
}

export type ResolveNodeByHandleOptions = {
  /** 缓存写入走 waitUntil，避免拖慢响应 */
  waitUntil?: (promise: Promise<unknown>) => void;
};

/**
 * 唯一推荐入口：按 handle 解析公开节点地址。
 */
export async function resolveNodeByHandle(
  env: Env,
  handle: string,
  opts: ResolveNodeByHandleOptions = {},
): Promise<NodeResolveResult> {
  // --- L0：本站站主正式名（搜自己不回源注册中心）---
  const own = await resolveOwnNodeByHandle(env, handle);
  if (own) {
    await recordLookupResolve(env, 'l0_self');
    return {
      ok: true,
      data: {
        ...own,
        resolve_source: 'l0_self',
      },
    };
  }

  // --- L1 ---
  const local = await resolveHandleFromL1(env, handle);
  if (local) {
    const source = local.resolve_source === 'l1_follows' ? 'l1_follows' : 'l1_cache';
    await recordLookupResolve(env, source);
    return {
      ok: true,
      data: {
        ...local,
        resolve_source: source,
      },
    };
  }

  // --- L2：互粉协助（M-OPT-8b；失败不影响继续）---
  if (isLookupL2MutualAssistEnabled(env)) {
    const l2 = await tryResolveHandleViaL2Mutual(env, handle, {
      waitUntil: opts.waitUntil,
    });
    if (l2.kind === 'hit') {
      await recordLookupResolve(env, 'l2_mutual');
      return {
        ok: true,
        data: {
          ...l2.data,
          resolve_source: 'l2_mutual',
          cache_ttl_seconds: LOOKUP_CACHE_TTL_SECONDS,
        },
      };
    }
    if (l2.kind === 'miss') {
      await recordLookupResolve(env, 'l2_miss');
    } else {
      await recordLookupResolve(env, 'l2_skipped');
    }
  }

  // --- L3：有限 FoF（M-OPT-8c；默认开；失败不影响 L4）---
  if (isLookupL3FofEnabled(env)) {
    const l3 = await tryResolveHandleViaL3Fof(env, handle, {
      waitUntil: opts.waitUntil,
    });
    if (l3.kind === 'hit') {
      await recordLookupResolve(env, 'l3_fof');
      return {
        ok: true,
        data: {
          ...l3.data,
          resolve_source: 'l3_fof',
          cache_ttl_seconds: LOOKUP_CACHE_TTL_SECONDS,
        },
      };
    }
    if (l3.kind === 'miss') {
      await recordLookupResolve(env, 'l3_miss');
    } else {
      await recordLookupResolve(env, 'l3_skipped');
    }
  }

  // --- L4 ---
  const quota = await tryConsumeRegistryQuota(env, 'lookup_day');
  if (!quota.ok) {
    await recordLookupResolve(env, 'l4_quota_exceeded');
    return {
      ok: false,
      error_code: quota.error_code,
      message: quota.message,
      status: 429,
    };
  }

  let res: Response;
  try {
    // 中文注释：正式名含 @，必须 encode，避免 path 被截断
    res = await registryFetch(env, `/lookup/${encodeURIComponent(handle)}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await recordLookupResolve(env, 'l4_error');
    if (message.includes('节点尚未注册')) {
      console.info('[nodeResolve] 节点尚未注册，无法查询注册中心');
      return {
        ok: false,
        error_code: 'LOOKUP_INTERNAL',
        message: '节点尚未注册，无法查询注册中心',
        status: 500,
      };
    }
    console.error('[nodeResolve] 注册中心不可达', message);
    return {
      ok: false,
      error_code: 'LOOKUP_INTERNAL',
      message: '注册中心不可达',
      status: 500,
    };
  }

  if (res.status === 404) {
    await recordLookupResolve(env, 'l4_not_found');
    return {
      ok: false,
      error_code: 'LOOKUP_NOT_FOUND',
      message: 'handle 不存在',
      status: 404,
    };
  }

  // M9-3-CL1：联邦 home 不可达 → 503，绝不能当成 404「未找到」
  if (res.status === 503) {
    await recordLookupResolve(env, 'l4_error');
    let errCode = 'FEDERATED_HOME_UNAVAILABLE';
    let message = '归属注册中心暂时不可用';
    try {
      const body = (await res.json()) as {
        error_code?: string;
        message?: string;
        data?: RegistryLookupData;
      };
      if (body.error_code) errCode = body.error_code;
      if (body.message) message = body.message;
      // M9-3-CL4：记下 503 供 Settings 诊断（无 peer 拓扑）
      const meta = body.data;
      await writeFederationLastLookup(env, {
        handle,
        home_registry_id: meta?.home_registry_id ?? null,
        resolved_via_registry_id: meta?.resolved_via_registry_id ?? null,
        route_version:
          typeof meta?.route_version === 'number' ? meta.route_version : null,
        route_stale: typeof meta?.route_stale === 'boolean' ? meta.route_stale : null,
        error_code: errCode,
        http_status: 503,
        at: new Date().toISOString(),
      });
    } catch {
      await writeFederationLastLookup(env, {
        handle,
        home_registry_id: null,
        resolved_via_registry_id: null,
        route_version: null,
        route_stale: null,
        error_code: errCode,
        http_status: 503,
        at: new Date().toISOString(),
      });
    }
    return {
      ok: false,
      error_code: errCode,
      message,
      status: 503,
    };
  }

  if (!res.ok) {
    await recordLookupResolve(env, 'l4_error');
    let errCode = 'LOOKUP_INTERNAL';
    try {
      const body = (await res.json()) as { error_code?: string };
      if (body.error_code) errCode = body.error_code;
    } catch {
      /* 非 JSON */
    }
    console.warn(`[nodeResolve] 注册中心返回 ${res.status} ${errCode}`);
    return {
      ok: false,
      error_code: errCode,
      message: '注册中心返回异常',
      status: 500,
    };
  }

  let registryBody: { ok: boolean; data: RegistryLookupData };
  try {
    registryBody = (await res.json()) as { ok: boolean; data: RegistryLookupData };
  } catch (err) {
    await recordLookupResolve(env, 'l4_error');
    console.error('[nodeResolve] 注册中心响应 JSON 解析失败', err);
    return {
      ok: false,
      error_code: 'LOOKUP_INTERNAL',
      message: '注册中心响应格式异常',
      status: 500,
    };
  }

  const data = registryBody.data;
  const cacheWrite = upsertLookupCacheEntry(env, {
    handle: data.handle ?? handle,
    user_id: data.user_id,
    node_url: data.node_url,
    worker_b_url: data.worker_b_url ?? null,
    pubkey_fingerprint: data.pubkey_fingerprint,
    registry_status: data.registry_status ?? null,
    health_status: data.health_status ?? null,
    response_json: JSON.stringify(data),
  });
  if (opts.waitUntil) {
    opts.waitUntil(cacheWrite);
  } else {
    await cacheWrite;
  }

  await recordLookupResolve(env, 'l4_registry');
  // M9-3-CL4：L4 成功时持久化联邦 meta（home/via/stale）
  await writeFederationLastLookup(env, {
    handle: data.handle ?? handle,
    home_registry_id:
      typeof data.home_registry_id === 'string' ? data.home_registry_id : null,
    resolved_via_registry_id:
      typeof data.resolved_via_registry_id === 'string'
        ? data.resolved_via_registry_id
        : null,
    route_version:
      typeof data.route_version === 'number' ? data.route_version : null,
    route_stale: typeof data.route_stale === 'boolean' ? data.route_stale : null,
    error_code: null,
    http_status: 200,
    at: new Date().toISOString(),
  });
  return {
    ok: true,
    data: {
      ...data,
      user_id: data.user_id,
      handle: data.handle ?? handle,
      node_url: data.node_url,
      worker_b_url: data.worker_b_url ?? data.node_url,
      registry_status: data.registry_status ?? null,
      health_status: data.health_status ?? null,
      pubkey_fingerprint: data.pubkey_fingerprint,
      resolve_source: 'l4_registry',
      cache_ttl_seconds: LOOKUP_CACHE_TTL_SECONDS,
    },
  };
}
