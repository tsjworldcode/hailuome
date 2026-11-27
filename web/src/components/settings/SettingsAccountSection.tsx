/** @jsxImportSource preact */
/** M-REFACTOR-1d：账户 / 改密 section */
import type { VNode } from 'preact';
import { t } from '../../lib/i18n';
import {
  SETTINGS_SECTION_CLASS,
  SETTINGS_INPUT_CLASS,
  SETTINGS_PASSWORD_INPUT_CLASS,
  SETTINGS_PRIMARY_BTN_CLASS,
} from '../../lib/settingsSectionStyles';
import { SettingsSectionHeader } from './SettingsSectionHeader';
import { PasswordField } from '../PasswordField';
import {
  loggedInHandle,
  legacyMode,
  mustChangeCredentials,
  showChangePassword,
} from './hooks/useSettingsSession';
import {
  oldPwdInput,
  newPwdInput,
  newPwdConfirmInput,
  newUsernameInput,
  oldPwdVisible,
  newPwdVisible,
  newPwdConfirmVisible,
  changePwdPending,
  vaultOuterRetryPending,
  vaultOuterRetryBusy,
  vaultOuterUnopenable,
  vaultOuterRebuildBusy,
  handleChangePassword,
  handleRetryVaultOuterRewrap,
  handleRebuildVaultOuter,
  currentLoginUsername,
} from './hooks/useAccountSettings';
import { vaultUnlockFailed } from '../../lib/vaultSession';

/** UX-SHOW-PWD：设置页密码框的眼睛样式（皮肤；结构与行为由 PasswordField 提供） */
const SETTINGS_PASSWORD_TOGGLE_CLASS =
  'absolute right-2 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 dark:text-zinc-400 dark:hover:bg-zinc-800';

