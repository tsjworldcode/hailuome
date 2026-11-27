/**
 * M9-PH-TA-1：官方主注册中心信任锚（仅公钥，开源钉死）。
 *
 * - 私钥永不进本仓库
 * - 连接 / 落库主中心前须用本公钥验 well-known（M9-PH-TA-2 起强制）
 * - fork 自建联邦须整体替换本锚点，不得冒充官方 reg1
 *
 * 公钥来源（2026-08-21）：
 *   GET https://hailuo-registry.allovo.eu.org/.well-known/hailuo-registry-identity
 *   registry_id=reg1
 */

/** 主中心稳定 ID（与 registry PRIMARY / REGISTRY_ID 对齐）。 */
export const PRIMARY_REGISTRY_ID = 'reg1';

/**
 * 生产主中心 Ed25519 公钥（raw 32 字节，标准 base64）。
 * 轮换密钥须发新版节点（可过渡期双公钥，属后续步）。
 */
export const PRIMARY_TRUST_PUBKEY_B64 = 'YJ0Vrc2UeghkCaW+E+HWkWb+NVInkxvQYIkLTrqI9aE=';

/** 默认引导 URL；仅候选，落库前须过锚点验签。 */
export const PRIMARY_REGISTRY_DEFAULT_URL = 'https://hailuo-registry.allovo.eu.org';

/**
 * 官方主中心历史 workers.dev（well-known 仍可能签此 URL）。
 * fork 自建联邦须整体替换，不得保留官方域名。
 */
export const PRIMARY_REGISTRY_WORKERS_DEV_URL =
  'https://hailuo-registry-registry-gateway-production.jgyw.workers.dev';

/**
 * M9-AUDIT-1：主中心联系 / identity URL 硬编码 allowlist。
 * 禁止「任意自定义域 + 官方 workers.dev identity」过闸（防窃取 node_api_token）。
 */
export const PRIMARY_REGISTRY_CONTACT_ALLOWLIST = [
  PRIMARY_REGISTRY_DEFAULT_URL,
  PRIMARY_REGISTRY_WORKERS_DEV_URL,
] as const;

/** 锚点钉死日（ISO 日期，便于审计 / 文档）。 */
export const PRIMARY_TRUST_ANCHOR_PINNED_AT = '2026-08-21';

/** 是否主中心 registry_id（大小写不敏感）。 */
export function isPrimaryRegistryId(registryId: string): boolean {
  return registryId.trim().toLowerCase() === PRIMARY_REGISTRY_ID;
}

/** contact / identity 是否落在官方 allowlist（去尾斜杠比较）。 */
export function isAllowedPrimaryRegistryUrl(url: string): boolean {
  const normalized = stripTrailingSlash(url);
  if (!normalized) return false;
  return PRIMARY_REGISTRY_CONTACT_ALLOWLIST.some(
    (allowed) => stripTrailingSlash(allowed) === normalized,
  );
}

/**
 * 比较 Ed25519 raw 公钥（忽略空白；标准 / URL-safe base64 均可）。
 * 不做网络请求；供 migrate / directive 校验复用。
 */
export function matchesPrimaryTrustPubkey(pubkeyB64: string): boolean {
  const a = normalizePubkeyB64(pubkeyB64);
  const b = normalizePubkeyB64(PRIMARY_TRUST_PUBKEY_B64);
  return a.length > 0 && a === b;
}

/** M9-PH-TA-2：锚点硬条件失败原因（写入 migrate / Cron 的 reason）。 */
export type PrimaryTrustAnchorRejectReason =
  | 'not_https'
  | 'registry_id_mismatch'
  | 'pubkey_mismatch'
  | 'registry_url_mismatch'
  | 'signature_missing'
  | 'signature_incomplete'
  | 'signature_invalid';

const WORKERS_DEV_HOST_RE = /\.workers\.dev$/i;

function stripTrailingSlash(url: string): string {
  return url.trim().replace(/\/$/, '');
}

