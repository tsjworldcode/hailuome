/**
 * M16-4c：浏览器端群聊 E2EE — group_key 生成/包裹与 AES-GCM 正文加解密。
 * M-VAULT-6：新建包裹默认挂 vault；明文 group_key 仅在本模块与 sessionStorage。
 * EPOCH-REKEY-2：为他人密封用 X25519 `member_dh_pubkey`（v2）；自包仍用 vault v1。
 */
import type { GroupMessageEnvelope } from '@hailuo/shared-types';
import { bytesToHex, encodeText, hexToBytes } from '@hailuo/shared-utils';

const GROUP_KEK_SALT = 'hailuo-group-kek-v1';
const GROUP_HKDF_INFO = 'hailuo-group-message-v1';
/** 成员 DH 密封：HKDF info 前缀（含 epoch 防跨轮挪用） */
const GROUP_DH_WRAP_INFO = 'hailuo-group-dh-wrap-v1';

/** 旧：password_hash 直包；新：vault hex 包（M-VAULT-6） */
export const GROUP_WRAP_KDF_PASSWORD = 'PBKDF2-HKDF-v1' as const;
export const GROUP_WRAP_KDF_VAULT = 'VAULT-HKDF-v1' as const;
export type GroupWrapKdf = typeof GROUP_WRAP_KDF_PASSWORD | typeof GROUP_WRAP_KDF_VAULT;

/** REKEY-2：对端 member_dh_pubkey 密封 */
export const GROUP_WRAP_KDF_X25519 = 'X25519-HKDF-v1' as const;

/** 存入 D1 group_wrapped_keys 的 KEK 包裹 JSON（Worker 不解包） */
export interface GroupWrappedKeyJsonV1 {
  readonly v: 1;
  readonly wrap_alg: 'AES-256-GCM';
  readonly kdf: GroupWrapKdf;
  readonly epoch: number;
  readonly nonce: string;
  readonly ciphertext: string;
}

/** 对成员 DH 公钥密封：临时 X25519 + AES-GCM */
export interface GroupWrappedKeyJsonV2 {
  readonly v: 2;
  readonly wrap_alg: 'AES-256-GCM';
  readonly kdf: typeof GROUP_WRAP_KDF_X25519;
  readonly epoch: number;
  readonly ephemeral_pubkey: string;
  readonly nonce: string;
  readonly ciphertext: string;
}

export type GroupWrappedKeyJson = GroupWrappedKeyJsonV1 | GroupWrappedKeyJsonV2;

export function isGroupWrappedKeyV2(w: GroupWrappedKeyJson): w is GroupWrappedKeyJsonV2 {
  return w.v === 2;
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

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', toCryptoBytes(encodeText(text)));
  return bytesToHex(new Uint8Array(digest));
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

/** 生成 256-bit 群对称密钥（AES-256-GCM）。 */
export async function generateGroupKey(): Promise<Uint8Array> {
  return crypto.getRandomValues(new Uint8Array(32));
}

/**
 * SEC-AUDIT-2026-10-16：群钥同源指纹 = SHA-256(raw group_key) → 64 hex。
 * 上传 next-epoch wraps / commit 用；Worker 不解包，只比对同源。
 */
export async function fingerprintGroupKey(groupKey: Uint8Array): Promise<string> {
  const dig = new Uint8Array(await crypto.subtle.digest('SHA-256', toCryptoBytes(groupKey)));
  return bytesToHex(dig);
}

/** wrapMaterial：vault hex（新）或 password_hash（旧） */
async function deriveGroupKekBytes(wrapMaterial: string, groupId: string): Promise<Uint8Array> {
  const ikm = new Uint8Array(
    await crypto.subtle.digest('SHA-256', toCryptoBytes(encodeText(wrapMaterial))),
  );
  return hkdfSha256(
    ikm,
    toCryptoBytes(encodeText(GROUP_KEK_SALT)),
    toCryptoBytes(encodeText(groupId)),
    32,
  );
}

/** 默认挂 vault（M-VAULT-6）；迁移期仍可显式写 password 世代 */
export async function wrapGroupKey(
  groupKey: Uint8Array,
  wrapMaterial: string,
  groupId: string,
  epoch: number,
  kdf: GroupWrapKdf = GROUP_WRAP_KDF_VAULT,
): Promise<GroupWrappedKeyJsonV1> {
  const kek = await deriveGroupKekBytes(wrapMaterial, groupId);
  const aesKey = await crypto.subtle.importKey('raw', toCryptoBytes(kek), 'AES-GCM', false, ['encrypt']);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, toCryptoBytes(groupKey)),
  );
  return {
    v: 1,
    wrap_alg: 'AES-256-GCM',
    kdf,
    epoch,
    nonce: bytesToBase64(nonce),
    ciphertext: bytesToBase64(cipher),
  };
}

