import { translate, type Language, language as languageSignal } from './i18n';
import { DEFAULT_LANGUAGE } from './i18n/locales';

// M7-2 + M-i18n-L5：相对时间走 i18n key，去掉 zh/en 二元硬编码文案

const SECOND_MS = 1_000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * 把 ISO 8601 时间戳格式化为相对时间（文案来自 i18n catalogs）。
 *
 * 规则：
 * - < 1 分钟 → timeNow
 * - < 1 小时 → timeMinutesAgo
 * - < 24 小时 → timeHoursAgo
 * - < 7 天 → timeDaysAgo
 * - ≥ 7 天 → YYYY-MM-DD
 */
export function formatRelativeTime(
  isoString: string,
  now: number = Date.now(),
  lang: Language = languageSignal.value ?? DEFAULT_LANGUAGE,
): string {
  const parsed = Date.parse(isoString);
  if (!Number.isFinite(parsed)) return '';
  const diff = now - parsed;

  if (diff < MINUTE_MS) return translate('timeNow', lang);
  if (diff < HOUR_MS) {
    return translate('timeMinutesAgo', lang, { count: Math.floor(diff / MINUTE_MS) });
  }
  if (diff < DAY_MS) {
    return translate('timeHoursAgo', lang, { count: Math.floor(diff / HOUR_MS) });
  }
  if (diff < 7 * DAY_MS) {
    return translate('timeDaysAgo', lang, { count: Math.floor(diff / DAY_MS) });
  }
  return formatAbsoluteDate(isoString);
}

export function formatAbsoluteDate(isoString: string): string {
  const t = Date.parse(isoString);
  if (!Number.isFinite(t)) return '';
  const d = new Date(t);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
