/**
 * M33-1 / M7-32：登记邮箱白名单 v5 SSOT（与 hailuo-registry email-allowlist-v4.json 同步）。
 *
 * v5 判定（与中心 `checkEmailPolicy` 对齐）：
 *   1. **黑名单优先**（父域链）→ EMAIL_DOMAIN_BLOCKED
 *   2. **白名单命中**（父域链）→ 直接放行
 *   3. **段数 ≥4** → EMAIL_DOMAIN_NOT_ALLOWED
 *   4. **恰好 3 段**：节点本地预检无法读中心开关，默认**放行到中心**由 `single_per_org`（是否允许三级域名）终裁；
 *      避免开关打开后节点误拒。中心关开关时仍会拒。
 *   5. **1～2 段未命中白名单** → EMAIL_DOMAIN_NOT_ALLOWED
 */
import raw from '../email-allowlist-v4.json';

export const EMAIL_ALLOWLIST_VERSION = raw.version as string;

export const REGISTER_EMAIL_DOMAIN_USER_MESSAGE = raw.userMessage as string;

const ALLOWLIST_SET = new Set(
  (raw.allowlist as readonly string[]).map((d) => d.trim().toLowerCase()),
);
const BLOCKLIST_SET = new Set(
  (raw.blocklist as readonly string[]).map((d) => d.trim().toLowerCase()),
);

export function getEmailAllowlistV1DomainCount(): number {
  return ALLOWLIST_SET.size;
}

export function getEmailBlocklistV1DomainCount(): number {
  return raw.blocklist.length;
}

function extractEmailDomain(email: string): string {
  const at = email.lastIndexOf('@');
  if (at < 0) return '';
  return email.slice(at + 1).trim().toLowerCase();
}

/** 生成域名父域链（自身 + 逐级去左段）。 */
export function buildDomainParentChain(domain: string): string[] {
  const parts = domain.split('.').filter(Boolean);
  const chain: string[] = [];
  for (let i = 0; i < parts.length; i += 1) {
    chain.push(parts.slice(i).join('.'));
  }
  return chain;
}

export function domainOrParentInSet(domain: string, set: ReadonlySet<string>): boolean {
  for (const candidate of buildDomainParentChain(domain)) {
    if (set.has(candidate)) return true;
  }
  return false;
}

export function countDomainSegments(domain: string): number {
  return domain.split('.').filter(Boolean).length;
}

/** 段数是否 ≤3（深度辅助；放行逻辑以白名单 + 三级开关为准）。 */
export function isAllowedDomainDepth(domain: string): boolean {
  const n = countDomainSegments(domain);
  return n >= 1 && n <= 3;
}

/** @deprecated 语义为「恰好 3 段」。 */
export function isMultilevelSubdomain(domain: string): boolean {
  return countDomainSegments(domain) === 3;
}

export type RegisterEmailDomainCheck =
  | { ok: true }
  | { ok: false; code: 'EMAIL_DOMAIN_NOT_ALLOWED' | 'EMAIL_DOMAIN_BLOCKED' };

/** 登记域本地预检（v5）。 */
export function checkRegisterEmailDomainV1(email: string): RegisterEmailDomainCheck {
  const domain = extractEmailDomain(email);
  if (!domain) return { ok: false, code: 'EMAIL_DOMAIN_NOT_ALLOWED' };

  // 1. 黑名单优先
  if (domainOrParentInSet(domain, BLOCKLIST_SET)) {
    return { ok: false, code: 'EMAIL_DOMAIN_BLOCKED' };
  }
  // 2. 白名单命中 → 直接放行
  if (domainOrParentInSet(domain, ALLOWLIST_SET)) {
    return { ok: true };
  }

  const segments = countDomainSegments(domain);
  // 3. 四级及以上拒
  if (segments >= 4) {
    return { ok: false, code: 'EMAIL_DOMAIN_NOT_ALLOWED' };
  }
  // 4. 恰好三级：本地放行，由注册中心开关终裁
  if (segments === 3) {
    return { ok: true };
  }
  // 5. 1～2 段未进白名单 → 拒
  return { ok: false, code: 'EMAIL_DOMAIN_NOT_ALLOWED' };
}
