/**
 * M33-v2：通道 A 自包含收件地址（零 registry 签发 API）。
 * 格式见 hailuo-registry/docs/m33-v2-certification-attempt-plan.md §2
 * M7-39：v3 升级——收件地址嵌入 handle（5 段：`handle10-uid10-nonce10-expB36-mac12`）；
 * MAC 拼串变为 `v3|<handle>|<userId>|<nonce>|<exp>`（含 handle）。
 * 解析时优先 v3（5 段），降级 v2（4 段，handle 不参与 v2 MAC 故不验）。
 */
import { base64urlDecode, bytesToHex, hexToBytes } from '@hailuo/shared-utils';
import { ed25519PrivateKeyPkcs8HexToJwk } from './ed25519';

const VERIFY_PREFIX = 'verify+';
/**
 * v2 老地址分隔符（历史兼容）。v2 仍用 `-`。
 * v3 改用 `.`：handle10 / nonce10 本身允许 `-`，用 `-` 会让 5 段歧义、解析失败。
 */
export const CERT_INBOUND_V2_LOCAL_DELIMITER = '-';
/** v3 分隔符：handle 允许 `-`、nonce 字母表也含 `-`；点号不在这些字段里，5 段无歧义。 */
export const CERT_INBOUND_V3_LOCAL_DELIMITER = '.';
// 邮箱 local-part 在 Cloudflare / 注册中心入站会被转小写；nonce 只生成小写，
// 且 MAC 拼串也按小写计算，避免「签发时大小写混合 → 收信后变小写 → mac_invalid」。
const NONCE_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789_-';
const MAC_LABEL = 'hailuo:cert-inbound-v2:';

export type CertInboundV2Parsed = {
  uid10: string;
  nonce10: string;
  expUnix: number;
  mac12: string;
  host: string;
};

/** M7-39：v3 解析（含 handle 段）。handle 段可能不足 10 字符（短 handle），按整体 trim 后存。 */
export type CertInboundV3Parsed = CertInboundV2Parsed & {
  /** M7-39：v3 新增 handle 段（trim 后小写；与 v2 不兼容）。 */
  handle: string;
};

export async function exportEd25519PublicKeyRawFromPrivate(privateKeyPkcs8Hex: string): Promise<Uint8Array> {
  const jwk = await ed25519PrivateKeyPkcs8HexToJwk(privateKeyPkcs8Hex);
  if (!jwk.x) throw new Error('Ed25519 JWK 缺少公钥 x');
  return base64urlDecode(jwk.x);
}

