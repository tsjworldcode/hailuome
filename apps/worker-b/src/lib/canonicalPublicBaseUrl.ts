/**
 * M7-30g-4：Worker B 无 D1，公开基址读 STATE_KV 镜像。
 * 优先级：canonical key → public profile.worker_b_url → 请求 origin（回落）。
 */
import {
  PUBLIC_PROFILE_KV_KEY,
  PUBLIC_WORKER_B_URL_KV_KEY,
  type PublicOwnerProfile,
} from '@hailuo/shared-types';
import type { Env } from '../env.d';

const CACHE_TTL_MS = 60_000;

type CacheEntry = { value: string; expiresAtMs: number };

let cache: CacheEntry | null = null;

function stripTrailingSlash(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

function isPublicOwnerProfile(value: unknown): value is PublicOwnerProfile {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return typeof record.handle === 'string' && typeof record.pubkey === 'string';
}

/** 测试或换域后：清 isolate 缓存。 */
export function invalidateCanonicalPublicBaseUrlCache(): void {
  cache = null;
}

/**
 * 解析本节点对外公开基址（无尾斜杠）。
 * @param requestOrigin 当前请求 origin，作最终回落（禁止当作换域后的权威）
 */
export async function resolveCanonicalPublicBaseUrl(
  env: Env,
  requestOrigin?: string,
): Promise<string> {
  const now = Date.now();
  if (cache && cache.expiresAtMs > now) {
    return cache.value;
  }

  let fromCanonical = '';
  try {
    const raw = await env.STATE_KV.get(PUBLIC_WORKER_B_URL_KV_KEY);
    if (typeof raw === 'string' && raw.trim()) {
      fromCanonical = stripTrailingSlash(raw);
    }
  } catch (err) {
    console.error('[canonicalPublicBaseUrl] STATE_KV canonical 读取失败', err);
  }

  let fromProfile = '';
  if (!fromCanonical) {
    try {
      const cached = await env.STATE_KV.get(PUBLIC_PROFILE_KV_KEY, 'json');
      if (isPublicOwnerProfile(cached) && cached.worker_b_url) {
        fromProfile = stripTrailingSlash(cached.worker_b_url);
      }
    } catch (err) {
      console.error('[canonicalPublicBaseUrl] STATE_KV profile 读取失败', err);
    }
  }

  const fromOrigin =
    typeof requestOrigin === 'string' && requestOrigin.trim()
      ? stripTrailingSlash(requestOrigin)
      : '';

  const url = fromCanonical || fromProfile || fromOrigin;
  cache = { value: url, expiresAtMs: now + CACHE_TTL_MS };
  return url;
}
