/** @jsxImportSource preact */
/** M-REFACTOR-1d：读帖保护 section；FORCE 再开时 source=program 只读展示（现行 FORCE-2 可改档） */
import type { VNode } from 'preact';
import { t } from '../../lib/i18n';
import {
  SETTINGS_SECTION_CLASS,
  SETTINGS_OPTION_ROW_CLASS,
} from '../../lib/settingsSectionStyles';
import { SettingsSectionHeader } from './SettingsSectionHeader';
import { loggedInHandle } from './hooks/useSettingsSession';
import {
  readProtectionMode,
  readProtectionSource,
  readProtectionLoading,
  readProtectionSaving,
  handleReadProtectionChange,
} from './hooks/useReadProtectionSettings';

export function SettingsReadProtectionSection(): VNode {
  const programLocked = readProtectionSource.value === 'program';
  const fieldsetDisabled =
    readProtectionLoading.value ||
    readProtectionSaving.value ||
    !loggedInHandle.value ||
    programLocked;

  return (
      <section class={SETTINGS_SECTION_CLASS}>
        <SettingsSectionHeader sectionKey="readProtection" title={t('settingsReadProtectionTitle')} />
        <p class="mt-1 text-xs leading-5 text-slate-600 dark:text-zinc-400">
          {t('settingsReadProtectionDescription')}
        </p>
        {programLocked && (
          <p class="mt-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
            {t('settingsReadProtectionSourceProgram')}
          </p>
        )}
        {readProtectionSource.value === 'env' && (
          <p class="mt-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
            {t('settingsReadProtectionSourceEnv')}
          </p>
        )}
        <fieldset
          class="mt-4 space-y-2"
          disabled={fieldsetDisabled}
        >
          <label class={SETTINGS_OPTION_ROW_CLASS + ' text-sm'}>
            <input
              type="radio"
              name="read-protection-mode"
              checked={readProtectionMode.value === 'public-read'}
              onChange={() => { void handleReadProtectionChange('public-read'); }}
              class="mt-0.5"
            />
            <span class="text-slate-700 dark:text-zinc-200">{t('settingsReadProtectionPublic')}</span>
          </label>
          <label class={SETTINGS_OPTION_ROW_CLASS + ' text-sm'}>
            <input
              type="radio"
              name="read-protection-mode"
              checked={readProtectionMode.value === 'token-required'}
              onChange={() => { void handleReadProtectionChange('token-required'); }}
              class="mt-0.5"
            />
            <span class="text-slate-700 dark:text-zinc-200">{t('settingsReadProtectionTokenRequired')}</span>
          </label>
          <label class={SETTINGS_OPTION_ROW_CLASS + ' text-sm'}>
            <input
              type="radio"
              name="read-protection-mode"
              checked={readProtectionMode.value === 'following-only'}
              onChange={() => { void handleReadProtectionChange('following-only'); }}
              class="mt-0.5"
            />
            <span class="text-slate-700 dark:text-zinc-200">{t('settingsReadProtectionFollowing')}</span>
          </label>
          <label class={SETTINGS_OPTION_ROW_CLASS + ' text-sm'}>
            <input
              type="radio"
              name="read-protection-mode"
              checked={readProtectionMode.value === 'mutual-only'}
              onChange={() => { void handleReadProtectionChange('mutual-only'); }}
              class="mt-0.5"
            />
            <span class="text-slate-700 dark:text-zinc-200">{t('settingsReadProtectionMutual')}</span>
          </label>
          <label class={SETTINGS_OPTION_ROW_CLASS + ' text-sm'}>
            <input
              type="radio"
              name="read-protection-mode"
              checked={readProtectionMode.value === 'owner-only'}
              onChange={() => { void handleReadProtectionChange('owner-only'); }}
              class="mt-0.5"
            />
            <span class="text-slate-700 dark:text-zinc-200">{t('settingsReadProtectionOwner')}</span>
          </label>
        </fieldset>
        <p class="mt-3 text-xs leading-5 text-slate-500 dark:text-zinc-400">
          {t('settingsReadProtectionDelayNote')}
        </p>
        {/* protected 档下 <img> 发不出 Authorization：提醒站主确认媒体票据密钥 */}
        {readProtectionMode.value !== 'public-read' && readProtectionMode.value !== 'owner-only' && (
          <p class="mt-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
            {t('settingsReadProtectionMediaTicketHint')}
          </p>
        )}
        {(readProtectionLoading.value || readProtectionSaving.value) && (
          <p class="mt-2 text-xs text-slate-500 dark:text-zinc-400">{t('settingsReadProtectionSaving')}</p>
        )}
      </section>
  );

}
