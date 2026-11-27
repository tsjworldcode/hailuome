/**
 * M13-1 + M14-5 + NCF-READ-POLICY + SEC-AUDIT-ENFORCED-FORCE-2：
 * isolate 内 follower_token_mode 读缓存；FORCE 关时读 KV/env；未配置默认 token-required。
 */
import type { FollowerTokenMode } from '@hailuo/shared-types';
import {
  FOLLOWER_TOKEN_MODE_FORCED,
  isFollowerTokenModeProgramForced,
  parseFollowerTokenModeForRead,
  resolveForcedFollowerTokenMode,
} from '@hailuo/shared-utils';

export type { FollowerTokenMode };

export const FOLLOWER_TOKEN_MODE_KV_KEY = 'node:follower_token_mode';

/** 与注册中心 health 探活频率对齐：45s 内复用内存缓存，避免每请求 KV get */
export const FOLLOWER_TOKEN_MODE_CACHE_TTL_MS = 45_000;

const MISCONFIGURED_MSG = '节点读帖保护配置无效，请检查 FOLLOWER_TOKEN_MODE 或联系站主';

type ModeCacheEntry = { mode: FollowerTokenMode; fetchedAt: number };

let cache: ModeCacheEntry | null = null;

export type FollowerTokenModeResolution =
  | { ok: true; mode: FollowerTokenMode }
  | { ok: false; error_code: 'MISCONFIGURED'; message: string };

export function modeFromFollowerTokenEnv(env: { FOLLOWER_TOKEN_MODE?: string }): FollowerTokenModeResolution {
  // 恒强制：忽略 wrangler / .dev.vars（与 GRP-RELAY-AUTH-FORCE-1 同模式）
  if (isFollowerTokenModeProgramForced()) {
    return { ok: true, mode: resolveForcedFollowerTokenMode() };
  }
  const parsed = parseFollowerTokenModeForRead(env.FOLLOWER_TOKEN_MODE);
  if (!parsed.ok) {
    return { ok: false, error_code: 'MISCONFIGURED', message: MISCONFIGURED_MSG };
  }
  return { ok: true, mode: parsed.mode };
}

export type ResolveFollowerTokenModeOptions = {
  /** /health 探活仅用 wrangler env，不读 KV（注册中心 Cron 最高频） */
  skipKv?: boolean;
};

/**
 * 解析当前 follower_token_mode。
 * FORCE 开启时恒 `FOLLOWER_TOKEN_MODE_FORCED`（忽略 KV / env）。
 * 否则：KV（TTL 缓存）优先，miss 回落 env（未设 → token-required）；非法 → MISCONFIGURED；KV exception → stale / env。
 */
export async function resolveFollowerTokenMode(
  env: { FOLLOWER_TOKEN_MODE?: string },
  stateKv: KVNamespace,
  options?: ResolveFollowerTokenModeOptions,
): Promise<FollowerTokenModeResolution> {
  if (isFollowerTokenModeProgramForced()) {
    return { ok: true, mode: FOLLOWER_TOKEN_MODE_FORCED };
  }

  if (options?.skipKv) {
    return modeFromFollowerTokenEnv(env);
  }

  const now = Date.now();
  if (cache && now - cache.fetchedAt < FOLLOWER_TOKEN_MODE_CACHE_TTL_MS) {
    return { ok: true, mode: cache.mode };
  }

  const envResult = modeFromFollowerTokenEnv(env);
  if (!envResult.ok) {
    return envResult;
  }

  try {
    const kv = await stateKv.get(FOLLOWER_TOKEN_MODE_KV_KEY);
    let resolved = envResult.mode;
    if (kv !== null && kv !== '') {
      const kvParsed = parseFollowerTokenModeForRead(kv);
      if (!kvParsed.ok) {
        return { ok: false, error_code: 'MISCONFIGURED', message: MISCONFIGURED_MSG };
      }
      resolved = kvParsed.mode;
    }
    cache = { mode: resolved, fetchedAt: now };
    return { ok: true, mode: resolved };
  } catch (err) {
    console.error('[worker-b] 读 follower_token_mode KV 失败', err);
    if (cache) {
      return { ok: true, mode: cache.mode };
    }
    return envResult;
  }
}

/** 契约测试用：重置 isolate 缓存 */
export function resetFollowerTokenModeCacheForTests(): void {
  cache = null;
}
