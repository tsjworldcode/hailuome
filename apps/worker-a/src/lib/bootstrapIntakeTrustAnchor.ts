/**
 * 海螺入口（bootstrap intake）信任锚 — 仅公钥 + URL 候选 + 公钥版本号（开源钉死）。
 *
 * - 入口公钥 **与** 主中心 `PRIMARY_TRUST_PUBKEY_B64` **永久分离**（防「签了但换钥」叙事混用）
 * - 私钥永不进本仓库；权威签发属 `hailuo-bootstrap` 运营面（admin secret）
 * - 主中心锚点仍作入口不可达时的回落（见 `primaryRegistryTrustAnchor.ts`）
 * - 旧 BD「入口与主中心同钥自验」符号 **废止**，勿再引入
 * - `BOOTSTRAP_TRUST_PUBKEY_VERSION` 与 BSP 仓**双侧同翻**（不能「签了但换钥」）
 *   V2 manifest 携带 `pubkey_version` 字段，必须等于本常量；不匹配即拒签。
 * - **v0.3 双锚点（BS-EV-3 · NCF-EV-3-1）**：`BOOTSTRAP_TRUST_PUBKEY_B64_V1` + `V2` 并行
 *   钉死；OR 验签语义由 `verifyManifestV2Multi` + `matchesBootstrapTrustSigner` 联合保证。
 *   V1 = 旧生产钥（保持向后兼容，仪式日 2026-10-01）；
 *   V2 = ceremony 后新钥（仪式日 2026-10-16 占位；仪式落地时翻为正式生产钥）。
 *   signers[i].pubkey_b64 必须等于 V1/V2 之一，否则 `BOOTSTRAP_SIGNER_PUBKEY_UNKNOWN`。
 *
 * 状态：`pinned`（V1 仪式日 2026-10-01；V2 ceremony 占位 2026-10-16；仪式落地后翻 V2 正式日）
 */

import { PRIMARY_TRUST_PUBKEY_B64 } from './primaryRegistryTrustAnchor';

/** 入口信任根状态：正式钥已钉死（bootstrap BS-OPS-1b）。 */
export const BOOTSTRAP_TRUST_PUBKEY_STATUS = 'pinned' as const;

/**
 * 入口 Ed25519 公钥 V1（raw 32 字节，标准 base64）= 当前生产主钥。
 * 只用于验入口 signed manifest；不得用 manifest 内接待中心 pubkey 自验。
 * 与 hailuo-bootstrap `shared/bootstrapTrustAnchor.ts` 同源；仪式日 2026-10-01。
 */
export const BOOTSTRAP_TRUST_PUBKEY_B64 =
  'y8KluZ+k6Q4nZDAVHp0Qp1ZXpUNQP9niFELpoUuyPtk=';

/**
 * 入口 Ed25519 公钥 V1 别名（NCF-EV-3-1 · V1 = 旧钥，保持向后兼容）。
 * 与 `BOOTSTRAP_TRUST_PUBKEY_B64` 同一字符串。
 */
export const BOOTSTRAP_TRUST_PUBKEY_B64_V1 = BOOTSTRAP_TRUST_PUBKEY_B64;

/**
 * 入口 Ed25519 公钥 V2（raw 32 字节，标准 base64）= ceremony 后新钥。
 * 当前 NCF-EV-3-1 协议扩展阶段为占位 `AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=`（32 字节 raw）。
 * ceremony 落地时（BS-EV-3-3 · NCF-EV-3-3）翻为正式生产钥；与 BSP 仓同翻号。
 *
 * **占位安全约束**：
 *  - 长度必须 = 32 字节 raw → 44 字符 base64 + 1 padding 'A' = 45 字符
 *  - 仪式前 signers[] 含此占位公钥时，验签必失败（除非 ceremony dry-run 用同一占位钥对）；
 *  - ceremony 落地时此占位与 BSP 仓同步翻为正式生产钥，signers 验签才通过。
 */
export const BOOTSTRAP_TRUST_PUBKEY_B64_V2 =
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

/**
 * 入口信任根公钥版本号（开源钉死；与 BSP 仓同翻）。
 * - V1 manifest 隐式 `pubkey_version=1`（无字段，按本常量处理）
 * - V2 manifest 必须携带 `pubkey_version` 字段 = 本常量，否则 `BOOTSTRAP_MANIFEST_PUBKEY_VERSION_MISMATCH`
 *
 * 翻号流程：BSP + NCF **同时** 升级（不能单边翻）；翻号期间 V1 manifest 仍可走原路径。
 * 旧 BD「读 manifest 字段动态认钥」**废止**——本常量是"防签了但换钥"叙事的硬约束。
 */
export const BOOTSTRAP_TRUST_PUBKEY_VERSION: number = 2;

/** 钉死日（ISO 日期）；V1 正式钥 2026-10-01。 */
export const BOOTSTRAP_TRUST_ANCHOR_PINNED_AT = '2026-10-01';

