/**
 * M-VAULT-3：登录后确保保险箱主密钥在会话中可用。
 * M-VAULT-4：改密只重包保险箱外层（业务钥明文不变）。
 * Worker 永不接触明文 vault。
 */
import type { WorkerAClient } from './workerA';
import { ApiError } from './errors';
import {
  generateVaultMasterKey,
  unwrapVaultMasterKey,
  vaultMasterKeyFromHex,
  vaultMasterKeyToHex,
  wrapVaultMasterKey,
  type WrappedVaultJson,
} from './vaultCrypto';
import { getVaultMasterKeyHex, setVaultMasterKeyHex } from './vaultSession';

export type EnsureVaultResult = 'restored' | 'created' | 'session_hit' | 'deferred_until_registered';

/**
 * VAULT-REPAIR：旧外层无法用当前材料解开（凭证重新播种 / 迁移后 salt 变化、密文损坏）。
 * 这类失败重试无意义，必须由用户在设置页显式「重建保险箱」。
 */
export class VaultUnrecoverableError extends Error {
  readonly code = 'VAULT_UNRECOVERABLE';
  constructor(message: string) {
    super(message);
    this.name = 'VaultUnrecoverableError';
  }
}

/** 改密/ensure 时节点尚未登记：外层 API 返回 409，属预期推迟而非运维故障 */
export function isVaultDeferredUntilRegistered(err: unknown): boolean {
  return err instanceof ApiError && err.code === 'USER_NOT_REGISTERED';
}

/**
 * @param client 已带 JWT 的 Worker A 客户端
 * @param passwordHash 当前登录派生材料（与 setDmKekMaterial 同源）
 */
export async function ensureVault(
  client: WorkerAClient,
  passwordHash: string,
): Promise<EnsureVaultResult> {
  if (!passwordHash || typeof passwordHash !== 'string') {
    throw new Error('缺少密码材料，无法打开保险箱');
  }

  // 同标签页已有明文则跳过网络
  if (getVaultMasterKeyHex()) {
    return 'session_hit';
  }

  const remote = await client.getOwnerWrappedVault();
  if (!remote) {
    const key = generateVaultMasterKey();
    const wrapped = await wrapVaultMasterKey(key, passwordHash);
    try {
      await client.putOwnerWrappedVault({
        wrapped_vault_json: JSON.stringify(wrapped),
        key_version: 1,
      });
    } catch (err) {
      // 首次部署强制改密发生在登记前：PUT 409，保险箱改在登记后 ensureVault 再建
      if (isVaultDeferredUntilRegistered(err)) return 'deferred_until_registered';
      throw err;
    }
    setVaultMasterKeyHex(vaultMasterKeyToHex(key));
    return 'created';
  }

  let wrapped: WrappedVaultJson;
  try {
    wrapped = JSON.parse(remote.wrapped_vault_json) as WrappedVaultJson;
  } catch {
    throw new VaultUnrecoverableError('保险箱云端包裹损坏，请在设置里重建保险箱');
  }

  try {
    const key = await unwrapVaultMasterKey(wrapped, passwordHash);
    setVaultMasterKeyHex(vaultMasterKeyToHex(key));
    return 'restored';
  } catch {
    // 不回显 password / wrapped 明文；外层与当前凭证不匹配 → 需重建而非重试
    throw new VaultUnrecoverableError('无法用当前密码打开保险箱，请在设置里重建保险箱');
  }
}

/**
 * M-VAULT-4：改密后只换保险箱外层。
 * 优先用本会话 vault 明文；否则用旧 password_hash 从 D1 解出再以新 hash 重包。
 * 成功后会话 vault 明文不变；禁止日志打印 password / wrapped。
 */
export async function rewrapVaultOuter(
  client: WorkerAClient,
  oldPasswordHash: string,
  newPasswordHash: string,
): Promise<void> {
  if (!oldPasswordHash || !newPasswordHash) {
    throw new Error('缺少密码材料，无法更新保险箱外层');
  }

  let keyBytes: Uint8Array | null = null;
  const sessionHex = getVaultMasterKeyHex();
  if (sessionHex) {
    keyBytes = vaultMasterKeyFromHex(sessionHex);
  }

  const remote = await client.getOwnerWrappedVault();
  if (!keyBytes) {
    if (!remote) {
      // 尚无保险箱：用新密码直接创建（开发期 / 漏跑 ensureVault）
      keyBytes = generateVaultMasterKey();
      const wrapped = await wrapVaultMasterKey(keyBytes, newPasswordHash);
      // 未登记 → PUT 409 USER_NOT_REGISTERED，由改密 UI 识别为「推迟」而非故障重试
      await client.putOwnerWrappedVault({
        wrapped_vault_json: JSON.stringify(wrapped),
        key_version: 1,
      });
      setVaultMasterKeyHex(vaultMasterKeyToHex(keyBytes));
      return;
    }
    let parsed: WrappedVaultJson;
    try {
      parsed = JSON.parse(remote.wrapped_vault_json) as WrappedVaultJson;
    } catch {
      throw new VaultUnrecoverableError('保险箱云端包裹损坏，请在设置里重建保险箱');
    }
    try {
      keyBytes = await unwrapVaultMasterKey(parsed, oldPasswordHash);
    } catch {
      // 旧外层与当前可用的任何材料都不匹配 → 重试无意义，交给「重建保险箱」
      throw new VaultUnrecoverableError('无法用旧密码解开保险箱外层，请在设置里重建保险箱');
    }
  }

  const nextWrapped = await wrapVaultMasterKey(keyBytes, newPasswordHash);
  // 内存校验：新密码能解开新外层
  const verified = await unwrapVaultMasterKey(nextWrapped, newPasswordHash);
  if (verified.byteLength !== keyBytes.byteLength || !verified.every((b, i) => b === keyBytes![i])) {
    throw new Error('保险箱外层重包校验失败');
  }

  const nextVersion =
    remote && typeof remote.key_version === 'number' && remote.key_version >= 1
      ? remote.key_version
      : 1;
  await client.putOwnerWrappedVault({
    wrapped_vault_json: JSON.stringify(nextWrapped),
    key_version: nextVersion,
  });
  setVaultMasterKeyHex(vaultMasterKeyToHex(keyBytes));
}

/**
 * VAULT-REPAIR：丢弃无法解开的旧外层，用当前密码材料重新生成 + 包裹主密钥。
 * 破坏性操作（旧外层保护过的业务钥不可恢复），只能由用户显式确认后调用。
 */
export async function rebuildVaultOuter(
  client: WorkerAClient,
  passwordHash: string,
): Promise<void> {
  if (!passwordHash || typeof passwordHash !== 'string') {
    throw new Error('缺少密码材料，无法重建保险箱');
  }
  const key = generateVaultMasterKey();
  const wrapped = await wrapVaultMasterKey(key, passwordHash);
  // 写前自检：新外层必须能用当前材料解开
  const verified = await unwrapVaultMasterKey(wrapped, passwordHash);
  if (verified.byteLength !== key.byteLength || !verified.every((b, i) => b === key[i])) {
    throw new Error('保险箱重建校验失败');
  }
  await client.putOwnerWrappedVault({
    wrapped_vault_json: JSON.stringify(wrapped),
    key_version: 1,
  });
  setVaultMasterKeyHex(vaultMasterKeyToHex(key));
}
