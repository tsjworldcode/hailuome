/**
 * M-VAULT-5/6：业务钥 wrap/unwrap 共用材料。
 * 写路径必须用 vault；解包顺序 vault → passwordHash → session KEK（至 M-VAULT-7）。
 */
import { getDmKekMaterial } from './dmSession';
import { getVaultMasterKeyHex } from './vaultSession';

/** 业务 wrap 必须用会话中的 vault 明文 hex */
export function requireVaultWrapMaterial(): string {
  const hex = getVaultMasterKeyHex();
  if (!hex) throw new Error('保险箱未打开，请重新登录后再试');
  return hex;
}

/** 解包材料顺序：vault → 显式 passwordHash → session KEK */
export function businessUnwrapMaterials(passwordHash?: string | null): string[] {
  const out: string[] = [];
  const vault = getVaultMasterKeyHex();
  if (vault) out.push(vault);
  if (passwordHash && !out.includes(passwordHash)) out.push(passwordHash);
  const kek = getDmKekMaterial();
  if (kek && !out.includes(kek)) out.push(kek);
  return out;
}