/** V2 钉死日（ISO 日期；NCF-EV-3-1 占位仪式日；ceremony 落地后翻为正式仪式日）。 */
export const BOOTSTRAP_TRUST_ANCHOR_V2_PINNED_AT = '2026-10-16';

/**
 * signers[] 多签公钥白名单（NCF-EV-3-1 · OR 验签前置校验）。
 * signers[i].pubkey_b64 必须归一化后命中此表任一项；否则 `BOOTSTRAP_SIGNER_PUBKEY_UNKNOWN`。
 * 严格 URL-safe / standard base64 兼容（归一化后比较）。
 */
export const BOOTSTRAP_TRUST_SIGNER_WHITELIST: readonly string[] = [
  BOOTSTRAP_TRUST_PUBKEY_B64_V1,
  BOOTSTRAP_TRUST_PUBKEY_B64_V2,
];

/**
 * signers[] 元素 pubkey_b64 是否命中 NCF 端已钉死双锚点之一（NCF-EV-3-1 · 防 pubkey 替换攻击）。
 * 调用方必须在调用 `verifyManifestV2Multi` 之前对每个 signers[i] 跑此校验。
 * 命中 V1 返 'v1'，命中 V2 返 'v2'，都不命中返 null。
 */
export function matchesBootstrapTrustSigner(
  pubkeyB64: string,
): 'v1' | 'v2' | null {
  if (typeof pubkeyB64 !== 'string' || pubkeyB64.length === 0) return null;
  const normalized = normalizePubkeyB64(pubkeyB64);
  for (const k of BOOTSTRAP_TRUST_SIGNER_WHITELIST) {
    if (normalizePubkeyB64(k) === normalized) {
      return normalizePubkeyB64(k) === normalizePubkeyB64(BOOTSTRAP_TRUST_PUBKEY_B64_V1) ? 'v1' : 'v2';
    }
  }
  return null;
}

/**
 * 开源钉死的入口镜像 URL（BI-3 拉 manifest）。
 * 正式入口：`bootstrap.movom.eu.org` 上的公开 well-known。
 * 节点若设置 env `BOOTSTRAP_URL_CANDIDATES`（逗号分隔），以环境变量为准，本表不生效。
 */
export const BOOTSTRAP_URL_CANDIDATES_PINNED = [
  'https://bootstrap.movom.eu.org/.well-known/hailuo-bootstrap.json',
] as const;

/** 可选 env 覆盖键名（wrangler / .dev.vars；运行时由调用方传入字符串，本模块不读 process.env）。 */
export const BOOTSTRAP_URL_CANDIDATES_ENV_KEY = 'BOOTSTRAP_URL_CANDIDATES' as const;

function stripTrailingSlash(url: string): string {
  return url.trim().replace(/\/$/, '');
}

function normalizePubkeyB64(raw: string): string {
  return raw.trim().replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
}

/** 入口公钥与主中心公钥是否已分离（BI-1 硬验收）。 */
export function isBootstrapTrustSeparatedFromPrimary(): boolean {
  const a = normalizePubkeyB64(BOOTSTRAP_TRUST_PUBKEY_B64);
  const b = normalizePubkeyB64(PRIMARY_TRUST_PUBKEY_B64);
  return a.length > 0 && b.length > 0 && a !== b;
}

/** 比较候选串是否等于钉死入口公钥（忽略空白；标准 / URL-safe base64 均可）。 */
export function matchesBootstrapTrustPubkey(pubkeyB64: string): boolean {
  const a = normalizePubkeyB64(pubkeyB64);
  const b = normalizePubkeyB64(BOOTSTRAP_TRUST_PUBKEY_B64);
  return a.length > 0 && a === b;
}

/**
 * 候选版本号是否等于钉死入口公钥版本号（BS-OPS-EV-2-1）。
 * 默认 1 = V1 manifest 隐式版本号；V2 manifest 必显式携带，等于本常量才放行。
 */
export function matchesBootstrapTrustPubkeyVersion(version: unknown): boolean {
  if (typeof version !== 'number' || !Number.isInteger(version) || version <= 0) {
    return false;
  }
  return version === BOOTSTRAP_TRUST_PUBKEY_VERSION;
}

/**
 * 解析入口 URL 候选列表。
 * @param envOverride 可选：env `BOOTSTRAP_URL_CANDIDATES` 原文（逗号分隔）；空则用钉死表
 * @returns 去尾斜杠、仅 https、去重后的有序列表
 */
export function resolveBootstrapUrlCandidates(
  envOverride?: string | null,
): readonly string[] {
  const raw = (envOverride ?? '').trim();
  const source = raw
    ? raw.split(',').map((s) => s.trim()).filter(Boolean)
    : [...BOOTSTRAP_URL_CANDIDATES_PINNED];

  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of source) {
    const normalized = stripTrailingSlash(item);
    if (!normalized) continue;
    try {
      const u = new URL(normalized);
      if (u.protocol !== 'https:') continue;
    } catch {
      continue;
    }
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}
