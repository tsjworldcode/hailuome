/** M-REFACTOR-1d：公开资料 view model */
import { signal } from '@preact/signals';
import { getOwnerJwt, getWorkerAUrl } from '../../../lib/auth';
import { createWorkerAClient, type OwnerProfile } from '../../../lib/workerA';
import { ApiError, getErrorMessage } from '../../../lib/errors';
import { prepareAvatarForUpload } from '../../../lib/avatarImage';
import { buildWorkerBImageUrl } from '../../../lib/mediaUrls';
import { t } from '../../../lib/i18n';
import { setStatus } from './useSettingsSession';

export const profileDisplayNameInput = signal<string>('');
export const profileBioInput = signal<string>('');
export const profileContactEmailInput = signal<string>('');
export const profileAvatarKeyInput = signal<string>('');
export const profileWorkerBUrl = signal<string>('');
export const profileSaving = signal<boolean>(false);
export const profileAvatarUploading = signal<boolean>(false);

export function hydrateProfileForm(profile: OwnerProfile): void {
  profileDisplayNameInput.value = profile.display_name ?? '';
  profileBioInput.value = profile.bio ?? '';
  profileContactEmailInput.value = profile.contact_email ?? '';
  profileAvatarKeyInput.value = profile.avatar_key ?? '';
  profileWorkerBUrl.value = profile.worker_b_url ?? '';
}

export async function refreshProfileForm(baseUrl: string): Promise<void> {
  const client = createWorkerAClient({ baseUrl, getJwt: () => getOwnerJwt() });
  const profile = await client.getMe();
  hydrateProfileForm(profile);
}

export function profileAvatarUrl(): string {
  if (!profileWorkerBUrl.value || !profileAvatarKeyInput.value) return '';
  return buildWorkerBImageUrl(profileWorkerBUrl.value, profileAvatarKeyInput.value);
}

export async function handleAvatarFileChange(e: Event): Promise<void> {
  const input = e.currentTarget as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  const baseUrl = getWorkerAUrl();
  if (!baseUrl) {
    setStatus('error', t('settingsSaveEndpointFirst'));
    return;
  }
  if (!file.type.startsWith('image/')) {
    setStatus('error', t('settingsAvatarNotImage'));
    return;
  }
  if (file.size > 5 * 1024 * 1024) {
    setStatus('error', t('settingsAvatarTooLarge'));
    return;
  }
  profileAvatarUploading.value = true;
  try {
    // M-AVATAR-SCALE-1：上传前先在浏览器本地等比缩到最长边 600 并转 WebP，
    // 避免手机原图（3–8 MB）直接吃掉 IMAGE_KV 单值额度（KV Free 写仅 1,000 次/天）。
    const prepared = await prepareAvatarForUpload(file);
    const client = createWorkerAClient({ baseUrl, getJwt: () => getOwnerJwt() });
    const uploaded = await client.uploadImage({
      body: prepared.blob,
      contentType: prepared.contentType,
      contentLength: prepared.blob.size,
    });
    profileAvatarKeyInput.value = uploaded.key;
    // 缩放生效时额外告知站主「已自动缩小」，避免对画质变化产生困惑。
    setStatus(
      'success',
      prepared.resized
        ? t('settingsAvatarUploadedResized', undefined, {
            from: `${prepared.originalWidth}×${prepared.originalHeight}`,
            to: `${prepared.scaledWidth}×${prepared.scaledHeight}`,
          })
        : t('settingsAvatarUploaded'),
    );
  } catch (err) {
    setStatus('error', err instanceof ApiError ? err.displayMessage : getErrorMessage({}, t('settingsAvatarUploadFailed')));
  } finally {
    profileAvatarUploading.value = false;
    input.value = '';
  }
}

export async function handleSavePublicProfile(e: Event): Promise<void> {
  e.preventDefault();
  const baseUrl = getWorkerAUrl();
  if (!baseUrl) {
    setStatus('error', t('settingsSaveEndpointFirst'));
    return;
  }
  const displayName = profileDisplayNameInput.value.trim();
  const bio = profileBioInput.value.trim();
  const contactEmail = profileContactEmailInput.value.trim();
  const avatarKey = profileAvatarKeyInput.value.trim();
  if (displayName.length > 80) {
    setStatus('error', t('settingsDisplayNameTooLong'));
    return;
  }
  if ([...bio].length > 280) {
    setStatus('error', t('settingsBioTooLong'));
    return;
  }
  if (contactEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail)) {
    setStatus('error', t('settingsContactEmailInvalid'));
    return;
  }
  profileSaving.value = true;
  try {
    const client = createWorkerAClient({ baseUrl, getJwt: () => getOwnerJwt() });
    const updated = await client.updateProfile({
      display_name: displayName,
      bio,
      contact_email: contactEmail,
      avatar_key: avatarKey,
    });
    hydrateProfileForm(updated);
    setStatus('success', t('settingsPublicProfileSaved'));
  } catch (err) {
    setStatus('error', err instanceof ApiError ? err.displayMessage : getErrorMessage({}, t('settingsPublicProfileSaveFailed')));
  } finally {
    profileSaving.value = false;
  }
}
