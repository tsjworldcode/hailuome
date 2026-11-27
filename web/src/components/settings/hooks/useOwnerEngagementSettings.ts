/** M34-2：站主在线 / 关注流自动同步 Settings view model */
import { signal } from '@preact/signals';
import { getOwnerJwt, getWorkerAUrl } from '../../../lib/auth';
import { createWorkerAClient, type OnlineStatusSnapshot } from '../../../lib/workerA';
import { ApiError, getErrorMessage } from '../../../lib/errors';
import { showToast } from '../../../lib/toast';
import { t } from '../../../lib/i18n';

export const onlineStatus = signal<OnlineStatusSnapshot | null>(null);
export const onlineStatusLoading = signal(false);
export const feedAggregateRunning = signal(false);

export async function refreshOnlineStatus(): Promise<void> {
  const baseUrl = getWorkerAUrl();
  if (!baseUrl) {
    onlineStatus.value = null;
    return;
  }
  onlineStatusLoading.value = true;
  try {
    const client = createWorkerAClient({ baseUrl, getJwt: () => getOwnerJwt() });
    onlineStatus.value = await client.getOnlineStatus();
  } catch (err) {
    onlineStatus.value = null;
    showToast(
      err instanceof ApiError ? err.displayMessage : getErrorMessage({}, t('settingsFeedSyncLoadFailed')),
      'error',
    );
  } finally {
    onlineStatusLoading.value = false;
  }
}

export async function handleRunFeedAggregateNow(): Promise<void> {
  const baseUrl = getWorkerAUrl();
  if (!baseUrl) {
    showToast(t('settingsDailySyncEndpointMissing'), 'error');
    return;
  }
  feedAggregateRunning.value = true;
  try {
    const client = createWorkerAClient({ baseUrl, getJwt: () => getOwnerJwt() });
    const result = await client.runFeedAggregateNow();
    showToast(
      t('settingsFeedSyncTriggered', undefined, {
        fetched: String(result.fetched),
        failed: String(result.failed),
      }),
      'info',
    );
    await refreshOnlineStatus();
  } catch (err) {
    showToast(
      err instanceof ApiError ? err.displayMessage : getErrorMessage({}, t('settingsFeedSyncRunFailed')),
      'error',
    );
  } finally {
    feedAggregateRunning.value = false;
  }
}
