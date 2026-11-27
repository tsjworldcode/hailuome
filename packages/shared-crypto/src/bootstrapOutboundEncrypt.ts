/**
 * 路径 D · 节点侧加密与邮件模板构造（REG-BO / M9-PH-BO-1）。
 *
 * 对齐 registry `m-reg-bootstrap-outbound-plan.md` §3.2 / §3.3：
 *   - RSA-OAEP-2048(写死公钥) 包 AES-256 key + AES-GCM 加密 JSON
 *   - Ed25519 签 8 字段消息（challenge_id|…|issued_at）
 *   - 正文明文仅三件套（P1-b）：payload / browser_nonce / issued_at
 *
 * 私钥（节点 Ed25519）由 Worker A 持有；本模块只提供纯函数，不读 env。
 */

import {
  BOOTSTRAP_OUTBOUND_RSA_FINGERPRINT,
  BOOTSTRAP_OUTBOUND_RSA_KEY_VERSION,
  BOOTSTRAP_OUTBOUND_RSA_PUBLIC_KEY_SPKI_B64,
} from './bootstrapOutboundRsaPublicKey';
import { ed25519PubkeyHexToRegistryBase64, ed25519SignatureHexToRegistryBase64, signMessage } from './ed25519';

const RSA_OAEP_WRAPPED_KEY_BYTES = 256;
const AES_GCM_KEY_BYTES = 32;
const AES_GCM_IV_BYTES = 12;

export type OutboundPlaintextFields = {
  challenge_id: string;
  handle: string;
  worker_a_url: string;
  worker_b_url: string;
  pubkey: string;
  email: string;
  nonce: string;
  issued_at: string;
  signature_b64: string;
  rsa_key_version: string;
};

export type OutboundEmailTemplate = {
  to: string;
  subject: string;
  body: string;
  challenge_id: string;
  browser_nonce: string;
  issued_at: string;
  fingerprint_short: string;
  tag8: string;
  /** claim_token = browser_nonce（P-a） */
  claim_token: string;
};

function bytesToB64(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.trim());
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** 复制为独立 ArrayBuffer 视图，满足 TS BufferSource（避免 ArrayBufferLike 报错）。 */
function asBufferSource(bytes: Uint8Array): BufferSource {
  return new Uint8Array(bytes);
}

function randHexLower(byteLen: number): string {
  const buf = new Uint8Array(byteLen);
  crypto.getRandomValues(buf);
  let out = '';
  for (const b of buf) out += b.toString(16).padStart(2, '0');
  return out;
}

/** 与 registry `newChallengeId` 同源口径：`chg_` + base36 时戳 + 20 hex。 */
export function newOutboundChallengeId(nowMs: number = Date.now()): string {
  const ts = nowMs.toString(36).toUpperCase().padStart(10, '0').slice(-10);
  return `chg_${ts}${randHexLower(10).toUpperCase()}`;
}

/** browser_nonce / claim_token：32 小写 hex。 */
export function newOutboundBrowserNonce(): string {
  return randHexLower(16);
}

/** 收件 tag8：`[a-z0-9]{8}`。 */
export function newOutboundTag8(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const buf = new Uint8Array(8);
  crypto.getRandomValues(buf);
  let out = '';
  for (const b of buf) out += alphabet[b % alphabet.length]!;
  return out;
}

export function outboundFingerprintShort(
  fingerprint: string = BOOTSTRAP_OUTBOUND_RSA_FINGERPRINT,
): string {
  return fingerprint.trim().toLowerCase().slice(0, 8);
}

export function buildOutboundSubject(
  fingerprint: string = BOOTSTRAP_OUTBOUND_RSA_FINGERPRINT,
): string {
  return `[Hailuo Bootstrap-Outbound] ${outboundFingerprintShort(fingerprint)}`;
}

export function buildOutboundToAddress(host: string, tag8: string = newOutboundTag8()): string {
  const h = host.trim().toLowerCase().replace(/^@/, '');
  const tag = tag8.trim().toLowerCase();
  if (!h) throw new Error('BOOTSTRAP_OUTBOUND_HOST_MISSING');
  if (!/^[a-z0-9]{8}$/.test(tag)) throw new Error('BOOTSTRAP_OUTBOUND_TAG_INVALID');
  return `bootstrap-outbound+${tag}@${h}`;
}

