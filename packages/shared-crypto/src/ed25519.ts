/**
 * Ed25519 ?????Web Crypto API SubtleCrypto?
 *
 * ???????
 *   - ???32 ?? raw ? hex ????64 ???
 *   - ???48 ?? PKCS8 ? hex ????96 ???
 *
 * ???
 *   - Worker A?????????????? Token????
 *   - Worker B???????????????? Token????
 */

import { bytesToHex, hexToBytes, base64urlEncode, base64urlDecode, encodeText, nowSec, normalizeWorkerBOrigin } from '@hailuo/shared-utils';

/** base64 归一化：URL-safe (`-_`) → standard (`+/`)，去 padding。NCF 端本地副本（不依赖 BSP 仓 manifestSign）。 */
function normalizeBase64(raw: string): string {
  return raw.trim().replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
}

/** base64 standard 解码（与 BSP 端 decodeBase64Flexible 同语义）。 */
export function decodeBase64Flexible(input: string): Uint8Array {
  const normalized = normalizeBase64(input);
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
import type { FollowerReadScope, FollowerTokenPayload } from '@hailuo/shared-types';
import { getCachedKey } from './keyCache';

/** ???? ? ?? base64????? precheck/verify ????? base64url? */
function bytesToStandardBase64(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/**
 * ????? hex?64 ?? raw 32B?? ??????? base64 pubkey?
 * ?? hex ? base64 ?????? 48 ????? REGISTER_PUBKEY_INVALID?
 */
export function ed25519PubkeyHexToRegistryBase64(publicKeyHex: string): string {
  const bytes = hexToBytes(publicKeyHex);
  if (bytes.length !== 32) {
    throw new Error(`Ed25519 ???? 32 ???hex 64 ?????? ${bytes.length} ??`);
  }
  return bytesToStandardBase64(bytes);
}

/** signMessage ??? hex ?? ? ???? verify ??? base64?64 ??? */
export function ed25519SignatureHexToRegistryBase64(signatureHex: string): string {
  const bytes = hexToBytes(signatureHex);
  if (bytes.length !== 64) {
    throw new Error(`Ed25519 ???? 64 ???hex 128 ?????? ${bytes.length} ??`);
  }
  return bytesToStandardBase64(bytes);
}

// ---- ????? -------------------------------------------

export interface KeyPair {
  publicKeyHex: string;   // 64 ?? hex?32 ?? raw?
  privateKeyHex: string;  // 96 ?? hex?48 ?? PKCS8?
}

/** 从 PKCS8 hex 导出标准 JWK（M9-7 节点搬家 bundle 用） */
export async function ed25519PrivateKeyPkcs8HexToJwk(privateKeyHex: string): Promise<JsonWebKey> {
  const key = await crypto.subtle.importKey(
    'pkcs8',
    hexToBytes(privateKeyHex),
    { name: 'Ed25519' },
    true,
    ['sign'],
  );
  return (await crypto.subtle.exportKey('jwk', key)) as JsonWebKey;
}

/** 从 JWK 导入 PKCS8 hex（与 generateKeyPair 存储格式一致） */
export async function ed25519PrivateKeyJwkToPkcs8Hex(jwk: JsonWebKey): Promise<string> {
  const key = await crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'Ed25519' },
    true,
    ['sign'],
  );
  const pkcs8 = await crypto.subtle.exportKey('pkcs8', key) as ArrayBuffer;
  return bytesToHex(new Uint8Array(pkcs8));
}
/** 生成 Ed25519 密钥对（Worker 部署脚本 / 本地生成用） */
export async function generateKeyPair(): Promise<KeyPair> {
  const keyPair = await crypto.subtle.generateKey(
    { name: 'Ed25519' },
    true,
    ['sign', 'verify'],
  ) as CryptoKeyPair;
  const publicRaw = await crypto.subtle.exportKey('raw', keyPair.publicKey) as ArrayBuffer;
  const privatePkcs8 = await crypto.subtle.exportKey('pkcs8', keyPair.privateKey) as ArrayBuffer;
  return {
    publicKeyHex: bytesToHex(new Uint8Array(publicRaw)),
    privateKeyHex: bytesToHex(new Uint8Array(privatePkcs8)),
  };
}

// ---- ???? -----------------------------------------------

/**
 * ?? Ed25519 ???PKCS8 hex??
 *
 * M5-P2 ????? keyCache ??????????? token ???????
 * ??????????? PKCS8???? 0.5?2ms CPU??
 */
