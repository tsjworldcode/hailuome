/** M-REFACTOR-1d：账户 / 改密 view model；M-VAULT-4：改密只重包保险箱外层 */
import { signal } from '@preact/signals';
import { getOwnerJwt, getOwnerLoginUsername, getWorkerAUrl } from '../../../lib/auth';
import { createWorkerAClient } from '../../../lib/workerA';
import {
  buildChangePasswordHashes,
  buildNewPasswordHashForMigration,
} from '../../../lib/ownerPassword';
import { ApiError, getErrorMessage } from '../../../lib/errors';
import {
  isVaultDeferredUntilRegistered,
  rebuildVaultOuter,
  rewrapVaultOuter,
  VaultUnrecoverableError,
} from '../../../lib/ensureVault';
import { setDmKekMaterial, getDmKekMaterial } from '../../../lib/dmSession';
import { setVaultUnlockFailed } from '../../../lib/vaultSession';
import { loginOwner } from '../../../lib/ownerSession';
import { t } from '../../../lib/i18n';
import { checkPasswordStrengthClient } from '../settingsUtils';
import {
  legacyMode,
  mustChangeCredentials,
  showChangePassword,
  setStatus,
} from './useSettingsSession';

export const oldPwdInput = signal<string>('');
export const newPwdInput = signal<string>('');
export const newPwdConfirmInput = signal<string>('');
export const newUsernameInput = signal<string>('');
/** UX-SHOW-PWD：三个密码框各自的眼睛开关（默认全部隐藏） */
export const oldPwdVisible = signal<boolean>(false);
export const newPwdVisible = signal<boolean>(false);
export const newPwdConfirmVisible = signal<boolean>(false);
export const changePwdPending = signal<boolean>(false);
/** 服务器改密已成功，但保险箱外层 PUT 失败 → 展示「重试外层」 */
export const vaultOuterRetryPending = signal<boolean>(false);
/** VAULT-REPAIR：旧外层解不开（重试无意义）→ 展示「重建保险箱」 */
export const vaultOuterUnopenable = signal<boolean>(false);
export const vaultOuterRetryBusy = signal<boolean>(false);
export const vaultOuterRebuildBusy = signal<boolean>(false);

/** 改密成功后暂存，供外层重试（不落盘） */
let pendingNewPasswordHash: string | undefined;
let pendingOldPasswordHash: string | undefined;
let pendingSuccessMsg = '';

/**
 * 改密后用来解开旧外层的材料。
 * 登录时写入的那份才是实际上锁用的，必须优先；当场按旧密码重算的 hash 只作后备。
 */
function oldUnlockMaterials(derived: string | undefined): string[] {
  const stored = getDmKekMaterial();
  const materials: string[] = [];
  if (stored) materials.push(stored);
  if (derived && derived !== stored) materials.push(derived);
  return materials;
}

/** 外层重包结果：unopenable 表示旧外层与当前材料不匹配，重试无用 */
type RewrapOutcome = 'ok' | 'missing' | 'deferred' | 'unopenable';

/** 同一页内更新外层：先用登录时的材料，失败再试重算的旧 hash。 */
async function rewrapVaultWithOldMaterials(
  derived: string | undefined,
  newPasswordHash: string,
  client: ReturnType<typeof createWorkerAClient>,
): Promise<RewrapOutcome> {
  const materials = oldUnlockMaterials(derived);
  if (materials.length === 0) return 'missing';
  let sawUnopenable = false;
  let lastTransient: unknown;
  for (const oldMaterial of materials) {
    try {
      await rewrapVaultOuter(client, oldMaterial, newPasswordHash);
      return 'ok';
    } catch (err) {
      // 未登记节点：外层 API 固定 409，换材料重试无意义
      if (isVaultDeferredUntilRegistered(err)) return 'deferred';
      // 旧外层解不开是确定性失败，换材料也救不回来 → 交给「重建保险箱」
      if (err instanceof VaultUnrecoverableError) {
        sawUnopenable = true;
        continue;
      }
      lastTransient = err;
    }
  }
  // 网络/API 抖动优先按「可重试」处理，别引导用户误重建
  if (lastTransient) throw lastTransient;
  return sawUnopenable ? 'unopenable' : 'missing';
}

