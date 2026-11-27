/**
 * M10-4 / M10-5c：私信会话内敏感材料 — 全部 sessionStorage，关闭标签页即清除。
 * M-VAULT-3：登出时一并清 vault 主密钥。
 */
import { clearVaultMasterKey } from './vaultSession';

const DM_KEK_MATERIAL_KEY = 'hailuo:dm-kek-material';

/** 身份私钥 / 会话密钥 / 已解密明文（与 KEK 同生命周期） */
export const DM_VOLATILE_SS_KEYS = {
  IDENTITY: 'hailuo:dm-identity',
  SESSION_KEYS: 'hailuo:dm-session-keys',
  PLAINTEXT: 'hailuo:dm-plaintext',
} as const;

export function setDmKekMaterial(passwordHash: string): void {
  if (typeof window === 'undefined') return;
  window.sessionStorage.setItem(DM_KEK_MATERIAL_KEY, passwordHash);
}

export function getDmKekMaterial(): string | null {
  if (typeof window === 'undefined') return null;
  return window.sessionStorage.getItem(DM_KEK_MATERIAL_KEY);
}

export function clearDmKekMaterial(): void {
  if (typeof window === 'undefined') return;
  window.sessionStorage.removeItem(DM_KEK_MATERIAL_KEY);
}

/** 清除私信身份密钥、会话 AES 密钥、已解密明文缓存 */
export function clearDmVolatileStorage(): void {
  if (typeof window === 'undefined') return;
  window.sessionStorage.removeItem(DM_VOLATILE_SS_KEYS.IDENTITY);
  window.sessionStorage.removeItem(DM_VOLATILE_SS_KEYS.SESSION_KEYS);
  window.sessionStorage.removeItem(DM_VOLATILE_SS_KEYS.PLAINTEXT);
}

/** 存量节点：D1 有 dm_pubkey 但无 wrapped_identity 备份 */
const DM_LEGACY_IDENTITY_KEY = 'hailuo:dm-legacy-identity-pending';

export function setDmLegacyIdentityPending(pending: boolean): void {
  if (typeof window === 'undefined') return;
  if (pending) window.sessionStorage.setItem(DM_LEGACY_IDENTITY_KEY, '1');
  else window.sessionStorage.removeItem(DM_LEGACY_IDENTITY_KEY);
}

export function isDmLegacyIdentityPending(): boolean {
  if (typeof window === 'undefined') return false;
  return window.sessionStorage.getItem(DM_LEGACY_IDENTITY_KEY) === '1';
}

/** 登出 / 全量清本地数据：KEK 材料 + vault + 私信敏感缓存 + legacy 标记 */
export function clearDmSessionSecrets(): void {
  clearDmKekMaterial();
  clearVaultMasterKey();
  clearDmVolatileStorage();
  setDmLegacyIdentityPending(false);
}
