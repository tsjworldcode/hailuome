/** M-REFACTOR-1d：读帖保护 view model */
import { signal } from '@preact/signals';
import type { FollowerTokenMode } from '@hailuo/shared-types';
import { getOwnerJwt, getWorkerAUrl } from '../../../lib/auth';
import { createWorkerAClient } from '../../../lib/workerA';
import { ApiError, getErrorMessage } from '../../../lib/errors';
import { showToast } from '../../../lib/toast';
import { t } from '../../../lib/i18n';
import { setStatus } from './useSettingsSession';

export const readProtectionMode = signal<FollowerTokenMode>('token-required');
export const readProtectionSource = signal<'d1' | 'env' | 'program'>('program');
export const readProtectionLoading = signal<boolean>(false);
export const readProtectionSaving = signal<boolean>(false);

export async function refreshReadProtectionMode(baseUrl: string): Promise<void> {
  readProtectionLoading.value = true;
  try {
    const client = createWorkerAClient({ baseUrl, getJwt: () => getOwnerJwt() });
    const setting = await client.getFollowerTokenMode();
    readProtectionMode.value = setting.mode;
    readProtectionSource.value = setting.source;
  } catch (err) {
    setStatus('error', err instanceof ApiError ? err.displayMessage : getErrorMessage({}, t('settingsReadProtectionLoadFailed')));
  } finally {
    readProtectionLoading.value = false;
  }
}

export async function handleReadProtectionChange(mode: FollowerTokenMode): Promise<void> {
  const baseUrl = getWorkerAUrl();
  if (!baseUrl || readProtectionSaving.value) return;
  readProtectionSaving.value = true;
  try {
    const client = createWorkerAClient({ baseUrl, getJwt: () => getOwnerJwt() });
    const updated = await client.setFollowerTokenMode(mode);
    readProtectionMode.value = updated.mode;
    readProtectionSource.value = updated.source;
    showToast(t('settingsReadProtectionSaved'), 'info');
  } catch (err) {
    showToast(err instanceof ApiError ? err.displayMessage : getErrorMessage({}, t('settingsReadProtectionSaveFailed')), 'error');
  } finally {
    readProtectionSaving.value = false;
  }
}
