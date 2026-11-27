/**
 * M32-1：注册中心推荐用户 × 本地关注列表过滤（稳定身份优先）。
 *
 * 匹配优先级：user_id → pubkey_fingerprint → 规范化 worker_b_url → handle（遗留回退）。
 */

import { normalizeWorkerBOrigin } from '@hailuo/shared-utils';

/** 推荐项与关注行共用的最小身份字段 */
export interface RecommendedIdentityFields {
  user_id?: string | null;
  handle?: string | null;
  worker_b_url?: string | null;
  node_url?: string | null;
  pubkey_fingerprint?: string | null;
}

/** 从关注列表汇总出的稳定身份集合 */
export interface FollowIdentityIndex {
  userIds: Set<string>;
  pubkeyFingerprints: Set<string>;
  workerBUrls: Set<string>;
  handles: Set<string>;
}

function nonEmpty(value: string | null | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** 规范化 Worker B URL：trim、去尾斜杠、小写（与右栏比对一致） */
export function normalizeWorkerBUrlForCompare(url: string): string {
  const trimmed = nonEmpty(url);
  if (!trimmed) return '';
  return normalizeWorkerBOrigin(trimmed).toLowerCase();
}

function normalizeHandleForCompare(handle: string): string {
  return nonEmpty(handle).toLowerCase();
}

/** 从推荐项提取可比对 URL（worker_b_url 优先，其次 node_url） */
export function recommendedWorkerBUrls(item: RecommendedIdentityFields): string[] {
  const urls: string[] = [];
  const workerB = normalizeWorkerBUrlForCompare(item.worker_b_url ?? '');
  const node = normalizeWorkerBUrlForCompare(item.node_url ?? '');
  if (workerB) urls.push(workerB);
  if (node && node !== workerB) urls.push(node);
  return urls;
}

/**
 * 判断推荐项是否已被本地关注。
 * 优先级：user_id → pubkey_fingerprint → worker_b_url → handle。
 */
export function isRecommendedUserFollowed(
  item: RecommendedIdentityFields,
  index: FollowIdentityIndex,
): boolean {
  const userId = nonEmpty(item.user_id);
  if (userId && index.userIds.has(userId)) return true;

  const fingerprint = nonEmpty(item.pubkey_fingerprint);
  if (fingerprint && index.pubkeyFingerprints.has(fingerprint)) return true;

  for (const url of recommendedWorkerBUrls(item)) {
    if (index.workerBUrls.has(url)) return true;
  }

  const handle = normalizeHandleForCompare(item.handle ?? '');
  if (handle && index.handles.has(handle)) return true;

  return false;
}

/** 由关注身份行构建索引（与 GET /api/follows 输出字段对齐） */
export function buildFollowIdentityIndex(
  follows: readonly RecommendedIdentityFields[],
): FollowIdentityIndex {
  const userIds = new Set<string>();
  const pubkeyFingerprints = new Set<string>();
  const workerBUrls = new Set<string>();
  const handles = new Set<string>();

  for (const row of follows) {
    const userId = nonEmpty(row.user_id);
    if (userId) userIds.add(userId);

    const fingerprint = nonEmpty(row.pubkey_fingerprint);
    if (fingerprint) pubkeyFingerprints.add(fingerprint);

    for (const url of recommendedWorkerBUrls(row)) {
      if (url) workerBUrls.add(url);
    }

    const handle = normalizeHandleForCompare(row.handle ?? '');
    if (handle) handles.add(handle);
  }

  return { userIds, pubkeyFingerprints, workerBUrls, handles };
}

export interface FilterRegistryRecommendedResult<T extends RecommendedIdentityFields> {
  items: T[];
  hidden_following_count: number;
  displayed_count: number;
}

/** 过滤已关注推荐项；保留原顺序 */
export function filterRegistryRecommendedUsers<T extends RecommendedIdentityFields>(
  items: readonly T[],
  index: FollowIdentityIndex,
): FilterRegistryRecommendedResult<T> {
  const visible: T[] = [];
  let hidden = 0;
  for (const item of items) {
    if (isRecommendedUserFollowed(item, index)) {
      hidden += 1;
    } else {
      visible.push(item);
    }
  }
  return {
    items: visible,
    hidden_following_count: hidden,
    displayed_count: visible.length,
  };
}
