/**
 * HMAC-SHA256 请求签名工具（Web Crypto API）
 * 用途：Worker A 向注册中心上报健康状态时，对请求签名（防重放，窗口 5 分钟 + nonce 唯一）
 *
 * 签名格式（v2，M22-v2-1 后）：
 *   HMAC-SHA256(secret, "<METHOD> <path>\n<unix_sec>:<nonce_hex>:<body>")
 *
 * 请求头：
 *   X-Timestamp: <unix_sec>
 *   X-Nonce: <random_hex_16>
 *   X-Signature: <hmac_hex>
 *
 * v1→v2 变更（M22-v2-1，2026-05-24）：
 *   v1 签名材料 `<ts>:<nonce>:<body>` 不含 method/path，允许 "合法 health 签名重放到 lookup"
 *   跨端点旁路（attacker 拿到一份签名后可重放到任意 4 个端点）。
 *   v2 把 `<METHOD> <path>` 绑进签名材料，攻击者必须为每个端点 × 每个动词 × 每个 query 独立签名。
 *
 * 跨仓同源约束：本文件的 `buildSignatureInputV2()` 必须与 hailuo-registry
 * `workers/registry-gateway/src/lib/hmac.ts.buildSignatureInputV2()` 字节完全一致。
 * 任一侧改了拼串实现，另一侧必须同步发版。
 */

import { bytesToHex, hexToBytes, encodeText, nowSec } from '@hailuo/shared-utils';
import { getCachedKey } from './keyCache';

/**
 * 导入 HMAC-SHA256 请求签名密钥。
 *
 * M5-P2 优化：通过 keyCache 缓存。注意 cacheKey 前缀用 `hmac-req:` 与
 * jwt.ts 的 `jwt-hs256:` 区隔，即便密钥材料相同也走独立缓存槽位
 * （语义边界清晰，便于将来差异化 keyUsages）。
 */
