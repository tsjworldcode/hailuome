/**
 * SEC-AUDIT-2026-10-6a · 媒体票据（MEDIA-TICKET-1）。
 *
 * 【为什么需要】
 *   浏览器 `<img src>` 无法携带 `Authorization` 头。若 Worker B 处于 protected 档
 *   （`following-only` / `mutual-only`），`GET /img/:key` 必须带粉丝 Token，
 *   纯 `<img>` 直连会被 401 拒绝（前端只能 JS fetch → Blob，代价大且易白屏）。
 *
 * 【形状】
 *   ticket = `base64url(payloadJson)` + `.` + `base64url(HMAC-SHA256(secret, payloadB64))`
 *   payload = `{ v, k, s, exp, jti }`
 *     - `v`：版本（当前 1）
 *     - `k`：绑定的**单个** storage key（`kv:` / `r2:` / `b2:` / `filebase:` 前缀）
 *     - `s`：签发时的请求者标识（粉丝节点 URL），**仅审计用**
 *     - `exp`：过期时间（Unix 秒），TTL 见 `MEDIA_TICKET_TTL_SEC`
 *     - `jti`：随机 nonce，避免同秒同 key 产生完全相同的票据
 *
 * 【安全边界（务必随实现同步文档）】
 *   1. 票据**绑定单个 storage key**：不能拿 A 图的票去读 B 图（横向复用被拒）。
 *   2. 票据**只在 `GET /img/:key` 生效**：其它端点不解析票据参数。
 *   3. TTL 很短（60s）：过期即废，无法长期囤积。
 *   4. 密钥**独立**：`MEDIA_TICKET_SECRET` 与 `INTERNAL_FORWARD_SECRET` /
 *      `JWT_SECRET` / `HMAC_SECRET` 不得复用——票据会出现在 URL 里，
 *      复用其它密钥等于把那些通道的泄露面一并扩大。
 *   5. ⚠️ **请求者绑定在纯 `<img>` 直连场景不可验证**：`<img>` 不带身份，
 *      浏览器也不会替我们附加。因此 `s` 只能作为签发时的审计线索，
 *      不能当作「只有原请求者能用此票」的强制约束。真正的请求者级隔离依赖
 *      protected 档下的 `Authorization` 路径（见 docs/worker-b-api.md）。
 *
 * 【跨 Worker 说明】
 *   票据由**被访问方（源站）Worker B** 自行签发并自行校验，`MEDIA_TICKET_SECRET`
 *   只存在于该 Worker B；不经过 Worker A，也不需要跨 Worker 同步 secret。
 */

import { base64urlDecode, base64urlEncode, bytesToHex, encodeText, nowSec, randomNonceHex } from '@hailuo/shared-utils';
import { getCachedKey } from './keyCache';

/** 票据 TTL（秒）：短到无法囤积，长到足够一次页面渲染批量取图。 */
export const MEDIA_TICKET_TTL_SEC = 60;

/** 票据版本号（字段升级时 +1，验签侧同时拒绝旧版本）。 */
export const MEDIA_TICKET_VERSION = 1;

/** 票据 payload（未签名部分）。 */
export interface MediaTicketPayload {
  /** 版本 */
  v: number;
  /** 绑定的单个 storage key */
  k: string;
  /** 签发时的请求者标识（粉丝节点 URL），仅审计用 */
  s: string;
  /** 过期时间（Unix 秒） */
  exp: number;
  /** 随机 nonce */
  jti: string;
}

/** 验签失败原因（供 Worker B 映射错误码；不携带任何票据原文）。 */
export type MediaTicketFailure =
  | 'missing'
  | 'malformed'
  | 'version_mismatch'
  | 'bad_signature'
  | 'expired'
  | 'key_mismatch';

export type MediaTicketVerifyResult =
  | { ok: true; payload: MediaTicketPayload }
  | { ok: false; reason: MediaTicketFailure };

/**
 * 导入 HMAC-SHA256 票据签名密钥。
 *
 * ⚠️ 缓存槽位前缀用 `media-ticket-hmac:`，与 `hmac-req:`（请求签名）、
 * `jwt-hs256:`（登录 JWT）**区隔**：即使运维误把同一串材料填进多个 secret，
 * 缓存槽位也不会互相污染，且语义边界清晰。
 */
