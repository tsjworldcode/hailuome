/** M34-4：Settings 最近登录设备 */
import { signal } from '@preact/signals';
import { getOwnerJwt, getWorkerAUrl } from '../../../lib/auth';
import { createWorkerAClient, type OwnerSessionListItem } from '../../../lib/workerA';
import { ApiError, getErrorMessage } from '../../../lib/errors';
import { showToast } from '../../../lib/toast';
import { logoutOwnerAndReload } from '../../../lib/ownerSession';
import { t } from '../../../lib/i18n';

export const ownerSessions = signal<OwnerSessionListItem[]>([]);
export const ownerSessionsLoading = signal(false);
export const ownerSessionRevokingId = signal<string | null>(null);

export async function refreshOwnerSessions(): Promise<void> {
  const baseUrl = getWorkerAUrl();
  if (!baseUrl) {
    ownerSessions.value = [];
    return;
  }
  ownerSessionsLoading.value = true;
  try {
    const client = createWorkerAClient({ baseUrl, getJwt: () => getOwnerJwt() });
    const data = await client.listOwnerSessions({ limit: 20 });
    ownerSessions.value = [...data.items];
  } catch (err) {
    ownerSessions.value = [];
    showToast(
      err instanceof ApiError
        ? err.displayMessage
        : getErrorMessage({}, t('settingsOwnerSessionsLoadFailed')),
      'error',
    );
  } finally {
    ownerSessionsLoading.value = false;
  }
}

export async function handleRevokeOwnerSession(sessionId: string): Promise<void> {
  const baseUrl = getWorkerAUrl();
  if (!baseUrl) {
    showToast(t('settingsDailySyncEndpointMissing'), 'error');
    return;
  }
  ownerSessionRevokingId.value = sessionId;
  try {
    const client = createWorkerAClient({ baseUrl, getJwt: () => getOwnerJwt() });
    const result = await client.revokeOwnerSession(sessionId);
    showToast(
      result.is_current
        ? t('settingsOwnerSessionsRevokedCurrent')
        : t('settingsOwnerSessionsRevoked'),
      'info',
    );
    if (result.is_current) {
      void logoutOwnerAndReload();
      return;
    }
    await refreshOwnerSessions();
  } catch (err) {
    showToast(
      err instanceof ApiError
        ? err.displayMessage
        : getErrorMessage({}, t('settingsOwnerSessionsRevokeFailed')),
      'error',
    );
  } finally {
    ownerSessionRevokingId.value = null;
  }
}
