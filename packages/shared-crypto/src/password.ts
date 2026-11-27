/**
 * 站主登录密码哈希（PBKDF2-SHA256）。
 *
 * 架构（M2-1b + Workers Free）：
 *   - **浏览器 / Node 部署脚本**：执行 PBKDF2（默认 200k，耗时在客户端或 seed 时一次性完成）
 *   - **Worker A 边缘**：只做 `comparePasswordHashProof` 常数时间字符串比对，**不跑 PBKDF2**
 *
 * 存储格式：`v1:PBKDF2:<iterations>:SHA256:<saltHex>:<hashHex>`
 *
 * ⚠️ NCF-AUDIT-OR-7 · 🟠 7 跨仓同源：2026-10-13 三仓统一 200,000 次。
 *   旧值 600,000 弃用（node-cf 独有），改为对齐 hailuo-registry + hailuo-bootstrap。
 *   派生路径用 200K：< 200K 走 Web Crypto PBKDF2；= 200K 仍 < 100K 不可能（200K > 100K），
 *   实际必走 @noble/hashes 兜底；与姊妹仓 `WEB_CRYPTO_PBKDF2_MAX_ITERATIONS = 100_000` 语义一致。
 *   旧 600K hash 仍可登录（用 D1 存的 iterations 重新 derive + 同源 comparePasswordHashProof 比对），
 *   但新 seed / 改密一律 200K。
 */

import { pbkdf2 } from '@noble/hashes/pbkdf2';
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex, hexToBytes, encodeText } from '@hailuo/shared-utils';

/** 新凭证默认迭代（跨三仓 200K；BS-OPS-2a.1 已拍 200K）。 */
export const PBKDF2_ITERATIONS = 200_000;

/** Workers Web Crypto PBKDF2 硬上限（仅 Node/浏览器 derive 使用，Worker 不 derive）。 */
export const WEB_CRYPTO_PBKDF2_MAX_ITERATIONS = 100_000;

const SALT_BYTES = 16;
const HASH_BITS = 256;
const VERSION_PREFIX = 'v1';
const ALGO_NAME = 'PBKDF2';
const HASH_NAME = 'SHA256';

/**
 * 用户名不存在时 timing-equalizing dummy（200K，固定 salt；Worker 仅字符串比对）。
 *
 * ⚠️ NCF-AUDIT-OR-7 · 🟠 7 跨仓同源：迭代从 600K 改为 200K（与姊妹仓对齐）；
 *    hash 字节同步重派生（@noble/hashes pbkdf2 sha256, 200000 轮, dkLen 32, salt 固定），
 *    保证三仓 `passwordKdfParamsFromDummyHash()` 给浏览器的 iterations 字段一致。
 *
 *    跨仓一致性：本字面 + PBKDF2_ITERATIONS + WEB_CRYPTO_PBKDF2_MAX_ITERATIONS 必须与
 *    hailuo-registry / hailuo-bootstrap 同名常量同字节，BS-OPS-2a.1 拍板值 = 200K。
 *    改本常量前先看姊妹仓是否同步。
 */
export const DUMMY_PASSWORD_HASH =
  'v1:PBKDF2:200000:SHA256:6f90594d2921c1cab5abcf15947c746b:14ad6fa703ca50ba28f352efa7c58e929b2abfa2c796b991d51056d96347d93f';

export interface ParsedPasswordHash {
  readonly version: string;
  readonly algo: string;
  readonly iterations: number;
  readonly hashName: string;
  readonly saltHex: string;
  readonly hashHex: string;
}

/** 解析 D1 存的全格式 hash 字符串。 */
export function parsePasswordHashString(storedHash: string): ParsedPasswordHash | null {
  const hash = storedHash.trim();
  const parts = hash.split(':');
  if (parts.length !== 6) return null;
  const [version, algo, iterStr, hashName, saltHex, hashHex] = parts;
  const iterations = parseInt(iterStr, 10);
  if (!Number.isFinite(iterations) || iterations < 1) return null;
  if (version !== VERSION_PREFIX || algo !== ALGO_NAME || hashName !== HASH_NAME) return null;
  try {
    const salt = hexToBytes(saltHex);
    const hashBytes = hexToBytes(hashHex);
    if (salt.length === 0 || hashBytes.length === 0) return null;
  } catch {
    return null;
  }
  return { version, algo, iterations, hashName, saltHex, hashHex };
}

