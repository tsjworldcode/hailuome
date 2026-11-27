/**
 * M12-1：TOTP / HOTP（RFC 4226/6238）与恢复码工具。
 * 仅使用 Web Crypto API，兼容 Workers edge runtime。
 */

import { bytesToHex, encodeText } from '@hailuo/shared-utils';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
/** 恢复码字符集：大写无歧义字母数字（不含 0/O/1/I/L）。 */
const RECOVERY_CHARS = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

/** 复制为独立 ArrayBuffer，满足 TS BufferSource 约束。 */
function asBufferSource(bytes: Uint8Array): BufferSource {
  return new Uint8Array(bytes);
}

export type TotpAlgorithm = 'SHA1';

export interface TotpParams {
  readonly period: number;
  readonly digits: number;
  readonly algorithm: TotpAlgorithm;
}

export const DEFAULT_TOTP_PARAMS: TotpParams = {
  period: 30,
  digits: 6,
  algorithm: 'SHA1',
};

export interface VerifyTotpOptions extends TotpParams {
  /** 当前 counter ± window 个 period */
  readonly window?: number;
  /** 已使用的最大 counter；拒绝 counter <= lastUsedCounter 的重放 */
  readonly lastUsedCounter?: number | null;
}

export interface VerifyTotpResult {
  readonly ok: boolean;
  readonly counter?: number;
}

/** RFC 4648 Base32 编码（无 padding）。 */
export function encodeBase32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

/** RFC 4648 Base32 解码；非法字符抛错。 */
export function decodeBase32(input: string): Uint8Array {
  const cleaned = input.replace(/=+$/g, '').replace(/\s+/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of cleaned) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error('INVALID_BASE32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

/** 生成 TOTP secret（默认 20 字节 → Base32）。 */
export function generateTotpSecretBase32(byteLength = 20): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return encodeBase32(bytes);
}

function counterToBytes(counter: number): Uint8Array {
  const buf = new ArrayBuffer(8);
  const view = new DataView(buf);
  const high = Math.floor(counter / 0x100000000);
  const low = counter >>> 0;
  view.setUint32(0, high, false);
  view.setUint32(4, low, false);
  return new Uint8Array(buf);
}

async function hmacSha1(key: Uint8Array, message: Uint8Array): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    asBufferSource(key),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, asBufferSource(message)));
}

function hotpFromHmac(hmac: Uint8Array, digits: number): string {
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const binary =
    ((hmac[offset]! & 0x7f) << 24) |
    ((hmac[offset + 1]! & 0xff) << 16) |
    ((hmac[offset + 2]! & 0xff) << 8) |
    (hmac[offset + 3]! & 0xff);
  const mod = 10 ** digits;
  return (binary % mod).toString().padStart(digits, '0');
}

/** HOTP：counter 为时间步或显式 counter。 */
export async function hotp(
  secretBase32: string,
  counter: number,
  digits = DEFAULT_TOTP_PARAMS.digits,
): Promise<string> {
  const key = decodeBase32(secretBase32);
  const hmac = await hmacSha1(key, counterToBytes(counter));
  return hotpFromHmac(hmac, digits);
}

/** 当前 Unix 时间对应的 TOTP counter。 */
export function totpCounter(nowMs: number, period = DEFAULT_TOTP_PARAMS.period): number {
  return Math.floor(nowMs / 1000 / period);
}

/** 校验 TOTP；成功时返回匹配的 counter。 */
export async function verifyTotp(
  secretBase32: string,
  code: string,
  options: VerifyTotpOptions = DEFAULT_TOTP_PARAMS,
): Promise<VerifyTotpResult> {
  const normalized = code.replace(/\s+/g, '');
  if (!/^\d+$/.test(normalized)) return { ok: false };
  const digits = options.digits ?? DEFAULT_TOTP_PARAMS.digits;
  if (normalized.length !== digits) return { ok: false };

  const window = options.window ?? 1;
  const period = options.period ?? DEFAULT_TOTP_PARAMS.period;
  const nowCounter = totpCounter(Date.now(), period);
  const lastUsed = options.lastUsedCounter ?? null;

  for (let delta = -window; delta <= window; delta++) {
    const candidate = nowCounter + delta;
    if (candidate < 0) continue;
    if (lastUsed !== null && candidate <= lastUsed) continue;
    const expected = await hotp(secretBase32, candidate, digits);
    if (timingSafeEqualString(normalized, expected)) {
      return { ok: true, counter: candidate };
    }
  }
  return { ok: false };
}

