/**
 * M-i18n-L1：界面语言唯一注册表。
 * 加语言 = 在此登记一行 + 补 catalogs/<lang>/；禁止业务侧写死 zh/en 二元分支。
 */
export const DEFAULT_LANGUAGE = 'zh' as const;

export const SUPPORTED_LOCALES = {
  zh: {
    nativeName: '中文',
    shortName: '中',
    htmlLang: 'zh-CN',
    /** Turnstile 等第三方组件语言码 */
    turnstileLang: 'zh-CN',
    match: (tag: string): boolean => tag.toLowerCase().startsWith('zh'),
  },
  en: {
    nativeName: 'English',
    shortName: 'EN',
    htmlLang: 'en',
    turnstileLang: 'en',
    match: (tag: string): boolean => tag.toLowerCase().startsWith('en'),
  },
} as const;

export type Language = keyof typeof SUPPORTED_LOCALES;

export const LANGUAGE_CODES = Object.keys(SUPPORTED_LOCALES) as Language[];

export function isLanguage(value: unknown): value is Language {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(SUPPORTED_LOCALES, value);
}

export function normalizeLanguage(value: unknown): Language {
  return isLanguage(value) ? value : DEFAULT_LANGUAGE;
}

export function htmlLangFor(lang: Language): string {
  return SUPPORTED_LOCALES[lang].htmlLang;
}

export function turnstileLangFor(lang: Language): string {
  return SUPPORTED_LOCALES[lang].turnstileLang;
}

/** 供 LanguageScript 内联：短码 → htmlLang（与注册表保持同步） */
export function localeHtmlLangMap(): Record<Language, string> {
  const out = {} as Record<Language, string>;
  for (const code of LANGUAGE_CODES) {
    out[code] = SUPPORTED_LOCALES[code].htmlLang;
  }
  return out;
}

export function matchBrowserLanguage(tags: readonly string[]): Language {
  for (const raw of tags) {
    const tag = String(raw || '').trim();
    if (!tag) continue;
    for (const code of LANGUAGE_CODES) {
      if (SUPPORTED_LOCALES[code].match(tag)) return code;
    }
  }
  return DEFAULT_LANGUAGE;
}
