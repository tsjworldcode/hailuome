/**
 * M32-1：读取关注列表稳定身份字段（供推荐过滤与 GET /api/follows 复用逻辑）。
 * M-OPT-SPLIT-4：本文件切到显式 resolveIdentityDb(env)，不再走 env.DB 隐式 binding。
 *   - follows 与 cache_entries 同在 IDENTITY_DB（migration 0001 + 0017 + 0041），
 *     因此保留单库 batch；A-7 真分 binding 后若 N→独立，再拆两步串行。
 */

import type { Env } from '../env.d';
import { resolveIdentityDb } from '../db/bindings';
import type { RecommendedIdentityFields } from './registryRecommendedFilter';

interface FollowRow {
  follower_node_url: string;
  followed_handle: string | null;
  followed_worker_b_url: string | null;
  cached_profile_json: string | null;
}

function optionalString(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, maxLength);
}

function readCachedFollowProfile(raw: string | null): RecommendedIdentityFields {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      handle: optionalString(parsed.handle, 64),
      worker_b_url:
        optionalString(parsed.worker_b_url, 2048) || optionalString(parsed.node_url, 2048),
      user_id: optionalString(parsed.user_id, 64),
      pubkey_fingerprint: optionalString(parsed.pubkey_fingerprint, 32),
    };
  } catch {
    return {};
  }
}

/** 读取关注稳定身份（含 cache_entries 补齐的 user_id / pubkey_fingerprint） */
export async function readFollowIdentityRows(env: Env): Promise<RecommendedIdentityFields[]> {
  const identityDb = resolveIdentityDb(env);
  // follows 与 cache_entries 同在 IDENTITY_DB（migration 0001 + 0017 + 0041），
  // 因此保留单库 batch；A-7 真分 binding 后若 N→独立，再拆两步串行。
  const result = await identityDb
    .prepare(
      `SELECT f.follower_node_url, f.followed_handle, f.followed_worker_b_url,
              (
                SELECT ce.response_json
                  FROM cache_entries ce
                 WHERE ce.node_url = f.follower_node_url OR ce.worker_b_url = f.follower_node_url
                 ORDER BY ce.fetched_at DESC
                 LIMIT 1
              ) AS cached_profile_json
         FROM follows f`,
    )
    .all<FollowRow>();

  return (result.results ?? []).map((row) => {
    const cached = readCachedFollowProfile(row.cached_profile_json);
    const handle = row.followed_handle || cached.handle || '';
    const workerBUrl = row.followed_worker_b_url || cached.worker_b_url || row.follower_node_url;
    return {
      user_id: cached.user_id || '',
      handle,
      worker_b_url: workerBUrl,
      node_url: row.follower_node_url,
      pubkey_fingerprint: cached.pubkey_fingerprint || '',
    };
  });
}
