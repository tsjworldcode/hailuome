/**
 * M9-12 / M13-3：公开读 KV 写入（Worker A Cron / 发帖刷新路径）。
 * M13-3：主键 envelope `{ items, meta }` 单次 put；读路径兼容 legacy 数组 + :meta 分键。
 * M13-10：feed:latest 内容指纹去重——无变化跳过 put，避免 Feed 提频打穿 KV 写 1000/天。
 * M34-OPT-1：单帖独立 key `post:{id}` 追加写入，支持 Worker B O(1) 单帖读取。
 * M13-15：废弃 `feed:sorted` 第二 put——变化时仅写 `feed:latest`（1 put）；
 * 并对上一版 `feed:sorted:{prevGeneratedAt}` 做有界 delete（≤1，无 list 扫库）。
 * audit-v3 步骤 2.2：posts:latest 写前 size guard；>20 MB 分桶到 posts:latest:bucket:{i}（最多 3 桶）。
 */
import {
  FEED_CACHE_META_KV_KEY,
  FEED_SORTED_KV_PREFIX,
  POSTS_CACHE_META_KV_KEY,
  POSTS_LATEST_BUCKET_PREFIX,
  POSTS_LATEST_MAX_BUCKETS,
  POSTS_LATEST_MAX_BYTES,
  POST_INDIVIDUAL_KV_PREFIX,
  type PublicReadCacheMeta,
} from '@hailuo/shared-types';
import type { Env } from '../env';

function isoNow(): string {
  return new Date().toISOString();
}

type CacheKvEnv = Pick<Env, 'POSTS_CACHE_KV' | 'LEGACY_PUBLIC_CACHE_META'>;

function shouldWriteLegacyMeta(env: CacheKvEnv): boolean {
  return env.LEGACY_PUBLIC_CACHE_META === 'true';
}

/** UTF-8 字节长度（与 KV value 计量一致） */
export function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

/**
 * 将 items 切成 ≤ maxBuckets 个桶，使每桶 envelope JSON ≤ maxBytes。
 * 列表假定已按时间倒序；放不下的最旧条目会被丢弃（fail-soft + warn）。
 * 导出供契约测试使用。
 */
export function splitPostsLatestBuckets(
  items: unknown[],
  maxBytes: number = POSTS_LATEST_MAX_BYTES,
  maxBuckets: number = POSTS_LATEST_MAX_BUCKETS,
): { buckets: unknown[][]; truncated: number } {
  const buckets: unknown[][] = [];
  let truncated = 0;
  let cursor = 0;

  while (cursor < items.length && buckets.length < maxBuckets) {
    const bucket: unknown[] = [];
    // 空桶先探测单帖是否本身超限
    while (cursor < items.length) {
      const candidate = [...bucket, items[cursor]];
      const probeMeta: PublicReadCacheMeta = {
        generated_at: '1970-01-01T00:00:00.000Z',
        stale: false,
        bucket_count: maxBuckets,
      };
      const probe = JSON.stringify({ items: candidate, meta: probeMeta });
      if (utf8ByteLength(probe) > maxBytes) {
        if (bucket.length === 0) {
          // 单帖已超限：跳过该帖，避免整次刷新失败
          console.warn(
            '[publicCacheMeta] posts:latest 单帖超过安全上限，跳过该条',
            { index: cursor },
          );
          cursor += 1;
          truncated += 1;
          continue;
        }
        break;
      }
      bucket.push(items[cursor]);
      cursor += 1;
    }
    if (bucket.length === 0) break;
    buckets.push(bucket);
  }

  if (cursor < items.length) {
    truncated += items.length - cursor;
    console.warn(
      '[publicCacheMeta] posts:latest 分桶达上限，截断最旧条目',
      { kept: items.length - truncated, truncated, maxBuckets },
    );
  }

  return { buckets, truncated };
}

