/**
 * M10-4：浏览器端私信 E2EE（X25519 ECDH + HKDF + AES-GCM）。
 * 私钥与明文仅在本模块与 sessionStorage 间流转，不上传 Worker 明文。
 */
import type { DmEnvelope, DmSendTicket } from '@hailuo/shared-types';
import { canonicalizeDmSendTicket, randomDmNonceHex } from '@hailuo/shared-crypto';
import { bytesToHex, encodeText, hexToBytes } from '@hailuo/shared-utils';

const DM_HKDF_INFO = 'hailuo-dm-v1';
const DM_KEK_SALT = 'hailuo-dm-kek-v1';
const DM_IDENTITY_KEK_INFO = 'hailuo-dm-identity-v1';

/** 旧：password_hash 直包；新：vault_master_key hex 包（M-VAULT-5） */
export const DM_WRAP_KDF_PASSWORD = 'PBKDF2-HKDF-v1' as const;
export const DM_WRAP_KDF_VAULT = 'VAULT-HKDF-v1' as const;
export type DmWrapKdf = typeof DM_WRAP_KDF_PASSWORD | typeof DM_WRAP_KDF_VAULT;

/** Web Crypto 在 strict TS 下要求 ArrayBuffer 视图，shared-utils 字节需拷贝。 */
function toCryptoBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(bytes.byteLength);
  out.set(bytes);
  return out;
}

export interface DmWrappedKeyJson {
  readonly v: 1;
  readonly wrap_alg: 'AES-256-GCM';
  readonly kdf: DmWrapKdf;
  readonly key_epoch: number;
  readonly nonce: string;
  readonly ciphertext: string;
}

/**
 * 会话密钥包裹载荷（v2）。
 *
 * - `mk`：AES-GCM 消息密钥（64 hex）。
 * - `pub`：该密钥对应的 ephemeral 公钥；发信时写入信封 `ephemeral_pubkey`。
 * - `priv`：ephemeral 私钥，仅首次创建密钥的一端需要；用于换客户端后继续沿用同一把钥。
 *
 * 旧包裹解出来是 32 字节裸密钥（无 pub/priv），仍按 legacy 兼容。
 * 方向键共享：接收端拿到 `mk + pub` 后也能用它回信，避免同一 epoch 出现两把钥。
 */
export interface DmSessionKeyPayload {
  readonly message_key_hex: string;
  readonly ephemeral_pubkey_hex?: string;
  readonly ephemeral_private_key_hex?: string;
}

/** M10-5c：身份私钥包裹 JSON（KEK info 固定为 hailuo-dm-identity-v1） */
export interface DmWrappedIdentityJson {
  readonly v: 1;
  readonly wrap_alg: 'AES-256-GCM';
  readonly kdf: DmWrapKdf;
  readonly identity_kdf_info: typeof DM_IDENTITY_KEK_INFO;
  readonly nonce: string;
  readonly ciphertext: string;
}

export interface DmIdentityKeyPair {
  readonly publicKeyHex: string;
  readonly privateKeyHex: string;
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

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', toCryptoBytes(encodeText(text)));
  return bytesToHex(new Uint8Array(digest));
}

function normalizeHandle(handle: string): string {
  return handle.trim().toLowerCase();
}

/** 会话 ID：双 handle 排序后 SHA256 取前 32 hex。 */
export async function deriveConversationId(handleA: string, handleB: string): Promise<string> {
  const sorted = [normalizeHandle(handleA), normalizeHandle(handleB)].sort();
  const hash = await sha256Hex(sorted.join(':'));
  return `conv_${hash.slice(0, 32)}`;
}

/** 新消息 ID（dm_ 前缀 + 随机 hex，满足 Worker 校验正则）。 */
export function newDmMessageId(): string {
  return `dm_${randomDmNonceHex(16)}`;
}

export async function generateDmIdentityKeyPair(): Promise<DmIdentityKeyPair> {
  const pair = (await crypto.subtle.generateKey(
    { name: 'X25519' },
    true,
    ['deriveBits'],
  )) as CryptoKeyPair;
  const pubRaw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const privPkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  return { publicKeyHex: bytesToHex(pubRaw), privateKeyHex: bytesToHex(privPkcs8) };
}

