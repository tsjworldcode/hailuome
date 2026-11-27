/**
 * NCF-READ-POLICY：黑名单 STATE_KV 读取。
 * - miss（无键）≠ exception（读失败）
 * - exception → stale-last-good（isolate 内 sub 缓存，TTL 对齐 M6-3 Cron）
 * - protected 档且无可用缓存 → 503 MISCONFIGURED（禁止 fail-open）
 */
import { blacklistKvKeysForSub } from '@hailuo/shared-utils';

/** 与 Worker A Cron 黑名单同步周期对齐 */
export const BLACKLIST_SUB_CACHE_TTL_MS = 5 * 60 * 1000;

type SubCacheEntry = { blacklisted: boolean; fetchedAt: number };

const subCache = new Map<string, SubCacheEntry>();

export function resetBlacklistKvSubCacheForTests(): void {
  subCache.clear();
}

function getFreshEntry(sub: string): SubCacheEntry | null {
  const hit = subCache.get(sub);
  if (!hit) return null;
  if (Date.now() - hit.fetchedAt > BLACKLIST_SUB_CACHE_TTL_MS) return null;
  return hit;
}

function getStaleEntry(sub: string): SubCacheEntry | null {
  return subCache.get(sub) ?? null;
}

export type BlacklistKvReadResult =
  | { ok: true; blacklisted: boolean }
  | { ok: false; error_code: 'MISCONFIGURED'; message: string };

const BLACKLIST_KV_FAIL_MSG = '节点黑名单状态暂不可用，请稍后再试';

export async function isFollowerSubBlacklistedStrict(
  stateKv: KVNamespace,
  sub: string,
  options: { protectedMode: boolean },
): Promise<BlacklistKvReadResult> {
  const fresh = getFreshEntry(sub);
  if (fresh) {
    return { ok: true, blacklisted: fresh.blacklisted };
  }

  try {
    let blacklisted = false;
    for (const key of blacklistKvKeysForSub(sub)) {
      const hit = await stateKv.get(key);
      if (hit) {
        blacklisted = true;
        break;
      }
    }
    subCache.set(sub, { blacklisted, fetchedAt: Date.now() });
    return { ok: true, blacklisted };
  } catch (err) {
    console.error('[blacklist-kv] STATE_KV 黑名单查询失败', err);
    const stale = getStaleEntry(sub);
    if (stale) {
      return { ok: true, blacklisted: stale.blacklisted };
    }
    if (options.protectedMode) {
      return {
        ok: false,
        error_code: 'MISCONFIGURED',
        message: BLACKLIST_KV_FAIL_MSG,
      };
    }
    // public-read 匿名路径通常不经此处；走到时维持历史 fail-open
    return { ok: true, blacklisted: false };
  }
}
