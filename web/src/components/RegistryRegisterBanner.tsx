/** @jsxImportSource preact */
import type { VNode } from 'preact';
import { useEffect } from 'preact/hooks';
import { loadOwnerProfile, ownerProfile } from '../lib/ownerProfile';
import { initLanguage, t } from '../lib/i18n';

export function RegistryRegisterBanner(): VNode {
  useEffect(() => {
    initLanguage();
    void loadOwnerProfile();
  }, []);

  const profile = ownerProfile.value;
  if (!profile || profile.registered) return null as unknown as VNode;

  return (
    <aside
      class="border-b border-sky-200 bg-gradient-to-r from-sky-50 to-indigo-50 px-4 py-3 dark:border-sky-500/30 dark:from-sky-950/40 dark:to-indigo-950/30"
      role="note"
    >
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div class="min-w-0 text-sm leading-relaxed text-sky-900 dark:text-sky-100">
          <p class="font-semibold" data-i18n="registryBannerTitle">{t('registryBannerTitle')}</p>
          <p class="mt-0.5 text-xs text-sky-800/90 dark:text-sky-200/80">
            {/* handle-copy-allow: 仅在未登记时渲染，此时只有部署短名，没有正式名 */}
            {t('registryBannerBody', undefined, { handle: profile.handle })}
          </p>
        </div>
        <a
          href="/register"
          class="shrink-0 rounded-full bg-sky-600 px-4 py-2 text-sm font-bold text-white transition hover:bg-sky-700 dark:bg-sky-500 dark:hover:bg-sky-400"
          data-i18n="registryBannerAction"
        >
          {t('registryBannerAction')}
        </a>
      </div>
    </aside>
  );
}