async function importPrivateKey(privateKeyHex: string): Promise<CryptoKey> {
  return getCachedKey(`ed25519-priv:${privateKeyHex}`, () =>
    crypto.subtle.importKey(
      'pkcs8',
      hexToBytes(privateKeyHex),
      { name: 'Ed25519' },
      false,
      ['sign'],
    ),
  );
}

/**
 * ?? Ed25519 ???raw hex??
 *
 * M5-P2 ????? token ??? M6 ???????????? importKey?
 */
async function importPublicKey(publicKeyHex: string): Promise<CryptoKey> {
  return getCachedKey(`ed25519-pub:${publicKeyHex}`, () =>
    crypto.subtle.importKey(
      'raw',
      hexToBytes(publicKeyHex),
      { name: 'Ed25519' },
      false,
      ['verify'],
    ),
  );
}

// ---- ????????? challenge ??-----------------------

/** ??? UTF-8 ??? Ed25519 ????? hex */
export async function signMessage(message: string, privateKeyHex: string): Promise<string> {
  const key = await importPrivateKey(privateKeyHex);
  const data = encodeText(message);
  const sig = await crypto.subtle.sign('Ed25519', key, data);
  return bytesToHex(new Uint8Array(sig));
}

/** 校验 UTF-8 消息的 Ed25519 签名（hex）；失败或格式错误返回 false */
export async function verifyMessage(
  message: string,
  sigHex: string,
  publicKeyHex: string,
): Promise<boolean> {
  try {
    const key = await importPublicKey(publicKeyHex);
    const data = encodeText(message);
    return crypto.subtle.verify('Ed25519', key, hexToBytes(sigHex), data);
  } catch {
    return false;
  }
}

// ---- ?????? -------------------------------------------

/**
 * ???????????? sig ??
 * ?????`${postId}:${content}:${createdAt}`
 */
export async function signPost(
  postId: string,
  content: string,
  createdAt: string,
  privateKeyHex: string,
): Promise<string> {
  const key = await importPrivateKey(privateKeyHex);
  const data = encodeText(`${postId}:${content}:${createdAt}`);
  const sig = await crypto.subtle.sign('Ed25519', key, data);
  return bytesToHex(new Uint8Array(sig));
}

/**
 * ??????
 */
export async function verifyPost(
  postId: string,
  content: string,
  createdAt: string,
  sigHex: string,
  publicKeyHex: string,
): Promise<boolean> {
  try {
    const key = await importPublicKey(publicKeyHex);
    const data = encodeText(`${postId}:${content}:${createdAt}`);
    return crypto.subtle.verify('Ed25519', key, hexToBytes(sigHex), data);
  } catch {
    return false;
  }
}

// ---- 纯转发帖签名（M9-1）--------------------------------

/**
 * 转发帖 canonical 载荷（与 signRepost / verifyRepost 同源）
 * 格式：`${id}:repost:${normalizeWorkerBOrigin(node_url)}:${origin_post_id}:${created_at}`
 */
export function buildRepostSignatureInput(
  postId: string,
  originNodeUrl: string,
  originPostId: string,
  createdAt: string,
): string {
  const origin = normalizeWorkerBOrigin(originNodeUrl);
  return `${postId}:repost:${origin}:${originPostId}:${createdAt}`;
}

/** 纯转发帖 Ed25519 签名（不含原帖 content/sig） */
export async function signRepost(
  postId: string,
  originNodeUrl: string,
  originPostId: string,
  createdAt: string,
  privateKeyHex: string,
): Promise<string> {
  const key = await importPrivateKey(privateKeyHex);
  const data = encodeText(buildRepostSignatureInput(postId, originNodeUrl, originPostId, createdAt));
  const sig = await crypto.subtle.sign('Ed25519', key, data);
  return bytesToHex(new Uint8Array(sig));
}

/** 验签纯转发帖 */
export async function verifyRepost(
  postId: string,
  originNodeUrl: string,
  originPostId: string,
  createdAt: string,
  sigHex: string,
  publicKeyHex: string,
): Promise<boolean> {
  try {
    const key = await importPublicKey(publicKeyHex);
    const data = encodeText(buildRepostSignatureInput(postId, originNodeUrl, originPostId, createdAt));
    return crypto.subtle.verify('Ed25519', key, hexToBytes(sigHex), data);
  } catch {
    return false;
  }
}