async function importX25519PrivateKey(hex: string): Promise<CryptoKey> {
  // deriveIdentityPublicKeyHex() 需要 exportKey('jwk') 取公钥；extractable=false 会抛
  // InvalidAccessError: key is not extractable（私钥本身已以 hex 存 sessionStorage/IDB，
  // 这里只影响内存中 CryptoKey 的可导出性，不新增落盘暴露面）。
  return crypto.subtle.importKey('pkcs8', toCryptoBytes(hexToBytes(hex)), { name: 'X25519' }, true, ['deriveBits']);
}

async function importX25519PublicKey(hex: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', toCryptoBytes(hexToBytes(hex)), { name: 'X25519' }, false, []);
}

async function deriveMessageKeyBytes(
  privateKeyHex: string,
  peerPublicKeyHex: string,
  conversationId: string,
): Promise<Uint8Array> {
  const priv = await importX25519PrivateKey(privateKeyHex);
  const pub = await importX25519PublicKey(peerPublicKeyHex);
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'X25519', public: pub }, priv, 256),
  );
  return hkdfSha256(shared, toCryptoBytes(encodeText(conversationId)), toCryptoBytes(encodeText(DM_HKDF_INFO)), 32);
}

export async function deriveMessageKeyForSend(
  ephemeralPrivateKeyHex: string,
  recipientDmPubkeyHex: string,
  conversationId: string,
): Promise<Uint8Array> {
  return deriveMessageKeyBytes(ephemeralPrivateKeyHex, recipientDmPubkeyHex, conversationId);
}

export async function deriveMessageKeyForReceive(
  ephemeralPublicKeyHex: string,
  localPrivateKeyHex: string,
  conversationId: string,
): Promise<Uint8Array> {
  return deriveMessageKeyBytes(localPrivateKeyHex, ephemeralPublicKeyHex, conversationId);
}

export async function generateEphemeralKeyPair(): Promise<DmIdentityKeyPair> {
  return generateDmIdentityKeyPair();
}

export async function buildDmEnvelopeAad(envelope: Omit<DmEnvelope, 'sig'>): Promise<Uint8Array> {
  const header = [
    'DM_ENVELOPE_HEADER_V1',
    envelope.conversation_id,
    envelope.message_id,
    envelope.sender_handle,
    envelope.sender_worker_b_url,
    envelope.recipient_handle,
    envelope.created_at,
    envelope.nonce,
    String(envelope.key_epoch),
    envelope.ephemeral_pubkey,
    canonicalizeDmSendTicket(envelope.send_ticket),
  ].join('\n');
  const hashHex = await sha256Hex(header);
  return encodeText(hashHex);
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

export async function encryptDmPlaintext(
  plaintext: string,
  messageKey: Uint8Array,
  envelopeHeader: Omit<DmEnvelope, 'sig' | 'ciphertext'>,
): Promise<string> {
  const aesKey = await crypto.subtle.importKey('raw', toCryptoBytes(messageKey), 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aad = await buildDmEnvelopeAad({ ...envelopeHeader, ciphertext: '' });
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: toCryptoBytes(aad) },
      aesKey,
      toCryptoBytes(encodeText(plaintext)),
    ),
  );
  const packed = new Uint8Array(iv.length + cipher.length);
  packed.set(iv, 0);
  packed.set(cipher, iv.length);
  return bytesToBase64(packed);
}

export async function decryptDmCiphertext(
  ciphertextB64: string,
  messageKey: Uint8Array,
  envelopeHeader: Omit<DmEnvelope, 'sig' | 'ciphertext'>,
): Promise<string> {
  const packed = base64ToBytes(ciphertextB64);
  const iv = packed.slice(0, 12);
  const cipher = packed.slice(12);
  const aesKey = await crypto.subtle.importKey('raw', toCryptoBytes(messageKey), 'AES-GCM', false, ['decrypt']);
  const aad = await buildDmEnvelopeAad({ ...envelopeHeader, ciphertext: ciphertextB64 });
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv, additionalData: toCryptoBytes(aad) },
    aesKey,
    cipher,
  );
  return new TextDecoder().decode(plain);
}

