/**
 * M9-7-S1：节点搬家包外层 AES-256-GCM（口令派生）。
 * 加解密在浏览器 / Node 契约测中执行；Worker 边缘不跑 PBKDF2（Free Tier CPU）。
 * 内层明文仍为 hailuo-node-export-v1 JSON。
 */
import { encodeText } from '@hailuo/shared-utils';
import { derivePasswordHash, PBKDF2_ITERATIONS } from './password';

export const NODE_EXPORT_ENCRYPTED_FORMAT = 'hailuo-node-export-v2-enc' as const;
export const NODE_EXPORT_ENC_HKDF_SALT = 'hailuo-node-export-v2-enc' as const;
export const NODE_EXPORT_ENC_HKDF_INFO = 'outer' as const;
/** 搬家口令最短长度（含私钥载荷，对齐私信备份强度） */
export const NODE_EXPORT_PASSPHRASE_MIN_LEN = 12;

export interface NodeExportEncryptedWrap {
  readonly v: 1;
  readonly salt_hex: string;
  readonly iterations: number;
  readonly nonce_b64: string;
  readonly ciphertext_b64: string;
}

export interface NodeExportEncryptedFile {
  readonly format: typeof NODE_EXPORT_ENCRYPTED_FORMAT;
  readonly wrap: NodeExportEncryptedWrap;
}

export class NodeExportCryptoError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'NodeExportCryptoError';
    this.code = code;
  }
}

function toCryptoBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(bytes.byteLength);
  out.set(bytes);
  return out;
}

function randomSaltHex(byteLen = 16): string {
  const salt = crypto.getRandomValues(new Uint8Array(byteLen));
  return [...salt].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
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

/** 搬家口令 → AES-256 密钥（独立于登录密码哈希用途）。 */
export async function deriveNodeExportOuterKey(
  passphrase: string,
  saltHex: string,
  iterations: number,
): Promise<Uint8Array> {
  const kdf = await derivePasswordHash(passphrase, saltHex, iterations);
  const ikm = new Uint8Array(
    await crypto.subtle.digest('SHA-256', toCryptoBytes(encodeText(kdf))),
  );
  return hkdfSha256(
    ikm,
    toCryptoBytes(encodeText(NODE_EXPORT_ENC_HKDF_SALT)),
    toCryptoBytes(encodeText(NODE_EXPORT_ENC_HKDF_INFO)),
    32,
  );
}

export function assertNodeExportPassphrase(passphrase: string): void {
  if (typeof passphrase !== 'string' || passphrase.length < NODE_EXPORT_PASSPHRASE_MIN_LEN) {
    throw new NodeExportCryptoError(
      'NODE_EXPORT_PASSPHRASE_WEAK',
      `搬家口令至少 ${NODE_EXPORT_PASSPHRASE_MIN_LEN} 个字符`,
    );
  }
  if (!/[A-Za-z]/.test(passphrase) || !/[0-9]/.test(passphrase) || !/[^A-Za-z0-9]/.test(passphrase)) {
    throw new NodeExportCryptoError(
      'NODE_EXPORT_PASSPHRASE_WEAK',
      '搬家口令需同时包含字母、数字与符号',
    );
  }
}

export function isNodeExportEncryptedFile(raw: unknown): raw is NodeExportEncryptedFile {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  return (raw as Record<string, unknown>).format === NODE_EXPORT_ENCRYPTED_FORMAT;
}

export function parseNodeExportEncryptedFile(raw: unknown): NodeExportEncryptedFile {
  if (!isNodeExportEncryptedFile(raw)) {
    throw new NodeExportCryptoError('NODE_EXPORT_ENC_INVALID', '不是 hailuo-node-export-v2-enc 加密包');
  }
  const wrap = (raw as NodeExportEncryptedFile).wrap;
  if (
    !wrap ||
    typeof wrap !== 'object' ||
    wrap.v !== 1 ||
    typeof wrap.salt_hex !== 'string' ||
    typeof wrap.iterations !== 'number' ||
    typeof wrap.nonce_b64 !== 'string' ||
    typeof wrap.ciphertext_b64 !== 'string'
  ) {
    throw new NodeExportCryptoError('NODE_EXPORT_ENC_INVALID', '加密包 wrap 字段不完整');
  }
  return {
    format: NODE_EXPORT_ENCRYPTED_FORMAT,
    wrap: {
      v: 1,
      salt_hex: wrap.salt_hex,
      iterations: wrap.iterations,
      nonce_b64: wrap.nonce_b64,
      ciphertext_b64: wrap.ciphertext_b64,
    },
  };
}

/** 将 v1 JSON 字符串加密为 v2-enc 文件对象。 */
export async function encryptNodeExportJson(
  plaintextJson: string,
  passphrase: string,
  iterations: number = PBKDF2_ITERATIONS,
): Promise<NodeExportEncryptedFile> {
  assertNodeExportPassphrase(passphrase);
  if (typeof plaintextJson !== 'string' || plaintextJson.length === 0) {
    throw new NodeExportCryptoError('NODE_EXPORT_ENC_INVALID', '明文搬家包为空');
  }
  const saltHex = randomSaltHex();
  const outerKey = await deriveNodeExportOuterKey(passphrase, saltHex, iterations);
  const aesKey = await crypto.subtle.importKey(
    'raw',
    toCryptoBytes(outerKey),
    'AES-GCM',
    false,
    ['encrypt'],
  );
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce },
      aesKey,
      toCryptoBytes(encodeText(plaintextJson)),
    ),
  );
  return {
    format: NODE_EXPORT_ENCRYPTED_FORMAT,
    wrap: {
      v: 1,
      salt_hex: saltHex,
      iterations,
      nonce_b64: bytesToBase64(nonce),
      ciphertext_b64: bytesToBase64(cipher),
    },
  };
}

/** 解密 v2-enc → 内层 JSON 字符串（通常为 hailuo-node-export-v1）。 */
export async function decryptNodeExportJson(
  encrypted: NodeExportEncryptedFile,
  passphrase: string,
): Promise<string> {
  assertNodeExportPassphrase(passphrase);
  const file = parseNodeExportEncryptedFile(encrypted);
  try {
    const outerKey = await deriveNodeExportOuterKey(
      passphrase,
      file.wrap.salt_hex,
      file.wrap.iterations,
    );
    const aesKey = await crypto.subtle.importKey(
      'raw',
      toCryptoBytes(outerKey),
      'AES-GCM',
      false,
      ['decrypt'],
    );
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: toCryptoBytes(base64ToBytes(file.wrap.nonce_b64)) },
      aesKey,
      toCryptoBytes(base64ToBytes(file.wrap.ciphertext_b64)),
    );
    return new TextDecoder().decode(plain);
  } catch (err) {
    if (err instanceof NodeExportCryptoError) throw err;
    throw new NodeExportCryptoError('NODE_EXPORT_DEC_FAILED', '解密失败：口令错误或文件损坏');
  }
}