/** 当前登录名（JWT `oun`）：展示 + 判重用，不是鉴权依据 */
export function currentLoginUsername(): string {
  return getOwnerLoginUsername();
}

/**
 * VAULT-REPAIR-AUTO：旧外层已确定解不开时直接静默重建。
 * 不重建的情况：网络/401/500 等瞬时错误（可能只是暂时读不到，不能误毁）。
 */
async function tryAutoRebuildVault(
  client: ReturnType<typeof createWorkerAClient>,
  material: string,
): Promise<boolean> {
  try {
    await rebuildVaultOuter(client, material);
    return true;
  } catch {
    return false;
  }
}

function finishChangePasswordSuccess(message: string): void {
  vaultOuterRetryPending.value = false;
  vaultOuterUnopenable.value = false;
  pendingNewPasswordHash = undefined;
  pendingOldPasswordHash = undefined;
  pendingSuccessMsg = '';
  oldPwdInput.value = '';
  newPwdInput.value = '';
  newPwdConfirmInput.value = '';
  newUsernameInput.value = '';
  oldPwdVisible.value = false;
  newPwdVisible.value = false;
  newPwdConfirmVisible.value = false;
  showChangePassword.value = false;
  legacyMode.value = false;
  mustChangeCredentials.value = false;
  setStatus('success', message);
}

export async function handleRetryVaultOuterRewrap(): Promise<void> {
  const baseUrl = getWorkerAUrl();
  const newHash = pendingNewPasswordHash;
  if (!baseUrl || !newHash) {
    setStatus('error', t('settingsVaultOuterRewrapMissingMaterial'));
    return;
  }
  vaultOuterRetryBusy.value = true;
  setStatus('idle', '');
  try {
    const client = createWorkerAClient({ baseUrl, getJwt: () => getOwnerJwt() });
    const result = await rewrapVaultWithOldMaterials(pendingOldPasswordHash, newHash, client).catch(
      (err) =>
        isVaultDeferredUntilRegistered(err)
          ? ('deferred' as const)
          : err instanceof VaultUnrecoverableError
            ? ('unopenable' as const)
            : ('failed' as const),
    );
    if (result === 'missing') {
      setStatus('error', t('settingsVaultOuterRewrapMissingMaterial'));
      return;
    }
    if (result === 'unopenable') {
      // 旧外层解不开：重试无效，直接静默重建；失败才留一个重试入口
      if (!(await tryAutoRebuildVault(client, newHash))) {
        vaultOuterUnopenable.value = true;
        setStatus('error', t('settingsVaultRepairAutoFailed'));
        return;
      }
      setVaultUnlockFailed(false);
    }
    if (result === 'failed') {
      setStatus('error', t('settingsVaultOuterRewrapFailed'));
      return;
    }
    setDmKekMaterial(newHash);
    // 未登记：密码已生效；保险箱等登记后登录 ensureVault 自动建，勿再逼点「重试」
    finishChangePasswordSuccess(
      result === 'deferred'
        ? t('settingsVaultOuterDeferredUntilRegister')
        : pendingSuccessMsg || t('settingsPasswordChanged'),
    );
  } catch (err) {
    if (err instanceof ApiError) {
      setStatus('error', err.displayMessage);
    } else {
      setStatus('error', t('settingsVaultOuterRewrapFailed'));
    }
  } finally {
    vaultOuterRetryBusy.value = false;
  }
}

/**
 * VAULT-REPAIR：旧外层解不开时的唯一出路 —— 用当前材料重建。
 * 破坏性：旧外层保护过的私信/群聊/记录密钥不可恢复；调用前必须由 UI 二次确认。
 */
