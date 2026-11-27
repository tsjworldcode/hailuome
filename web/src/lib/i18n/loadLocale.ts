/**
 * M-i18n-L3：按语言懒加载 catalogs；zh 常驻主包，其它语言 dynamic import。
 */
import { signal } from '@preact/signals';
import zhCatalog from './catalogs/zh';
import { DEFAULT_LANGUAGE, type Language } from './locales';

export type MessageCatalog = typeof zhCatalog;

const cache = new Map<Language, MessageCatalog>();
cache.set(DEFAULT_LANGUAGE, zhCatalog);

/** 非 zh catalog 加载完成后递增，供 translate 订阅以触发重渲染 */
export const catalogGeneration = signal(0);

type CatalogModule = { default: MessageCatalog };

const loaders: Partial<Record<Language, () => Promise<CatalogModule>>> = {
  en: () => import('./catalogs/en/index.ts') as unknown as Promise<CatalogModule>,
};

export function isLocaleLoaded(lang: Language): boolean {
  return cache.has(lang);
}

export function getCachedCatalog(lang: Language): MessageCatalog | undefined {
  return cache.get(lang);
}

export function getCatalog(lang: Language): MessageCatalog {
  return cache.get(lang) ?? cache.get(DEFAULT_LANGUAGE)!;
}

export async function loadLocale(lang: Language): Promise<MessageCatalog> {
  const normalized = lang;
  const hit = cache.get(normalized);
  if (hit) return hit;
  if (normalized === DEFAULT_LANGUAGE) {
    cache.set(DEFAULT_LANGUAGE, zhCatalog);
    return zhCatalog;
  }
  const loader = loaders[normalized];
  if (!loader) {
    return getCatalog(DEFAULT_LANGUAGE);
  }
  const mod = await loader();
  cache.set(normalized, mod.default);
  catalogGeneration.value += 1;
  return mod.default;
}

/** 预加载除 zh 外的已注册语言（可选，Settings 页 mount 时调用） */
export function preloadLocale(lang: Language): void {
  if (lang === DEFAULT_LANGUAGE || cache.has(lang)) return;
  void loadLocale(lang);
}
