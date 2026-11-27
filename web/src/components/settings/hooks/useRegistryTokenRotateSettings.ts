/** R-MSG-1b：注册中心通行证自助轮换 view model */
import { signal } from '@preact/signals';
import { getOwnerJwt, getWorkerAUrl } from '../../../lib/auth';
import { createWorkerAClient } from '../../../lib/workerA';
import { ApiError, getErrorMessage } from '../../../lib/errors';
import { t } from '../../../lib/i18n';
import { setStatus } from './useSettingsSession';

export type RegistryTokenConfirmKind = 'registry-token-rotate';
export const registryTokenConfirmKind = signal<RegistryTokenConfirmKind | null>(null);
export const rotateRegistryTokenPending = signal<boolean>(false);

export function handleRotateRegistryToken(): void {
  const baseUrl = getWorkerAUrl();
  const jwt = getOwnerJwt();
  if (!baseUrl || !jwt) {
    setStatus('error', t('settingsLoginRequired'));
    return;
  }
  registryTokenConfirmKind.value = 'registry-token-rotate';
}

export async function confirmRotateRegistryToken(): Promise<void> {
  const baseUrl = getWorkerAUrl();
  const jwt = getOwnerJwt();
  if (!baseUrl || !jwt) {
    registryTokenConfirmKind.value = null;
    setStatus('error', t('settingsLoginRequired'));
    return;
  }
  rotateRegistryTokenPending.value = true;
  try {
    const client = createWorkerAClient({ baseUrl, getJwt: () => jwt });
    const data = await client.rotateRegistryToken();
    registryTokenConfirmKind.value = null;
    setStatus(
      'success',
      t('settingsRegistryTokenRotateSuccess', undefined, { display: data.node_api_token_display }),
    );
  } catch (err) {
    registryTokenConfirmKind.value = null;
    setStatus(
      'error',
      err instanceof ApiError
        ? err.displayMessage
        : getErrorMessage({}, t('settingsRegistryTokenRotateFailed')),
    );
  } finally {
    rotateRegistryTokenPending.value = false;
  }
}