export async function handleRebuildVaultOuter(): Promise<void> {
  const baseUrl = getWorkerAUrl();
  // 改过密：用新密码材料；仅登录告警：用本次登录的材料
  const material = pendingNewPasswordHash || getDmKekMaterial();
  if (!baseUrl || !material) {
    setStatus('error', t('settingsVaultOuterRewrapMissingMaterial'));
    return;
  }
  vaultOuterRebuildBusy.value = true;
  setStatus('idle', '');
  try {
    const client = createWorkerAClient({ baseUrl, getJwt: () => getOwnerJwt() });
    await rebuildVaultOuter(client, material);
    setDmKekMaterial(material);
    setVaultUnlockFailed(false);
    finishChangePasswordSuccess(pendingSuccessMsg || t('settingsVaultOuterRebuildDone'));
  } catch (err) {
    if (err instanceof ApiError) {
      setStatus('error', err.displayMessage);
    } else {
      setStatus('error', t('settingsVaultOuterRebuildFailed'));
    }
  } finally {
    vaultOuterRebuildBusy.value = false;
  }
}

export async function handleChangePassword(e: Event): Promise<void> {
  e.preventDefault();
  setStatus('idle', '');
  vaultOuterRetryPending.value = false;
  vaultOuterUnopenable.value = false;

  const baseUrl = getWorkerAUrl();
  if (!baseUrl) {
    setStatus('error', t('settingsEndpointSaveFirst'));
    return;
  }
  const oldPassword = oldPwdInput.value;
  const newPassword = newPwdInput.value;
  const confirmPassword = newPwdConfirmInput.value;
  const newUsername = newUsernameInput.value.trim();

  if (!oldPassword || !newPassword) {
    setStatus('error', t('settingsChangePwdFillBoth'));
    return;
  }
  if (mustChangeCredentials.value && !newUsername) {
    setStatus('error', t('settingsChangePwdNeedUsername'));
    return;
  }
  // OWNER-RENAME：普通改密也可选填登录名；留空不改，填了必须合法且不能回退到默认 admin
  if (newUsername) {
    if (newUsername === 'admin') {
      setStatus('error', t('settingsChangePwdNoAdmin'));
      return;
    }
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(newUsername)) {
      setStatus('error', t('settingsChangePwdUsernameInvalid'));
      return;
    }
  }
  if (newPassword !== confirmPassword) {
    setStatus('error', t('settingsChangePwdMismatch'));
    return;
  }
  if (oldPassword === newPassword) {
    setStatus('error', t('settingsChangePwdSameAsOld'));
    return;
  }
  const strength = checkPasswordStrengthClient(newPassword);
  if (!strength.ok) {
    setStatus('error', t('settingsChangePwdWeak', undefined, { reason: strength.reason }));
    return;
  }

  changePwdPending.value = true;
  try {
    const client = createWorkerAClient({ baseUrl, getJwt: () => getOwnerJwt() });
    const jwt = getOwnerJwt();
    let res;
    let newPasswordHashForVault: string | undefined;
    let oldPasswordHashForVault: string | undefined;
    if (legacyMode.value) {
      const newPasswordHash = await buildNewPasswordHashForMigration(newPassword);
      newPasswordHashForVault = newPasswordHash;
      res = await client.changePassword({
        oldPassword,
        newPassword,
        newPasswordHash,
        ...(newUsername ? { newUsername } : {}),
      });
    } else {
      if (!jwt) {
        setStatus('error', t('settingsSessionExpired'));
        return;
      }
      const { oldPasswordHash, newPasswordHash } = await buildChangePasswordHashes(
        baseUrl,
        jwt,
        oldPassword,
        newPassword,
      );
      oldPasswordHashForVault = oldPasswordHash;
      newPasswordHashForVault = newPasswordHash;
      res = await client.changePassword({
        oldPasswordHash,
        newPasswordHash,
        ...(newUsername ? { newUsername } : {}),
      });
    }

    let successMsg = res.username_changed_to
      ? t('settingsPasswordChangedWithUsername', undefined, { username: res.username_changed_to })
      : res.migrated_from_legacy
        ? t('settingsPasswordMigrated')
        : t('settingsPasswordChanged');

    // OWNER-RENAME：改了登录名 → 旧 JWT 的 oun 已过期，立即用新用户名 + 新密码静默重登。
    // 重登同时会触发保险箱自愈；失败也不打断后续，只提示稍后重新登录。
    if (res.username_changed_to) {
      let relogged = false;
      try {
        await loginOwner({ username: res.username_changed_to, password: newPassword });
        relogged = true;
      } catch {
        relogged = false;
      }
      if (!relogged) {
        successMsg = `${successMsg} ${t('settingsUsernameReloginNeeded', undefined, {
          username: res.username_changed_to,
        })}`;
      }
    }

    // M-VAULT-4 / VAULT-PRE-REG-KEY-3：改密只重包外层；未登记且无行则跳过
    if (newPasswordHashForVault) {
      let skipVaultRewrap = false;
      try {
        const me = await client.getMe();
        // registered=false：尚无 users.handle；无外层行则改密与保险箱无关
        if (me.registered !== true) {
          const existing = await client.getOwnerWrappedVault();
          if (!existing) skipVaultRewrap = true;
        }
      } catch {
        // me / GET 失败不阻断改密成功态；走原 rewrap，由失败分支提示
      }

      if (skipVaultRewrap) {
        setDmKekMaterial(newPasswordHashForVault);
        finishChangePasswordSuccess(
          `${successMsg} ${t('settingsVaultOuterDeferredUntilRegister')}`,
        );
        return;
      }

      const vaultRewrap = await rewrapVaultWithOldMaterials(
        oldPasswordHashForVault,
        newPasswordHashForVault,
        client,
      ).catch((err) =>
        isVaultDeferredUntilRegistered(err)
          ? ('deferred' as const)
          : err instanceof VaultUnrecoverableError
            ? ('unopenable' as const)
            : ('failed' as const),
      );
      if (vaultRewrap === 'missing') {
        vaultOuterUnopenable.value = false;
        pendingNewPasswordHash = newPasswordHashForVault;
        pendingOldPasswordHash = oldPasswordHashForVault;
        pendingSuccessMsg = successMsg;
        vaultOuterRetryPending.value = true;
        setStatus('error', t('settingsVaultOuterRewrapMissingMaterial'));
        return;
      }
      if (vaultRewrap === 'unopenable') {
        // VAULT-REPAIR-AUTO：旧外层已确定解不开（多为重部署后凭证重播种换了 salt），
        // 静默重建，不让站主理解/点击；只有重建失败（网络/API）才退回重试入口。
        if (!(await tryAutoRebuildVault(client, newPasswordHashForVault))) {
          vaultOuterUnopenable.value = true;
          pendingNewPasswordHash = newPasswordHashForVault;
          pendingOldPasswordHash = oldPasswordHashForVault;
          pendingSuccessMsg = successMsg;
          vaultOuterRetryPending.value = true;
          setStatus('error', t('settingsVaultRepairAutoFailed'));
          return;
        }
        setVaultUnlockFailed(false);
      }
      if (vaultRewrap === 'failed') {
        vaultOuterUnopenable.value = false;
        pendingNewPasswordHash = newPasswordHashForVault;
        pendingOldPasswordHash = oldPasswordHashForVault;
        pendingSuccessMsg = successMsg;
        vaultOuterRetryPending.value = true;
        setStatus('error', t('settingsVaultOuterRewrapFailed'));
        return;
      }
      setDmKekMaterial(newPasswordHashForVault);
      if (vaultRewrap === 'deferred') {
        finishChangePasswordSuccess(
          `${successMsg} ${t('settingsVaultOuterDeferredUntilRegister')}`,
        );
        return;
      }
    }

    finishChangePasswordSuccess(successMsg);
  } catch (err) {
    if (err instanceof ApiError) {
      // 旧服务端返回 AUTH_INVALID + 「旧密码错误」；新服务端返回 OLD_PASSWORD_INCORRECT。
      // 改密场景别笼统显示「账号或密码错误」，直接说清楚填的是当前登录密码。
      const saidOldPasswordWrong =
        (err.code === 'AUTH_INVALID' && (err.body?.message ?? '').includes('旧密码错误'));
      setStatus('error', saidOldPasswordWrong ? t('settingsOldPasswordIncorrect') : err.displayMessage);
    } else {
      setStatus('error', getErrorMessage({}, t('settingsChangePwdFailed')));
    }
  } finally {
    changePwdPending.value = false;
  }
}
