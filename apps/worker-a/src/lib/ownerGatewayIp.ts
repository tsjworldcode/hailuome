/**
 * M7-30h-4 / M7-30i-1：Owner Gateway（Pages + Worker B compat）经 HMAC v3 注入的可信客户端 IP。
 */
import { verifyOwnerGatewayRequest } from '@hailuo/shared-crypto';
import type { Env } from '../env';
import { getClientIp } from './loginAttempts';

/** 登录/step-up 频控 IP 解析：仅需 header/env，不绑定 Hono Variables。 */
type IpCtx = {
  req: {
    header: (name: string) => string | undefined;
    method: string;
    url: string;
  };
  env: Env;
};

/** Pages Owner Gateway 或 Worker B compat owner-proxy 均走 v3 IP 验签。 */
function isTrustedOwnerGatewayProxy(c: IpCtx): boolean {
  const pages = (c.req.header('X-Hailuo-Pages-Proxy') ?? '').trim();
  const ownerProxy = (c.req.header('X-Hailuo-Owner-Proxy') ?? '').trim();
  return pages === 'owner-gateway' || ownerProxy === 'compat';
}

/**
 * 登录 / step-up 频控用 IP。
 * Owner Gateway 请求在 HMAC v3 + X-Hailuo-Client-Ip 验签通过后采用注入 IP；否则走 CF-Connecting-IP 回落。
 */
export async function resolveTrustedClientIp(c: IpCtx, bodyText: string): Promise<string> {
  if (!isTrustedOwnerGatewayProxy(c)) {
    return getClientIp(c);
  }

  const clientIp = (c.req.header('X-Hailuo-Client-Ip') ?? '').trim();
  const secret = c.env.INTERNAL_FORWARD_SECRET?.trim() ?? '';
  const timestamp = c.req.header('X-Timestamp') ?? '';
  const nonce = c.req.header('X-Nonce') ?? '';
  const signature = c.req.header('X-Signature') ?? '';
  if (!clientIp || !secret || !timestamp || !nonce || !signature) {
    return getClientIp(c);
  }

  const url = new URL(c.req.url);
  const pathWithQuery = `${url.pathname}${url.search}`;
  const ok = await verifyOwnerGatewayRequest(
    { method: c.req.method.toUpperCase(), path: pathWithQuery },
    bodyText,
    clientIp,
    { timestamp, nonce, signature },
    secret,
  );
  return ok ? clientIp : getClientIp(c);
}
