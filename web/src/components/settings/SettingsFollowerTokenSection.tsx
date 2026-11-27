/** @jsxImportSource preact */
/** M-REFACTOR-1dï¼?ç²?ä¸?Tokenã??è®°ä½æ??ã?section */
import type { VNode } from 'preact';
import { t } from '../../lib/i18n';
import { SETTINGS_SECTION_CLASS } from '../../lib/settingsSectionStyles';
import { SettingsSectionHeader } from './SettingsSectionHeader';
import {
  rememberFollowerToken,
  handleRememberFollowerToken,
} from './hooks/useSettingsSession';

export function SettingsFollowerTokenSection(): VNode {
  return (
      <section class={SETTINGS_SECTION_CLASS}>
        <SettingsSectionHeader sectionKey="followerToken" title={t('settingsFollowerTokenTitle')} />
        <p class="mt-1 text-xs leading-5 text-slate-600 dark:text-zinc-400">
          {t('settingsFollowerTokenDescription')}
        </p>
        <label class="mt-3 flex cursor-pointer items-start gap-2 text-sm text-slate-700 dark:text-zinc-300">
          <input
            type="checkbox"
            checked={rememberFollowerToken.value}
            onChange={(e) => {
              handleRememberFollowerToken((e.currentTarget as HTMLInputElement).checked);
            }}
            class="mt-0.5 h-4 w-4 rounded border-zinc-500 text-sky-600 focus:ring-sky-500 dark:border-zinc-700"
          />
          <span>{t('settingsFollowerTokenRemember')}</span>
        </label>
      </section>
  );

}
