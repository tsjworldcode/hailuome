/**
 * M-VAULT-1：独立保险箱主密钥原语。
 * 登录 password_hash 只包/解 vault；业务钥（私信/群/笔记）后续改挂 vault。
 * 明文 vault 仅在浏览器；Worker 只存 wrapped JSON，永不解密。
 */
import { bytesToHex, encodeText, hexToBytes } from '@hailuo/shared-utils';

/** 与计划 docs/m-vault-master-key-plan.md §2.1 一致 */
export const VAULT_WRAP_KDF = 'SHA256-password_hash-v1' as const;
const VAULT_WRAP_DOMAIN = 'hailuo-vault-wrap-v1:';

export interface WrappedVaultJson {
  readonly v: 1;
  readonly wrap_alg: 'AES-256-GCM';
  readonly kdf: typeof VAULT_WRAP_KDF;
  readonly nonce: string;
  readonly ciphertext: string;
}

/** Web Crypto 在 strict TS 下要求 ArrayBuffer 视图 */
function toCryptoBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(bytes.byteLength);
  out.set(bytes);
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** KEK：SHA256(domain || password_hash) → 32 字节 AES-GCM 密钥 */
async function deriveVaultWrapKek(passwordHash: string): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.digest('SHA-256', toCryptoBytes(encodeText(`${VAULT_WRAP_DOMAIN}${passwordHash}`))),
  );
}

/** 生成 32 字节随机保险箱主密钥 */
export function generateVaultMasterKey(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}

export function vaultMasterKeyToHex(key: Uint8Array): string {
  return bytesToHex(key);
}

export function vaultMasterKeyFromHex(hex: string): Uint8Array {
  return hexToBytes(hex);
}

/** 用登录 password_hash 包裹 vault 明文 */
export async function wrapVaultMasterKey(
  vaultMasterKey: Uint8Array,
  passwordHash: string,
): Promise<WrappedVaultJson> {
  if (vaultMasterKey.byteLength !== 32) {
    throw new Error('vault 主密钥长度无效');
  }
  const kek = await deriveVaultWrapKek(passwordHash);
  const aesKey = await crypto.subtle.importKey('raw', toCryptoBytes(kek), 'AES-GCM', false, ['encrypt']);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, toCryptoBytes(vaultMasterKey)),
  );
  return {
    v: 1,
    wrap_alg: 'AES-256-GCM',
    kdf: VAULT_WRAP_KDF,
    nonce: bytesToBase64(nonce),
    ciphertext: bytesToBase64(cipher),
  };
}

/** 用登录 password_hash 解开 vault 明文 */
export async function unwrapVaultMasterKey(
  wrapped: WrappedVaultJson,
  passwordHash: string,
): Promise<Uint8Array> {
  if (wrapped.v !== 1 || wrapped.wrap_alg !== 'AES-256-GCM' || wrapped.kdf !== VAULT_WRAP_KDF) {
    throw new Error('保险箱包裹格式不受支持');
  }
  const kek = await deriveVaultWrapKek(passwordHash);
  const aesKey = await crypto.subtle.importKey('raw', toCryptoBytes(kek), 'AES-GCM', false, ['decrypt']);
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: toCryptoBytes(base64ToBytes(wrapped.nonce)) },
    aesKey,
    toCryptoBytes(base64ToBytes(wrapped.ciphertext)),
  );
  const key = new Uint8Array(plain);
  if (key.byteLength !== 32) {
    throw new Error('解包后的 vault 主密钥长度无效');
  }
  return key;
}