export async function deriveInboundCertMacKey(pubkeyRaw: Uint8Array): Promise<CryptoKey> {
  const label = new TextEncoder().encode(MAC_LABEL);
  const combined = new Uint8Array(label.length + pubkeyRaw.length);
  combined.set(label);
  combined.set(pubkeyRaw, label.length);
  const hash = await crypto.subtle.digest('SHA-256', combined);
  return crypto.subtle.importKey('raw', hash, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

function randomNonce10(): string {
  const buf = new Uint8Array(10);
  crypto.getRandomValues(buf);
  let out = '';
  for (const b of buf) out += NONCE_ALPHABET[b % NONCE_ALPHABET.length];
  return out;
}

function uidSuffix10(userId: string): string {
  const id = userId.trim();
  if (id.length < 10) throw new Error('user_id 过短，无法生成 uid10');
  return id.slice(-10);
}

/**
 * M7-39：handle 长度归一化到 10 字符 base32 右对齐 + 前缀补 0。
 * handle 全域唯一（议题 7），取后 10 字符（base32-like 字符集）保证段内信息密度；
 * handle 不足 10 字符时整体取（不做 padding——避免歧义；解析端若拿到非 10 字符也接受，trim 校验即可）。
 */
function handleTohandle10(handle: string): string {
  // 中文注释：handle 不限制字符集，trim + 小写后整体取，< 10 字符不补位（解析端对此宽容）；
  // ≥ 10 字符取后 10 字符（保留密度）。不允许空字符串——前置 trim 已经拒过。
  const trimmed = handle.trim().toLowerCase();
  if (!trimmed) throw new Error('handle 为空');
  return trimmed.length >= 10 ? trimmed.slice(-10) : trimmed;
}

function buildMacMessage(userId: string, nonce10: string, expUnix: number): string {
  // 收信端 local-part 已小写；nonce 必须按小写入 MAC，否则混合大小写签发必然 mac_invalid。
  return `v2|${userId}|${nonce10.toLowerCase()}|${expUnix}`;
}

/** M7-39：v3 MAC 拼串含 handle。handle 必须先 trim + 小写；nonce 同样按小写。 */
function buildMacMessageV3(handle: string, userId: string, nonce10: string, expUnix: number): string {
  return `v3|${handle.toLowerCase()}|${userId}|${nonce10.toLowerCase()}|${expUnix}`;
}

export async function computeInboundCertMac12(
  macKey: CryptoKey,
  userId: string,
  nonce10: string,
  expUnix: number,
): Promise<string> {
  const sig = await crypto.subtle.sign(
    'HMAC',
    macKey,
    new TextEncoder().encode(buildMacMessage(userId, nonce10, expUnix)),
  );
  return bytesToHex(new Uint8Array(sig).slice(0, 6));
}

export async function verifyInboundCertMac12(
  macKey: CryptoKey,
  userId: string,
  nonce10: string,
  expUnix: number,
  mac12: string,
): Promise<boolean> {
  const expected = await computeInboundCertMac12(macKey, userId, nonce10, expUnix);
  return expected.toLowerCase() === mac12.trim().toLowerCase();
}

/** 签发 v2 收件地址（节点 Worker A 本地调用）。 */
/** @deprecated M7-39 后改用 `issueInboundCertAddressV3`，v2 仍保留供旧代码读，但不再签发新地址。 */
export async function issueInboundCertAddressV2(params: {
  userId: string;
  certInboundHost: string;
  ttlHours: number;
  privateKeyPkcs8Hex: string;
}): Promise<{
  cert_inbound_address: string;
  cert_inbound_host: string;
  expires_at: string;
  expires_in: number;
  nonce10: string;
}> {
  const host = params.certInboundHost.trim().toLowerCase().replace(/\.$/, '');
  if (!host) throw new Error('cert_inbound_host 为空');

  const pubkeyRaw = await exportEd25519PublicKeyRawFromPrivate(params.privateKeyPkcs8Hex);
  const macKey = await deriveInboundCertMacKey(pubkeyRaw);
  const nonce10 = randomNonce10();
  const ttlMs = Math.max(1, params.ttlHours) * 60 * 60 * 1000;
  const expiresAt = new Date(Date.now() + ttlMs);
  const expUnix = Math.floor(expiresAt.getTime() / 1000);
  const mac12 = await computeInboundCertMac12(macKey, params.userId, nonce10, expUnix);
  const uid10 = uidSuffix10(params.userId);
  const local = [uid10, nonce10, expUnix.toString(36), mac12].join(CERT_INBOUND_V2_LOCAL_DELIMITER);
  const address = `${VERIFY_PREFIX}${local}@${host}`;

  return {
    cert_inbound_address: address,
    cert_inbound_host: host,
    expires_at: expiresAt.toISOString(),
    expires_in: Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000)),
    nonce10,
  };
}

/**
 * M7-39：签发 v3 收件地址（节点 Worker A 本地调用）。
 * v3 local-part：`handle10.uid10.nonce10.expB36.mac12`（点号分段；handle/nonce 自身可含 `-`，点号不会歧义）。
 * MAC 拼串 = `v3|<handle10>|<userId>|<nonce>|<exp>`（与中心验签解析出的 handle10 对齐）。
 */
