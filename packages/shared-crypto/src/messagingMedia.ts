import type { MessagingMediaSigned } from '@hailuo/shared-types';
import { MESSAGING_MEDIA_ALG } from '@hailuo/shared-types';
import { bytesToHex, encodeText, hexToBytes } from '@hailuo/shared-utils';
import { computeBodyHash } from './ed25519';

/** signed media 块键排序 JSON（纳入 envelope sig）。 */
export function canonicalizeMessagingMediaSigned(media: MessagingMediaSigned): string {
  const keys = Object.keys(media).sort() as (keyof MessagingMediaSigned)[];
  const sorted: Record<string, unknown> = {};
  for (const key of keys) {
    sorted[key] = media[key];
  }
  return JSON.stringify(sorted);
}

export async function hashMessagingMediaSigned(media: MessagingMediaSigned): Promise<string> {
  return computeBodyHash(canonicalizeMessagingMediaSigned(media));
}

export function buildMessagingMediaKeyInfo(messageId: string, mediaId: string): string {
  return `hailuo-dm-media-v1:${messageId}:${mediaId}`;
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

function toCryptoBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(bytes.byteLength);
  out.set(bytes);
  return out;
}

export async function sha256BytesHex(bytes: ArrayBuffer | Uint8Array): Promise<string> {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const digest = await crypto.subtle.digest('SHA-256', toCryptoBytes(view));
  return bytesToHex(new Uint8Array(digest));
}

/** 从会话 message_key 派生 media 子密钥（AAD 绑定 message_id + media_id）。 */
export async function deriveMessagingMediaKey(
  messageKey: Uint8Array,
  messageId: string,
  mediaId: string,
): Promise<Uint8Array> {
  const info = encodeText(buildMessagingMediaKeyInfo(messageId, mediaId));
  const salt = new Uint8Array(32);
  return hkdfSha256(toCryptoBytes(messageKey), salt, info, 32);
}

export async function encryptMessagingMediaBytes(
  plainBytes: ArrayBuffer | Uint8Array,
  messageKey: Uint8Array,
  messageId: string,
  mediaId: string,
): Promise<{ ciphertext: Uint8Array; ciphertextSha256: string }> {
  const mediaKey = await deriveMessagingMediaKey(messageKey, messageId, mediaId);
  const aesKey = await crypto.subtle.importKey(
    'raw',
    toCryptoBytes(mediaKey),
    'AES-GCM',
    false,
    ['encrypt'],
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plain =
    plainBytes instanceof Uint8Array ? plainBytes : new Uint8Array(plainBytes);
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, toCryptoBytes(plain)),
  );
  const packed = new Uint8Array(iv.length + cipher.length);
  packed.set(iv, 0);
  packed.set(cipher, iv.length);
  const ciphertextSha256 = await sha256BytesHex(packed);
  return { ciphertext: packed, ciphertextSha256 };
}

export async function decryptMessagingMediaBytes(
  ciphertext: ArrayBuffer | Uint8Array,
  messageKey: Uint8Array,
  messageId: string,
  mediaId: string,
  expectedSha256: string,
): Promise<Uint8Array> {
  const view = ciphertext instanceof Uint8Array ? ciphertext : new Uint8Array(ciphertext);
  const actualSha = await sha256BytesHex(view);
  if (actualSha.toLowerCase() !== expectedSha256.trim().toLowerCase()) {
    throw new Error('媒体密文校验失败');
  }
  const mediaKey = await deriveMessagingMediaKey(messageKey, messageId, mediaId);
  const aesKey = await crypto.subtle.importKey(
    'raw',
    toCryptoBytes(mediaKey),
    'AES-GCM',
    false,
    ['decrypt'],
  );
  const iv = view.slice(0, 12);
  const body = view.slice(12);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, aesKey, body);
  return new Uint8Array(plain);
}

export function buildMessagingMediaSigned(input: {
  mediaId: string;
  senderStorageKey: string;
  senderWorkerBUrl: string;
  sizeBytes: number;
  ciphertextSha256: string;
}): MessagingMediaSigned {
  return {
    media_id: input.mediaId,
    sender_storage_key: input.senderStorageKey,
    sender_worker_b_url: input.senderWorkerBUrl.replace(/\/+$/, ''),
    size_bytes: Math.floor(input.sizeBytes),
    ciphertext_sha256: input.ciphertextSha256.toLowerCase(),
    alg: MESSAGING_MEDIA_ALG,
  };
}
