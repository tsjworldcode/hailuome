/**
 * M-i18n-L5：error_code 文案 catalog（不并入 TranslationKey）。
 */
import zhErrors from './catalogs/zh/errors';
import { DEFAULT_LANGUAGE, isLanguage, type Language } from './locales';

export type ErrorCodeCatalog = typeof zhErrors;

const cache = new Map<Language, ErrorCodeCatalog>();
cache.set(DEFAULT_LANGUAGE, zhErrors);

type ErrModule = { default: ErrorCodeCatalog };
const loaders: Partial<Record<Language, () => Promise<ErrModule>>> = {
  en: () => import('./catalogs/en/errors.ts') as unknown as Promise<ErrModule>,
};

export function getErrorCatalog(lang: Language = DEFAULT_LANGUAGE): ErrorCodeCatalog {
  return cache.get(lang) ?? cache.get(DEFAULT_LANGUAGE)!;
}

export async function loadErrorCatalog(lang: Language): Promise<ErrorCodeCatalog> {
  const hit = cache.get(lang);
  if (hit) return hit;
  if (lang === DEFAULT_LANGUAGE) {
    cache.set(DEFAULT_LANGUAGE, zhErrors);
    return zhErrors;
  }
  const loader = loaders[lang];
  if (!loader) return getErrorCatalog(DEFAULT_LANGUAGE);
  const mod = await loader();
  cache.set(lang, mod.default);
  return mod.default;
}

export function lookupErrorMessage(code: string, lang: Language = DEFAULT_LANGUAGE): string | undefined {
  const resolved = isLanguage(lang) ? lang : DEFAULT_LANGUAGE;
  const table = getErrorCatalog(resolved);
  if (Object.prototype.hasOwnProperty.call(table, code)) {
    return table[code as keyof ErrorCodeCatalog];
  }
  const zh = getErrorCatalog(DEFAULT_LANGUAGE);
  if (Object.prototype.hasOwnProperty.call(zh, code)) {
    return zh[code as keyof ErrorCodeCatalog];
  }
  return undefined;
}

export function preloadErrorCatalog(lang: Language): void {
  if (lang === DEFAULT_LANGUAGE || cache.has(lang)) return;
  void loadErrorCatalog(lang);
}

/** 兼容旧测试：zh catalog 即原 ERROR_MESSAGES 内容 */
export const ERROR_MESSAGES_ZH = zhErrors;
