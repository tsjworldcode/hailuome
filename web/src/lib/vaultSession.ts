/**
 * M-VAULT-3：保险箱主密钥会话材料 — 仅 sessionStorage，关标签即清。
 * 明文 hex 不落 D1 / localStorage / 日志。
 * VAULT-REPAIR：登录后若旧外层解不开（凭证被重新播种/迁移会换 salt），
 * 用本信号在设置页给出「重建保险箱」入口，不再静默失败。
 */
import { signal } from '@preact/signals';

const VAULT_MASTER_KEY_SS = 'hailuo:vault-master-key';
// Astro 是多页应用：登录岛与设置岛跨页导航会重新加载模块，信号必须落 sessionStorage 才能跨页存活
const VAULT_UNLOCK_FAILED_SS = 'hailuo:vault-unlock-failed';

function readVaultUnlockFailed(): boolean {
  if (typeof window === 'undefined') return false;
  return window.sessionStorage.getItem(VAULT_UNLOCK_FAILED_SS) === '1';
}

/** 登录时保险箱打不开（旧外层与当前凭证不匹配）；≠ 网络失败 */
export const vaultUnlockFailed = signal<boolean>(readVaultUnlockFailed());

export function setVaultUnlockFailed(failed: boolean): void {
  const next = failed === true;
  vaultUnlockFailed.value = next;
  if (typeof window === 'undefined') return;
  if (next) window.sessionStorage.setItem(VAULT_UNLOCK_FAILED_SS, '1');
  else window.sessionStorage.removeItem(VAULT_UNLOCK_FAILED_SS);
}

export function setVaultMasterKeyHex(hex: string): void {
  if (typeof window === 'undefined') return;
  const trimmed = hex.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(trimmed)) {
    throw new Error('保险箱主密钥格式无效');
  }
  window.sessionStorage.setItem(VAULT_MASTER_KEY_SS, trimmed);
}

export function getVaultMasterKeyHex(): string | null {
  if (typeof window === 'undefined') return null;
  const v = window.sessionStorage.getItem(VAULT_MASTER_KEY_SS);
  if (!v || !/^[0-9a-f]{64}$/i.test(v)) return null;
  return v.toLowerCase();
}

export function clearVaultMasterKey(): void {
  vaultUnlockFailed.value = false;
  if (typeof window === 'undefined') return;
  window.sessionStorage.removeItem(VAULT_MASTER_KEY_SS);
  window.sessionStorage.removeItem(VAULT_UNLOCK_FAILED_SS);
}