/** M13-3 + audit-v3 2.2：写入 posts:latest envelope；超大时分桶 */
export async function putPostsLatestWithMeta(
  env: CacheKvEnv,
  items: unknown[],
): Promise<{ bucket_count: number; truncated: number }> {
  const generatedAt = isoNow();
  const singleMeta: PublicReadCacheMeta = {
    generated_at: generatedAt,
    stale: false,
  };
  const singleBody = JSON.stringify({ items, meta: singleMeta });

  // 常见路径：单值未超限 → 一次 put（与 M13-3 行为一致）
  if (utf8ByteLength(singleBody) <= POSTS_LATEST_MAX_BYTES) {
    await env.POSTS_CACHE_KV.put('posts:latest', singleBody);
    if (shouldWriteLegacyMeta(env)) {
      await env.POSTS_CACHE_KV.put(POSTS_CACHE_META_KV_KEY, JSON.stringify(singleMeta));
    }
    return { bucket_count: 1, truncated: 0 };
  }

  // 超限：分桶（主 key = 第 0 桶；bucket:1.. 为后续桶）
  const { buckets, truncated } = splitPostsLatestBuckets(items);
  if (buckets.length === 0) {
    const emptyMeta: PublicReadCacheMeta = {
      generated_at: generatedAt,
      stale: true,
      bucket_count: 1,
    };
    await env.POSTS_CACHE_KV.put(
      'posts:latest',
      JSON.stringify({ items: [], meta: emptyMeta }),
    );
    return { bucket_count: 1, truncated: truncated || items.length };
  }

  const bucketCount = buckets.length;
  const headMeta: PublicReadCacheMeta = {
    generated_at: generatedAt,
    stale: truncated > 0,
    bucket_count: bucketCount,
  };
  await env.POSTS_CACHE_KV.put(
    'posts:latest',
    JSON.stringify({ items: buckets[0], meta: headMeta }),
  );

  const sidePuts: Promise<unknown>[] = [];
  for (let i = 1; i < bucketCount; i++) {
    const sideMeta: PublicReadCacheMeta = {
      generated_at: generatedAt,
      stale: truncated > 0,
      bucket_count: bucketCount,
    };
    sidePuts.push(
      env.POSTS_CACHE_KV.put(
        `${POSTS_LATEST_BUCKET_PREFIX}${i}`,
        JSON.stringify({ items: buckets[i], meta: sideMeta }),
      ),
    );
  }
  if (shouldWriteLegacyMeta(env)) {
    sidePuts.push(
      env.POSTS_CACHE_KV.put(POSTS_CACHE_META_KV_KEY, JSON.stringify(headMeta)),
    );
  }
  await Promise.all(sidePuts);

  console.warn('[publicCacheMeta] posts:latest 已分桶写入', {
    bucket_count: bucketCount,
    truncated,
    bytes_head: utf8ByteLength(JSON.stringify({ items: buckets[0], meta: headMeta })),
  });

  return { bucket_count: bucketCount, truncated };
}

/**
 * feed:latest 内容指纹：只含影响 Following 展示的字段，不含 generated_at。
 * 导出供契约测试使用。
 */
export function feedLatestContentFingerprint(
  items: unknown[],
  partialFailedCount = 0,
): string {
  const ids = items.map((raw) => {
    if (!raw || typeof raw !== 'object') return '';
    const row = raw as Record<string, unknown>;
    const postId = typeof row.post_id === 'string' ? row.post_id : '';
    const id = typeof row.id === 'string' ? row.id : '';
    return postId || id;
  });
  return `${partialFailedCount}|${ids.join(',')}`;
}

function fingerprintFromStoredFeedEnvelope(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw) as {
      items?: unknown[];
      meta?: { partial_failed_count?: number };
    };
    // legacy：纯数组
    if (Array.isArray(parsed)) {
      return feedLatestContentFingerprint(parsed, 0);
    }
    const items = Array.isArray(parsed.items) ? parsed.items : [];
    const partial =
      typeof parsed.meta?.partial_failed_count === 'number'
        ? parsed.meta.partial_failed_count
        : 0;
    return feedLatestContentFingerprint(items, partial);
  } catch {
    return null;
  }
}

/** M13-15：从已存 envelope 取出 generated_at，供有界清理旧 feed:sorted 键 */
function generatedAtFromStoredFeedEnvelope(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw) as { meta?: { generated_at?: unknown } };
    if (Array.isArray(parsed) || !parsed || typeof parsed !== 'object') return null;
    const g = parsed.meta?.generated_at;
    return typeof g === 'string' && g.length > 0 ? g : null;
  } catch {
    return null;
  }
}

/**
 * M34-OPT-1：写入单帖独立 KV key（`post:{id}`）。
 * 与 posts:latest envelope 互补——posts:latest 保持全量快照，
 * 本函数提供 O(1) 单帖直接读取路径。
 * 调用方：posts.ts 发帖成功 / 删帖时（经 waitUntil 异步，不阻塞 HTTP 响应）。
 */
export async function putPostIndividual(
  env: Pick<Env, 'POSTS_CACHE_KV'>,
  post: unknown,
): Promise<void> {
  const row = post as Record<string, unknown>;
  const id = typeof row.id === 'string' ? row.id : '';
  if (!id) return;
  await env.POSTS_CACHE_KV.put(`${POST_INDIVIDUAL_KV_PREFIX}${id}`, JSON.stringify(post));
}

