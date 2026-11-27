// SDH-5：粉丝 Token 签发限频（按 follower_node_url 每小时 D1 计数）。

import type { Env } from '../env';
import { resolveGovernanceDb } from '../db/bindings';

/** 单 follower 节点每小时最多申领次数。 */
export const FOLLOWER_TOKEN_RATE_LIMIT_PER_HOUR = 60;

function currentHourBucketIso(): string {
  const d = new Date();
  d.setUTCMinutes(0, 0, 0);
  return d.toISOString();
}

function normalizeFollowerNodeUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

/**
 * 检查并递增签发限频；超限返回 false。
 */
export async function checkAndIncrementFollowerTokenRate(
  env: Env,
  followerNodeUrl: string,
): Promise<boolean> {
  const normalized = normalizeFollowerNodeUrl(followerNodeUrl);
  const windowHour = currentHourBucketIso();

  const result = await resolveGovernanceDb(env)
    .prepare(
      `INSERT INTO follower_token_rate_buckets (follower_node_url, window_hour, count)
       VALUES (?, ?, 1)
       ON CONFLICT (follower_node_url, window_hour) DO UPDATE
       SET count = count + 1
       WHERE count < ?`,
    )
    .bind(normalized, windowHour, FOLLOWER_TOKEN_RATE_LIMIT_PER_HOUR)
    .run()
    .catch(() => null);

  return (result?.meta.changes ?? 0) > 0;
}
