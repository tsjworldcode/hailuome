/** @jsxImportSource preact */
/** M-REFACTOR-1dï¼?è??ç??API å?¥å£ section */
import type { VNode } from 'preact';
import { getWorkerAUrl } from '../../lib/auth';
import { isDeployEndpointBound } from '../../lib/deployEndpoint';
import { t } from '../../lib/i18n';
import {
  SETTINGS_SECTION_CLASS,
  SETTINGS_INPUT_CLASS,
  SETTINGS_SECONDARY_BTN_CLASS,
} from '../../lib/settingsSectionStyles';
import { SettingsSectionHeader } from './SettingsSectionHeader';
import {
  workerAUrlInput,
  handleSaveUrl,
  handleClearUrl,
} from './hooks/useSettingsSession';

export function SettingsEndpointSection(): VNode {
  return (
      <section class={SETTINGS_SECTION_CLASS}>
        <SettingsSectionHeader sectionKey="endpoint" title={t('settingsPrivateEndpointTitle')} />
        {isDeployEndpointBound() ? (
          <div class="mt-3 space-y-2">
            <p class="text-xs leading-5 text-slate-600 dark:text-zinc-400">
              {t('settingsPrivateEndpointBound')}
            </p>
            <p class="break-all rounded-md border border-zinc-300 bg-slate-50 px-3 py-2 font-mono text-xs text-slate-700 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
              {getWorkerAUrl() ?? ''}
            </p>
          </div>
        ) : (
          <>
            <p class="mt-1 text-xs leading-5 text-slate-600 dark:text-zinc-400">
              {t('settingsPrivateEndpointManualPrefix')}{' '}
              <code class="rounded bg-slate-100 px-1.5 py-0.5 dark:bg-zinc-800 dark:text-zinc-300">https://your-worker-b.workers.dev</code>
              {t('settingsPrivateEndpointManualSuffix')}
            </p>
            <form class="mt-3 space-y-2" onSubmit={(e) => { void handleSaveUrl(e); }} noValidate>
              <label class="block text-sm font-medium text-slate-700 dark:text-zinc-300" for="endpoint-url-input">
                {t('settingsPrivateEndpointLabel')}
              </label>
              <input
                id="endpoint-url-input"
                type="url"
                inputMode="url"
                placeholder="https://your-worker-b.workers.dev"
                autoComplete="off"
                spellcheck={false}
                value={workerAUrlInput.value}
                onInput={(e) => {
                  workerAUrlInput.value = (e.currentTarget as HTMLInputElement).value;
                }}
                class={SETTINGS_INPUT_CLASS}
              />
              <div class="flex flex-wrap gap-2 pt-1">
                <button
                  type="submit"
                  class="rounded-md bg-sky-600 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-sky-700"
                >
                  {t('settingsPrivateEndpointSave')}
                </button>
                <button
                  type="button"
                  onClick={handleClearUrl}
                  class={SETTINGS_SECONDARY_BTN_CLASS}
                >
                  {t('settingsPrivateEndpointClear')}
                </button>
              </div>
            </form>
          </>
        )}
      </section>
  );

}