/**
 * M34-OPT-1：删除单帖独立 KV key（`post:{id}`）。
 * 调用方：posts.ts 删帖成功时（经 waitUntil 异步）。
 */
export async function deletePostIndividual(
  env: Pick<Env, 'POSTS_CACHE_KV'>,
  postId: string,
): Promise<void> {
  if (!postId) return;
  await env.POSTS_CACHE_KV.delete(`${POST_INDIVIDUAL_KV_PREFIX}${postId}`);
}

export type PutFeedLatestResult = {
  written: boolean;
  skippedUnchanged: boolean;
};

export type PutFeedLatestOptions = {
  /**
   * M13-16：只比对指纹、不写 KV。
   * - skippedUnchanged=true → 内容未变
   * - skippedUnchanged=false && written=false → 若实写将消耗 1 put
   */
  dryRunFingerprintOnly?: boolean;
};

/**
 * M13-15：有界清理上一版 feed:sorted 键（≤1 delete，禁止 list 扫库）。
 * 失败不阻断主路径——遗留键可由后续轮次继续删，或运维按前缀手工删。
 */
async function deletePreviousFeedSortedKey(
  env: CacheKvEnv,
  prevGeneratedAt: string | null,
): Promise<void> {
  if (!prevGeneratedAt) return;
  try {
    await env.POSTS_CACHE_KV.delete(`${FEED_SORTED_KV_PREFIX}${prevGeneratedAt}`);
  } catch (err) {
    console.warn('[publicCacheMeta] 清理旧 feed:sorted 失败（有界，不阻断）', err);
  }
}

/** M13-3 + M13-10 + M13-15：写入 feed:latest envelope；未变 0 put，变化 1 put（不再写 feed:sorted） */
export async function putFeedLatestWithMeta(
  env: CacheKvEnv,
  items: unknown[],
  partialFailedCount = 0,
  options?: PutFeedLatestOptions,
): Promise<PutFeedLatestResult> {
  const nextFp = feedLatestContentFingerprint(items, partialFailedCount);
  let prevGeneratedAt: string | null = null;
  try {
    const existing = await env.POSTS_CACHE_KV.get('feed:latest');
    if (existing) {
      prevGeneratedAt = generatedAtFromStoredFeedEnvelope(existing);
      const prevFp = fingerprintFromStoredFeedEnvelope(existing);
      if (prevFp !== null && prevFp === nextFp) {
        return { written: false, skippedUnchanged: true };
      }
    }
  } catch (err) {
    console.error('[publicCacheMeta] 读 feed:latest 指纹失败，继续写入', err);
  }

  // M13-16：预算占额前只探测「是否需要 put」
  if (options?.dryRunFingerprintOnly) {
    return { written: false, skippedUnchanged: false };
  }

  const meta: PublicReadCacheMeta = {
    generated_at: isoNow(),
    stale: partialFailedCount > 0,
    partial_failed_count: partialFailedCount,
  };
  await env.POSTS_CACHE_KV.put('feed:latest', JSON.stringify({ items, meta }));
  if (shouldWriteLegacyMeta(env)) {
    await env.POSTS_CACHE_KV.put(FEED_CACHE_META_KV_KEY, JSON.stringify(meta));
  }
  // M13-15：停写 feed:sorted；仅有界删上一版键（delete 不计 put 账本）
  await deletePreviousFeedSortedKey(env, prevGeneratedAt);
  return { written: true, skippedUnchanged: false };
}

/** @deprecated M13-3 起由 putPostsLatestWithMeta 替代 */
export async function writePostsCacheMeta(env: Pick<Env, 'POSTS_CACHE_KV'>): Promise<void> {
  const meta: PublicReadCacheMeta = {
    generated_at: isoNow(),
    stale: false,
  };
  await env.POSTS_CACHE_KV.put(POSTS_CACHE_META_KV_KEY, JSON.stringify(meta));
}

/** @deprecated M13-3 起由 putFeedLatestWithMeta 替代 */
export async function writeFeedCacheMeta(
  env: Pick<Env, 'POSTS_CACHE_KV'>,
  partialFailedCount = 0,
): Promise<void> {
  const meta: PublicReadCacheMeta = {
    generated_at: isoNow(),
    stale: partialFailedCount > 0,
    partial_failed_count: partialFailedCount,
  };
  await env.POSTS_CACHE_KV.put(FEED_CACHE_META_KV_KEY, JSON.stringify(meta));
}
