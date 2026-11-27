/**
 * NCF-2B-5：公开资料字段规范化（纯函数，无 Env）。
 */
export const PROFILE_DISPLAY_NAME_MAX = 80;
export const PROFILE_BIO_MAX = 280;
export const PROFILE_CONTACT_EMAIL_MAX = 254;
export const PROFILE_AVATAR_KEY_MAX = 200;

export function normalizeProfileText(value: unknown, max: number): string | null {
  if (value === undefined) return null;
  if (typeof value !== 'string') return null;
  return value.trim().slice(0, max);
}

export function normalizeContactEmail(value: unknown): string | null {
  const normalized = normalizeProfileText(value, PROFILE_CONTACT_EMAIL_MAX);
  if (normalized === null) return null;
  if (!normalized) return '';
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized) ? normalized.toLowerCase() : null;
}

export function normalizePatchProfileBody(body: Record<string, unknown>): {
  ok: true;
  displayName: string;
  bio: string;
  avatarKey: string;
  contactEmail: string;
} | { ok: false; reason: 'use_registration_profile' | 'bad_request' } {
  if ('birth_date' in body || 'gender' in body || 'country' in body || 'phone' in body) {
    return { ok: false, reason: 'use_registration_profile' };
  }
  const displayName = normalizeProfileText(body.display_name, PROFILE_DISPLAY_NAME_MAX);
  const bio = normalizeProfileText(body.bio, PROFILE_BIO_MAX);
  const avatarKey = normalizeProfileText(body.avatar_key, PROFILE_AVATAR_KEY_MAX);
  const contactEmail = normalizeContactEmail(body.contact_email);
  if (displayName === null || bio === null || avatarKey === null || contactEmail === null) {
    return { ok: false, reason: 'bad_request' };
  }
  return { ok: true, displayName, bio, avatarKey, contactEmail };
}
