/** @jsxImportSource preact */
/** M-REFACTOR-1d：公开资料 section */
import type { VNode } from 'preact';
import { t } from '../../lib/i18n';
import {
  SETTINGS_SECTION_CLASS,
  SETTINGS_INPUT_CLASS,
  SETTINGS_PRIMARY_BTN_CLASS,
} from '../../lib/settingsSectionStyles';
import { SettingsSectionHeader } from './SettingsSectionHeader';
import { loggedInHandle } from './hooks/useSettingsSession';
import {
  profileDisplayNameInput,
  profileBioInput,
  profileContactEmailInput,
  profileAvatarKeyInput,
  profileSaving,
  profileAvatarUploading,
  profileAvatarUrl,
  handleAvatarFileChange,
  handleSavePublicProfile,
} from './hooks/usePublicProfileSettings';

export function SettingsPublicProfileSection(): VNode | null {
  if (!loggedInHandle.value) return null;
  const avatarPreview = profileAvatarUrl();
  return (
        <section class={SETTINGS_SECTION_CLASS}>
          <div class="flex items-start justify-between gap-4">
            <div>
              <SettingsSectionHeader sectionKey="publicProfile" title={t('settingsPublicProfileTitle')} />
              <p class="mt-1 text-xs leading-5 text-slate-600 dark:text-zinc-400">{t('settingsPublicProfileDescription')}</p>
            </div>
            <a href="/profile" class="shrink-0 text-xs text-sky-600 hover:underline dark:text-sky-400">
              {t('settingsPublicProfileView')}
            </a>
          </div>

          <form class="mt-4 space-y-4" onSubmit={handleSavePublicProfile}>
            <div class="flex items-center gap-4">
              {avatarPreview ? (
                <img
                  src={avatarPreview}
                  alt={t('settingsAvatarAlt')}
                  class="h-16 w-16 rounded-full border border-zinc-300 object-cover dark:border-zinc-700"
                />
              ) : (
                <div class="flex h-16 w-16 items-center justify-center rounded-full bg-sky-600 text-xl font-bold text-white">
                  {loggedInHandle.value.slice(0, 1).toUpperCase()}
                </div>
              )}
              <div class="min-w-0 flex-1">
                <label class="inline-flex cursor-pointer rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 transition hover:bg-slate-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800">
                  <span>{profileAvatarUploading.value ? t('settingsAvatarUploading') : t('settingsAvatarChoose')}</span>
                  <input
                    type="file"
                    accept="image/*"
                    class="sr-only"
                    disabled={profileAvatarUploading.value}
                    onChange={(e) => void handleAvatarFileChange(e)}
                  />
                </label>
                {profileAvatarKeyInput.value && (
                  <button
                    type="button"
                    class="ml-2 rounded-md px-2 py-1 text-xs text-slate-500 hover:bg-slate-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
                    onClick={() => { profileAvatarKeyInput.value = ''; }}
                  >
                    {t('settingsAvatarClear')}
                  </button>
                )}
                <p class="mt-1 text-xs text-slate-500 dark:text-zinc-500">{t('settingsAvatarHint')}</p>
              </div>
            </div>

            <div>
              <label class="mb-1 block text-sm font-medium text-slate-700 dark:text-zinc-300" for="public-display-name-input">
                {t('settingsDisplayName')}
              </label>
              <input
                id="public-display-name-input"
                type="text"
                maxlength={80}
                value={profileDisplayNameInput.value}
                onInput={(e) => { profileDisplayNameInput.value = (e.currentTarget as HTMLInputElement).value; }}
                class="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50"
              />
            </div>

            <div>
              <label class="mb-1 block text-sm font-medium text-slate-700 dark:text-zinc-300" for="public-bio-input">
                {t('settingsBio')}
              </label>
              <textarea
                id="public-bio-input"
                rows={3}
                maxlength={280}
                value={profileBioInput.value}
                onInput={(e) => { profileBioInput.value = (e.currentTarget as HTMLTextAreaElement).value; }}
                class={SETTINGS_INPUT_CLASS}
                placeholder={t('settingsBioPlaceholder')}
              />
              <p class="mt-1 text-right text-xs text-slate-400">{[...profileBioInput.value].length}/280</p>
            </div>

            <div>
              <label class="mb-1 block text-sm font-medium text-slate-700 dark:text-zinc-300" for="public-email-input">
                {t('settingsContactEmail')}
              </label>
              <input
                id="public-email-input"
                type="email"
                inputMode="email"
                value={profileContactEmailInput.value}
                onInput={(e) => { profileContactEmailInput.value = (e.currentTarget as HTMLInputElement).value; }}
                class={SETTINGS_INPUT_CLASS}
                placeholder="name@example.com"
              />
              <p class="mt-1 text-xs text-slate-500 dark:text-zinc-500">{t('settingsContactEmailHint')}</p>
            </div>

            <button
              type="submit"
              disabled={profileSaving.value || profileAvatarUploading.value}
              class={SETTINGS_PRIMARY_BTN_CLASS}
            >
              {profileSaving.value ? t('settingsSaving') : t('settingsPublicProfileSave')}
            </button>
          </form>
        </section>
  );

}