export async function issueInboundCertAddressV3(params: {
  userId: string;
  handle: string;
  certInboundHost: string;
  ttlHours: number;
  privateKeyPkcs8Hex: string;
}): Promise<{
  cert_inbound_address: string;
  cert_inbound_host: string;
  handle10: string;
  expires_at: string;
  expires_in: number;
  nonce10: string;
}> {
  const host = params.certInboundHost.trim().toLowerCase().replace(/\.$/, '');
  if (!host) throw new Error('cert_inbound_host 为空');
  const handleRaw = params.handle.trim().toLowerCase();
  if (!handleRaw) throw new Error('handle 为空');

  const pubkeyRaw = await exportEd25519PublicKeyRawFromPrivate(params.privateKeyPkcs8Hex);
  const macKey = await deriveInboundCertMacKey(pubkeyRaw);
  const nonce10 = randomNonce10();
  const ttlMs = Math.max(1, params.ttlHours) * 60 * 60 * 1000;
  const expiresAt = new Date(Date.now() + ttlMs);
  const expUnix = Math.floor(expiresAt.getTime() / 1000);
  const uid10 = uidSuffix10(params.userId);
  const handle10 = handleTohandle10(handleRaw);
  // MAC 必须与地址里实际嵌入的 handle10 对齐：中心验签用解析出的 handle10 重算 MAC。
  // 用 full handle 会导致 >10 字符的 handle 全部 mac_invalid。
  const mac12 = await computeInboundCertMac12V3(macKey, handle10, params.userId, nonce10, expUnix);
  // v3 段分隔用 `.`：handle10 可能含 `-`，继续用 `-` 会在解析时拆成 6 段。
  const local = [handle10, uid10, nonce10, expUnix.toString(36), mac12].join(
    CERT_INBOUND_V3_LOCAL_DELIMITER,
  );
  const address = `${VERIFY_PREFIX}${local}@${host}`;

  return {
    cert_inbound_address: address,
    cert_inbound_host: host,
    handle10,
    expires_at: expiresAt.toISOString(),
    expires_in: Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000)),
    nonce10,
  };
}

/** 从收件人地址解析 v2/v3；非 v2/v3 返回 null。v3 优先（有 5 段时强制 v3）。 */
export function parseInboundCertAddressV2(rawRecipient: string): CertInboundV3Parsed | CertInboundV2Parsed | null {
  const trimmed = rawRecipient.trim();
  const angle = trimmed.match(/<([^>]+)>/);
  const addr = (angle ? angle[1] : trimmed).trim();
  const at = addr.lastIndexOf('@');
  if (at <= 0) return null;
  const local = addr.slice(0, at);
  const host = addr.slice(at + 1).toLowerCase();
  if (!local.startsWith(VERIFY_PREFIX)) return null;
  const body = local.slice(VERIFY_PREFIX.length);
  const parts = splitLocalParts(body);
  if (!parts) return null;
  // M7-39：5 段为 v3，4 段为 v2；解析器对 5 段更严格（拒绝把 handle 段当 v2）
  if (parts.length === 5) {
    const [handle, uid10, nonce10, expB36, mac12] = parts;
    if (!handle || !/^[a-z0-9_-]+$/i.test(handle)) return null;
    if (!uid10 || uid10.length !== 10 || !/^[a-z0-9_-]+$/i.test(uid10)) return null;
    if (!nonce10 || nonce10.length !== 10 || !/^[a-z0-9_-]+$/i.test(nonce10)) return null;
    if (!mac12 || mac12.length !== 12 || !/^[0-9a-f]+$/i.test(mac12)) return null;
    const expUnix = Number.parseInt(expB36, 36);
    if (!Number.isFinite(expUnix) || expUnix <= 0) return null;
    return { handle: handle.toLowerCase(), uid10, nonce10, expUnix, mac12, host };
  }
  // v2 fallback
  const [uid10, nonce10, expB36, mac12] = parts;
  if (!uid10 || uid10.length !== 10 || !/^[a-z0-9_-]+$/i.test(uid10)) return null;
  if (!nonce10 || nonce10.length !== 10 || !/^[a-z0-9_-]+$/i.test(nonce10)) return null;
  if (!mac12 || mac12.length !== 12 || !/^[0-9a-f]+$/i.test(mac12)) return null;
  const expUnix = Number.parseInt(expB36, 36);
  if (!Number.isFinite(expUnix) || expUnix <= 0) return null;
  return { uid10, nonce10, expUnix, mac12, host };
}

/**
 * M7-39：v3 解析（强类型）。
 */
export function parseInboundCertAddressV3(rawRecipient: string): CertInboundV3Parsed | null {
  const parsed = parseInboundCertAddressV2(rawRecipient);
  if (!parsed || !('handle' in parsed)) return null;
  return parsed;
}