/** §3.2.2 签名消息（8 字段；不含 signature_b64 / rsa_key_version）。 */
export function buildOutboundSignedMessage(fields: {
  challenge_id: string;
  handle: string;
  worker_a_url: string;
  worker_b_url: string;
  pubkey: string;
  email: string;
  nonce: string;
  issued_at: string;
}): string {
  return [
    fields.challenge_id,
    fields.handle,
    fields.worker_a_url,
    fields.worker_b_url,
    fields.pubkey,
    fields.email,
    fields.nonce,
    fields.issued_at,
  ].join('|');
}

/** P1-b：正文仅三件套 + 可选说明行（解析器只认 key: value）。 */
export function formatOutboundEmailBodyP1b(parts: {
  payload: string;
  browser_nonce: string;
  issued_at: string;
}): string {
  return [
    '请勿修改下列三行内容；用自有邮箱发送到 To 地址；勿发到 verify+ 认证地址。',
    `payload: ${parts.payload}`,
    `browser_nonce: ${parts.browser_nonce}`,
    `issued_at: ${parts.issued_at}`,
  ].join('\n');
}

export async function importBootstrapOutboundRsaPublicKey(
  spkiB64: string = BOOTSTRAP_OUTBOUND_RSA_PUBLIC_KEY_SPKI_B64,
): Promise<CryptoKey> {
  const der = b64ToBytes(spkiB64);
  return crypto.subtle.importKey(
    'spki',
    asBufferSource(der),
    { name: 'RSA-OAEP', hash: 'SHA-256' },
    false,
    ['encrypt'],
  );
}

/** 构造 payload_b64 = base64(RSA-OAEP(aes)||iv||AES-GCM(ct||tag))。 */
export async function encryptOutboundPayload(params: {
  fields: OutboundPlaintextFields;
  publicKeySpkiB64?: string;
}): Promise<string> {
  const spki = await importBootstrapOutboundRsaPublicKey(params.publicKeySpkiB64);
  const aesKeyRaw = new Uint8Array(AES_GCM_KEY_BYTES);
  crypto.getRandomValues(aesKeyRaw);
  const iv = new Uint8Array(AES_GCM_IV_BYTES);
  crypto.getRandomValues(iv);

  const aesKey = await crypto.subtle.importKey(
    'raw',
    asBufferSource(aesKeyRaw),
    { name: 'AES-GCM' },
    false,
    ['encrypt'],
  );
  const plain = new TextEncoder().encode(JSON.stringify(params.fields));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: asBufferSource(iv) },
      aesKey,
      asBufferSource(plain),
    ),
  );
  const wrappedKey = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, spki, asBufferSource(aesKeyRaw)),
  );
  if (wrappedKey.byteLength !== RSA_OAEP_WRAPPED_KEY_BYTES) {
    throw new Error(`RSA wrap 长度异常：${wrappedKey.byteLength}`);
  }

  const out = new Uint8Array(wrappedKey.byteLength + iv.byteLength + ciphertext.byteLength);
  out.set(wrappedKey, 0);
  out.set(iv, wrappedKey.byteLength);
  out.set(ciphertext, wrappedKey.byteLength + iv.byteLength);
  return bytesToB64(out);
}

export type BuildOutboundTemplateInput = {
  handle: string;
  email: string;
  worker_a_url: string;
  worker_b_url: string;
  /** Ed25519 公钥 hex（64） */
  pubkey_hex: string;
  /** Ed25519 PKCS8 私钥 hex */
  private_key_hex: string;
  cert_inbound_host: string;
  now_ms?: number;
};

/**
 * 端到端组模板：预生成 challenge_id + nonce → 签名 → 加密 → To/Subject/Body。
 */
