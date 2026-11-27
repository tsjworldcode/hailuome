/**
 * M7-24：本节点调用注册中心前的本地配额自检（D1 原子计数）。
 *
 * - 与注册中心侧 node_business_rate_buckets 上限对齐默认值，在节点本地先挡一层。
 * - cache_entries 命中时不调用本模块（lookup 路由负责）。
 * - Feed / health 上报不走 lookup_day 配额。
 */

import type { Env } from '../env';
import { resolveIdentityDb } from '../db/bindings';

/** 与 hailuo-registry `NODE_LOOKUP_DAY_LIMIT` 默认一致（M-OPT-1qn：10；原 5000 作废） */
export const REGISTRY_LOOKUP_DAY_LIMIT_DEFAULT = 10;
/** 预留：注册中心 `NODE_SEARCH_DAY_LIMIT` */
export const REGISTRY_SEARCH_DAY_LIMIT_DEFAULT = 1000;
/** 预留：注册中心 search IP 分钟频控参考值 */
export const REGISTRY_SEARCH_MINUTE_LIMIT_DEFAULT = 20;

export type RegistryQuotaScope = 'lookup_day' | 'search_day' | 'search_minute';

export type RegistryQuotaCheckResult =
  | { ok: true }
  | { ok: false; error_code: string; message: string };

function parsePositiveLimit(raw: string | undefined, fallback: number): number {
  if (!raw?.trim()) return fallback;
  const n = parseInt(raw.trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** 读取 env 配额上限（站主可在 wrangler vars 覆盖） */
export function getRegistryQuotaLimit(env: Env, scope: RegistryQuotaScope): number {
  switch (scope) {
    case 'lookup_day':
      return parsePositiveLimit(env.REGISTRY_LOOKUP_DAY_LIMIT, REGISTRY_LOOKUP_DAY_LIMIT_DEFAULT);
    case 'search_day':
      return parsePositiveLimit(env.REGISTRY_SEARCH_DAY_LIMIT, REGISTRY_SEARCH_DAY_LIMIT_DEFAULT);
    case 'search_minute':
      return parsePositiveLimit(env.REGISTRY_SEARCH_MINUTE_LIMIT, REGISTRY_SEARCH_MINUTE_LIMIT_DEFAULT);
    default:
      return REGISTRY_LOOKUP_DAY_LIMIT_DEFAULT;
  }
}

function bucketKey(scope: RegistryQuotaScope, now = new Date()): string {
  const iso = now.toISOString();
  if (scope === 'search_minute') return iso.slice(0, 16);
  return iso.slice(0, 10);
}

function quotaExceeded(scope: RegistryQuotaScope): RegistryQuotaCheckResult {
  if (scope === 'lookup_day') {
    return {
      ok: false,
      error_code: 'LOOKUP_REGISTRY_QUOTA_EXCEEDED',
      message: '本节点今日向注册中心 lookup 次数已达上限，请明日再试；已缓存的 handle 仍可查询',
    };
  }
  if (scope === 'search_day') {
    return {
      ok: false,
      error_code: 'SEARCH_REGISTRY_QUOTA_EXCEEDED',
      message: '本节点今日向注册中心 search 次数已达上限，请明日再试',
    };
  }
  return {
    ok: false,
    error_code: 'SEARCH_REGISTRY_RATE_LIMITED',
    message: '本节点向注册中心 search 过于频繁，请稍后再试',
  };
}

/**
 * 回源注册中心前调用：原子自增计数，未达上限返回 ok。
 * D1 异常时 fail-closed（与注册中心节点业务频控一致）。
 */
export async function tryConsumeRegistryQuota(
  env: Env,
  scope: RegistryQuotaScope,
): Promise<RegistryQuotaCheckResult> {
  const limit = getRegistryQuotaLimit(env, scope);
  const bucket = bucketKey(scope);
  const nowIso = new Date().toISOString();
  // MIGRATION-COVERAGE：registry_quota_buckets 实际在 IDENTITY_DB（migrations-identity/0012）
  const identityDb = resolveIdentityDb(env);

  try {
    const result = await identityDb.prepare(
      `INSERT INTO registry_quota_buckets (scope, bucket, count, updated_at)
       VALUES (?1, ?2, 1, ?3)
       ON CONFLICT(scope, bucket) DO UPDATE SET
         count = count + 1,
         updated_at = excluded.updated_at
       WHERE count < ?4
       RETURNING count`,
    )
      .bind(scope, bucket, nowIso, limit)
      .all<{ count: number }>();

    if ((result.results?.length ?? 0) === 0) {
      return quotaExceeded(scope);
    }
    return { ok: true };
  } catch (err) {
    console.error('[registryQuota] D1 error, fail-closed', scope, err);
    return quotaExceeded(scope);
  }
}

/** 只读：当前桶已用次数与上限（供设置页/排障，不扣配额） */
export async function getRegistryQuotaUsage(
  env: Env,
  scope: RegistryQuotaScope,
): Promise<{ used: number; limit: number; bucket: string }> {
  const limit = getRegistryQuotaLimit(env, scope);
  const bucket = bucketKey(scope);
  // MIGRATION-COVERAGE：同上（IDENTITY_DB）
  const identityDb = resolveIdentityDb(env);
  try {
    const row = await identityDb.prepare(
      `SELECT count FROM registry_quota_buckets WHERE scope = ?1 AND bucket = ?2`,
    )
      .bind(scope, bucket)
      .first<{ count: number }>();
    return { used: row?.count ?? 0, limit, bucket };
  } catch (err) {
    console.error('[registryQuota] read usage failed', scope, err);
    return { used: 0, limit, bucket };
  }
}
