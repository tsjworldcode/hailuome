/** @jsxImportSource preact */
/** M-REFACTOR-1d：隐藏帖恢复 section */
import type { VNode } from 'preact';
import { t } from '../../lib/i18n';
import { SETTINGS_SECTION_CLASS } from '../../lib/settingsSectionStyles';
import { SettingsSectionHeader } from './SettingsSectionHeader';
import {
  handleRestoreHiddenPosts,
  restoringHiddenPosts,
} from './hooks/useRegistryDiagnosticsSettings';

export function SettingsHiddenPostsSection(): VNode {
  return (
      <section class={SETTINGS_SECTION_CLASS}>
        <SettingsSectionHeader
          sectionKey="hiddenPosts"
          title={t('settingsHiddenPostsTitle')}
          trailing={
            <button
              type="button"
              disabled={restoringHiddenPosts.value}
              onClick={() => { void handleRestoreHiddenPosts(); }}
              class="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              {restoringHiddenPosts.value ? t('settingsHiddenPostsRestoring') : t('settingsHiddenPostsRestore')}
            </button>
          }
        />
        <p class="mt-1 text-xs leading-5 text-slate-600 dark:text-zinc-400">
          {t('settingsHiddenPostsDescription')}
        </p>
      </section>
  );

}