export function SettingsAccountSection(): VNode | null {
  if (!loggedInHandle.value) return null;
  return (
    <>
        <section class={SETTINGS_SECTION_CLASS}>
          <SettingsSectionHeader
            sectionKey="account"
            title={mustChangeCredentials.value ? t('settingsAccountFirstTitle') : t('settingsAccountTitle')}
            trailing={
              !mustChangeCredentials.value ? (
                <button
                  type="button"
                  onClick={() => { showChangePassword.value = !showChangePassword.value; }}
                  class="text-xs text-sky-600 hover:underline dark:text-sky-400"
                >
                  {showChangePassword.value ? t('settingsAccountCollapse') : t('settingsAccountExpand')}
                </button>
              ) : undefined
            }
          />
          {mustChangeCredentials.value && (
            <p class="mt-2 rounded-md border border-rose-300 bg-rose-50 px-3 py-2 text-xs text-rose-900 dark:border-rose-700 dark:bg-rose-950 dark:text-rose-100">
              {t('settingsDefaultAccountWarning')}
            </p>
          )}
          {legacyMode.value && (
            <p class="mt-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100">
              {t('settingsLegacyWarning')}
            </p>
          )}
          {/* VAULT-REPAIR-AUTO：保险箱已自动重建；只有自动修复失败才在这里给一次重试 */}
          {(vaultOuterRetryPending.value || vaultUnlockFailed.value) && (() => {
            const needsRebuild = vaultOuterUnopenable.value || vaultUnlockFailed.value;
            const message = vaultOuterRetryPending.value
              ? needsRebuild
                ? t('settingsVaultRepairAutoFailed')
                : t('settingsVaultOuterRewrapFailed')
              : t('settingsVaultUnlockFailed');
            const busy = needsRebuild ? vaultOuterRebuildBusy.value : vaultOuterRetryBusy.value;
            const onClick = needsRebuild ? handleRebuildVaultOuter : handleRetryVaultOuterRewrap;
            return (
              <div class="mt-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-950 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100">
                <p>{message}</p>
                <div class="mt-2 flex flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => { void onClick(); }}
                    class={SETTINGS_PRIMARY_BTN_CLASS}
                  >
                    {busy ? t('settingsSaving') : t('settingsVaultRepairRetry')}
                  </button>
                </div>
              </div>
            );
          })()}
          {(showChangePassword.value || mustChangeCredentials.value) && (
            <form class="mt-3 space-y-2" onSubmit={handleChangePassword}>
              <label class="block text-sm font-medium text-slate-700 dark:text-zinc-300" for="owner-new-username-input">
                {mustChangeCredentials.value ? t('settingsNewUsername') : t('settingsLoginUsernameLabel')}
              </label>
              <input
                id="owner-new-username-input"
                type="text"
                autoComplete="username"
                spellcheck={false}
                placeholder={
                  mustChangeCredentials.value
                    ? t('settingsNewUsernamePlaceholder')
                    : t('settingsLoginUsernameHint', undefined, {
                        username: currentLoginUsername() || 'admin',
                      })
                }
                value={newUsernameInput.value}
                onInput={(e) => { newUsernameInput.value = (e.currentTarget as HTMLInputElement).value; }}
                class={SETTINGS_INPUT_CLASS}
              />
              {!mustChangeCredentials.value && (
                <p class="mt-1 text-xs text-slate-500 dark:text-zinc-500">
                  {t('settingsLoginUsernameHint', undefined, {
                    username: currentLoginUsername() || 'admin',
                  })}
                </p>
              )}
              <label class="block text-sm font-medium text-slate-700 dark:text-zinc-300" for="owner-old-pwd-input">{t('settingsOldPassword')}</label>
              <PasswordField
                id="owner-old-pwd-input"
                autoComplete="current-password"
                placeholder={mustChangeCredentials.value ? t('settingsOldPasswordDefaultPlaceholder') : t('settingsOldPasswordPlaceholder')}
                value={oldPwdInput.value}
                visible={oldPwdVisible.value}
                inputClass={SETTINGS_PASSWORD_INPUT_CLASS}
                toggleClass={SETTINGS_PASSWORD_TOGGLE_CLASS}
                onInput={(v) => { oldPwdInput.value = v; }}
                onToggle={() => { oldPwdVisible.value = !oldPwdVisible.value; }}
              />
              <label class="block text-sm font-medium text-slate-700 dark:text-zinc-300" for="owner-new-pwd-input">{t('settingsNewPassword')}</label>
              <PasswordField
                id="owner-new-pwd-input"
                autoComplete="new-password"
                placeholder={t('settingsNewPasswordPlaceholder')}
                value={newPwdInput.value}
                visible={newPwdVisible.value}
                inputClass={SETTINGS_PASSWORD_INPUT_CLASS}
                toggleClass={SETTINGS_PASSWORD_TOGGLE_CLASS}
                onInput={(v) => { newPwdInput.value = v; }}
                onToggle={() => { newPwdVisible.value = !newPwdVisible.value; }}
              />
              <p class="mt-1 text-xs text-slate-500 dark:text-zinc-500">{t('settingsNewPasswordHint')}</p>
              <label class="block text-sm font-medium text-slate-700 dark:text-zinc-300" for="owner-new-pwd-confirm-input">{t('settingsConfirmPassword')}</label>
              <PasswordField
                id="owner-new-pwd-confirm-input"
                autoComplete="new-password"
                value={newPwdConfirmInput.value}
                visible={newPwdConfirmVisible.value}
                inputClass={SETTINGS_PASSWORD_INPUT_CLASS}
                toggleClass={SETTINGS_PASSWORD_TOGGLE_CLASS}
                onInput={(v) => { newPwdConfirmInput.value = v; }}
                onToggle={() => { newPwdConfirmVisible.value = !newPwdConfirmVisible.value; }}
              />
              <button
                type="submit"
                disabled={changePwdPending.value || vaultOuterRetryPending.value}
                class={SETTINGS_PRIMARY_BTN_CLASS}
              >
                {changePwdPending.value ? t('settingsSaving') : mustChangeCredentials.value ? t('settingsSaveFirstAccount') : t('settingsSavePassword')}
              </button>
            </form>
          )}
        </section>
    </>
  );
}