/** 解析 v2/v3 local-part：v2 用 `-`，v3 新签发用 `.`；两者都兼容，按 4/5 段判定。 */
function splitLocalParts(body: string): [string, string, string, string] | [string, string, string, string, string] | null {
  const byDash = body.split(CERT_INBOUND_V2_LOCAL_DELIMITER);
  if (byDash.length === 4) {
    return byDash as [string, string, string, string];
  }
  if (byDash.length === 5) {
    return byDash as [string, string, string, string, string];
  }
  const byDot = body.split('.');
  if (byDot.length === 4) {
    return byDot as [string, string, string, string];
  }
  if (byDot.length === 5) {
    return byDot as [string, string, string, string, string];
  }
  return null;
}

/** 在逗号分隔收件人列表中找第一个 v2/v3 地址。 */
export function findInboundCertAddressV2InList(rawTo: string): (CertInboundV3Parsed | CertInboundV2Parsed) | null {
  for (const part of rawTo.split(',')) {
    const parsed = parseInboundCertAddressV2(part);
    if (parsed) return parsed;
  }
  return null;
}

/** registry 验签用：从 users.pubkey base64 解析 raw 并派生 MAC 密钥。 */
export async function deriveInboundCertMacKeyFromPubkeyB64(pubkeyB64: string): Promise<CryptoKey> {
  const bytes = decodeBase64Any(pubkeyB64);
  if (bytes.length !== 32) throw new Error('pubkey 长度无效');
  return deriveInboundCertMacKey(bytes);
}

function decodeBase64Any(input: string): Uint8Array {
  const normalized = input.trim().replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

export async function verifyInboundCertForUser(params: {
  pubkeyB64: string;
  userId: string;
  parsed: CertInboundV2Parsed;
}): Promise<boolean> {
  // 邮箱 local-part 入站会被转小写；user_id 的 uid10 后缀可能含大写，比较必须忽略大小写。
  if (!params.userId.toLowerCase().endsWith(params.parsed.uid10.toLowerCase())) return false;
  const macKey = await deriveInboundCertMacKeyFromPubkeyB64(params.pubkeyB64);
  return verifyInboundCertMac12(
    macKey,
    params.userId,
    params.parsed.nonce10,
    params.parsed.expUnix,
    params.parsed.mac12,
  );
}

/** M7-39：v3 MAC 验签——handle 进拼串。handle 比对必须在调用方完成（中心知道该 user 的 handle）。 */
export async function computeInboundCertMac12V3(
  macKey: CryptoKey,
  handle: string,
  userId: string,
  nonce10: string,
  expUnix: number,
): Promise<string> {
  const sig = await crypto.subtle.sign(
    'HMAC',
    macKey,
    new TextEncoder().encode(buildMacMessageV3(handle, userId, nonce10, expUnix)),
  );
  return bytesToHex(new Uint8Array(sig).slice(0, 6));
}

export async function verifyInboundCertMac12V3(
  macKey: CryptoKey,
  handle: string,
  userId: string,
  nonce10: string,
  expUnix: number,
  mac12: string,
): Promise<boolean> {
  const expected = await computeInboundCertMac12V3(macKey, handle, userId, nonce10, expUnix);
  return expected.toLowerCase() === mac12.trim().toLowerCase();
}

/** M7-39：v3 验签——handle 进 MAC + handle10 归属比对（调用方负责把实际 handle 传进来）。 */
export async function verifyInboundCertForUserAndHandle(params: {
  pubkeyB64: string;
  userId: string;
  expectedHandle: string;
  parsed: CertInboundV3Parsed;
}): Promise<boolean> {
  // 中文注释：地址里只嵌入 handle10；expectedHandle 可能更长，先按同一口径取后 10 位再比。
  const expectedRaw = params.expectedHandle.trim().toLowerCase();
  const expected10 = expectedRaw.length >= 10 ? expectedRaw.slice(-10) : expectedRaw;
  if (params.parsed.handle.trim().toLowerCase() !== expected10) {
    return false;
  }
  // 收件地址入站会被转小写，user_id 后缀可能含大写；uid10 比较必须忽略大小写。
  if (!params.userId.toLowerCase().endsWith(params.parsed.uid10.toLowerCase())) return false;
  const macKey = await deriveInboundCertMacKeyFromPubkeyB64(params.pubkeyB64);
  return verifyInboundCertMac12V3(
    macKey,
    params.parsed.handle,
    params.userId,
    params.parsed.nonce10,
    params.parsed.expUnix,
    params.parsed.mac12,
  );
}
