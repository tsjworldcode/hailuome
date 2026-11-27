/** @jsxImportSource preact */
/** M-i18n-L3：i18n runtime — 注册表 + zh 常驻 + 其它语言懒加载 */
import { signal } from '@preact/signals';
import zhCatalog from './catalogs/zh';
import {
  catalogGeneration,
  getCatalog,
  loadLocale,
  preloadLocale,
  isLocaleLoaded,
  type MessageCatalog,
} from './loadLocale';
import { loadErrorCatalog, preloadErrorCatalog } from './errorCatalog';
import {
  DEFAULT_LANGUAGE,
  htmlLangFor,
  isLanguage,
  matchBrowserLanguage,
  normalizeLanguage,
  type Language,
} from './locales';

export type { Language } from './locales';
export type { MessageCatalog } from './loadLocale';
export {
  DEFAULT_LANGUAGE,
  LANGUAGE_CODES,
  SUPPORTED_LOCALES,
  htmlLangFor,
  isLanguage,
  matchBrowserLanguage,
  normalizeLanguage,
  turnstileLangFor,
} from './locales';
export { loadLocale, preloadLocale, isLocaleLoaded, getCatalog };
export { loadErrorCatalog, preloadErrorCatalog };

export const LANGUAGE_STORAGE_KEY = 'hailuo:language';

/** zh 全量常驻；en 等语言经 loadLocale 注入后可通过 getCatalog 读取 */
export const TRANSLATIONS: Readonly<Record<Language, MessageCatalog>> = {
  zh: zhCatalog,
  en: {} as MessageCatalog,
};

export type TranslationKey = keyof typeof zhCatalog;

export function getBrowserDefaultLanguage(): Language {
  if (typeof navigator === 'undefined') return DEFAULT_LANGUAGE;
  const candidates = [navigator.language, ...(navigator.languages ?? [])];
  return matchBrowserLanguage(candidates);
}

export function readStoredLanguage(): Language {
  if (typeof window === 'undefined') return DEFAULT_LANGUAGE;
  try {
    const stored = window.localStorage.getItem(LANGUAGE_STORAGE_KEY);
    if (isLanguage(stored)) return stored;
  } catch {
    return getBrowserDefaultLanguage();
  }
  return getBrowserDefaultLanguage();
}

function applyDocumentLanguage(next: Language): void {
  if (typeof document === 'undefined') return;
  document.documentElement.lang = htmlLangFor(next);
  document.documentElement.dataset.lang = next;
}

/**
 * UX-I18N-SYNC：客户端模块加载时立刻从 localStorage 读语言，
 * 避免 View Transition / island 水合前 language 仍停在默认 zh，
 * 导致切换钮高亮「中」而正文已是英文。
 */
function initialLanguage(): Language {
  if (typeof window === 'undefined') return DEFAULT_LANGUAGE;
  return readStoredLanguage();
}

export const language = signal<Language>(initialLanguage());

export function translate(
  key: TranslationKey,
  lang: Language = language.value,
  vars?: Record<string, string | number>,
): string {
  void catalogGeneration.value;
  const table = getCatalog(lang);
  let text: string = table[key] ?? getCatalog(DEFAULT_LANGUAGE)[key] ?? key;
  if (vars) {
    for (const [name, value] of Object.entries(vars)) {
      text = text.replaceAll('{' + name + '}', String(value));
    }
  }
  return text;
}

export const t = translate;

export async function setLanguage(next: Language): Promise<void> {
  const normalized = normalizeLanguage(next);
  await Promise.all([loadLocale(normalized), loadErrorCatalog(normalized)]);
  language.value = normalized;
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(LANGUAGE_STORAGE_KEY, normalized);
    } catch {
      /* localStorage 不可用时只做当前页内切换 */
    }
  }
  applyDocumentLanguage(normalized);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent('hailuo:language-change', { detail: { language: normalized } }),
    );
  }
}

export function initLanguage(): Language {
  const next = readStoredLanguage();
  language.value = next;
  applyDocumentLanguage(next);
  if (next !== DEFAULT_LANGUAGE) {
    void Promise.all([loadLocale(next), loadErrorCatalog(next)]).then(() => {
      if (typeof window !== 'undefined') {
        window.dispatchEvent(
          new CustomEvent('hailuo:language-change', { detail: { language: next } }),
        );
      }
    });
  }
  return next;
}

let pageLoadBound = false;

function bindAstroPageLoadSync(): void {
  if (typeof document === 'undefined' || pageLoadBound) return;
  pageLoadBound = true;
  document.addEventListener('astro:page-load', () => {
    initLanguage();
  });
}

if (typeof window !== 'undefined') {
  applyDocumentLanguage(language.value);
  bindAstroPageLoadSync();
}
