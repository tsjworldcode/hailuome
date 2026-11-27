/**
 * JWT HS256 工具（Web Crypto API HMAC-SHA256）
 * 用途：Worker A 为节点所有者签发登录 JWT
 */

import { base64urlEncode, base64urlDecode, encodeText, nowSec } from '@hailuo/shared-utils';
import type { OwnerJwtPayload } from '@hailuo/shared-types';
import { getCachedKey } from './keyCache';

const HS256_HEADER = base64urlEncode(encodeText(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));

/**
 * 导入 HMAC-SHA256 验签密钥。
 *
 * M5-P2 优化：通过 keyCache 缓存 CryptoKey，避免每次 sign/verify 都重做
 * importKey（单次约 0.5–2ms CPU）。同 isolate 内同一 secret 只 import 一次。
 */
async function importHmacKey(secret: string): Promise<CryptoKey> {
  return getCachedKey(`jwt-hs256:${secret}`, () =>
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
 * 签发所有者 JWT（Worker A 登录接口使用）
 */
export async function signOwnerJWT(
  handle: string,
  secret: string,
  ttlSec = 86400,  // 默认 24h
  options?: { ownerUsername?: string },
): Promise<string> {
  const payload: OwnerJwtPayload = {
    sub: handle,
    iat: nowSec(),
    exp: nowSec() + ttlSec,
    ...(options?.ownerUsername ? { oun: options.ownerUsername } : {}),
  };
  const payloadPart = base64urlEncode(encodeText(JSON.stringify(payload)));
  const key = await importHmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, encodeText(`${HS256_HEADER}.${payloadPart}`));
  return `${HS256_HEADER}.${payloadPart}.${base64urlEncode(sig)}`;
}

/**
 * 验证所有者 JWT（Worker A 鉴权中间件使用）
 * 返回 payload 或 null（验签失败/已过期）
 */
export async function verifyOwnerJWT(
  token: string,
  secret: string,
): Promise<OwnerJwtPayload | null> {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [header, payloadB64, sigB64] = parts;
    const key = await importHmacKey(secret);
    const valid = await crypto.subtle.verify(
      'HMAC',
      key,
      base64urlDecode(sigB64),
      encodeText(`${header}.${payloadB64}`),
    );
    if (!valid) return null;
    const payload = JSON.parse(new TextDecoder().decode(base64urlDecode(payloadB64))) as OwnerJwtPayload;
    if (payload.exp < nowSec()) return null;
    return payload;
  } catch {
    return null;
  }
}
