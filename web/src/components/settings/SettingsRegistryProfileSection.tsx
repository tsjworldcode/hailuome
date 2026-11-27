/** @jsxImportSource preact */
/** M-REFACTOR-1d：登记资料 section；M7-41b：未认证可改，认证完成后只读。 */
import type { VNode } from 'preact';
import { t } from '../../lib/i18n';
import {
  SETTINGS_SECTION_CLASS,
  SETTINGS_INPUT_CLASS,
  SETTINGS_PRIMARY_BTN_CLASS,
} from '../../lib/settingsSectionStyles';
import { SettingsSectionHeader } from './SettingsSectionHeader';
import { formatLogTime } from './settingsUtils';
import { loggedInHandle } from './hooks/useSettingsSession';
import { profileWorkerBUrl } from './hooks/usePublicProfileSettings';
import {
  regProfileDisplayHandle,
  regProfileNodeUrl,
  regProfileEmailInput,
  regProfileEmailLocked,
  regProfileTermsVersion,
  regProfileTermsAcceptedAt,
  regProfileUpdatedAt,
  regProfileLoading,
  regProfileSaving,
  regProfileLoadError,
  regProfileNeedsRegister,
  regProfileCertInboundHost,
  regProfileCertInboundExample,
  regProfileCertInboundPurpose,
  regCertPurgeStatus,
  handleSaveRegistrationProfile,
} from './hooks/useRegistrySettings';
import { CertPurgeReminderBanner } from '../CertPurgeReminderBanner';

const REG_EMAIL_READONLY_CLASS =
  'w-full cursor-not-allowed rounded-xl border border-zinc-300 bg-zinc-50 px-3 py-2.5 text-[15px] text-zinc-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-400';

