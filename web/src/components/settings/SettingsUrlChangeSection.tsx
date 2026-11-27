/** @jsxImportSource preact */
/** M-REFACTOR-1d：Settings 节点换域分段；仅展示公开 Worker B / node_url，禁止回落写层地址 */
import type { VNode } from 'preact';
import { getWorkerAUrl } from '../../lib/auth';
import { t } from '../../lib/i18n';
import { SETTINGS_SECTION_CLASS } from '../../lib/settingsSectionStyles';
import { SettingsDeferredSection } from '../SettingsDeferredSection';
import { SettingsSectionHeader } from './SettingsSectionHeader';
import { loggedInHandle } from './hooks/useSettingsSession';
import { profileWorkerBUrl, refreshProfileForm } from './hooks/usePublicProfileSettings';
import {
  regProfileNodeUrl,
  urlMoveStatusRefresh,
  refreshRegistrationProfileForm,
} from './hooks/useRegistrySettings';

export function SettingsUrlChangeSection(): VNode | null {
  if (!loggedInHandle.value) return null;
  return (
        <section class={SETTINGS_SECTION_CLASS}>
          <SettingsSectionHeader sectionKey="urlChange" title={t('settingsUrlChangeTitle')} />
          <p class="mt-1 text-xs leading-5 text-slate-600 dark:text-zinc-400">
            {t('settingsUrlChangeDescription')}
          </p>
          <SettingsDeferredSection
            strategy="visible"
            loader={() => import('../UrlChangeWizard').then((m) => ({ default: m.UrlChangeWizard }))}
            componentProps={{
              // 仅公开地址；勿用写层 endpoint 回落，避免误标为「当前公开地址」
              currentNodeUrl: regProfileNodeUrl.value || profileWorkerBUrl.value || '',
              onUrlChanged: async () => {
                const baseUrl = getWorkerAUrl();
                if (baseUrl) {
                  await Promise.all([
                    refreshRegistrationProfileForm(baseUrl),
                    refreshProfileForm(baseUrl),
                  ]);
                }
                urlMoveStatusRefresh.value += 1;
              },
            }}
            skeletonLabel={t('settingsDeferredLoadingUrlChange')}
          />
          <SettingsDeferredSection
            strategy="visible"
            loader={() =>
              import('../UrlMoveStatusPanel').then((m) => ({ default: m.UrlMoveStatusPanel }))
            }
            componentProps={{
              refreshToken: urlMoveStatusRefresh.value,
            }}
            skeletonLabel={t('settingsDeferredLoadingUrlMoveStatus')}
          />
        </section>
  );

}
