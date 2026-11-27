/**
 * M14：读帖保护模式解析（D1 权威 + shared-utils SSOT）。
 * SEC-AUDIT-ENFORCED-FORCE-2：FORCE 关时读 D1/env；未配置默认 token-required。
 */
import { resolveIdentityDb } from '../db/bindings';
import type { FollowerTokenMode } from '@hailuo/shared-types';
import {
  isFollowerTokenModeProgramForced,
  normalizeFollowerTokenMode,
  normalizeWorkerBOrigin,
  resolveForcedFollowerTokenMode,
} from '@hailuo/shared-utils';
import type { Env } from '../env';
import { FOLLOWER_TOKEN_MODE_CONFIG_KEY } from '../routes/node-settings';

/** 从 D1 system_config 或 env 解析当前读帖保护档位（含 enforced 读 alias）。 */
export async function resolveReadProtectionMode(env: Env): Promise<FollowerTokenMode> {
  // 恒强制：签发 / 互粉门禁与 Worker B 读档对齐，不读 D1/env
  if (isFollowerTokenModeProgramForced()) {
    return resolveForcedFollowerTokenMode();
  }
  try {
    const row = await resolveIdentityDb(env)
      .prepare('SELECT value FROM system_config WHERE key = ? LIMIT 1')
      .bind(FOLLOWER_TOKEN_MODE_CONFIG_KEY)
      .first<{ value: string }>();
    if (row?.value) {
      return normalizeFollowerTokenMode(row.value);
    }
  } catch (err) {
    console.error('[readProtectionMode] 读 follower_token_mode 失败，回落 env', err);
  }
  return normalizeFollowerTokenMode(env.FOLLOWER_TOKEN_MODE);
}

/** 读者 Worker B URL 是否在站主 follows 表（URL 已归一化比对）。 */
export async function isFollowedNode(env: Env, workerBUrl: string): Promise<boolean> {
  const normalized = normalizeWorkerBOrigin(workerBUrl);
  const row = await resolveIdentityDb(env)
    .prepare('SELECT 1 AS found FROM follows WHERE follower_node_url = ? LIMIT 1')
    .bind(normalized)
    .first<{ found: number }>();
  return row !== null;
}

export { normalizeWorkerBOrigin };
