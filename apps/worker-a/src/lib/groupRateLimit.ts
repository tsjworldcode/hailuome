// M16-2：群消息 ingress 限频（group_id + member_worker_b_url 每小时 D1 计数）。

import type { Env } from '../env';
import { normalizeGroupMemberUrl } from './groupMemberUrl';
import { messagingDb } from './messagingDb';

/** 单成员单群每小时最多 ingress/发信次数。 */
export const GROUP_MESSAGE_RATE_LIMIT_PER_HOUR = 120;

function currentHourBucketIso(): string {
  const d = new Date();
  d.setUTCMinutes(0, 0, 0);
  return d.toISOString();
}

function bucketKey(groupId: string, memberWorkerBUrl: string, windowStart: string): string {
  return `${groupId}|${normalizeGroupMemberUrl(memberWorkerBUrl)}|${windowStart}`;
}

/**
 * 检查并递增群消息限频；超限返回 false。
 * 使用 D1 UPSERT + WHERE 原子递增，禁止 KV 写。
 */
export async function checkAndIncrementGroupMessageRate(
  env: Env,
  groupId: string,
  memberWorkerBUrl: string,
): Promise<boolean> {
  const windowStart = currentHourBucketIso();
  const key = bucketKey(groupId, memberWorkerBUrl, windowStart);

  const result = await messagingDb(env)
    .prepare(
      `INSERT INTO group_rate_buckets (bucket_key, count, window_start)
       VALUES (?, 1, ?)
       ON CONFLICT (bucket_key) DO UPDATE
       SET count = count + 1
       WHERE count < ?`,
    )
    .bind(key, windowStart, GROUP_MESSAGE_RATE_LIMIT_PER_HOUR)
    .run()
    .catch(() => null);

  return (result?.meta.changes ?? 0) > 0;
}

/** 单成员单群每小时最多 sync 次数。 */
export const GROUP_SYNC_RATE_LIMIT_PER_HOUR = 96;

/** SEC-5：补钥低频通道独立计数，不允许换 epoch 绕过成员小时上限。 */
export const GROUP_FAST_PULL_RATE_LIMIT_PER_HOUR = 30;

export async function checkAndIncrementGroupFastPullRate(
  env: Env,
  groupId: string,
  memberWorkerBUrl: string,
): Promise<boolean> {
  const windowStart = currentHourBucketIso();
  const key = `fast-pull|${groupId}|${normalizeGroupMemberUrl(memberWorkerBUrl)}|${windowStart}`;
  const result = await messagingDb(env)
    .prepare(
      `INSERT INTO group_rate_buckets (bucket_key, count, window_start)
       VALUES (?, 1, ?)
       ON CONFLICT (bucket_key) DO UPDATE
       SET count = count + 1
       WHERE count < ?`,
    )
    .bind(key, windowStart, GROUP_FAST_PULL_RATE_LIMIT_PER_HOUR)
    .run();
  // 数据库错误向上交给 503，不能误判成超限，更不能放行。
  if (!result.success || typeof result.meta.changes !== 'number') throw new Error('fast-pull rate unavailable');
  return result.meta.changes > 0;
}

function syncBucketKey(groupId: string, memberWorkerBUrl: string, windowStart: string): string {
  return `${groupId}|${normalizeGroupMemberUrl(memberWorkerBUrl)}|sync|${windowStart}`;
}

/** sync-with-parent 限频（D1，禁止 KV）。 */
export async function checkAndIncrementGroupSyncRate(
  env: Env,
  groupId: string,
  memberWorkerBUrl: string,
): Promise<boolean> {
  const windowStart = currentHourBucketIso();
  const key = syncBucketKey(groupId, memberWorkerBUrl, windowStart);

  const result = await messagingDb(env)
    .prepare(
      `INSERT INTO group_rate_buckets (bucket_key, count, window_start)
       VALUES (?, 1, ?)
       ON CONFLICT (bucket_key) DO UPDATE
       SET count = count + 1
       WHERE count < ?`,
    )
    .bind(key, windowStart, GROUP_SYNC_RATE_LIMIT_PER_HOUR)
    .run()
    .catch(() => null);

  return (result?.meta.changes ?? 0) > 0;
}