// ---- ?? Token?Ed25519 JWT-like?--------------------------

const ED_HEADER = base64urlEncode(encodeText(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' })));

/**
 * ???? Token?Worker A ???
 * ???<base64url_header>.<base64url_payload>.<base64url_sig>
 */
export async function signFollowerToken(
  followerNodeUrl: string,
  issuerHandle: string,
  privateKeyHex: string,
  ttlSec = 86400,  // ?? 24h
  followerHandle?: string,
  readScope?: FollowerReadScope,
): Promise<string> {
  const payload: FollowerTokenPayload = {
    sub: followerNodeUrl,
    iss: issuerHandle,
    ...(followerHandle ? { fan: followerHandle } : {}),
    ...(readScope ? { read_scope: readScope } : {}),
    iat: nowSec(),
    exp: nowSec() + ttlSec,
  };
  const payloadPart = base64urlEncode(encodeText(JSON.stringify(payload)));
  const sigInput = encodeText(`${ED_HEADER}.${payloadPart}`);
  const key = await importPrivateKey(privateKeyHex);
  const sig = await crypto.subtle.sign('Ed25519', key, sigInput);
  return `${ED_HEADER}.${payloadPart}.${base64urlEncode(sig)}`;
}

/**
 * ???? Token?Worker B ???
 * ?? payload ? null?????/????
 */
export async function verifyFollowerToken(
  token: string,
  publicKeyHex: string,
): Promise<FollowerTokenPayload | null> {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [header, payloadB64, sigB64] = parts;
    const sigInput = encodeText(`${header}.${payloadB64}`);
    const key = await importPublicKey(publicKeyHex);
    const valid = await crypto.subtle.verify('Ed25519', key, base64urlDecode(sigB64), sigInput);
    if (!valid) return null;
    const payload = JSON.parse(new TextDecoder().decode(base64urlDecode(payloadB64))) as FollowerTokenPayload;
    // ????
    if (payload.exp < nowSec()) return null;
    return payload;
  } catch {
    return null;
  }
}

// ---- ???? envelope?M9-19?--------------------

/**
 * ?? envelope ???????
 *   <type>:<post_id>:<actor_handle>:<actor_node_url>:<created_at>:<nonce>:<body_hash>
 *
 * body_hash ? SHA-256 hex???/unlike ??????? content ???delete_reply ? reply_id ???
 */
export function buildInteractionSignatureInput(
  type: string,
  postId: string,
  actorHandle: string,
  actorNodeUrl: string,
  createdAt: string,
  nonce: string,
  bodyHash: string,
): string {
  return `${type}:${postId}:${actorHandle}:${actorNodeUrl}:${createdAt}:${nonce}:${bodyHash}`;
}

/**
 * ??? envelope ? Ed25519 ????? hex ???
 * ????????? Worker A???????????
 */
export async function signInteraction(
  type: string,
  postId: string,
  actorHandle: string,
  actorNodeUrl: string,
  createdAt: string,
  nonce: string,
  bodyHash: string,
  privateKeyHex: string,
): Promise<string> {
  const key = await importPrivateKey(privateKeyHex);
  const input = buildInteractionSignatureInput(type, postId, actorHandle, actorNodeUrl, createdAt, nonce, bodyHash);
  const data = encodeText(input);
  const sig = await crypto.subtle.sign('Ed25519', key, data);
  return bytesToHex(new Uint8Array(sig));
}

/**
 * ??????? envelope ?????
 * ????????????????? Worker A????? actor ??????????
 * @returns true ?????????
 */
export async function verifyInteraction(
  type: string,
  postId: string,
  actorHandle: string,
  actorNodeUrl: string,
  createdAt: string,
  nonce: string,
  bodyHash: string,
  sigHex: string,
  publicKeyHex: string,
): Promise<boolean> {
  try {
    const key = await importPublicKey(publicKeyHex);
    const input = buildInteractionSignatureInput(type, postId, actorHandle, actorNodeUrl, createdAt, nonce, bodyHash);
    const data = encodeText(input);
    return crypto.subtle.verify('Ed25519', key, hexToBytes(sigHex), data);
  } catch {
    return false;
  }
}

/**
 * ???? body hash??SHA-256 hex????
 * ???? content ????????????/?????????????
 */
export async function computeBodyHash(content: string): Promise<string> {
  const data = encodeText(content);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return bytesToHex(new Uint8Array(hash));
}
