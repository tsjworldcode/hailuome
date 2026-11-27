/**
 * NCF-REG-IP-1：登记预检 / 提交转给注册中心的客户地址。
 * 不落库、不写日志、不放进返回给浏览器的 JSON。
 *
 * 站主网页经 Pages 或 Worker B 时，Worker A 往往没有原来的 CF-Connecting-IP。
 * 入口已把该地址放进验签过的 X-Hailuo-Client-Ip。直连 Worker A 时只用本次 CF-Connecting-IP。
 * 不用 X-Forwarded-For，不用 unknown，不编造。
 */
import { verifyOwnerGatewayRequest } from '@hailuo/shared-crypto';
import type { Env } from '../env';

export const HAILUO_CLIENT_IP_HEADER = 'X-Hailuo-Client-Ip';

/** 单个 IP 文本上限。更长的不当地址，避免截断后变成另一个地址。 */
const MAX_CLIENT_IP_HEADER_LEN = 128;

type ForwardIpCtx = {
  req: {
    header: (name: string) => string | undefined;
    method: string;
    url: string;
  };
  env: Env;
};

/** 能放进单个请求头才原样返回。空、unknown、换行、空白、过长都丢掉。 */
export function headerSafeClientIp(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!value || value === 'unknown') return null;
  if (value.length > MAX_CLIENT_IP_HEADER_LEN) return null;
  if (/[\u0000-\u001F\u007F]/.test(value) || /\s/.test(value)) return null;
  return value;
}

/** 没有合法地址时返回空对象，调用方不带头。 */
export function hailuoClientIpHeaders(ip: string | null): Record<string, string> {
  const safe = headerSafeClientIp(ip);
  if (!safe) return {};
  return { [HAILUO_CLIENT_IP_HEADER]: safe };
}

function isOwnerGatewayForward(c: ForwardIpCtx): boolean {
  const pages = (c.req.header('X-Hailuo-Pages-Proxy') ?? '').trim();
  const ownerProxy = (c.req.header('X-Hailuo-Owner-Proxy') ?? '').trim();
  return pages === 'owner-gateway' || ownerProxy === 'compat';
}

/**
 * 本次预检或提交要带给注册中心的地址。
 * bodyText 必须是验签时的原始正文，不能用 JSON.stringify 重排。
 */
export async function readRegistrationForwardClientIp(
  c: ForwardIpCtx,
  bodyText: string,
): Promise<string | null> {
  const direct = headerSafeClientIp(c.req.header('CF-Connecting-IP'));
  if (!isOwnerGatewayForward(c)) return direct;

  const injected = headerSafeClientIp(c.req.header(HAILUO_CLIENT_IP_HEADER));
  if (!injected) return direct;

  const secret = c.env.INTERNAL_FORWARD_SECRET?.trim() ?? '';
  const timestamp = c.req.header('X-Timestamp') ?? '';
  const nonce = c.req.header('X-Nonce') ?? '';
  const signature = c.req.header('X-Signature') ?? '';
  if (!secret || !timestamp || !nonce || !signature) return direct;

  const url = new URL(c.req.url);
  const ok = await verifyOwnerGatewayRequest(
    { method: c.req.method.toUpperCase(), path: `${url.pathname}${url.search}` },
    bodyText,
    injected,
    { timestamp, nonce, signature },
    secret,
  );
  return ok ? injected : direct;
}