export async function buildOutboundEmailTemplate(
  input: BuildOutboundTemplateInput,
): Promise<OutboundEmailTemplate> {
  const nowMs = input.now_ms ?? Date.now();
  const handle = input.handle.trim().toLowerCase().replace(/_/g, '-');
  const email = input.email.trim().toLowerCase();
  const worker_a_url = input.worker_a_url.trim().replace(/\/$/, '');
  const worker_b_url = input.worker_b_url.trim().replace(/\/$/, '');
  if (!handle || !email || !worker_a_url || !worker_b_url) {
    throw new Error('BOOTSTRAP_OUTBOUND_FIELDS_INCOMPLETE');
  }
  if (!/^https:\/\//i.test(worker_a_url) || !/^https:\/\//i.test(worker_b_url)) {
    throw new Error('BOOTSTRAP_OUTBOUND_URL_MUST_HTTPS');
  }

  const challenge_id = newOutboundChallengeId(nowMs);
  const nonce = newOutboundBrowserNonce();
  const issued_at = new Date(nowMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const pubkey = ed25519PubkeyHexToRegistryBase64(input.pubkey_hex);

  const signedMessage = buildOutboundSignedMessage({
    challenge_id,
    handle,
    worker_a_url,
    worker_b_url,
    pubkey,
    email,
    nonce,
    issued_at,
  });
  const signatureHex = await signMessage(signedMessage, input.private_key_hex);
  const signature_b64 = ed25519SignatureHexToRegistryBase64(signatureHex);

  const fields: OutboundPlaintextFields = {
    challenge_id,
    handle,
    worker_a_url,
    worker_b_url,
    pubkey,
    email,
    nonce,
    issued_at,
    signature_b64,
    rsa_key_version: BOOTSTRAP_OUTBOUND_RSA_KEY_VERSION,
  };

  const payload = await encryptOutboundPayload({ fields });
  const tag8 = newOutboundTag8();
  const fingerprint_short = outboundFingerprintShort();
  const to = buildOutboundToAddress(input.cert_inbound_host, tag8);
  const subject = buildOutboundSubject();
  const body = formatOutboundEmailBodyP1b({
    payload,
    browser_nonce: nonce,
    issued_at,
  });

  return {
    to,
    subject,
    body,
    challenge_id,
    browser_nonce: nonce,
    issued_at,
    fingerprint_short,
    tag8,
    claim_token: nonce,
  };
}

/** UI 解锁：§3.0.3 纯函数（F1 刷新重置由调用方负责）。 */
export type OutboundUnlockState = {
  /** 本会话至少 1 次 precheck（成败不论） */
  precheck_count: number;
  /** 网络失败 / 无响应 / HTTP 5xx 计数 */
  failure_count: number;
  /** 最近两次点击「注册」的时间戳（ms）；不足两次则为空 */
  last_two_click_ms: readonly number[];
};

export function isOutboundUiUnlocked(state: OutboundUnlockState, nowMs: number = Date.now()): boolean {
  if (state.precheck_count < 1) return false;
  if (state.failure_count < 2) return false;
  const clicks = state.last_two_click_ms;
  if (clicks.length < 2) return false;
  const [a, b] = clicks.slice(-2) as [number, number];
  if (b - a < 60_000) return false;
  // 防御：最后一次点击不能是「未来」；允许时钟轻微偏差
  if (b > nowMs + 5_000) return false;
  return true;
}

/** 记录一次注册点击；返回新状态。 */
export function recordOutboundRegisterClick(
  prev: OutboundUnlockState,
  clickMs: number,
): OutboundUnlockState {
  const last = [...prev.last_two_click_ms, clickMs].slice(-2);
  return { ...prev, last_two_click_ms: last };
}

export function recordOutboundPrecheck(
  prev: OutboundUnlockState,
  opts: { isTransportOr5xxFailure: boolean },
): OutboundUnlockState {
  return {
    ...prev,
    precheck_count: prev.precheck_count + 1,
    failure_count: prev.failure_count + (opts.isTransportOr5xxFailure ? 1 : 0),
  };
}

export const EMPTY_OUTBOUND_UNLOCK_STATE: OutboundUnlockState = {
  precheck_count: 0,
  failure_count: 0,
  last_two_click_ms: [],
};