async function importHmacKey(secret: string): Promise<CryptoKey> {
  return getCachedKey(`hmac-req:${secret}`, () =>
    crypto.subtle.importKey(
      'raw',
      encodeText(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign', 'verify'],
    ),
  );
}

function randomNonce(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

/**
 * v2 签名输入串拼装：`<METHOD> <path>\n<timestamp>:<nonce>:<body>`
 *
 * 跨仓同源点：注册中心 `lib/hmac.ts.buildSignatureInputV2()` 必须使用完全相同的拼串实现。
 *
 * 约束：
 *   - `method` 必须大写（'GET' / 'POST' / ...）；调用方负责传入大写形式。
 *   - `path` 必须包含 query string 字面量（如 `/api/posts/feed?since=2026-05-24T06:00:00Z`）；
 *     query string 不做重排序，逐字签名（防 `?since=A` 被改 `?since=B` 重放）。
 *   - METHOD 与 path 之间用单个空格，后续部分用 `\n`（换行符）分隔。
 *   - 空 body（GET 请求）尾部为空字符串：`<METHOD> <path>\n<unix_sec>:<nonce>:`
 */
export function buildSignatureInputV2(
  method: string,
  path: string,
  timestamp: string,
  nonce: string,
  body: string,
): string {
  return `${method} ${path}\n${timestamp}:${nonce}:${body}`;
}

/**
 * Pages Owner Gateway 专用 v3：在 v2 材料末尾追加 `:clientIp`（HMAC 验签通过后才信任 IP）。
 * clientIp 空字符串仍保留尾部分隔符，便于 Pages / Worker A 对齐。
 */
export function buildOwnerGatewaySignatureInput(
  method: string,
  path: string,
  timestamp: string,
  nonce: string,
  body: string,
  clientIp: string,
): string {
  return `${method} ${path}\n${timestamp}:${nonce}:${body}:${clientIp}`;
}

/**
 * 验证 Owner Gateway v3 签名（Worker A 提取可信客户端 IP 用）。
 */
export async function verifyOwnerGatewayRequest(
  meta: SignRequestMeta,
  body: string,
  clientIp: string,
  headers: { timestamp: string; nonce: string; signature: string },
  secret: string,
  windowSec = 300,
): Promise<boolean> {
  try {
    const ts = parseInt(headers.timestamp, 10);
    if (isNaN(ts)) return false;
    const diff = Math.abs(nowSec() - ts);
    if (diff > windowSec) return false;
    const key = await importHmacKey(secret);
    const input = buildOwnerGatewaySignatureInput(
      meta.method,
      meta.path,
      headers.timestamp,
      headers.nonce,
      body,
      clientIp,
    );
    const expected = await crypto.subtle.sign('HMAC', key, encodeText(input));
    const expectedBytes = new Uint8Array(expected);
    const actualBytes = hexToBytes(headers.signature);
    if (expectedBytes.length !== actualBytes.length) return false;
    let diff2 = 0;
    for (let i = 0; i < expectedBytes.length; i++) diff2 |= expectedBytes[i] ^ actualBytes[i];
    return diff2 === 0;
  } catch {
    return false;
  }
}

/** Owner Gateway v3 签名（Pages / Worker B compat 共用）。 */
export async function signOwnerGatewayRequest(
  meta: SignRequestMeta,
  body: string,
  clientIp: string,
  secret: string,
): Promise<SignedRequestHeaders> {
  const timestamp = String(nowSec());
  const nonce = randomNonce();
  const key = await importHmacKey(secret);
  const input = buildOwnerGatewaySignatureInput(
    meta.method,
    meta.path,
    timestamp,
    nonce,
    body,
    clientIp,
  );
  const sig = await crypto.subtle.sign('HMAC', key, encodeText(input));
  return {
    'X-Timestamp': timestamp,
    'X-Nonce': nonce,
    'X-Signature': bytesToHex(new Uint8Array(sig)),
  };
}

export interface SignedRequestHeaders {
  'X-Timestamp': string;
  'X-Nonce': string;
  'X-Signature': string;
}

/**
 * 调用方需要传入的 HTTP 请求元信息（v2 必填）。
 */
export interface SignRequestMeta {
  /** HTTP 动词，调用方负责大写化（'GET' / 'POST'） */
  method: string;
  /** 请求路径 + query string 字面量，不含 scheme/host */
  path: string;
}

/**
 * 为请求签名（v2 含 method/path 绑定），返回需要附加的请求头。
 *
 * @param meta   HTTP 元信息（method + path）。v2 必填，旧 v1 调用方需配套升级。
 * @param body   原始请求体文本；GET / 无 body 时传 `''`。
 * @param secret HMAC_SECRET，由调用方（如 registryFetch）从 env 读取，
 *               生产部署时两仓库同值（≥32 字节 UTF-8）。
 */
export async function signRequest(
  meta: SignRequestMeta,
  body: string,
  secret: string,
): Promise<SignedRequestHeaders> {
  const timestamp = String(nowSec());
  const nonce = randomNonce();
  const key = await importHmacKey(secret);
  const input = buildSignatureInputV2(meta.method, meta.path, timestamp, nonce, body);
  const sig = await crypto.subtle.sign('HMAC', key, encodeText(input));
  return {
    'X-Timestamp': timestamp,
    'X-Nonce': nonce,
    'X-Signature': bytesToHex(new Uint8Array(sig)),
  };
}

/**
 * 验证请求签名（节点本地自测 / 离线工具用；生产验签在注册中心 `lib/hmac.ts`）。
 * windowSec：允许的时间窗口（默认 300 秒 = 5 分钟）。
 *
 * v2：与 signRequest 对称，需传入 `meta: { method, path }`。
 */
export async function verifyRequest(
  meta: SignRequestMeta,
  body: string,
  headers: { timestamp: string; nonce: string; signature: string },
  secret: string,
  windowSec = 300,
): Promise<boolean> {
  try {
    const ts = parseInt(headers.timestamp, 10);
    if (isNaN(ts)) return false;
    // 时间窗口检查（防重放）
    const diff = Math.abs(nowSec() - ts);
    if (diff > windowSec) return false;
    const key = await importHmacKey(secret);
    const input = buildSignatureInputV2(meta.method, meta.path, headers.timestamp, headers.nonce, body);
    const expected = await crypto.subtle.sign('HMAC', key, encodeText(input));
    // 常数时间比较（防时序攻击）
    const expectedBytes = new Uint8Array(expected);
    const actualBytes = hexToBytes(headers.signature);
    if (expectedBytes.length !== actualBytes.length) return false;
    let diff2 = 0;
    for (let i = 0; i < expectedBytes.length; i++) diff2 |= expectedBytes[i] ^ actualBytes[i];
    return diff2 === 0;
  } catch {
    return false;
  }
}