/** 按群号加入：单成员每小时最多尝试次数（防枚举 / 刷接口）。 */
export const GROUP_JOIN_RATE_LIMIT_PER_HOUR = 30;

/**
 * SEC-AUDIT-2026-10-2：单群每小时入群尝试上限。
 * 防攻击者换 URL 重置成员桶后打穿同一群（原桶仅按 member_worker_b_url）。
 */
export const GROUP_JOIN_RATE_LIMIT_PER_GROUP_PER_HOUR = 120;

function joinBucketKey(memberWorkerBUrl: string, windowStart: string): string {
  return `join|${normalizeGroupMemberUrl(memberWorkerBUrl)}|${windowStart}`;
}

function joinGroupBucketKey(groupId: string, windowStart: string): string {
  return `join-grp|${groupId}|${windowStart}`;
}

async function bumpJoinBucket(
  env: Env,
  key: string,
  windowStart: string,
  maxCount: number,
): Promise<boolean> {
  const result = await messagingDb(env)
    .prepare(
      `INSERT INTO group_rate_buckets (bucket_key, count, window_start)
       VALUES (?, 1, ?)
       ON CONFLICT (bucket_key) DO UPDATE
       SET count = count + 1
       WHERE count < ?`,
    )
    .bind(key, windowStart, maxCount)
    .run()
    .catch(() => null);

  return (result?.meta.changes ?? 0) > 0;
}

/**
 * M16-JOIN-POLICY-4 + SEC-AUDIT-2026-10-2：
 * 同时扣「成员 URL 桶」与「群级桶」；任一拒绝即 false。
 */
export async function checkAndIncrementGroupJoinRate(
  env: Env,
  memberWorkerBUrl: string,
  groupId?: string,
): Promise<boolean> {
  const windowStart = currentHourBucketIso();
  const memberOk = await bumpJoinBucket(
    env,
    joinBucketKey(memberWorkerBUrl, windowStart),
    windowStart,
    GROUP_JOIN_RATE_LIMIT_PER_HOUR,
  );
  if (!memberOk) return false;

  if (groupId && groupId.trim()) {
    const groupOk = await bumpJoinBucket(
      env,
      joinGroupBucketKey(groupId.trim(), windowStart),
      windowStart,
      GROUP_JOIN_RATE_LIMIT_PER_GROUP_PER_HOUR,
    );
    if (!groupOk) return false;
  }

  return true;
}

/** REL-FIX-6：跨节点管理员代理拉取/审批限频（单请求方单群每小时上限）。 */
export const GROUP_ADMIN_JOIN_REQUEST_RATE_LIMIT_PER_HOUR = 60;

function adminJoinRequestBucketKey(
  groupId: string,
  requesterWorkerBUrl: string,
  windowStart: string,
): string {
  return `admin-join-req|${groupId.trim()}|${normalizeGroupMemberUrl(
    requesterWorkerBUrl,
  )}|${windowStart}`;
}

/**
 * REL-FIX-6：管理员代理限频（D1 UPSERT 原子递增，禁止 KV 写）。
 * 超限返回 false。
 */
export async function checkAndIncrementAdminJoinRequestRate(
  env: Env,
  groupId: string,
  requesterWorkerBUrl: string,
): Promise<boolean> {
  const windowStart = currentHourBucketIso();
  const key = adminJoinRequestBucketKey(groupId, requesterWorkerBUrl, windowStart);

  const result = await messagingDb(env)
    .prepare(
      `INSERT INTO group_rate_buckets (bucket_key, count, window_start)
       VALUES (?, 1, ?)
       ON CONFLICT (bucket_key) DO UPDATE
       SET count = count + 1
       WHERE count < ?`,
    )
    .bind(key, windowStart, GROUP_ADMIN_JOIN_REQUEST_RATE_LIMIT_PER_HOUR)
    .run()
    .catch(() => null);

  return (result?.meta.changes ?? 0) > 0;
}
