/**
 * M9-24：Owner Gateway 站主路径白名单 SSOT。
 * 数据来自同目录 `owner-gateway-allowlist.json`；Pages Functions 构建时生成 `_owner-allowlist.js`。
 */
import allowlist from '../owner-gateway-allowlist.json';

export type OwnerGatewayExactRule = {
  readonly match: 'exact';
  readonly path: string;
  readonly methods: readonly string[];
};

export type OwnerGatewayPrefixRule = {
  readonly match: 'prefix';
  readonly pathPrefix: string;
  readonly methods: readonly string[];
};

export type OwnerGatewayRule = OwnerGatewayExactRule | OwnerGatewayPrefixRule;

export const OWNER_GATEWAY_RULES = allowlist.ownerRules as readonly OwnerGatewayRule[];

/** Pages Public Gateway：仍转发到 Worker B 的路径前缀。 */
export const PUBLIC_WORKER_B_PREFIXES = allowlist.publicWorkerBPrefixes as readonly string[];

/** Worker B compat owner-proxy 挂载前缀（粗粒度；细粒度仍由 isAllowedOwnerPath 校验）。 */
export const OWNER_GATEWAY_COMPAT_MOUNT_PREFIXES = allowlist.compatMountPrefixes as readonly string[];

/** 站主写层是否允许经 Owner Gateway / compat owner-proxy 转发到 Worker A。 */
export function isAllowedOwnerPath(method: string, pathname: string): boolean {
  const normalizedMethod = method.toUpperCase();
  for (const rule of OWNER_GATEWAY_RULES) {
    if (rule.match === 'exact') {
      if (pathname === rule.path && rule.methods.includes(normalizedMethod)) return true;
      continue;
    }
    if (pathname.startsWith(rule.pathPrefix) && rule.methods.includes(normalizedMethod)) return true;
  }
  return false;
}

/** Public Gateway：是否应转发到 Worker B 公开读层。 */
export function isPublicWorkerBPath(pathname: string): boolean {
  return PUBLIC_WORKER_B_PREFIXES.some((prefix) => {
    // 中文注释：以 / 结尾的前缀（如 /groups/）目录根留给前端静态页，禁止整页相等命中误代理
    if (prefix.endsWith('/')) {
      return pathname.startsWith(prefix) && pathname.length > prefix.length;
    }
    return pathname === prefix || pathname.startsWith(`${prefix}/`);
  });
}
