/**
 * R-MSG-1b：轮换成功后原子写入本地三处凭证副本（R-MSG-1d：落盘为 AES-GCM 密文）。
 * 失败不得先删旧 token；registry 已换证后必须尽量落盘（含一次重试）。
 * 日志禁止输出完整 nat_ 明文。
 */
import { resolveIdentityDb } from '../db/bindings';
import type { Env } from '../env';
import { prepareNodeApiTokenForDb } from './nodeApiTokenAtRest';
import { readRegistryEndpoints } from './registryEndpoints';
import {
  bindWriteRegisteredRegistries,
  readRegisteredRegistry,
} from './registeredRegistries';

export function nodeApiTokenDisplay(token: string): string {
  return `${token.slice(0, 8)}...`;
}

/**
 * 同步更新（密文）：
 * - system_config.node_api_token
 * - registered_registries[0].node_api_token
 * - registry_endpoints 中与 home 同 registry_id 的 node_api_token
 */
export async function persistRotatedNodeApiToken(
  env: Env,
  newToken: string,
  rotatedAt: string = new Date().toISOString(),
): Promise<{ node_api_token_display: string; rotated_at: string }> {
  const token = newToken.trim();
  if (!token.startsWith('nat_') || token.length < 12) {
    throw new Error('ROTATE_TOKEN_MALFORMED');
  }

  const identityDb = resolveIdentityDb(env);
  const home = await readRegisteredRegistry(identityDb);
  if (!home) {
    throw new Error('ROTATE_NO_REGISTERED_REGISTRY');
  }

  // 中文注释：三处共用同一次 seal，避免随机 IV 导致投影比对误判
  const sealed = await prepareNodeApiTokenForDb(env, token);
  const updatedHome = { ...home, node_api_token: sealed };
  const endpoints = await readRegistryEndpoints(identityDb);
  const nextEndpoints = endpoints.map((ep) =>
    ep.registry_id === home.registry_id
      ? { ...ep, node_api_token: sealed, owner_user_id: home.owner_user_id }
      : ep,
  );

  const runBatch = async () => {
    await identityDb.batch([
      identityDb
        .prepare(
          `INSERT OR REPLACE INTO system_config (key, value, updated_at) VALUES ('node_api_token', ?, ?)`,
        )
        .bind(sealed, rotatedAt),
      bindWriteRegisteredRegistries(identityDb, updatedHome, rotatedAt),
      identityDb
        .prepare(
          `INSERT OR REPLACE INTO system_config (key, value, updated_at) VALUES ('registry_endpoints', ?, ?)`,
        )
        .bind(JSON.stringify(nextEndpoints), rotatedAt),
    ]);
  };

  try {
    await runBatch();
  } catch (err) {
    console.error('[rotate-token] 本地落盘失败，重试一次', err);
    await runBatch();
  }

  return {
    node_api_token_display: nodeApiTokenDisplay(token),
    rotated_at: rotatedAt,
  };
}