/** GET /auth/login-params 响应体（salt + 迭代，供浏览器 derive）。 */
export interface PasswordKdfParams {
  readonly kdf_version: string;
  readonly kdf_algo: string;
  readonly iterations: number;
  readonly hash_name: string;
  readonly salt_hex: string;
}

export function passwordKdfParamsFromStored(storedHash: string): PasswordKdfParams | null {
  const parsed = parsePasswordHashString(storedHash);
  if (!parsed) return null;
  return {
    kdf_version: parsed.version,
    kdf_algo: parsed.algo,
    iterations: parsed.iterations,
    hash_name: parsed.hashName,
    salt_hex: parsed.saltHex,
  };
}

export function passwordKdfParamsFromDummyHash(): PasswordKdfParams {
  const parsed = parsePasswordHashString(DUMMY_PASSWORD_HASH);
  if (!parsed) throw new Error('DUMMY_PASSWORD_HASH invalid');
  return {
    kdf_version: parsed.version,
    kdf_algo: parsed.algo,
    iterations: parsed.iterations,
    hash_name: parsed.hashName,
    salt_hex: parsed.saltHex,
  };
}

/** 组装完整 v1 存储字符串。 */
export function formatPasswordHashString(
  saltHex: string,
  hashHex: string,
  iterations: number = PBKDF2_ITERATIONS,
): string {
  return `${VERSION_PREFIX}:${ALGO_NAME}:${iterations}:${HASH_NAME}:${saltHex}:${hashHex}`;
}

/** PBKDF2-SHA256：≤100k 走 Web Crypto；>100k 走 @noble（浏览器/Node seed；Worker 禁止调用）。 */
async function derivePbkdf2Sha256(
  password: Uint8Array,
  salt: Uint8Array,
  iterations: number,
  dkLenBytes: number,
): Promise<Uint8Array> {
  if (iterations <= WEB_CRYPTO_PBKDF2_MAX_ITERATIONS) {
    const passwordBuf = new Uint8Array(password);
    const saltBuf = new Uint8Array(salt);
    const keyMaterial = await crypto.subtle.importKey(
      'raw',
      passwordBuf,
      { name: 'PBKDF2' },
      false,
      ['deriveBits'],
    );
    const hashBuf = await crypto.subtle.deriveBits(
      {
        name: 'PBKDF2',
        salt: saltBuf,
        iterations,
        hash: 'SHA-256',
      },
      keyMaterial,
      dkLenBytes * 8,
    );
    return new Uint8Array(hashBuf);
  }
  return pbkdf2(sha256, password, salt, { c: iterations, dkLen: dkLenBytes });
}

/**
 * 用已知 salt/iterations 从明文派生完整 v1 hash（浏览器登录 / 改密用）。
 */
export async function derivePasswordHash(
  password: string,
  saltHex: string,
  iterations: number,
): Promise<string> {
  const salt = hexToBytes(saltHex);
  const hashBytes = await derivePbkdf2Sha256(
    encodeText(password),
    salt,
    iterations,
    HASH_BITS / 8,
  );
  return formatPasswordHashString(saltHex, bytesToHex(hashBytes), iterations);
}

/** 部署 seed / owner-bootstrap：随机 salt + 默认 200k。 */
export async function hashPassword(password: string): Promise<string> {
  const salt = new Uint8Array(SALT_BYTES);
  crypto.getRandomValues(salt);
  const saltHex = bytesToHex(salt);
  return derivePasswordHash(password, saltHex, PBKDF2_ITERATIONS);
}

