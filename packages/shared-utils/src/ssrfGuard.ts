/**
 * M-OPT-9 同款：节点出站 fetch 的 SSRF 门禁（与 hailuo-registry ssrfGuard 语义对齐）。
 * Workers 无法在 connect 前 DNS 再校验；拦截明显私网/环回/元数据目标。
 * 本地联调：`PROOF_ALLOW_PRIVATE_TARGETS=true` 放行私网（默认关）。
 */

export type SsrfGuardResult =
  | { ok: true; url: URL }
  | { ok: false; reason: string };

const BLOCKED_HOST_EXACT = new Set([
  'localhost',
  'localhost.localdomain',
  'metadata.google.internal',
  'metadata',
  'kubernetes.default',
  'kubernetes.default.svc',
]);

/** 允许私网目标（仅本地/测试）。env 可为 Worker Bindings。 */
export function isPrivateProofTargetAllowed(env?: unknown): boolean {
  if (!env || typeof env !== 'object') return false;
  const raw = (env as Record<string, unknown>).PROOF_ALLOW_PRIVATE_TARGETS;
  const v = (typeof raw === 'string' ? raw : 'false').trim().toLowerCase();
  return v === 'true' || v === '1' || v === 'on' || v === 'yes';
}

function isIpv4Literal(host: string): boolean {
  return /^(?:\d{1,3}\.){3}\d{1,3}$/.test(host);
}

/** 私网 / 环回 / 链路本地 / CGNAT / 组播等保留 IPv4。 */
export function isBlockedIpv4(ip: string): boolean {
  const parts = ip.split('.').map((p) => Number(p));
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    return true;
  }
  const [a, b] = parts;
  if (a === 0) return true;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a >= 224) return true;
  return false;
}

/** 私网 / 环回 / ULA / 链路本地等 IPv6（含 IPv4-mapped）。 */
export function isBlockedIpv6(raw: string): boolean {
  const host = raw.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === '::' || host === '::1') return true;
  if (host.startsWith('fe80:')) return true;
  if (host.startsWith('fc') || host.startsWith('fd')) return true;
  if (host.startsWith('ff')) return true;
  const mapped = host.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped) return isBlockedIpv4(mapped[1]!);
  return false;
}

function hostnameBlocked(hostname: string): string | null {
  const host = hostname.trim().toLowerCase().replace(/\.$/, '');
  if (!host) return 'empty hostname';
  if (BLOCKED_HOST_EXACT.has(host)) return `blocked hostname: ${host}`;
  if (host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    return `blocked hostname suffix: ${host}`;
  }
  if (isIpv4Literal(host)) {
    return isBlockedIpv4(host) ? `blocked private/reserved IPv4: ${host}` : null;
  }
  if (host.includes(':')) {
    return isBlockedIpv6(host) ? `blocked private/reserved IPv6: ${host}` : null;
  }
  return null;
}

/** HTTPS 公共 URL 允许的端口白名单；与 hailuo-registry ssrfGuard 同源（`443/8443/8080/8000`）。
 *  - 443：标准 HTTPS
 *  - 8443：HTTPS 替代端口
 *  - 8080：HTTP 替代端口（HTTPS 反代常见）
 *  - 8000：开发 / 内网服务常用 HTTPS 端口
 *  跨仓一致性：必须与 `hailuo-registry/.../ssrfGuard.ts` 的端口集合**字面相同**；
 *  一侧加白名单时同步另一侧，否则两仓 SSRF 行为不一致。 */
export const ALLOWED_HTTPS_PORTS: ReadonlySet<string> = new Set([
  '443',
  '8443',
  '8080',
  '8000',
]);

/**
 * 校验可被节点主动回访的 HTTPS 公共 URL。
 * - 仅 https；端口缺省 / 在白名单内（`443/8443/8080/8000`）
 * - 禁止 userinfo
 * - 禁止明显私网/环回/元数据主机名与字面量 IP
 */
export function assertSafeOutboundHttpsUrl(
  raw: string,
  opts?: { allowPrivate?: boolean },
): SsrfGuardResult {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'not a valid URL' };
  }

  if (url.protocol !== 'https:') {
    return { ok: false, reason: 'must use https:// scheme' };
  }
  if (url.username || url.password) {
    return { ok: false, reason: 'userinfo not allowed' };
  }
  if (url.port && !ALLOWED_HTTPS_PORTS.has(url.port)) {
    return {
      ok: false,
      reason: `port ${url.port} not allowed (allowed: ${[...ALLOWED_HTTPS_PORTS].join('/')})`,
    };
  }

  if (!opts?.allowPrivate) {
    const blocked = hostnameBlocked(url.hostname);
    if (blocked) return { ok: false, reason: blocked };
  }

  return { ok: true, url };
}

/**
 * SEC-AUDIT-2026-10：对端 Worker B URL 边界断言（写库前 fail-closed / 出站前 fail-soft）。
 * 语义同 `assertSafeOutboundHttpsUrl`；命名强调 peer Worker B 场景。
 * **不**改 `normalize*` 纯函数（比对 / 签名 / 排序仍走 trim+去尾斜杠）。
 */
export function assertSafePeerWorkerBUrl(
  raw: string,
  opts?: { allowPrivate?: boolean },
): SsrfGuardResult {
  return assertSafeOutboundHttpsUrl(raw, opts);
}

/** 日志用脱敏 host（禁止打完整出站 URL，对齐 12-anti-deanonymization）。 */
export function redactOutboundUrlHost(raw: string): string {
  try {
    return new URL(raw).host;
  } catch {
    return '(invalid)';
  }
}