export function SettingsRegistryProfileSection(): VNode | null {
  if (!loggedInHandle.value) return null;
  return (
        <section class={SETTINGS_SECTION_CLASS}>
          <SettingsSectionHeader sectionKey="registryProfile" title={t('settingsRegistryTitle')} />
          <p class="mt-1 text-xs leading-5 text-slate-600 dark:text-zinc-400">
            {t('settingsRegistryDescription')}
          </p>

          {regProfileLoading.value ? (
            <p class="mt-4 text-sm text-slate-500 dark:text-zinc-400">{t('settingsRegistryLoading')}</p>
          ) : regProfileNeedsRegister.value ? (
            <div
              class="mt-4 rounded-md border border-sky-200 bg-sky-50 px-3 py-3 text-sm text-sky-950 dark:border-sky-700/50 dark:bg-sky-950/30 dark:text-sky-100"
              role="status"
            >
              <p>{t('settingsRegistryNotRegisteredHint')}</p>
              <a
                href="/register"
                class="mt-2 inline-block font-medium text-sky-700 underline-offset-2 hover:underline dark:text-sky-300"
              >
                {t('settingsRegistryRegisterLink')}
              </a>
            </div>
          ) : (
            <>
            {regProfileLoadError.value && (
              <p
                class="mt-4 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-100"
                role="alert"
              >
                {regProfileLoadError.value}
              </p>
            )}
            {regCertPurgeStatus.value && (
              <CertPurgeReminderBanner status={regCertPurgeStatus.value} />
            )}
            {(regProfileCertInboundHost.value || regProfileCertInboundExample.value) && (
              <div class="mt-4 rounded-xl border border-sky-200 bg-sky-50/80 p-4 dark:border-sky-500/30 dark:bg-sky-500/10">
                <h3 class="text-sm font-semibold text-sky-900 dark:text-sky-100">{t('settingsCertInboundTitle')}</h3>
                <p class="mt-1 text-xs text-sky-800 dark:text-sky-200">{t('settingsCertInboundHint')}</p>
                <dl class="mt-3 space-y-2 text-sm">
                  {regProfileCertInboundHost.value && (
                    <div>
                      <dt class="text-xs font-medium text-sky-800 dark:text-sky-300">{t('settingsCertInboundHost')}</dt>
                      <dd class="mono text-[13px] text-sky-950 dark:text-sky-50">{regProfileCertInboundHost.value}</dd>
                    </div>
                  )}
                  {regProfileCertInboundExample.value && (
                    <div>
                      <dt class="text-xs font-medium text-sky-800 dark:text-sky-300">{t('settingsCertInboundExample')}</dt>
                      <dd class="mono text-[13px] text-sky-950 dark:text-sky-50">{regProfileCertInboundExample.value}</dd>
                    </div>
                  )}
                  {regProfileCertInboundPurpose.value && (
                    <div>
                      <dt class="text-xs font-medium text-sky-800 dark:text-sky-300">{t('settingsCertInboundPurpose')}</dt>
                      <dd class="text-[13px] text-sky-950 dark:text-sky-50">{regProfileCertInboundPurpose.value}</dd>
                    </div>
                  )}
                </dl>
              </div>
            )}
            <form class="mt-4 space-y-4" onSubmit={handleSaveRegistrationProfile}>
              <div>
                <label class="mb-1 block text-sm font-medium text-slate-700 dark:text-zinc-300">{t('settingsRegistryHandleReadonly')}</label>
                <input
                  type="text"
                  value={regProfileDisplayHandle.value || '—'}
                  readOnly
                  class="w-full cursor-not-allowed rounded-xl border border-zinc-300 bg-zinc-50 px-3 py-2.5 text-[15px] text-zinc-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-400"
                />
              </div>
              <div>
                <label class="mb-1 block text-sm font-medium text-slate-700 dark:text-zinc-300">{t('settingsRegistryNodeUrlReadonly')}</label>
                <input
                  type="text"
                  value={regProfileNodeUrl.value || profileWorkerBUrl.value || '—'}
                  readOnly
                  class="w-full cursor-not-allowed rounded-xl border border-zinc-300 bg-zinc-50 px-3 py-2.5 text-[15px] text-zinc-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-400"
                />
              </div>
              <div>
                <label class="mb-1 block text-sm font-medium text-slate-700 dark:text-zinc-300" for="reg-profile-email">
                  {regProfileEmailLocked.value
                    ? t('settingsRegistryEmailReadonly')
                    : t('settingsRegistryEmail')}
                </label>
                <input
                  id="reg-profile-email"
                  type="email"
                  value={regProfileEmailInput.value || (regProfileEmailLocked.value ? '—' : '')}
                  readOnly={regProfileEmailLocked.value}
                  onInput={
                    regProfileEmailLocked.value
                      ? undefined
                      : (e) => {
                          regProfileEmailInput.value = (e.currentTarget as HTMLInputElement).value;
                        }
                  }
                  class={regProfileEmailLocked.value ? REG_EMAIL_READONLY_CLASS : SETTINGS_INPUT_CLASS}
                />
                {regProfileEmailLocked.value ? (
                  <p class="mt-1 text-xs text-slate-500 dark:text-zinc-500">
                    {t('settingsRegistryEmailLockedHint')}
                  </p>
                ) : null}
              </div>
              <div class="grid gap-3 sm:grid-cols-2">
                <div>
                  <span class="mb-1 block text-sm font-medium text-slate-700 dark:text-zinc-300">{t('settingsRegistryTermsVersion')}</span>
                  <input
                    type="text"
                    value={regProfileTermsVersion.value || '—'}
                    readOnly
                    class="w-full cursor-not-allowed rounded-xl border border-zinc-300 bg-zinc-50 px-3 py-2.5 text-[15px] text-zinc-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-400"
                  />
                </div>
                <div>
                  <span class="mb-1 block text-sm font-medium text-slate-700 dark:text-zinc-300">{t('settingsRegistryTermsAcceptedAt')}</span>
                  <input
                    type="text"
                    value={formatLogTime(regProfileTermsAcceptedAt.value)}
                    readOnly
                    class="w-full cursor-not-allowed rounded-xl border border-zinc-300 bg-zinc-50 px-3 py-2.5 text-[15px] text-zinc-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-400"
                  />
                </div>
              </div>
              {regProfileUpdatedAt.value && (
                <p class="text-xs text-slate-500 dark:text-zinc-500">
                  {t('settingsRegistryUpdatedAt', undefined, { time: formatLogTime(regProfileUpdatedAt.value) })}
                </p>
              )}
              {!regProfileEmailLocked.value ? (
                <button
                  type="submit"
                  disabled={regProfileSaving.value}
                  class={SETTINGS_PRIMARY_BTN_CLASS}
                >
                  {regProfileSaving.value ? t('settingsSaving') : t('settingsRegistrySave')}
                </button>
              ) : null}
            </form>
            </>
          )}
        </section>
  );

}