/** 从 D1 wrapped JSON 解出 group_key（材料由调用方选定；仅 v1）。 */
export async function unwrapGroupKey(
  wrapped: GroupWrappedKeyJsonV1,
  wrapMaterial: string,
  groupId: string,
): Promise<Uint8Array> {
  const kek = await deriveGroupKekBytes(wrapMaterial, groupId);
  const aesKey = await crypto.subtle.importKey('raw', toCryptoBytes(kek), 'AES-GCM', false, ['decrypt']);
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: toCryptoBytes(base64ToBytes(wrapped.nonce)) },
    aesKey,
    toCryptoBytes(base64ToBytes(wrapped.ciphertext)),
  );
  return new Uint8Array(plain);
}

async function importX25519PrivateKey(hex: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'pkcs8',
    toCryptoBytes(hexToBytes(hex)),
    { name: 'X25519' },
    false,
    ['deriveBits'],
  );
}

async function importX25519PublicKey(hex: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    toCryptoBytes(hexToBytes(hex)),
    { name: 'X25519' },
    false,
    [],
  );
}

async function generateX25519Ephemeral(): Promise<{ publicKeyHex: string; privateKey: CryptoKey }> {
  const pair = (await crypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits'])) as CryptoKeyPair;
  const pubRaw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  return { publicKeyHex: bytesToHex(pubRaw), privateKey: pair.privateKey };
}

async function deriveGroupDhKek(
  privateKey: CryptoKey,
  peerPublicKeyHex: string,
  groupId: string,
  epoch: number,
): Promise<Uint8Array> {
  const pub = await importX25519PublicKey(peerPublicKeyHex);
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'X25519', public: pub }, privateKey, 256),
  );
  return hkdfSha256(
    shared,
    toCryptoBytes(encodeText(groupId)),
    toCryptoBytes(encodeText(`${GROUP_DH_WRAP_INFO}:${epoch}`)),
    32,
  );
}

/**
 * REKEY-2：用对方 `member_dh_pubkey`（X25519 raw hex）密封新 group_key。
 * 每次生成临时钥；Worker 只收密文，不可解。
 */
export async function wrapGroupKeyForMemberDh(
  groupKey: Uint8Array,
  memberDhPubkeyHex: string,
  groupId: string,
  epoch: number,
): Promise<GroupWrappedKeyJsonV2> {
  const peer = memberDhPubkeyHex.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(peer)) {
    throw new Error('member_dh_pubkey 无效');
  }
  const eph = await generateX25519Ephemeral();
  const kek = await deriveGroupDhKek(eph.privateKey, peer, groupId, epoch);
  const aesKey = await crypto.subtle.importKey('raw', toCryptoBytes(kek), 'AES-GCM', false, ['encrypt']);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, toCryptoBytes(groupKey)),
  );
  return {
    v: 2,
    wrap_alg: 'AES-256-GCM',
    kdf: GROUP_WRAP_KDF_X25519,
    epoch,
    ephemeral_pubkey: eph.publicKeyHex,
    nonce: bytesToBase64(nonce),
    ciphertext: bytesToBase64(cipher),
  };
}

