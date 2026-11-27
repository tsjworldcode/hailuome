/**
 * M17 · 加好友跨节点 envelope（sign / verify + body SHA-256）。
 *
 * 计划 §5.4 定稿（与 M10-2 / M16-1c Ed25519 跨节点签名同口径，但不沿用 M9-19
 * `HAILUO_INTERACTION_V1` 拼串 — 加好友的签名输入含 method/path/ts/nonce/body_sha256）。
 *
 * 拼串（UTF-8，换行分隔）：
 *   HAILUO_FRIEND_REQUEST_V1
 *   {method}
 *   {path}
 *   {ts}
 *   {nonce}
 *   {body_sha256_hex}
 *
 * 签名：Ed25519.sign(privateKey, payload)；验签用 envelope 自带的 actor.pubkey
 * （M9-19 同模式；与 plan §六.1 第 6 步 / §六.2 第 7 步"用对端 users.pubkey 验签"一致）。
 *
 * 路径 / 方法：method + path 必须与 HTTP 请求一致（与 HMAC v2 buildSignatureInputV2
 * 同样含 method/path 绑定，防重放到错误端点）。
 *
 * 不放在 shared-crypto 的原因：拼串格式仅在 Worker A 内部使用，不跨仓同步；
 * 保持单仓依赖，路由层（M17-1d）一行 import 即可。
 */

import { bytesToHex, hexToBytes, isoToSec } from '@hailuo/shared-utils';

// ---- 常量（计划 §5.4 + §六.4） ---------------------------------------

/** envelope 前缀（与 M9-19 HAILUO_INTERACTION_V1 / DM HAILUO_DM_V1 等并列）。 */
export const FRIEND_REQUEST_ENVELOPE_PREFIX = 'HAILUO_FRIEND_REQUEST_V1';

/** 签名时间窗口（5 分钟），与 HMAC v2 验签同窗口。 */
export const FRIEND_REQUEST_ENVELOPE_WINDOW_SEC = 300;

/** Ed25519 sig hex 长度（64 字节 = 128 hex 字符），用于 rawBody 占位对齐长度。 */
export const FRIEND_REQUEST_SIG_HEX_LENGTH = 128;

/**
 * rawBody 中 sig 占位（与真实 sig 等长）。
 * 发送方先用占位 body 计算 SHA-256 再签名；接收方必须重建同一占位 body 复算，
 * 不能直接对含真实 sig 的 final body 取 hash，否则签名必然验不过。
 */
export const FRIEND_REQUEST_SIG_PLACEHOLDER = '0'.repeat(FRIEND_REQUEST_SIG_HEX_LENGTH);

/** 错误码（plan §5.6 + §六.4 收口；lib 内部用，路由层映射 HTTP 状态）。 */
export type FriendRequestEnvelopeErrorCode =
  | 'FRIEND_REQUEST_INVALID_SIG'
  | 'FRIEND_REQUEST_SIGNATURE_EXPIRED'
  | 'FRIEND_REQUEST_INVALID_PARAMS';

// ---- envelope 输入拼串（纯函数） ------------------------------------

/**
 * envelope 签名输入串拼装。
 * - `method` 必须大写（'POST'）；调用方负责传入大写形式。
 * - `path` 包含 query string 字面量（如 '/friend-requests/inbox?extra=1'）；
 *   不做重排序，逐字签名。
 * - method/path 与第一个 `\n` 之间用单个空格；后续部分用 `\n`（换行符）分隔。
 * - 空 body SHA-256 也是 64 hex 字符（不是空串），由 computeFriendRequestBodySha256Hex 保证。
 */
export function buildFriendRequestEnvelopeSigningInput(
  method: string,
  path: string,
  ts: string,
  nonce: string,
  bodySha256Hex: string,
): string {
  return `${FRIEND_REQUEST_ENVELOPE_PREFIX}\n${method} ${path}\n${ts}\n${nonce}\n${bodySha256Hex}`;
}

/**
 * 计算 raw body 的 SHA-256 hex（64 字符小写）。
 * envelope 签名输入的最后一段必须用此值，禁止传其它 hash（防 hash 算法漂移）。
 */
