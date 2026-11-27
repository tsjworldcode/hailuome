/** M-REFACTOR-1c：Settings 共享纯函数 */
import { stripTrailingSlash } from '../../lib/auth';
import { t } from '../../lib/i18n';

export function validateWorkerAUrl(raw: string): { ok: true; normalized: string } | { ok: false; reason: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, reason: t('settingsUrlEmpty') };
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, reason: t('settingsUrlInvalid') };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: t('settingsUrlProtocol') };
  }
  if (!parsed.host) {
    return { ok: false, reason: t('settingsUrlNoHost') };
  }
  return { ok: true, normalized: stripTrailingSlash(trimmed) };
}

/** 与 shared-crypto checkPasswordStrength 对齐：≥ 8 + 字母 + 数字（不强制符号）。 */
export function checkPasswordStrengthClient(p: string): { ok: true } | { ok: false; reason: string } {
  if (typeof p !== 'string') return { ok: false, reason: t('settingsPasswordNotString') };
  if (p.length < 8) return { ok: false, reason: t('settingsPasswordTooShort') };
  if (p.length > 256) return { ok: false, reason: t('settingsPasswordTooLong') };
  if (!/[A-Za-z]/.test(p)) return { ok: false, reason: t('settingsPasswordNeedsLetter') };
  if (!/[0-9]/.test(p)) return { ok: false, reason: t('settingsPasswordNeedsDigit') };
  return { ok: true };
}

export function formatLogTime(value: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

export function logLevelClass(level: string): string {
  const base = 'rounded px-1.5 py-0.5 font-mono text-[10px] uppercase';
  if (level === 'error') return `${base} bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300`;
  if (level === 'warn') return `${base} bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300`;
  if (level === 'info') return `${base} bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300`;
  return `${base} bg-slate-100 text-slate-600 dark:bg-zinc-800 dark:text-zinc-300`;
}
