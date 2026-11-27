/**
 * registry_endpoints 脱敏 helpers（M9-3-5）— Worker A 写 KV、Worker B / Web 读。
 */

import type { PublicRegistryEndpoint } from '@hailuo/shared-types';

/** D1 完整 endpoint 的最小字段集（含敏感字段，sanitize 时剔除）。 */
export interface RegistryEndpointLike {
  registry_id: string;
  registry_url: string;
  trust_pubkey: string;
  status: PublicRegistryEndpoint['status'];
  added_at: string;
  last_ok_at?: string;
  last_fail_at?: string;
  fail_streak: number;
  url_sync_state?: 'synced' | 'stale';
  node_api_token?: string;
  owner_user_id?: string;
}

export function sanitizeRegistryEndpointsForPublic(
  endpoints: RegistryEndpointLike[],
): PublicRegistryEndpoint[] {
  return endpoints.map((endpoint) => ({
    registry_id: endpoint.registry_id,
    registry_url: endpoint.registry_url,
    trust_pubkey: endpoint.trust_pubkey,
    status: endpoint.status,
    added_at: endpoint.added_at,
    ...(endpoint.last_ok_at ? { last_ok_at: endpoint.last_ok_at } : {}),
    ...(endpoint.last_fail_at ? { last_fail_at: endpoint.last_fail_at } : {}),
    fail_streak: endpoint.fail_streak,
    ...(endpoint.url_sync_state === 'stale' ? { url_sync_state: 'stale' as const } : {}),
  }));
}

/** 解析 KV JSON；含 token 字段或结构非法时丢弃该条/整包 fail-soft 为空。 */
export function parsePublicRegistryEndpointsKv(raw: string | null): PublicRegistryEndpoint[] {
  if (!raw?.trim()) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is PublicRegistryEndpoint => {
      if (!item || typeof item !== 'object') return false;
      const row = item as Record<string, unknown>;
      if ('node_api_token' in row || 'owner_user_id' in row) return false;
      return typeof row.registry_id === 'string'
        && typeof row.registry_url === 'string'
        && typeof row.trust_pubkey === 'string'
        && typeof row.status === 'string'
        && typeof row.added_at === 'string'
        && typeof row.fail_streak === 'number';
    });
  } catch {
    return [];
  }
}