/** wrapMaterial：vault hex（新）或 password_hash（旧）；算法相同，靠 kdf 标签区分世代 */
async function deriveKekBytes(wrapMaterial: string, conversationId: string): Promise<Uint8Array> {
  const ikm = new Uint8Array(
    await crypto.subtle.digest('SHA-256', toCryptoBytes(encodeText(wrapMaterial))),
  );
  return hkdfSha256(
    ikm,
    toCryptoBytes(encodeText(DM_KEK_SALT)),
    toCryptoBytes(encodeText(conversationId)),
    32,
  );
}

async function wrapSessionKeyBytes(
  plain: Uint8Array,
  wrapMaterial: string,
  conversationId: string,
  keyEpoch: number,
  kdf: DmWrapKdf,
): Promise<DmWrappedKeyJson> {
  const kek = await deriveKekBytes(wrapMaterial, conversationId);
  const aesKey = await crypto.subtle.importKey('raw', toCryptoBytes(kek), 'AES-GCM', false, ['encrypt']);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, toCryptoBytes(plain)),
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

async function unwrapSessionKeyBytes(
  wrapped: DmWrappedKeyJson,
  wrapMaterial: string,
  conversationId: string,
): Promise<Uint8Array> {
  const kek = await deriveKekBytes(wrapMaterial, conversationId);
  const aesKey = await crypto.subtle.importKey('raw', toCryptoBytes(kek), 'AES-GCM', false, ['decrypt']);
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: toCryptoBytes(base64ToBytes(wrapped.nonce)) },
    aesKey,
    toCryptoBytes(base64ToBytes(wrapped.ciphertext)),
  );
  return new Uint8Array(plain);
}

const SESSION_PAYLOAD_VERSION = 2;
const HEX64_RE = /^[0-9a-f]{64}$/i;
/** X25519 私钥以 PKCS8 十六进制保存（当前 48 字节 → 96 hex），不能用 64 hex 校验。 */
const PRIVATE_KEY_HEX_RE = /^(?:[0-9a-f]{2}){16,256}$/i;

/**
 * 打包会话密钥载荷（v2 JSON）。`pub` / `priv` 可选，缺省表示只有收信侧材料。
 * 新建密钥时必须同时写 `pub + priv`，换客户端后才能继续用同一把钥发信。
 */
export async function wrapSessionKeyPayload(
  payload: DmSessionKeyPayload,
  wrapMaterial: string,
  conversationId: string,
  keyEpoch: number,
  kdf: DmWrapKdf = DM_WRAP_KDF_VAULT,
): Promise<DmWrappedKeyJson> {
  const body = {
    v: SESSION_PAYLOAD_VERSION,
    mk: payload.message_key_hex,
    ...(payload.ephemeral_pubkey_hex ? { pub: payload.ephemeral_pubkey_hex } : {}),
    ...(payload.ephemeral_private_key_hex ? { priv: payload.ephemeral_private_key_hex } : {}),
  };
  const plain = toCryptoBytes(encodeText(JSON.stringify(body)));
  return wrapSessionKeyBytes(plain, wrapMaterial, conversationId, keyEpoch, kdf);
}

/** 解开 v2 载荷；旧 32 字节裸密钥按 legacy 返回 `{ message_key_hex }`。 */
export async function unwrapSessionKeyPayload(
  wrapped: DmWrappedKeyJson,
  wrapMaterial: string,
  conversationId: string,
): Promise<DmSessionKeyPayload> {
  const plain = await unwrapSessionKeyBytes(wrapped, wrapMaterial, conversationId);
  if (plain.byteLength === 32) {
    return { message_key_hex: bytesToHex(plain) };
  }
  try {
    const parsed = JSON.parse(new TextDecoder().decode(plain)) as Record<string, unknown>;
    const mk = typeof parsed.mk === 'string' ? parsed.mk.toLowerCase() : '';
    if (parsed.v === SESSION_PAYLOAD_VERSION && HEX64_RE.test(mk)) {
      const pub = typeof parsed.pub === 'string' && HEX64_RE.test(parsed.pub)
        ? parsed.pub.toLowerCase()
        : undefined;
      const priv = typeof parsed.priv === 'string' && PRIVATE_KEY_HEX_RE.test(parsed.priv)
        ? parsed.priv.toLowerCase()
        : undefined;
      return {
        message_key_hex: mk,
        ephemeral_pubkey_hex: pub,
        ephemeral_private_key_hex: priv,
      };
    }
  } catch {
    /* 非 JSON → 落到下方统一报错 */
  }
  throw new Error('会话密钥包裹格式无法识别');
}

