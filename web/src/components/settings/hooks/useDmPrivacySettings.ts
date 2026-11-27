/** M-REFACTOR-1d：私信身份轮换 view model */
import { signal } from '@preact/signals';
import { getOwnerJwt, getWorkerAUrl } from '../../../lib/auth';
import { createWorkerAClient } from '../../../lib/workerA';
import { ApiError, getErrorMessage } from '../../../lib/errors';
import { rotateDmIdentity } from '../../../lib/dmService';
import { getDmKekMaterial } from '../../../lib/dmSession';
import { getVaultMasterKeyHex } from '../../../lib/vaultSession';
import { t } from '../../../lib/i18n';
import { setStatus } from './useSettingsSession';

export type SettingsConfirmKind = 'dm-rotate';
export const settingsConfirmKind = signal<SettingsConfirmKind | null>(null);
export const rotateDmIdentityPending = signal<boolean>(false);

function hasDmWrapSession(): boolean {
  // M-VAULT-5：轮换身份挂 vault；旧 KEK 仅作会话存活提示
  return Boolean(getVaultMasterKeyHex() || getDmKekMaterial());
}

export async function handleRotateDmIdentity(): Promise<void> {
  const baseUrl = getWorkerAUrl();
  const jwt = getOwnerJwt();
  if (!baseUrl || !jwt || !hasDmWrapSession()) {
    setStatus('error', t('settingsLoginRequired'));
    return;
  }
  settingsConfirmKind.value = 'dm-rotate';
}

export async function confirmRotateDmIdentity(): Promise<void> {
  const baseUrl = getWorkerAUrl();
  const jwt = getOwnerJwt();
  if (!baseUrl || !jwt || !hasDmWrapSession()) {
    settingsConfirmKind.value = null;
    setStatus('error', t('settingsLoginRequired'));
    return;
  }
  rotateDmIdentityPending.value = true;
  try {
    const client = createWorkerAClient({ baseUrl, getJwt: () => jwt });
    await rotateDmIdentity(client);
    settingsConfirmKind.value = null;
    setStatus('success', t('settingsDmRotateSuccess'));
  } catch (err) {
    settingsConfirmKind.value = null;
    setStatus('error', err instanceof ApiError ? err.displayMessage : getErrorMessage({}, t('settingsDmRotateFailed')));
  } finally {
    rotateDmIdentityPending.value = false;
  }
}
