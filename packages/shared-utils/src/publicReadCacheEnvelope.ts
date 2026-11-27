import type { PublicReadCacheEnvelope, PublicReadCacheMeta } from '@hailuo/shared-types';

/** M13-3：判断 KV JSON 是否为 envelope（{ items, meta }），非纯数组 */
export function isPublicReadCacheEnvelope<T>(
  value: unknown,
): value is PublicReadCacheEnvelope<T> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.items)) return false;
  const meta = record.meta;
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return false;
  const m = meta as PublicReadCacheMeta;
  return m.generated_at === null || typeof m.generated_at === 'string';
}
