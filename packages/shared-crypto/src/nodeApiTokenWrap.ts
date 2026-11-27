/**
 * R-MSG-1d：节点 `nat_` at-rest AES-GCM wrap（与 TOTP wrap 同族，HKDF info 独立）。
 * 密文形态：`natw1:<ivB64>:<ctB64>`（不以 `nat_` 开头，便于与明文区分）。
 */
import { encodeText } from '@hailuo/shared-utils';

const WRAP_PREFIX = 'natw1';
const HKDF_INFO = 'hailuo-node-api-token-wrap-v1';

function asBufferSource(bytes: Uint8Array): BufferSource {
  return new Uint8Array(bytes);
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

async function deriveNodeApiTokenWrapKey(wrapSecret: string): Promise<Uint8Array> {
  const baseKey = await crypto.subtle.importKey(
    'raw',
    encodeText(wrapSecret),
    'HKDF',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(0),
      info: encodeText(HKDF_INFO),
    },
    baseKey,
    256,
  );
  return new Uint8Array(bits);
}

/** 是否为 at-rest wrap 密文。 */
export function isWrappedNodeApiToken(value: string): boolean {
  const parts = value.trim().split(':');
  return parts.length === 3 && parts[0] === WRAP_PREFIX && Boolean(parts[1]) && Boolean(parts[2]);
}

/** 是否为注册中心明文 `nat_`。 */
export function isPlainNodeApiToken(value: string): boolean {
  const t = value.trim();
  return t.startsWith('nat_') && t.length >= 12;
}

/** AES-256-GCM 包裹明文 `nat_`。 */
export async function wrapNodeApiToken(plaintext: string, wrapSecret: string): Promise<string> {
  const plain = plaintext.trim();
  if (!isPlainNodeApiToken(plain)) throw new Error('NODE_API_TOKEN_MALFORMED');
  const secret = wrapSecret.trim();
  if (secret.length < 16) throw new Error('NODE_API_TOKEN_WRAP_SECRET_WEAK');

  const keyBytes = await deriveNodeApiTokenWrapKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aesKey = await crypto.subtle.importKey('raw', asBufferSource(keyBytes), 'AES-GCM', false, [
    'encrypt',
  ]);
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: asBufferSource(iv) },
    aesKey,
    encodeText(plain),
  );
  return `${WRAP_PREFIX}:${bytesToBase64(iv)}:${bytesToBase64(new Uint8Array(ct))}`;
}

/** 解包 at-rest 密文 → 明文 `nat_`。 */
export async function unwrapNodeApiToken(wrapped: string, wrapSecret: string): Promise<string> {
  const parts = wrapped.trim().split(':');
  if (parts.length !== 3 || parts[0] !== WRAP_PREFIX) throw new Error('INVALID_NODE_API_TOKEN_WRAP');
  const secret = wrapSecret.trim();
  if (secret.length < 16) throw new Error('NODE_API_TOKEN_WRAP_SECRET_WEAK');

  const iv = base64ToBytes(parts[1]!);
  const ct = base64ToBytes(parts[2]!);
  const keyBytes = await deriveNodeApiTokenWrapKey(secret);
  const aesKey = await crypto.subtle.importKey('raw', asBufferSource(keyBytes), 'AES-GCM', false, [
    'decrypt',
  ]);
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: asBufferSource(iv) },
    aesKey,
    asBufferSource(ct),
  );
  const out = new TextDecoder().decode(plain).trim();
  if (!isPlainNodeApiToken(out)) throw new Error('INVALID_NODE_API_TOKEN_WRAP');
  return out;
}
