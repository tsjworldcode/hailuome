/** M-REFACTOR-1c：设置页 session view model */
import { signal } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import {
  getOwnerJwt,
  getWorkerAUrl,
  setWorkerAUrl,
  clearWorkerAUrl,
  readFollowerTokenRememberPref,
  writeFollowerTokenRememberPref,
} from '../../../lib/auth';
import { ownerBaseUrl, useOwnerCredentials } from '../../../lib/useOwnerCredentials';
import { tryRestoreOwnerSession, logoutOwnerAndReload } from '../../../lib/ownerSession';
import { loadPublicRegistryEndpoints } from '../../../lib/registryEndpoints';
import { t } from '../../../lib/i18n';
import { validateWorkerAUrl } from '../settingsUtils';
import { refreshMediaStorageSetting } from './useMediaStorageSettings';
import { registryEndpointsLoading } from './useRegistryDiagnosticsSettings';

export const workerAUrlInput = signal<string>('');
export const statusType = signal<'idle' | 'success' | 'error'>('idle');
export const statusMsg = signal<string>('');
export const loggedInHandle = signal<string | null>(null);
export const initialized = signal<boolean>(false);
/** 首屏 / 切页：正在恢复站主 session（勿把账号区渲染成空白） */
export const sessionHydrating = signal<boolean>(true);
export const legacyMode = signal<boolean>(false);
export const mustChangeCredentials = signal<boolean>(false);
export const showChangePassword = signal<boolean>(false);
export const rememberFollowerToken = signal<boolean>(false);

export type SessionRefreshExtras = {
  refreshProfileForm: (baseUrl: string) => Promise<void>;
  refreshRegistrationProfileForm: (baseUrl: string) => Promise<void>;
  refreshReadProtectionMode: (baseUrl: string) => Promise<void>;
};

/**
 * 优先用凭证钩子已异步解析的 ownerBaseUrl（含 deploy-env.json），
 * 再回落同步 getWorkerAUrl。禁止只读 sync——否则 onReady 时 URL 仍空、跳过 refresh。
 */
function getDisplayedWorkerAUrl(): string {
  const fromCreds = ownerBaseUrl.value?.trim();
  if (fromCreds) return fromCreds;
  return getWorkerAUrl() ?? '';
}

export function setStatus(type: 'idle' | 'success' | 'error', msg: string): void {
  statusType.value = type;
  statusMsg.value = msg;
}

export async function refreshSession(baseUrl: string, extras: SessionRefreshExtras): Promise<void> {
  const restored = await tryRestoreOwnerSession();
  if (restored) {
    loggedInHandle.value = restored.handle;
    mustChangeCredentials.value = restored.mustChangeCredentials;
    legacyMode.value = restored.legacyMode;
    if (restored.mustChangeCredentials) {
      showChangePassword.value = true;
    }
    await extras.refreshProfileForm(baseUrl);
    await extras.refreshRegistrationProfileForm(baseUrl);
    await extras.refreshReadProtectionMode(baseUrl);
    await refreshMediaStorageSetting(baseUrl);
    registryEndpointsLoading.value = true;
    void loadPublicRegistryEndpoints().finally(() => {
      registryEndpointsLoading.value = false;
    });
    return;
  }
  loggedInHandle.value = null;
  void logoutOwnerAndReload();
}

export async function handleSaveUrl(e: Event): Promise<void> {
  e.preventDefault();
  const result = validateWorkerAUrl(workerAUrlInput.value);
  if (!result.ok) {
    setStatus('error', result.reason);
    return;
  }
  setWorkerAUrl(result.normalized);
  workerAUrlInput.value = result.normalized;
  setStatus('success', t('settingsUrlSaved'));
  await refreshSession(result.normalized, sessionRefreshExtras!);
}

export function handleClearUrl(): void {
  clearWorkerAUrl();
  workerAUrlInput.value = '';
  setStatus('success', t('settingsUrlCleared'));
}

export function handleRememberFollowerToken(checked: boolean): void {
  rememberFollowerToken.value = checked;
  writeFollowerTokenRememberPref(checked ? 'on' : 'off');
  setStatus(
    'success',
    checked ? t('settingsRememberTokenOn') : t('settingsRememberTokenOff'),
  );
}

let sessionRefreshExtras: SessionRefreshExtras | null = null;

export function bindSessionRefreshExtras(extras: SessionRefreshExtras): void {
  sessionRefreshExtras = extras;
}

export function useSettingsSessionEffects(extras: SessionRefreshExtras): void {
  bindSessionRefreshExtras(extras);
  useOwnerCredentials(() => {
    const currentUrl = getDisplayedWorkerAUrl();
    workerAUrlInput.value = currentUrl;
    // 偏好只需读一次；session 每次凭证就绪都要 refresh（VT remount / deploy-env 晚到）
    if (!initialized.value) {
      rememberFollowerToken.value = readFollowerTokenRememberPref() === 'on';
      initialized.value = true;
    }
    if (!currentUrl) {
      sessionHydrating.value = false;
      return;
    }
    sessionHydrating.value = true;
    void refreshSession(currentUrl, extras).finally(() => {
      sessionHydrating.value = false;
    });
  });

  useEffect(() => {
    const onNavigate = (): void => {
      const currentUrl = getDisplayedWorkerAUrl();
      if (currentUrl && getOwnerJwt()) {
        sessionHydrating.value = true;
        void refreshSession(currentUrl, extras).finally(() => {
          sessionHydrating.value = false;
        });
      }
    };
    document.addEventListener('astro:page-load', onNavigate);
    document.addEventListener('astro:after-swap', onNavigate);
    return () => {
      document.removeEventListener('astro:page-load', onNavigate);
      document.removeEventListener('astro:after-swap', onNavigate);
    };
  }, []);
}
