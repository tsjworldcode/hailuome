/** M-REFACTOR-1d：注册中心登记资料 view model
 * SPILL-1c-node-b：人口学字段已下架；M7-41b：未认证可改，认证完成后只读。
 */
import { signal } from '@preact/signals';
import { getOwnerJwt, getWorkerAUrl } from '../../../lib/auth';
import { createWorkerAClient, type RegistrationProfile, type CertPurgeStatus } from '../../../lib/workerA';
import { ApiError, getErrorMessage } from '../../../lib/errors';
import { loadOwnerProfile } from '../../../lib/ownerProfile';
import { t } from '../../../lib/i18n';
import { validateRegisterEmail } from '@hailuo/shared-utils';
import { setStatus, loggedInHandle } from './useSettingsSession';
import { profileWorkerBUrl } from './usePublicProfileSettings';

export const regProfileDisplayHandle = signal<string>('');
export const regProfileNodeUrl = signal<string>('');
export const urlMoveStatusRefresh = signal(0);
export const regProfileEmailInput = signal<string>('');
/** M7-41b：email_verified 后只读；勿用「有没有邮箱」判断（未认证应可改） */
export const regProfileEmailLocked = signal<boolean>(false);
export const regProfileTermsVersion = signal<string>('');
export const regProfileTermsAcceptedAt = signal<string>('');
export const regProfileUpdatedAt = signal<string>('');
export const regProfileLoading = signal<boolean>(false);
export const regProfileSaving = signal<boolean>(false);
export const regProfileLoadError = signal<string | null>(null);
/** 未完成注册中心登记：不拉档案、不报「读取失败」，只提示去登记 */
export const regProfileNeedsRegister = signal<boolean>(false);
export const regProfileCertInboundHost = signal<string>('');
export const regProfileCertInboundExample = signal<string>('');
export const regProfileCertInboundPurpose = signal<string>('');
export const regCertPurgeStatus = signal<CertPurgeStatus | null>(null);

/** HANDLE-SLIM：展示优先正式名，再短名，再会话兜底 */
function applyHandleFallback(profile?: RegistrationProfile | null): string {
  const qualified = profile?.handle_qualified?.trim() || '';
  if (qualified) return qualified;
  const local = profile?.handle_local?.trim() || '';
  if (local) return local;
  return loggedInHandle.value?.trim() || '';
}

export function hydrateRegistrationProfileForm(profile: RegistrationProfile): void {
  regProfileNeedsRegister.value = false;
  regProfileDisplayHandle.value = applyHandleFallback(profile);
  const email = (profile.email ?? '').trim();
  regProfileEmailInput.value = email;
  // M7-41b：仅「注册中心邮箱认证完成」后锁定；未认证即使有邮箱也可改
  regProfileEmailLocked.value = profile.email_verified === true;
  regProfileTermsVersion.value = profile.terms_version?.trim() || '';
  regProfileTermsAcceptedAt.value = profile.terms_accepted_at ?? '';
  regProfileUpdatedAt.value = profile.updated_at ?? '';
  regProfileCertInboundHost.value = profile.cert_inbound_host ?? '';
  regProfileCertInboundExample.value = profile.cert_inbound_address_example ?? '';
  regProfileCertInboundPurpose.value = profile.cert_inbound_purpose ?? '';
}

/** 未登记：软空态，禁止顶部粉条 / 黄条「读取登记资料失败」 */
function applyUnregisteredSoftState(): void {
  regProfileNeedsRegister.value = true;
  regProfileLoadError.value = null;
  regProfileDisplayHandle.value = applyHandleFallback(null);
  regProfileNodeUrl.value = profileWorkerBUrl.value || getWorkerAUrl() || '';
  regProfileEmailInput.value = '';
  regProfileEmailLocked.value = false;
  regProfileTermsVersion.value = '';
  regProfileTermsAcceptedAt.value = '';
  regProfileUpdatedAt.value = '';
  regProfileCertInboundHost.value = '';
  regProfileCertInboundExample.value = '';
  regProfileCertInboundPurpose.value = '';
  regCertPurgeStatus.value = null;
}

function isUnregisteredProfileError(err: unknown): boolean {
  if (!(err instanceof ApiError)) return false;
  if (err.code === 'USER_NOT_REGISTERED') return true;
  const text = `${err.code} ${err.displayMessage} ${err.message}`;
  return /尚未.*(登记|注册)|节点尚未注册|registered_registries/i.test(text);
}

export async function refreshRegistrationProfileForm(baseUrl: string): Promise<void> {
  regProfileLoading.value = true;
  regProfileLoadError.value = null;
  regProfileNeedsRegister.value = false;
  try {
    const client = createWorkerAClient({ baseUrl, getJwt: () => getOwnerJwt() });
    // 中文注释：未登记无 node_api_token，拉档案必失败；先看 me.registered，避免误报「读取失败」
    const me = await client.getMe();
    if (me.registered !== true) {
      applyUnregisteredSoftState();
      return;
    }
    const profile = await client.getRegistrationProfile();
    hydrateRegistrationProfileForm(profile);
    // 中文注释：中心偶发缺 handle_* 时，再用本会话站主 handle 兜底一次
    if (!regProfileDisplayHandle.value) {
      regProfileDisplayHandle.value = applyHandleFallback(null);
    }
    regProfileNodeUrl.value = profileWorkerBUrl.value || getWorkerAUrl() || '';
    try {
      regCertPurgeStatus.value = await client.getCertPurgeStatus();
    } catch (purgeErr) {
      console.error('[Settings] 清号提醒状态加载失败', purgeErr);
      regCertPurgeStatus.value = null;
    }
  } catch (err) {
    if (isUnregisteredProfileError(err)) {
      applyUnregisteredSoftState();
      return;
    }
    console.error('[Settings] 登记信息加载失败', err);
    const message =
      err instanceof ApiError ? err.displayMessage : getErrorMessage({}, t('settingsRegistryLoadFailed'));
    regProfileLoadError.value = message;
    setStatus('error', message);
    // 中文注释：加载失败也尽量展示海螺名，避免只读栏完全空白
    if (!regProfileDisplayHandle.value) {
      regProfileDisplayHandle.value = applyHandleFallback(null);
    }
    regProfileNodeUrl.value = profileWorkerBUrl.value || getWorkerAUrl() || '';
  } finally {
    regProfileLoading.value = false;
  }
}

export async function handleSaveRegistrationProfile(e: Event): Promise<void> {
  e.preventDefault();
  // M7-41：已锁定时不提交（UI 已隐藏按钮，防绕过）
  if (regProfileEmailLocked.value) {
    setStatus('error', t('settingsRegistryEmailLockedHint'));
    return;
  }
  const baseUrl = getWorkerAUrl();
  if (!baseUrl) {
    setStatus('error', t('settingsSaveEndpointFirst'));
    return;
  }

  const emailParsed = validateRegisterEmail(regProfileEmailInput.value);
  if (!emailParsed.ok) {
    setStatus('error', emailParsed.error.message);
    return;
  }

  regProfileSaving.value = true;
  try {
    const client = createWorkerAClient({ baseUrl, getJwt: () => getOwnerJwt() });
    const updated = await client.updateRegistrationProfile({
      email: emailParsed.value,
    });
    hydrateRegistrationProfileForm(updated);
    await loadOwnerProfile(true);
    setStatus('success', t('settingsRegProfileSaved'));
  } catch (err) {
    setStatus('error', err instanceof ApiError ? err.displayMessage : getErrorMessage({}, t('settingsRegProfileSaveFailed')));
  } finally {
    regProfileSaving.value = false;
  }
}