/** 默认挂 vault（M-VAULT-5）；迁移期仍可显式写 password 世代 */
export async function wrapMessageKey(
  messageKey: Uint8Array,
  wrapMaterial: string,
  conversationId: string,
  keyEpoch: number,
  kdf: DmWrapKdf = DM_WRAP_KDF_VAULT,
): Promise<DmWrappedKeyJson> {
  return wrapSessionKeyPayload(
    { message_key_hex: bytesToHex(messageKey) },
    wrapMaterial,
    conversationId,
    keyEpoch,
    kdf,
  );
}

export async function unwrapMessageKey(
  wrapped: DmWrappedKeyJson,
  wrapMaterial: string,
  conversationId: string,
): Promise<Uint8Array> {
  const payload = await unwrapSessionKeyPayload(wrapped, wrapMaterial, conversationId);
  return hexToBytes(payload.message_key_hex);
}

async function deriveIdentityKekBytes(wrapMaterial: string): Promise<Uint8Array> {
  const ikm = new Uint8Array(
    await crypto.subtle.digest('SHA-256', toCryptoBytes(encodeText(wrapMaterial))),
  );
  return hkdfSha256(
    ikm,
    toCryptoBytes(encodeText(DM_KEK_SALT)),
    toCryptoBytes(encodeText(DM_IDENTITY_KEK_INFO)),
    32,
  );
}

/** 从 PKCS8 私钥导出 X25519 raw 公钥 hex（与 users.dm_pubkey 对齐） */
export async function deriveIdentityPublicKeyHex(privateKeyHex: string): Promise<string> {
  const privKey = await importX25519PrivateKey(privateKeyHex);
  const jwk = await crypto.subtle.exportKey('jwk', privKey);
  if (!jwk.x) throw new Error('无法导出身份公钥');
  let b64 = jwk.x.replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4) b64 += '=';
  const pubRaw = base64ToBytes(b64);
  return bytesToHex(pubRaw);
}

export async function wrapIdentityPrivateKey(
  privateKeyHex: string,
  wrapMaterial: string,
  kdf: DmWrapKdf = DM_WRAP_KDF_VAULT,
): Promise<DmWrappedIdentityJson> {
  const kek = await deriveIdentityKekBytes(wrapMaterial);
  const aesKey = await crypto.subtle.importKey('raw', toCryptoBytes(kek), 'AES-GCM', false, ['encrypt']);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const plain = toCryptoBytes(encodeText(privateKeyHex));
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, plain),
  );
  return {
    v: 1,
    wrap_alg: 'AES-256-GCM',
    kdf,
    identity_kdf_info: DM_IDENTITY_KEK_INFO,
    nonce: bytesToBase64(nonce),
    ciphertext: bytesToBase64(cipher),
  };
}

export async function unwrapIdentityPrivateKey(
  wrapped: DmWrappedIdentityJson,
  wrapMaterial: string,
): Promise<string> {
  const kek = await deriveIdentityKekBytes(wrapMaterial);
  const aesKey = await crypto.subtle.importKey('raw', toCryptoBytes(kek), 'AES-GCM', false, ['decrypt']);
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: toCryptoBytes(base64ToBytes(wrapped.nonce)) },
    aesKey,
    toCryptoBytes(base64ToBytes(wrapped.ciphertext)),
  );
  return new TextDecoder().decode(plain);
}

export type { DmEnvelope, DmSendTicket };