export function buildOtpauthUrl(input: {
  readonly secretBase32: string;
  readonly issuer: string;
  readonly label: string;
  readonly period?: number;
  readonly digits?: number;
  readonly algorithm?: TotpAlgorithm;
}): string {
  const issuer = input.issuer.trim() || 'hailuo-node';
  const label = input.label.trim() || issuer;
  const period = input.period ?? DEFAULT_TOTP_PARAMS.period;
  const digits = input.digits ?? DEFAULT_TOTP_PARAMS.digits;
  const algorithm = input.algorithm ?? DEFAULT_TOTP_PARAMS.algorithm;
  const account = `${issuer}:${label}`;
  const params = new URLSearchParams({
    secret: input.secretBase32,
    issuer,
    algorithm,
    digits: String(digits),
    period: String(period),
  });
  return `otpauth://totp/${encodeURIComponent(account)}?${params.toString()}`;
}

function randomRecoverySegment(length: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let out = '';
  for (let i = 0; i < length; i++) {
    out += RECOVERY_CHARS[bytes[i]! % RECOVERY_CHARS.length]!;
  }
  return out;
}

/** 生成 `XXXX-XXXX` 展示格式恢复码。 */
export function generateRecoveryCodes(count = 10): string[] {
  return Array.from({ length: count }, () => {
    const raw = randomRecoverySegment(4) + randomRecoverySegment(4);
    return `${raw.slice(0, 4)}-${raw.slice(4)}`;
  });
}

/** 归一化恢复码：trim、大写、去空格、补连字符。 */
export function normalizeRecoveryCode(raw: string): string | null {
  const compact = raw.trim().toUpperCase().replace(/\s+/g, '').replace(/-/g, '');
  if (!/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$/.test(compact)) return null;
  return `${compact.slice(0, 4)}-${compact.slice(4)}`;
}

export async function hashRecoveryCode(normalizedCode: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encodeText(normalizedCode));
  return bytesToHex(new Uint8Array(digest));
}

export function timingSafeEqualString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/** HKDF 派生 AES-256 密钥，包裹 D1 中的 TOTP secret。 */
async function deriveTotpWrapKey(wrapSecret: string): Promise<Uint8Array> {
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
      info: encodeText('hailuo-totp-wrap-v1'),
    },
    baseKey,
    256,
  );
  return new Uint8Array(bits);
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

/** 用 TOTP_WRAP_SECRET 包裹 Base32 secret，存 D1 `secret_wrapped`。 */
export async function wrapTotpSecret(plaintextBase32: string, wrapSecret: string): Promise<string> {
  const keyBytes = await deriveTotpWrapKey(wrapSecret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aesKey = await crypto.subtle.importKey('raw', asBufferSource(keyBytes), 'AES-GCM', false, ['encrypt']);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: asBufferSource(iv) }, aesKey, encodeText(plaintextBase32));
  return `v1:${bytesToBase64(iv)}:${bytesToBase64(new Uint8Array(ct))}`;
}

/** 解包 D1 中的 wrapped secret。 */
export async function unwrapTotpSecret(wrapped: string, wrapSecret: string): Promise<string> {
  const parts = wrapped.trim().split(':');
  if (parts.length !== 3 || parts[0] !== 'v1') throw new Error('INVALID_WRAP');
  const iv = base64ToBytes(parts[1]!);
  const ct = base64ToBytes(parts[2]!);
  const keyBytes = await deriveTotpWrapKey(wrapSecret);
  const aesKey = await crypto.subtle.importKey('raw', asBufferSource(keyBytes), 'AES-GCM', false, ['decrypt']);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: asBufferSource(iv) }, aesKey, asBufferSource(ct));
  return new TextDecoder().decode(plain);
}