/**
 * Worker 验密：比对客户端提交的完整 v1 字符串与 D1 存值（常数时间，零 PBKDF2 CPU）。
 *
 * 常数时间实现要点：
 * - 长度差通过 `a.length ^ b.length` 编码进 diff 变量，禁止 `if (a.length !== b.length) return false` 提前返回
 * - 循环遍历 `min(a.length, b.length)`；缺失位置等价看作 `0`（charCodeAt 越界返 NaN，统一 XOR 不命中）
 * - 总耗时与字符串长度严格正相关，不随内容差异变化
 *
 * ⚠️ 跨仓一致性：本函数必须与 `hailuo-registry` 的密码 hash 比对**同源**，否则两仓验密行为不一致。
 *    改本函数前先看 `hailuo-registry/.../crypto.ts` `comparePasswordHashProof` 是否同步。
 */
export function comparePasswordHashProof(provided: string, stored: string): boolean {
  const a = provided.trim();
  const b = stored.trim();
  // 长度差编码进 diff：禁止提前返回，否则泄露 hash 长度
  let diff = a.length ^ b.length;
  const len = a.length < b.length ? a.length : b.length;
  for (let i = 0; i < len; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export interface VerifyPasswordMeta {
  readonly ok: boolean;
  readonly ms: number;
  readonly stage: string;
  readonly diag?: VerifyPasswordDiag;
}

export interface VerifyPasswordDiag {
  readonly storedVersion?: string;
  readonly storedIterations?: number;
  readonly storedSaltHex?: string;
  readonly storedExpectedHashHex?: string;
  readonly computedHashHex?: string;
  readonly firstDiffIndex?: number;
}

/** Node 脚本 / 单测：本地 derive 后比对（Worker 生产路径请用 comparePasswordHashProof）。 */
export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  try {
    const parsed = parsePasswordHashString(storedHash);
    if (!parsed) return false;
    const derived = await derivePasswordHash(password, parsed.saltHex, parsed.iterations);
    return comparePasswordHashProof(derived, storedHash);
  } catch {
    return false;
  }
}

export async function verifyPasswordWithMeta(
  password: string,
  storedHash: string,
): Promise<VerifyPasswordMeta> {
  const t0 = Date.now();
  const parsed = parsePasswordHashString(storedHash);
  if (!parsed) {
    return { ok: false, ms: Date.now() - t0, stage: 'parse_parts' };
  }
  try {
    const derived = await derivePasswordHash(password, parsed.saltHex, parsed.iterations);
    const ok = comparePasswordHashProof(derived, storedHash);
    return {
      ok,
      ms: Date.now() - t0,
      stage: ok ? 'ok' : 'mismatch',
      diag: {
        storedVersion: parsed.version,
        storedIterations: parsed.iterations,
        storedSaltHex: parsed.saltHex,
        storedExpectedHashHex: parsed.hashHex,
        computedHashHex: derived.split(':')[5],
        firstDiffIndex: ok ? -1 : 0,
      },
    };
  } catch (e) {
    return {
      ok: false,
      ms: Date.now() - t0,
      stage: `exception:${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/** 校验客户端提交的 new_password_hash 格式（Worker 改密路径）。 */
export function validatePasswordHashFormat(storedHash: string): PasswordStrengthResult {
  const parsed = parsePasswordHashString(storedHash);
  if (!parsed) {
    return { ok: false, reason: 'password_hash 格式无效' };
  }
  if (parsed.hashHex.length !== 64 || parsed.saltHex.length !== 32) {
    return { ok: false, reason: 'password_hash 长度异常' };
  }
  return { ok: true };
}

export interface PasswordStrengthResult {
  readonly ok: boolean;
  readonly reason?: string;
}

/** 站主登录/改密强度：≥ 8 字符，须含字母与数字（不强制符号）。 */
export function checkPasswordStrength(password: string): PasswordStrengthResult {
  if (typeof password !== 'string') {
    return { ok: false, reason: '密码必须是字符串' };
  }
  if (password.length < 8) {
    return { ok: false, reason: '密码长度需 ≥ 8 字符' };
  }
  if (password.length > 256) {
    return { ok: false, reason: '密码长度需 ≤ 256 字符' };
  }
  const hasLetter = /[A-Za-z]/.test(password);
  const hasDigit = /[0-9]/.test(password);
  if (!hasLetter || !hasDigit) {
    return { ok: false, reason: '密码需同时包含字母与数字' };
  }
  return { ok: true };
}