export async function computeFriendRequestBodySha256Hex(rawBody: string): Promise<string> {
  const bytes = new TextEncoder().encode(rawBody);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return bytesToHex(new Uint8Array(digest));
}

/**
 * 接收方重建发送方签名时的占位 body（sig = 128 个 0）。
 *
 * 发送方 `JSON.stringify(placeholderEnvelope)` 时 sig 是最后一个字段；
 * 这里对解析后的对象直接覆盖 sig，保留原 key 顺序，得到的字节与发送方占位 body 一致。
 * 返回 null 表示入参不是普通对象（调用方映射 INVALID_PARAMS）。
 */
export function buildFriendRequestPlaceholderRawBody(parsedJson: unknown): string | null {
  if (!parsedJson || typeof parsedJson !== 'object' || Array.isArray(parsedJson)) return null;
  return JSON.stringify({ ...(parsedJson as Record<string, unknown>), sig: FRIEND_REQUEST_SIG_PLACEHOLDER });
}

// ---- Ed25519 sign / verify（Web Crypto API） -----------------------

/**
 * 用 Ed25519 私钥（PKCS8 hex）对 UTF-8 payload 签名，返回 hex 签名。
 * 调用方负责构造 payload（buildFriendRequestEnvelopeSigningInput + body SHA-256）。
 *
 * privateKeyPkcs8Hex：env.ED25519_PRIVATE_KEY（PKCS8 hex 字符串）。
 */
export async function signFriendRequestEnvelope(
  payload: string,
  privateKeyPkcs8Hex: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    'pkcs8',
    hexToBytes(privateKeyPkcs8Hex.trim()),
    { name: 'Ed25519' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('Ed25519', key, new TextEncoder().encode(payload));
  return bytesToHex(new Uint8Array(sig));
}

/**
 * 用 Ed25519 公钥（raw hex 64 字符）对 UTF-8 payload 验签。
 * 任一参数格式错误 / verify 失败 → 返回 false（不抛异常，路由层映射 FRIEND_REQUEST_INVALID_SIG）。
 */
export async function verifyFriendRequestEnvelope(
  payload: string,
  sigHex: string,
  publicKeyRawHex: string,
): Promise<boolean> {
  try {
    if (!publicKeyRawHex || publicKeyRawHex.length !== 64) return false;
    const key = await crypto.subtle.importKey(
      'raw',
      hexToBytes(publicKeyRawHex),
      { name: 'Ed25519' },
      false,
      ['verify'],
    );
    return await crypto.subtle.verify('Ed25519', key, hexToBytes(sigHex), new TextEncoder().encode(payload));
  } catch {
    return false;
  }
}

// ---- 时间窗口校验（纯函数） -----------------------------------------

/** ISO 8601 → unix sec；格式错误返 null。 */
function parseIsoSec(raw: string): number | null {
  if (!raw) return null;
  // inbox body 的 ts 是 unix sec 字符串（与 HMAC v2 ts 同口径），不是 ISO
  const asNumber = Number(raw);
  if (Number.isFinite(asNumber) && asNumber > 0) return Math.floor(asNumber);
  // 兜底：允许 ISO 字符串（兼容旧实现）
  return isoToSec(raw);
}

/**
 * 校验 envelope 时间窗口（±FRIEND_REQUEST_ENVELOPE_WINDOW_SEC）。
 * 返回 ok / 错误码（不含 message，路由层负责映射中文文案）。
 */
export function checkFriendRequestEnvelopeWindow(
  ts: string,
  now: Date = new Date(),
): { ok: true } | { ok: false; error_code: FriendRequestEnvelopeErrorCode } {
  const sec = parseIsoSec(ts);
  if (sec === null) {
    return { ok: false, error_code: 'FRIEND_REQUEST_INVALID_SIG' };
  }
  const nowSecVal = Math.floor(now.getTime() / 1000);
  if (Math.abs(nowSecVal - sec) > FRIEND_REQUEST_ENVELOPE_WINDOW_SEC) {
    return { ok: false, error_code: 'FRIEND_REQUEST_SIGNATURE_EXPIRED' };
  }
  return { ok: true };
}