function isWorkersDevUrl(url: string): boolean {
  try {
    return WORKERS_DEV_HOST_RE.test(new URL(stripTrailingSlash(url)).hostname);
  } catch {
    return false;
  }
}

/** 候选主中心 URL 必须 https（禁止明文 TOFU）。 */
export function requireHttpsRegistryUrl(url: string): PrimaryTrustAnchorRejectReason | null {
  try {
    const u = new URL(stripTrailingSlash(url));
    if (u.protocol !== 'https:') return 'not_https';
    return null;
  } catch {
    return 'not_https';
  }
}

/**
 * 联系 URL 与 identity.registry_url 是否可接受为同一主中心。
 * M9-AUDIT-1：contact 必须在 allowlist；仅允许「官方 workers.dev identity → 官方自定义域 contact」。
 */
export function registryUrlMatchesContact(
  contactUrl: string,
  identityRegistryUrl: string,
): boolean {
  const contact = stripTrailingSlash(contactUrl);
  const identity = stripTrailingSlash(identityRegistryUrl);
  if (!contact || !identity) return false;
  // 中文注释：任意 HTTPS 自定义域不得借官方签名 identity 过闸
  if (!isAllowedPrimaryRegistryUrl(contact)) return false;
  if (contact === identity) return true;
  // well-known 仍签官方 workers.dev，节点实际连 allowlist 内正式域
  if (
    isAllowedPrimaryRegistryUrl(identity)
    && isWorkersDevUrl(identity)
    && !isWorkersDevUrl(contact)
  ) {
    return true;
  }
  return false;
}

/**
 * 主中心身份硬字段（不含密码学验签）：id / 钉死公钥 / URL / https。
 * 供 challenge/verify 落库与 well-known 路径共用。
 */
export function checkPrimaryTrustAnchorHardFields(
  contactUrl: string,
  identity: { registry_id: string; pubkey: string; registry_url: string },
): PrimaryTrustAnchorRejectReason | null {
  const httpsFail = requireHttpsRegistryUrl(contactUrl);
  if (httpsFail) return httpsFail;
  if (!isPrimaryRegistryId(identity.registry_id)) return 'registry_id_mismatch';
  if (!matchesPrimaryTrustPubkey(identity.pubkey)) return 'pubkey_mismatch';
  if (!registryUrlMatchesContact(contactUrl, identity.registry_url)) {
    return 'registry_url_mismatch';
  }
  return null;
}

/**
 * 主中心 endpoint（通常 registry_endpoints[0]）是否已对齐仓库锚点。
 * directive 验签前必过，堵住「TOFU 假主中心再签假备用」。
 */
export function primaryEndpointReadyForDirectives(
  endpoint: { registry_id: string; trust_pubkey: string },
): { ok: true } | { ok: false; reason: 'trust_anchor_mismatch' } {
  if (!isPrimaryRegistryId(endpoint.registry_id) || !matchesPrimaryTrustPubkey(endpoint.trust_pubkey)) {
    return { ok: false, reason: 'trust_anchor_mismatch' };
  }
  return { ok: true };
}

/**
 * M9-PH-TA-3：禁止用 env 裸写备用注册中心。
 * 已登记后的联邦备用追加：仅主中心签发的 `add_registry`（**不是**未登记开窗）。
 * 未登记接待中心走海螺入口 `active_intake`（M9-PH-BI-6）。
 * 下列变量名若出现在 wrangler / .dev.vars 中一律视为配置错误（运行时不读取）。
 */
export const FORBIDDEN_BARE_BACKUP_REGISTRY_ENV_KEYS = [
  'BACKUP_REGISTRY_URL',
  'BACKUP_REGISTRY_URLS',
  'SECONDARY_REGISTRY_URL',
  'PEER_REGISTRY_URL',
  'REGISTRY_BACKUP_URL',
  'REGISTRY_ENDPOINTS_JSON',
] as const;

function normalizePubkeyB64(raw: string): string {
  return raw.trim().replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
}
