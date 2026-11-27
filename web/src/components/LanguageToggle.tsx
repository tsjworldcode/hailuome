/** @jsxImportSource preact */
import type { VNode } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import {
  initLanguage,
  language,
  LANGUAGE_CODES,
  LANGUAGE_STORAGE_KEY,
  normalizeLanguage,
  setLanguage,
  SUPPORTED_LOCALES,
  t,
  type Language,
} from '../lib/i18n';
import { SettingsSectionHeader } from './settings/SettingsSectionHeader';

function useLanguageSync(): void {
  useEffect(() => {
    initLanguage();

    function onStorage(e: StorageEvent): void {
      if (e.key !== LANGUAGE_STORAGE_KEY) return;
      void setLanguage(normalizeLanguage(e.newValue));
    }
    function onPageLoad(): void {
      initLanguage();
    }
    window.addEventListener('storage', onStorage);
    document.addEventListener('astro:page-load', onPageLoad);
    return () => {
      window.removeEventListener('storage', onStorage);
      document.removeEventListener('astro:page-load', onPageLoad);
    };
  }, []);
}

function LanguageButtons({ compact = false }: { readonly compact?: boolean }): VNode {
  // UX-I18N-SYNC：水合完成前不画「选中」态，避免 SSG 默认 zh 高亮与 localStorage=en 打架
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    initLanguage();
    setHydrated(true);
  }, []);

  return (
    <div
      role="radiogroup"
      aria-label={compact ? t('languageCompactLabel') : t('languageGroup')}
      class={
        compact
          ? 'inline-flex overflow-hidden rounded-full border border-slate-200 bg-slate-100 shadow-sm backdrop-blur transition-colors dark:border-zinc-700 dark:bg-zinc-950'
          : 'mt-3 inline-flex flex-wrap gap-1 rounded-full border border-slate-200 bg-slate-100 p-1 shadow-inner transition-colors dark:border-zinc-700 dark:bg-zinc-950'
      }
    >
      {LANGUAGE_CODES.map((code: Language) => {
        const meta = SUPPORTED_LOCALES[code];
        const active = hydrated && language.value === code;
        return (
          <button
            key={code}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => void setLanguage(code)}
            class={
              compact
                ? 'px-3 py-1.5 text-xs font-semibold transition ' +
                  (active
                    ? 'bg-sky-600 text-white dark:bg-sky-500 dark:text-white'
                    : 'text-slate-600 hover:bg-white hover:text-slate-950 dark:text-zinc-300 dark:hover:bg-zinc-800 dark:hover:text-zinc-50')
                : 'inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-medium transition ' +
                  (active
                    ? 'bg-sky-600 text-white shadow-sm hover:bg-sky-700 dark:bg-sky-500 dark:text-white dark:hover:bg-sky-400'
                    : 'text-slate-700 hover:bg-white hover:text-slate-950 dark:text-zinc-300 dark:hover:bg-zinc-800 dark:hover:text-zinc-50')
            }
          >
            {compact ? meta.shortName : meta.nativeName}
          </button>
        );
      })}
    </div>
  );
}

export function CompactLanguageToggle(): VNode {
  useLanguageSync();
  return <LanguageButtons compact />;
}

export function LanguageToggle(): VNode {
  useLanguageSync();

  return (
    <section
      class="rounded-lg border border-slate-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900"
      aria-labelledby="language-toggle-heading"
    >
      <SettingsSectionHeader sectionKey="language" title={t('languageTitle')} />
      <p class="mt-1 text-xs leading-5 text-slate-600 dark:text-zinc-400">
        {t('languageDescription')}
      </p>
      <LanguageButtons />
    </section>
  );
}