/** 本机用 X25519 私钥解开 v2 wrap（与登记的 member_dh_pubkey 配对）。 */
export async function unwrapGroupKeyWithDh(
  wrapped: GroupWrappedKeyJsonV2,
  localDhPrivateKeyHex: string,
  groupId: string,
): Promise<Uint8Array> {
  if (wrapped.kdf !== GROUP_WRAP_KDF_X25519 || !/^[0-9a-f]{64}$/i.test(wrapped.ephemeral_pubkey)) {
    throw new Error('群密钥 DH 包裹格式无效');
  }
  const priv = await importX25519PrivateKey(localDhPrivateKeyHex);
  const kek = await deriveGroupDhKek(
    priv,
    wrapped.ephemeral_pubkey.toLowerCase(),
    groupId,
    wrapped.epoch,
  );
  const aesKey = await crypto.subtle.importKey('raw', toCryptoBytes(kek), 'AES-GCM', false, ['decrypt']);
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: toCryptoBytes(base64ToBytes(wrapped.nonce)) },
    aesKey,
    toCryptoBytes(base64ToBytes(wrapped.ciphertext)),
  );
  return new Uint8Array(plain);
}

async function deriveGroupMessageKey(groupKey: Uint8Array, groupId: string, epoch: number): Promise<Uint8Array> {
  return hkdfSha256(
    groupKey,
    toCryptoBytes(encodeText(groupId)),
    toCryptoBytes(encodeText(`${GROUP_HKDF_INFO}:${epoch}`)),
    32,
  );
}

/** 与 member_group_messages 行字段对齐的稳定 AAD 输入（解密不依赖 nonce/expires_at）。 */
export interface GroupMessageAadInput {
  readonly group_id: string;
  readonly message_id: string;
  readonly epoch: number;
  readonly sender_handle: string;
  readonly sender_worker_b_url: string;
  readonly owner_worker_b_url: string;
  readonly msg_kind: string;
}

export async function buildGroupMessageAad(input: GroupMessageAadInput): Promise<Uint8Array> {
  const lines = [
    'GROUP_MESSAGE_AAD_V1',
    input.group_id,
    input.message_id,
    String(input.epoch),
    input.sender_handle,
    input.sender_worker_b_url,
    input.owner_worker_b_url,
    input.msg_kind,
  ].join('\n');
  const hashHex = await sha256Hex(lines);
  return encodeText(hashHex);
}

export function groupMessageAadFromEnvelope(
  envelope: Omit<GroupMessageEnvelope, 'sig'>,
): GroupMessageAadInput {
  return {
    group_id: envelope.group_id,
    message_id: envelope.message_id,
    epoch: envelope.epoch,
    sender_handle: envelope.sender_handle,
    sender_worker_b_url: envelope.sender_worker_b_url,
    owner_worker_b_url: envelope.owner_worker_b_url,
    msg_kind: envelope.msg_kind,
  };
}

export async function encryptGroupPlaintext(
  plaintext: string,
  groupKey: Uint8Array,
  aadInput: GroupMessageAadInput,
): Promise<string> {
  const messageKey = await deriveGroupMessageKey(groupKey, aadInput.group_id, aadInput.epoch);
  const aesKey = await crypto.subtle.importKey('raw', toCryptoBytes(messageKey), 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aad = await buildGroupMessageAad(aadInput);
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

export function groupKeyToHex(key: Uint8Array): string {
  return bytesToHex(key);
}

export function groupKeyFromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** 新群消息 ID（gmsg_ 前缀 + 随机 hex）。 */
export function newGroupMessageId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `gmsg_${bytesToHex(bytes)}`;
}

/** M16-7b：system 消息 ciphertext 为 UTF-8 明文 base64，无需 group_key 解密。 */
export function decodeGroupSystemPlaintext(ciphertextB64: string): string {
  return new TextDecoder().decode(base64ToBytes(ciphertextB64));
}

export async function decryptGroupPlaintext(
  ciphertextB64: string,
  groupKey: Uint8Array,
  aadInput: GroupMessageAadInput,
): Promise<string> {
  const messageKey = await deriveGroupMessageKey(groupKey, aadInput.group_id, aadInput.epoch);
  const packed = base64ToBytes(ciphertextB64);
  const iv = packed.slice(0, 12);
  const cipher = packed.slice(12);
  const aesKey = await crypto.subtle.importKey('raw', toCryptoBytes(messageKey), 'AES-GCM', false, ['decrypt']);
  const aad = await buildGroupMessageAad(aadInput);
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv, additionalData: toCryptoBytes(aad) },
    aesKey,
    cipher,
  );
  return new TextDecoder().decode(plain);
}
