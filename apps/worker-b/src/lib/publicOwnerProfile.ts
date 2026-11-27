/**
 * NCF-2E：公开用户资料快照形状校验与合规字段剥离。
 * SPILL-1c：PublicOwnerProfile 已无 birth_date/gender；仍剥离旧 KV 残留键。
 */
import type { PublicOwnerProfile } from '@hailuo/shared-types';

export function isPublicOwnerProfile(value: unknown): value is PublicOwnerProfile {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.handle === 'string' &&
    typeof record.pubkey === 'string' &&
    (record.dm_pubkey === undefined || typeof record.dm_pubkey === 'string') &&
    typeof record.worker_b_url === 'string'
  );
}

/** 公开 HTTP 响应不含合规字段；旧 KV 可能仍带 birth_date/gender（M7-29-P0 / SPILL-1c） */
export function omitPublicComplianceFields(
  profile: PublicOwnerProfile,
): PublicOwnerProfile {
  const record = { ...profile } as PublicOwnerProfile & {
    birth_date?: unknown;
    gender?: unknown;
    country?: unknown;
    phone?: unknown;
  };
  delete record.birth_date;
  delete record.gender;
  delete record.country;
  delete record.phone;
  return record;
}
