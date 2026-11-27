/**
 * M9-3-5：registry_endpoints D1 → STATE_KV 脱敏同步。
 *
 * KV 键 `node:registry_endpoints` 供 Worker B / Web 只读；不得含 node_api_token / owner_user_id。
 * 内容变更时才写入 KV（字符串比对），避免无 diff 的重复 put。
 */

import type { Env } from '../env';
import { resolveIdentityDb } from '../db/bindings';
import { readRegistryEndpoints } from '../lib/registryEndpoints';
import { REGISTRY_ENDPOINTS_KV_KEY } from '@hailuo/shared-types';
import { sanitizeRegistryEndpointsForPublic } from '@hailuo/shared-utils';

/**
 * 将 D1 registry_endpoints 脱敏后写入 STATE_KV（内容未变则跳过 put）。
 * fail-soft：失败只记日志，不抛异常。
 */
export async function syncRegistryEndpointsToKv(
  env: Env,
): Promise<{ status: 'synced' | 'skipped' | 'empty' }> {
  let endpoints;
  try {
    // M-OPT-SPLIT-A7-3：registry_endpoints 存 IDENTITY system_config
    endpoints = await readRegistryEndpoints(resolveIdentityDb(env));
  } catch (err) {
    console.error('[registry-endpoints/kv-sync] 读 D1 失败', err);
    return { status: 'skipped' };
  }

  if (endpoints.length === 0) {
    try {
      const existing = await env.STATE_KV.get(REGISTRY_ENDPOINTS_KV_KEY);
      if (existing === '[]') return { status: 'empty' };
      await env.STATE_KV.put(REGISTRY_ENDPOINTS_KV_KEY, '[]');
    } catch (err) {
      console.error('[registry-endpoints/kv-sync] 清空 KV 失败', err);
      return { status: 'skipped' };
    }
    return { status: 'empty' };
  }

  const payload = sanitizeRegistryEndpointsForPublic(endpoints);
  const json = JSON.stringify(payload);

  try {
    const existing = await env.STATE_KV.get(REGISTRY_ENDPOINTS_KV_KEY);
    if (existing === json) return { status: 'skipped' };
    await env.STATE_KV.put(REGISTRY_ENDPOINTS_KV_KEY, json);
    return { status: 'synced' };
  } catch (err) {
    console.error('[registry-endpoints/kv-sync] KV put 失败', err);
    return { status: 'skipped' };
  }
}