async function importMediaTicketKey(secret: string): Promise<CryptoKey> {
  return getCachedKey(`media-ticket-hmac:${secret}`, () =>
    crypto.subtle.importKey(
      'raw',
      encodeText(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign', 'verify'],
    ),
  );
}

/**
 * 签名输入串：`MEDIA_TICKET_V1\n<payloadBase64url>`
 *
 * 带版本域前缀，避免未来其它协议不小心复用同一密钥时产生跨协议签名复用。
 */
export function buildMediaTicketSignatureInput(payloadBase64Url: string): string {
  return `MEDIA_TICKET_V1\n${payloadBase64Url}`;
}

/** 构造未签名 payload（调用方自行决定 `s` 与 `exp`）。 */
export function buildMediaTicketPayload(input: {
  storageKey: string;
  requesterSub?: string;
  ttlSec?: number;
  now?: number;
}): MediaTicketPayload {
  const now = input.now ?? nowSec();
  const ttl = input.ttlSec ?? MEDIA_TICKET_TTL_SEC;
  return {
    v: MEDIA_TICKET_VERSION,
    k: input.storageKey,
    s: (input.requesterSub ?? '').trim(),
    exp: now + ttl,
    jti: randomNonceHex(16),
  };
}

/** 签发票据：返回 `payloadB64.signatureB64`。 */
export async function signMediaTicket(
  payload: MediaTicketPayload,
  secret: string,
): Promise<string> {
  const payloadB64 = base64urlEncode(encodeText(JSON.stringify(payload)));
  const key = await importMediaTicketKey(secret);
  const sig = await crypto.subtle.sign(
    'HMAC',
    key,
    encodeText(buildMediaTicketSignatureInput(payloadB64)),
  );
  return `${payloadB64}.${base64urlEncode(new Uint8Array(sig))}`;
}

/**
 * 校验票据。
 *
 * @param ticket 票据原文（来自 query）
 * @param secret `MEDIA_TICKET_SECRET`
 * @param expectedStorageKey 期望的 storage key；传 `null` 表示只验签不校验 key
 *                            （Worker B 侧应始终传当前 path 的 key）
 */
export async function verifyMediaTicket(
  ticket: string | null | undefined,
  secret: string,
  expectedStorageKey: string | null,
  now?: number,
): Promise<MediaTicketVerifyResult> {
  if (!ticket || typeof ticket !== 'string') {
    return { ok: false, reason: 'missing' };
  }
  const dot = ticket.indexOf('.');
  if (dot <= 0 || dot === ticket.length - 1) {
    return { ok: false, reason: 'malformed' };
  }
  const payloadB64 = ticket.slice(0, dot);
  const sigPart = ticket.slice(dot + 1);

  let payload: MediaTicketPayload;
  let payloadBytes: Uint8Array;
  let sigBytes: Uint8Array;
  try {
    payloadBytes = base64urlDecode(payloadB64);
    sigBytes = base64urlDecode(sigPart);
    const parsed: unknown = JSON.parse(new TextDecoder().decode(payloadBytes));
    if (!parsed || typeof parsed !== 'object') {
      return { ok: false, reason: 'malformed' };
    }
    const o = parsed as Record<string, unknown>;
    if (
      typeof o.v !== 'number' ||
      typeof o.k !== 'string' ||
      typeof o.s !== 'string' ||
      typeof o.exp !== 'number' ||
      typeof o.jti !== 'string'
    ) {
      return { ok: false, reason: 'malformed' };
    }
    payload = {
      v: o.v,
      k: o.k,
      s: o.s,
      exp: o.exp,
      jti: o.jti,
    };
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  if (payload.v !== MEDIA_TICKET_VERSION) {
    return { ok: false, reason: 'version_mismatch' };
  }

  // 验签（HMAC 自带恒定时间比较）
  let sigOk = false;
  try {
    const key = await importMediaTicketKey(secret);
    sigOk = await crypto.subtle.verify(
      'HMAC',
      key,
      // ⚠️ 复制到独立 ArrayBuffer：web 侧 TS 的 lib 类型更严（`Uint8Array<ArrayBufferLike>` 不可直接当 BufferSource）
      new Uint8Array(sigBytes),
      encodeText(buildMediaTicketSignatureInput(payloadB64)),
    );
  } catch {
    sigOk = false;
  }
  if (!sigOk) {
    return { ok: false, reason: 'bad_signature' };
  }

  const current = now ?? nowSec();
  if (payload.exp <= current) {
    return { ok: false, reason: 'expired' };
  }

  if (expectedStorageKey !== null && payload.k !== expectedStorageKey) {
    return { ok: false, reason: 'key_mismatch' };
  }

  return { ok: true, payload };
}

/** 票据摘要（仅供日志/审计，**不得**打印票据原文或完整签名）。 */
export function describeMediaTicketForAudit(payload: MediaTicketPayload): string {
  return `k=${payload.k} exp=${payload.exp} jti=${payload.jti}`;
}

/** 票据签名的十六进制摘要（供契约测试比对，勿用于日志）。 */
export function mediaTicketSignatureHex(ticket: string): string {
  const dot = ticket.indexOf('.');
  if (dot <= 0) return '';
  try {
    return bytesToHex(base64urlDecode(ticket.slice(dot + 1)));
  } catch {
    return '';
  }
}
