/**
 * M7-31b：公开资料 KV 中 email_verified 字段读写。
 * M7-30g-2：同步 canonical Worker B URL 到独立 STATE_KV key，供 Pages 运行时代理。
 */
import {
  PUBLIC_PROFILE_KV_KEY,
  PUBLIC_WORKER_B_URL_KV_KEY,
  type PublicOwnerProfile,
} from '@hailuo/shared-types';
import type { Env } from '../env';

function isPublicOwnerProfile(value: unknown): value is PublicOwnerProfile {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return typeof record.handle === 'string' && typeof record.pubkey === 'string';
}

function normalizePublicBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, '');
}

/** M7-30g-2：写入 STATE_KV 纯文本公开基址（Pages 无 D1 时读此 key）。 */
export async function syncCanonicalWorkerBUrlKv(env: Env, workerBUrl: string): Promise<void> {
  const url = normalizePublicBaseUrl(workerBUrl);
  if (!url) return;
  await env.STATE_KV.put(PUBLIC_WORKER_B_URL_KV_KEY, url);
}

/** 更新 STATE_KV 快照中的 email_verified；无快照时静默跳过。 */
export async function setPublicProfileEmailVerified(env: Env, verified: boolean): Promise<void> {
  await setPublicProfileEmailVerifiedCas(env, verified);
}

/**
 * M33-v2-7b：CAS 写蓝标 — 已为 true 时跳过 KV 写（省 Free Tier 配额）。
 * @returns updated=已写入；skipped=无需变更；missing=无快照
 */
export async function setPublicProfileEmailVerifiedCas(
  env: Env,
  verified: boolean,
): Promise<'updated' | 'skipped' | 'missing'> {
  const cached = await env.STATE_KV.get(PUBLIC_PROFILE_KV_KEY, 'json').catch(() => null);
  if (!isPublicOwnerProfile(cached)) return 'missing';
  if (cached.email_verified === verified) return 'skipped';
  const profile: PublicOwnerProfile = {
    ...cached,
    email_verified: verified,
    updated_at: new Date().toISOString(),
  };
  await env.STATE_KV.put(PUBLIC_PROFILE_KV_KEY, JSON.stringify(profile));
  return 'updated';
}

/** 读取当前公开资料中的 email_verified；缺省 false。 */
export async function readPublicProfileEmailVerified(env: Env): Promise<boolean> {
  const cached = await env.STATE_KV.get(PUBLIC_PROFILE_KV_KEY, 'json').catch(() => null);
  if (!isPublicOwnerProfile(cached)) return false;
  return cached.email_verified === true;
}

/** M7-30a / M7-30g-2：换域 confirm 后更新公开资料快照 + canonical URL KV。 */
export async function syncPublicProfileWorkerBUrl(env: Env, workerBUrl: string): Promise<void> {
  const normalized = normalizePublicBaseUrl(workerBUrl);
  // 先写专用 key：即使公开资料快照尚未建立，Pages 也能读到新基址
  await syncCanonicalWorkerBUrlKv(env, normalized).catch((err) => {
    console.error('[publicProfileKv] canonical worker_b_url KV 同步失败', err);
  });

  const cached = await env.STATE_KV.get(PUBLIC_PROFILE_KV_KEY, 'json').catch(() => null);
  if (!isPublicOwnerProfile(cached)) return;
  const profile: PublicOwnerProfile = {
    ...cached,
    worker_b_url: normalized || workerBUrl,
    updated_at: new Date().toISOString(),
  };
  await env.STATE_KV.put(PUBLIC_PROFILE_KV_KEY, JSON.stringify(profile));
}
