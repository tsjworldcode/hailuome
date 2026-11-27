/**
 * M11-6：私有记录浏览器端加密（AES-GCM + 主密钥包裹）。
 * M-VAULT-6：新建包裹默认挂 vault；明文与主密钥仅在本模块与 sessionStorage。
 */
import { encodeText } from '@hailuo/shared-utils';

const NOTES_KEK_SALT = 'hailuo-dm-kek-v1';
const NOTES_MASTER_SCOPE = 'hailuo-private-notes-master-v1';

export const PRIVATE_NOTES_ENC_PREFIX = 'enc:v1:';
export const PRIVATE_NOTES_KEY_EPOCH = 1;

/** 旧：password_hash 直包；新：vault hex 包（M-VAULT-6） */
export const NOTES_WRAP_KDF_PASSWORD = 'PBKDF2-HKDF-v1' as const;
export const NOTES_WRAP_KDF_VAULT = 'VAULT-HKDF-v1' as const;
export type NotesWrapKdf = typeof NOTES_WRAP_KDF_PASSWORD | typeof NOTES_WRAP_KDF_VAULT;

export interface PrivateNotesWrappedKeyJson {
  readonly v: 1;
  readonly wrap_alg: 'AES-256-GCM';
  readonly kdf: NotesWrapKdf;
  readonly key_epoch: number;
  readonly nonce: string;
  readonly ciphertext: string;
}

function toCryptoBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(bytes.byteLength);
  out.set(bytes);
  return out;
}

async function hkdfSha256(
  ikm: Uint8Array,
  salt: Uint8Array,
  info: Uint8Array,
  length: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', toCryptoBytes(ikm), 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: toCryptoBytes(salt), info: toCryptoBytes(info) },
    key,
    length * 8,
  );
  return new Uint8Array(bits);
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

async function deriveNotesKekBytes(wrapMaterial: string): Promise<Uint8Array> {
  const ikm = new Uint8Array(
    await crypto.subtle.digest('SHA-256', toCryptoBytes(encodeText(wrapMaterial))),
  );
  return hkdfSha256(
    ikm,
    toCryptoBytes(encodeText(NOTES_KEK_SALT)),
    toCryptoBytes(encodeText(NOTES_MASTER_SCOPE)),
    32,
  );
}

export function generatePrivateNotesMasterKey(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}

export function isEncryptedPrivateNoteContent(content: string): boolean {
  return content.startsWith(PRIVATE_NOTES_ENC_PREFIX);
}

export async function encryptPrivateNotePlaintext(plaintext: string, masterKey: Uint8Array): Promise<string> {
  const aesKey = await crypto.subtle.importKey('raw', toCryptoBytes(masterKey), 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, toCryptoBytes(encodeText(plaintext))),
  );
  const packed = new Uint8Array(iv.length + cipher.length);
  packed.set(iv, 0);
  packed.set(cipher, iv.length);
  return `${PRIVATE_NOTES_ENC_PREFIX}${bytesToBase64(packed)}`;
}

export async function decryptPrivateNotePlaintext(stored: string, masterKey: Uint8Array): Promise<string> {
  if (!isEncryptedPrivateNoteContent(stored)) return stored;
  const packed = base64ToBytes(stored.slice(PRIVATE_NOTES_ENC_PREFIX.length));
  const iv = packed.slice(0, 12);
  const cipher = packed.slice(12);
  const aesKey = await crypto.subtle.importKey('raw', toCryptoBytes(masterKey), 'AES-GCM', false, ['decrypt']);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, aesKey, cipher);
  return new TextDecoder().decode(plain);
}

/** 默认挂 vault（M-VAULT-6） */
export async function wrapPrivateNotesMasterKey(
  masterKey: Uint8Array,
  wrapMaterial: string,
  keyEpoch: number,
  kdf: NotesWrapKdf = NOTES_WRAP_KDF_VAULT,
): Promise<PrivateNotesWrappedKeyJson> {
  const kek = await deriveNotesKekBytes(wrapMaterial);
  const aesKey = await crypto.subtle.importKey('raw', toCryptoBytes(kek), 'AES-GCM', false, ['encrypt']);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, toCryptoBytes(masterKey)),
  );
  return {
    v: 1,
    wrap_alg: 'AES-256-GCM',
    kdf,
    key_epoch: keyEpoch,
    nonce: bytesToBase64(nonce),
    ciphertext: bytesToBase64(cipher),
  };
}

export async function unwrapPrivateNotesMasterKey(
  wrapped: PrivateNotesWrappedKeyJson,
  wrapMaterial: string,
): Promise<Uint8Array> {
  const kek = await deriveNotesKekBytes(wrapMaterial);
  const aesKey = await crypto.subtle.importKey('raw', toCryptoBytes(kek), 'AES-GCM', false, ['decrypt']);
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: toCryptoBytes(base64ToBytes(wrapped.nonce)) },
    aesKey,
    toCryptoBytes(base64ToBytes(wrapped.ciphertext)),
  );
  return new Uint8Array(plain);
}
