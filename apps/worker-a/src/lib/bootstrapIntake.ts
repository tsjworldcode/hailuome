/**
 * M9-PH-BI-3/4：验浏览器交来的入口原文 → 钉死入口公钥验签 → 写 active_intake（B）。
 * 节点不自己去拉入口。验签失败不写主中心回落，也不改 home（C）。
 *
 * EV-2-2 升级：V1 / V2 manifest 并行消费（V1 type + 5 键；V2 type + 6 键含 `pubkey_version`）。
 * V2 路径显式校验 `pubkey_version` 字段 = `BOOTSTRAP_TRUST_PUBKEY_VERSION` 钉死常量，
 * 不匹配 → `BOOTSTRAP_MANIFEST_PUBKEY_VERSION_MISMATCH` 安全错误码（BS-OPS-EV-2-1）。
 *
 * 存储：只写 IDENTITY_DB system_config（BI-2 四键）；禁止 KV。
 * 日志：不 dump 整包 manifest、不回显 IP/token。
 *
 * 契约文档：docs/worker-a-api.md §海螺入口消费层（active_intake）
 */

import {
  isManifestVersionNewer,
  isRotationWindowExpired,
  commitBootstrapIntakeSnapshot,
  readActiveIntake,
  readBootstrapManifestCache,
  type ActiveIntake,
} from './activeIntake';
import {
  BOOTSTRAP_TRUST_PUBKEY_B64,
  BOOTSTRAP_TRUST_PUBKEY_VERSION,
  matchesBootstrapTrustPubkeyVersion,
  matchesBootstrapTrustSigner,
} from './bootstrapIntakeTrustAnchor';
import {
  verifyManifestV2Multi,
  type BootstrapManifestSigner as SharedBootstrapManifestSigner,
} from '@hailuo/shared-crypto';
import {
  PRIMARY_REGISTRY_DEFAULT_URL,
  PRIMARY_REGISTRY_ID,
  PRIMARY_TRUST_PUBKEY_B64,
} from './primaryRegistryTrustAnchor';
export const HAILUO_BOOTSTRAP_MANIFEST_V1 = 'HAILUO_BOOTSTRAP_MANIFEST_V1' as const;
/** V2 manifest type 字面（BS-OPS-EV-2-1）：6 键含 `pubkey_version`。 */
export const HAILUO_BOOTSTRAP_MANIFEST_V2 = 'HAILUO_BOOTSTRAP_MANIFEST_V2' as const;

/** 与 bootstrap 计划 §8.12.2 / §十二-10 一致：名册窗 24h。 */
export const BOOTSTRAP_ROSTER_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** V1 顶层 5 键（与 BSP `shared/manifest.ts` HAILUO_BOOTSTRAP_V1_TOP_LEVEL_KEYS 同源）。 */
const TOP_LEVEL_KEYS_V1 = [
  'type',
  'manifest_version',
  'issued_at',
  'roster_synced_at',
  'intake',
] as const;

/** V2 顶层 6 键（与 BSP `shared/manifest.ts` HAILUO_BOOTSTRAP_V2_TOP_LEVEL_KEYS 同源）。 */
const TOP_LEVEL_KEYS_V2 = [
  'type',
  'pubkey_version',
  'manifest_version',
  'issued_at',
  'roster_synced_at',
  'intake',
] as const;

const INTAKE_KEYS = ['registry_id', 'registry_url', 'trust_pubkey'] as const;

export type BootstrapIntakeErrorCode =
  | 'BOOTSTRAP_FETCH_FAILED'
  | 'BOOTSTRAP_MANIFEST_INVALID'
  | 'BOOTSTRAP_SIG_INVALID'
  | 'BOOTSTRAP_ROSTER_STALE'
  | 'BOOTSTRAP_VERSION_ROLLBACK'
  | 'BOOTSTRAP_ALTERNATES_FORBIDDEN'
  /** EV-2-2：V2 manifest 携带的 `pubkey_version` 与本仓钉死版本号不一致。 */
  | 'BOOTSTRAP_MANIFEST_PUBKEY_VERSION_MISMATCH'
  /** EV-3-2：V3 manifest 在 `rotation_window_end_at` 之后被拒（旧 V2 manifest 过渡期满）。 */
  | 'BOOTSTRAP_MANIFEST_LEGACY_AFTER_WINDOW'
  /** EV-3-2：signers[i].pubkey_b64 不在 V1/V2 双锚点白名单（防 pubkey 替换攻击）。 */
  | 'BOOTSTRAP_SIGNER_PUBKEY_UNKNOWN'
  /** EV-3-2：signers[i].pubkey_version 与 pubkey_b64 不匹配（查表漏配）。 */
  | 'BOOTSTRAP_SIGNER_VERSION_MISMATCH'
  /** EV-3-2：所有 signers[] 验签均失败（OR 语义全 OR 不上）。 */
  | 'BOOTSTRAP_SIGNER_SIG_INVALID';

export type BootstrapIntakeRefreshResult =
  | {
    readonly ok: true;
    readonly source: 'bootstrap';
    readonly intake: ActiveIntake;
    readonly url: string;
  }
  | {
    readonly ok: false;
    readonly error_code: BootstrapIntakeErrorCode;
    readonly source: 'primary_fallback';
    readonly intake: ActiveIntake;
    readonly message: string;
  };

export interface BootstrapIntakeRefreshInput {
  readonly db: D1Database;
  /** 覆盖入口公钥（仅测试 golden vector；生产勿传）。 */
  readonly trustPubkeyB64?: string;
  /**
   * 覆盖入口公钥版本号（仅测试 golden vector；生产勿传）。
   * 缺省 = 钉死 `BOOTSTRAP_TRUST_PUBKEY_VERSION`（EV-2-2-3 起 = 2）。
   */
  readonly trustPubkeyVersion?: number;
  readonly urlCandidatesOverride?: string | null;
  readonly nowMs?: number;
  /** 再问时只带这一家的编号，用来判断版本是否和同一家比较。 */
  readonly avoidRegistryId?: string;
  /** 再问失败时保留已经领到的那一家，不改写成主中心回落。 */
  readonly keepPreviousOnFailure?: boolean;
  /**
   * 浏览器已经拿到的入口原文。
   * 验签只用这段文字，节点不向入口发起网络请求。
   * 没有原文或验签失败时不写主中心回落。
   */
  readonly presentedManifest?: string;
}

function stripTrailingSlash(url: string): string {
  return url.trim().replace(/\/$/, '');
}

function isIso8601Utc(s: string): boolean {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(s);
}

function base64ToBytes(b64: string): Uint8Array {
  const n = b64.replace(/-/g, '+').replace(/_/g, '/');
  const pad = n.length % 4 === 0 ? '' : '='.repeat(4 - (n.length % 4));
  const bin = atob(n + pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/** §4.2 固定键序紧凑 JSON → UTF-8（V1 · 5 键；与 hailuo-bootstrap canonicalizeManifestV1 同源）。 */
export function canonicalizeBootstrapManifestPayload(payload: {
  type: string;
  manifest_version: number;
  issued_at: string;
  roster_synced_at: string;
  intake: { registry_id: string; registry_url: string; trust_pubkey: string };
}): Uint8Array {
  const ordered: Record<string, unknown> = {};
  for (const k of TOP_LEVEL_KEYS_V1) {
    if (k === 'intake') {
      const intake: Record<string, unknown> = {};
      for (const ik of INTAKE_KEYS) {
        intake[ik] = payload.intake[ik];
      }
      ordered.intake = intake;
    } else {
      ordered[k] = payload[k];
    }
  }
  return new TextEncoder().encode(JSON.stringify(ordered));
}

/**
 * §4.2 固定键序紧凑 JSON → UTF-8（V2 · 6 键含 `pubkey_version`；与 BSP canonicalizeManifestV2 同源）。
 * 非空 `rotation_window_end_at` 追加在 6 键之后；缺省则与旧清单逐字节相同。
 * 任何自动 `JSON.stringify` 不保证键序一致——必须走本函数。
 */
export function canonicalizeBootstrapManifestPayloadV2(payload: {
  type: string;
  pubkey_version: number;
  manifest_version: number;
  issued_at: string;
  roster_synced_at: string;
  intake: { registry_id: string; registry_url: string; trust_pubkey: string };
  rotation_window_end_at?: string | null;
}): Uint8Array {
  const ordered: Record<string, unknown> = {};
  for (const k of TOP_LEVEL_KEYS_V2) {
    if (k === 'intake') {
      const intake: Record<string, unknown> = {};
      for (const ik of INTAKE_KEYS) {
        intake[ik] = payload.intake[ik];
      }
      ordered.intake = intake;
    } else {
      ordered[k] = payload[k];
    }
  }
  const windowEnd = payload.rotation_window_end_at;
  if (typeof windowEnd === 'string' && windowEnd.length > 0) {
    ordered.rotation_window_end_at = windowEnd;
  }
  return new TextEncoder().encode(JSON.stringify(ordered));
}

export async function verifyBootstrapManifestSig(
  payloadBytes: Uint8Array,
  sigB64: string,
  pubRawB64: string,
): Promise<boolean> {
  const pubRaw = base64ToBytes(pubRawB64);
  const sig = base64ToBytes(sigB64);
  if (pubRaw.length !== 32 || sig.length !== 64) return false;
  const spkiPrefix = new Uint8Array([
    0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
  ]);
  const spki = new Uint8Array(spkiPrefix.length + pubRaw.length);
  spki.set(spkiPrefix, 0);
  spki.set(pubRaw, spkiPrefix.length);
  try {
    const key = await crypto.subtle.importKey('spki', spki, { name: 'Ed25519' }, false, ['verify']);
    return await crypto.subtle.verify({ name: 'Ed25519' }, key, sig, payloadBytes);
  } catch {
    return false;
  }
}

function parseSignedManifest(
  raw: string,
  expectedPubkeyVersion: number,
): {
  ok: true;
  body: {
    type: typeof HAILUO_BOOTSTRAP_MANIFEST_V1;
    manifest_version: number;
    issued_at: string;
    roster_synced_at: string;
    intake: { registry_id: string; registry_url: string; trust_pubkey: string };
    sig: string;
    pubkey_version: typeof BOOTSTRAP_TRUST_PUBKEY_VERSION; // V1 隐式 = 钉死（EV-2-2-3 双侧同翻）
  };
} | {
  ok: true;
  body: {
    type: typeof HAILUO_BOOTSTRAP_MANIFEST_V2;
    pubkey_version: number;
    manifest_version: number;
    issued_at: string;
    roster_synced_at: string;
    intake: { registry_id: string; registry_url: string; trust_pubkey: string };
    sig: string;
    /** EV-3-2 v0.3.0：V3 多签过渡字段（V2 基础 6 键 + 可选 signers[] + 可选 rotation_window_end_at）。
     * - signers[] 任一命中白名单 V1/V2 之一即通过（OR 语义）
     * - 缺省 = 单签 V2 路径（向后兼容） */
    signers?: ReadonlyArray<{ pubkey_b64: string; pubkey_version: number; sig: string }>;
    rotation_window_end_at?: string;
  };
} | { ok: false; error_code: BootstrapIntakeErrorCode } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error_code: 'BOOTSTRAP_MANIFEST_INVALID' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error_code: 'BOOTSTRAP_MANIFEST_INVALID' };
  }
  const row = parsed as Record<string, unknown>;
  // 入口已取消通讯录叙事；出现则拒，避免旧稿灌地址簿
  if ('alternates' in row) {
    return { ok: false, error_code: 'BOOTSTRAP_ALTERNATES_FORBIDDEN' };
  }

  // V1 路径：5 键；隐式 pubkey_version = 钉死（EV-2-2-3 起 = 2）
  if (row.type === HAILUO_BOOTSTRAP_MANIFEST_V1) {
    if (!Number.isInteger(row.manifest_version) || (row.manifest_version as number) <= 0) {
      return { ok: false, error_code: 'BOOTSTRAP_MANIFEST_INVALID' };
    }
    if (typeof row.issued_at !== 'string' || !isIso8601Utc(row.issued_at)) {
      return { ok: false, error_code: 'BOOTSTRAP_MANIFEST_INVALID' };
    }
    if (typeof row.roster_synced_at !== 'string' || !isIso8601Utc(row.roster_synced_at)) {
      return { ok: false, error_code: 'BOOTSTRAP_MANIFEST_INVALID' };
    }
    if (typeof row.sig !== 'string' || !row.sig.trim()) {
      return { ok: false, error_code: 'BOOTSTRAP_MANIFEST_INVALID' };
    }
    const intake = row.intake;
    if (!intake || typeof intake !== 'object' || Array.isArray(intake)) {
      return { ok: false, error_code: 'BOOTSTRAP_MANIFEST_INVALID' };
    }
    const inn = intake as Record<string, unknown>;
    for (const k of INTAKE_KEYS) {
      if (typeof inn[k] !== 'string' || !String(inn[k]).trim()) {
        return { ok: false, error_code: 'BOOTSTRAP_MANIFEST_INVALID' };
      }
    }
    return {
      ok: true,
      body: {
        type: HAILUO_BOOTSTRAP_MANIFEST_V1,
        manifest_version: row.manifest_version as number,
        issued_at: row.issued_at,
        roster_synced_at: row.roster_synced_at,
        intake: {
          registry_id: String(inn.registry_id).trim(),
          registry_url: stripTrailingSlash(String(inn.registry_url)),
          trust_pubkey: String(inn.trust_pubkey).trim(),
        },
        sig: row.sig.trim(),
        pubkey_version: BOOTSTRAP_TRUST_PUBKEY_VERSION, // V1 隐式 = 钉死（EV-2-2-3）
      },
    };
  }

  // V2 路径：6 键含 `pubkey_version`；显式校验 = 本地钉死版本号
  if (row.type === HAILUO_BOOTSTRAP_MANIFEST_V2) {
    if (!Number.isInteger(row.pubkey_version) || (row.pubkey_version as number) <= 0) {
      return { ok: false, error_code: 'BOOTSTRAP_MANIFEST_PUBKEY_VERSION_MISMATCH' };
    }
    if (!Number.isInteger(row.manifest_version) || (row.manifest_version as number) <= 0) {
      return { ok: false, error_code: 'BOOTSTRAP_MANIFEST_INVALID' };
    }
    if (typeof row.issued_at !== 'string' || !isIso8601Utc(row.issued_at)) {
      return { ok: false, error_code: 'BOOTSTRAP_MANIFEST_INVALID' };
    }
    if (typeof row.roster_synced_at !== 'string' || !isIso8601Utc(row.roster_synced_at)) {
      return { ok: false, error_code: 'BOOTSTRAP_MANIFEST_INVALID' };
    }
    if (typeof row.sig !== 'string' || !row.sig.trim()) {
      return { ok: false, error_code: 'BOOTSTRAP_MANIFEST_INVALID' };
    }
    const intake = row.intake;
    if (!intake || typeof intake !== 'object' || Array.isArray(intake)) {
      return { ok: false, error_code: 'BOOTSTRAP_MANIFEST_INVALID' };
    }
    const inn = intake as Record<string, unknown>;
    for (const k of INTAKE_KEYS) {
      if (typeof inn[k] !== 'string' || !String(inn[k]).trim()) {
        return { ok: false, error_code: 'BOOTSTRAP_MANIFEST_INVALID' };
      }
    }
    const pubkeyVersion = row.pubkey_version as number;
    // EV-2-2 安全错误码：V2 manifest 携带的 pubkey_version 与本仓钉死版本号不匹配
    // 必须显式区分（不是 BOOTSTRAP_MANIFEST_INVALID）—— 防止"v0.2 已发但本仓未升级"被静默吞
    if (pubkeyVersion !== expectedPubkeyVersion) {
      return { ok: false, error_code: 'BOOTSTRAP_MANIFEST_PUBKEY_VERSION_MISMATCH' };
    }
    // EV-3-2 v0.3.0：解析 signers[] 多签过渡字段（V3 协议）
    // - signers[] 元素 = { pubkey_b64: string, pubkey_version: number, sig: string }
    // - rotation_window_end_at = ISO 8601 UTC | undefined
    // - 结构校验（不验签 — 验签在 refreshActiveIntakeFromBootstrap 走 verifyManifestV2Multi）
    const rawSigners = row.signers;
    let parsedSigners: ReadonlyArray<{ pubkey_b64: string; pubkey_version: number; sig: string }> | undefined;
    if (rawSigners !== undefined) {
      if (!Array.isArray(rawSigners)) {
        return { ok: false, error_code: 'BOOTSTRAP_MANIFEST_INVALID' };
      }
      const tmp: { pubkey_b64: string; pubkey_version: number; sig: string }[] = [];
      for (const s of rawSigners) {
        if (!s || typeof s !== 'object' || Array.isArray(s)) {
          return { ok: false, error_code: 'BOOTSTRAP_MANIFEST_INVALID' };
        }
        const sn = s as Record<string, unknown>;
        if (typeof sn.pubkey_b64 !== 'string' || !sn.pubkey_b64.trim()) {
          return { ok: false, error_code: 'BOOTSTRAP_SIGNER_PUBKEY_UNKNOWN' };
        }
        if (!Number.isInteger(sn.pubkey_version) || (sn.pubkey_version as number) <= 0) {
          return { ok: false, error_code: 'BOOTSTRAP_SIGNER_VERSION_MISMATCH' };
        }
        if (typeof sn.sig !== 'string' || !sn.sig.trim()) {
          return { ok: false, error_code: 'BOOTSTRAP_MANIFEST_INVALID' };
        }
        tmp.push({
          pubkey_b64: sn.pubkey_b64.trim(),
          pubkey_version: sn.pubkey_version as number,
          sig: sn.sig.trim(),
        });
      }
      parsedSigners = tmp;
    }
    const rawRotWindow = row.rotation_window_end_at;
    let parsedRotWindow: string | undefined;
    if (rawRotWindow !== undefined) {
      if (typeof rawRotWindow !== 'string' || !isIso8601Utc(rawRotWindow)) {
        return { ok: false, error_code: 'BOOTSTRAP_MANIFEST_INVALID' };
      }
      parsedRotWindow = rawRotWindow;
    }
    return {
      ok: true,
      body: {
        type: HAILUO_BOOTSTRAP_MANIFEST_V2,
        pubkey_version: pubkeyVersion,
        manifest_version: row.manifest_version as number,
        issued_at: row.issued_at,
        roster_synced_at: row.roster_synced_at,
        intake: {
          registry_id: String(inn.registry_id).trim(),
          registry_url: stripTrailingSlash(String(inn.registry_url)),
          trust_pubkey: String(inn.trust_pubkey).trim(),
        },
        sig: row.sig.trim(),
        ...(parsedSigners ? { signers: parsedSigners } : {}),
        ...(parsedRotWindow ? { rotation_window_end_at: parsedRotWindow } : {}),
      },
    };
  }

  // 未知 type
  return { ok: false, error_code: 'BOOTSTRAP_MANIFEST_INVALID' };
}

function primaryFallbackIntake(nowIso: string): ActiveIntake {
  return {
    registry_id: PRIMARY_REGISTRY_ID,
    registry_url: stripTrailingSlash(PRIMARY_REGISTRY_DEFAULT_URL),
    trust_pubkey: PRIMARY_TRUST_PUBKEY_B64,
    // EV-2-2-3：主中心回落隐式 pubkey_version = 钉死（与入口版本号同翻）
    pubkey_version: BOOTSTRAP_TRUST_PUBKEY_VERSION,
    source: 'primary_fallback',
    updated_at: nowIso,
    // EV-3-6：主中心回落显式 null（无 V3 协议字段，V1/V2 兼容路径）
    rotation_window_end_at: null,
  };
}

/**
 * 只验浏览器交来的入口原文，验签成功才写 B。
 * 没有原文、验签失败都不写主中心回落，也不向外发请求。
 *
 * EV-2-2：V1 / V2 manifest 分流（type 字面判定）；V2 额外校验 `pubkey_version` = 钉死常量。
 */
export async function refreshActiveIntakeFromBootstrap(
  input: BootstrapIntakeRefreshInput,
): Promise<BootstrapIntakeRefreshResult> {
  const nowMs = input.nowMs ?? Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const presented = input.presentedManifest?.trim() ?? '';
  const pubB64 = (input.trustPubkeyB64 ?? BOOTSTRAP_TRUST_PUBKEY_B64).trim();
  // EV-2-2：契约测可注入 pubkey_version override；生产缺省走钉死常量
  const pinnedPubkeyVersion = input.trustPubkeyVersion ?? BOOTSTRAP_TRUST_PUBKEY_VERSION;
  const prevCache = await readBootstrapManifestCache(input.db);
  const prevVersion = prevCache?.version ?? 0;
  const prevIntake = input.avoidRegistryId ? await readActiveIntake(input.db) : null;

  let lastCode: BootstrapIntakeErrorCode = 'BOOTSTRAP_MANIFEST_INVALID';

  // 节点不代拉入口。没交原文就停，不写回落。
  if (presented.length < 2 || presented.length > 32_000) {
    if (input.keepPreviousOnFailure && prevIntake) {
      return { ok: true, source: 'bootstrap', intake: prevIntake, url: prevIntake.registry_url };
    }
    return {
      ok: false,
      error_code: 'BOOTSTRAP_MANIFEST_INVALID',
      source: 'primary_fallback',
      intake: primaryFallbackIntake(nowIso),
      message: '登记须由浏览器提交入口原文',
    };
  }

  for (const _once of [presented]) {
    const fetched = { ok: true as const, text: _once };
    const parsed = parseSignedManifest(fetched.text, pinnedPubkeyVersion);
    if (!parsed.ok) {
      lastCode = parsed.error_code;
      continue;
    }
    const { body } = parsed;
    const syncedMs = Date.parse(body.roster_synced_at);
    if (!Number.isFinite(syncedMs) || nowMs - syncedMs < 0 || nowMs - syncedMs > BOOTSTRAP_ROSTER_MAX_AGE_MS) {
      lastCode = 'BOOTSTRAP_ROSTER_STALE';
      continue;
    }
    // 再拉时换到另一家：版本只和同一家比，另一家版本更小也接受。
    // 仍是同一家：更小的版本丢掉；相同或更大的继续用。
    if (input.avoidRegistryId) {
      const sameRegistry = prevIntake?.registry_id === body.intake.registry_id;
      if (sameRegistry && body.manifest_version < prevVersion) {
        lastCode = 'BOOTSTRAP_VERSION_ROLLBACK';
        continue;
      }
    } else if (!isManifestVersionNewer(body.manifest_version, prevVersion)) {
      lastCode = 'BOOTSTRAP_VERSION_ROLLBACK';
      continue;
    }
    // V1 / V2 canonicalize 分流（type 字面判定，TS 已窄化）
    const payloadBytes =
      body.type === HAILUO_BOOTSTRAP_MANIFEST_V2
        ? canonicalizeBootstrapManifestPayloadV2({
          type: HAILUO_BOOTSTRAP_MANIFEST_V2,
          pubkey_version: body.pubkey_version,
          manifest_version: body.manifest_version,
          issued_at: body.issued_at,
          roster_synced_at: body.roster_synced_at,
          intake: body.intake,
          ...(typeof body.rotation_window_end_at === 'string' && body.rotation_window_end_at.length > 0
            ? { rotation_window_end_at: body.rotation_window_end_at }
            : {}),
        })
        : canonicalizeBootstrapManifestPayload({
          type: HAILUO_BOOTSTRAP_MANIFEST_V1,
          manifest_version: body.manifest_version,
          issued_at: body.issued_at,
          roster_synced_at: body.roster_synced_at,
          intake: body.intake,
        });
    // EV-3-2 v0.3.0：V2 manifest 含 signers[] → 走 V3 多签 OR 验签（含白名单前置 + rotation_window 检查）
    // V1 manifest 不走 V3 路径（仪式前 V1 隐式 1 / 仪式后 V1 隐式 2；transition 由 V2 + signers[] 承担）
    if (body.type === HAILUO_BOOTSTRAP_MANIFEST_V2 && body.signers && body.signers.length > 0) {
      // 1) EV-3-6：rotation_window_end_at 过期检查（旧 V2 manifest 在 window 后拒；统一走 isRotationWindowExpired）
      if (isRotationWindowExpired(body.rotation_window_end_at, nowMs)) {
        lastCode = 'BOOTSTRAP_MANIFEST_LEGACY_AFTER_WINDOW';
        continue;
      }
      // 2) signers[] 白名单前置校验（防 pubkey 替换攻击）
      for (const s of body.signers) {
        const matchedVersion = matchesBootstrapTrustSigner(s.pubkey_b64);
        if (matchedVersion === null) {
          lastCode = 'BOOTSTRAP_SIGNER_PUBKEY_UNKNOWN';
          continue; // 跳出整个 for url 循环（注意：这是 inner continue，需要换写法）
        }
        // pubkey_version 应当等于白名单版本号（v1 → 1, v2 → 2）
        const expectedVersion = matchedVersion === 'v1' ? 1 : 2;
        if (s.pubkey_version !== expectedVersion) {
          lastCode = 'BOOTSTRAP_SIGNER_VERSION_MISMATCH';
          continue;
        }
      }
      // 由于上面 continue 只能跳出当前 for 循环（非 URL 循环），重构成全路径 flag
      // ↑ 重构说明：原意图是「任意 signers[i] 不命中白名单 → 整个 URL 拒」，下方统一处理
    }
    // EV-3-2 v0.3.0：V3 多签验签决策表（独立块处理）
    let v3MultiSigOk = true;
    if (body.type === HAILUO_BOOTSTRAP_MANIFEST_V2 && body.signers && body.signers.length > 0) {
      // 1) EV-3-6：rotation_window_end_at 过期检查（统一走 isRotationWindowExpired；与上面块同语义）
      if (isRotationWindowExpired(body.rotation_window_end_at, nowMs)) {
        lastCode = 'BOOTSTRAP_MANIFEST_LEGACY_AFTER_WINDOW';
        continue;
      }
      // 2) signers[] 白名单前置校验
      let signerCheckFailed: BootstrapIntakeErrorCode | null = null;
      for (const s of body.signers) {
        const matchedVersion = matchesBootstrapTrustSigner(s.pubkey_b64);
        if (matchedVersion === null) {
          signerCheckFailed = 'BOOTSTRAP_SIGNER_PUBKEY_UNKNOWN';
          break;
        }
        const expectedVersion = matchedVersion === 'v1' ? 1 : 2;
        if (s.pubkey_version !== expectedVersion) {
          signerCheckFailed = 'BOOTSTRAP_SIGNER_VERSION_MISMATCH';
          break;
        }
      }
      if (signerCheckFailed) {
        lastCode = signerCheckFailed;
        continue;
      }
      // 3) OR 验签（任一 signers[i] 验签通过即通过）
      const multiOk = await verifyManifestV2Multi(
        {
          type: HAILUO_BOOTSTRAP_MANIFEST_V2,
          pubkey_version: body.pubkey_version,
          manifest_version: body.manifest_version,
          issued_at: body.issued_at,
          roster_synced_at: body.roster_synced_at,
          intake: body.intake,
          ...(typeof body.rotation_window_end_at === 'string' && body.rotation_window_end_at.length > 0
            ? { rotation_window_end_at: body.rotation_window_end_at }
            : {}),
        },
        body.signers.map(
          (s): SharedBootstrapManifestSigner => ({
            pubkey_b64: s.pubkey_b64,
            pubkey_version: s.pubkey_version,
            sig: s.sig,
          }),
        ),
      );
      if (!multiOk) {
        lastCode = 'BOOTSTRAP_SIGNER_SIG_INVALID';
        continue;
      }
      v3MultiSigOk = true;
    } else {
      v3MultiSigOk = true; // V1 / V2 单签路径：下面 verifyBootstrapManifestSig 单独验签
    }
    const sigOk = v3MultiSigOk && (await verifyBootstrapManifestSig(payloadBytes, body.sig, pubB64));
    if (!sigOk) {
      lastCode = 'BOOTSTRAP_SIG_INVALID';
      continue;
    }

    const intake: ActiveIntake = {
      registry_id: body.intake.registry_id,
      registry_url: body.intake.registry_url,
      trust_pubkey: body.intake.trust_pubkey,
      // EV-2-2-3：写入 B 时 V2 写字段值，V1 隐式写钉死常量（与 BOOTSTRAP_TRUST_PUBKEY_VERSION 同步翻号）
      pubkey_version: body.type === HAILUO_BOOTSTRAP_MANIFEST_V2 ? body.pubkey_version : BOOTSTRAP_TRUST_PUBKEY_VERSION,
      source: 'bootstrap',
      updated_at: nowIso,
      // EV-3-6：V3 manifest 写 rotation_window_end_at；V1/V2 显式 null（不破 V1 旧缓存字节级兼容）
      rotation_window_end_at:
        body.type === HAILUO_BOOTSTRAP_MANIFEST_V2 && body.rotation_window_end_at
          ? body.rotation_window_end_at
          : null,
    };
    const saved = await commitBootstrapIntakeSnapshot(input.db, {
      isRepull: Boolean(input.avoidRegistryId),
      intake,
      manifest: {
        version: body.manifest_version,
        cachedAt: nowIso,
        json: fetched.text,
      },
    });
    if (saved === 'kept') {
      const kept = await readActiveIntake(input.db);
      if (kept) {
        return { ok: true, source: 'bootstrap', intake: kept, url: kept.registry_url };
      }
    }
    return { ok: true, source: 'bootstrap', intake, url: intake.registry_url };
  }

  const msgMap: Record<BootstrapIntakeErrorCode, string> = {
    BOOTSTRAP_FETCH_FAILED: '入口 manifest 拉取失败',
    BOOTSTRAP_MANIFEST_INVALID: '入口 manifest 字段不合法',
    BOOTSTRAP_SIG_INVALID: '入口 manifest 验签失败',
    BOOTSTRAP_ROSTER_STALE: '入口名册超过 24h 窗',
    BOOTSTRAP_VERSION_ROLLBACK: '入口 manifest_version 未单调递增',
    BOOTSTRAP_ALTERNATES_FORBIDDEN: '入口 manifest 不得含 alternates',
    BOOTSTRAP_MANIFEST_PUBKEY_VERSION_MISMATCH:
      '入口 V2 manifest pubkey_version 与本仓钉死版本号不一致',
    BOOTSTRAP_MANIFEST_LEGACY_AFTER_WINDOW: '入口 V3 manifest 已过 rotation_window_end_at（旧 V2 manifest 过渡期满）',
    BOOTSTRAP_SIGNER_PUBKEY_UNKNOWN: '入口 V3 manifest signers[].pubkey_b64 不在 V1/V2 白名单',
    BOOTSTRAP_SIGNER_VERSION_MISMATCH: '入口 V3 manifest signers[].pubkey_version 与公钥白名单版本号不匹配',
    BOOTSTRAP_SIGNER_SIG_INVALID: '入口 V3 manifest signers[] OR 验签全部失败',
  };
  if (input.keepPreviousOnFailure && prevIntake) {
    return { ok: true, source: 'bootstrap', intake: prevIntake, url: prevIntake.registry_url };
  }
  return {
    ok: false,
    error_code: lastCode,
    source: 'primary_fallback',
    intake: primaryFallbackIntake(nowIso),
    message: msgMap[lastCode],
  };
}

/** 收下浏览器交来的入口原文。节点再验签，不自己去拉入口。失败不写回落。 */
export async function acceptPresentedBootstrapManifest(input: {
  readonly db: D1Database;
  readonly manifestText: string;
  readonly avoidRegistryId?: string;
  readonly urlCandidatesOverride?: string | null;
  readonly nowMs?: number;
}): Promise<BootstrapIntakeRefreshResult> {
  const text = input.manifestText;
  const nowIso = new Date(input.nowMs ?? Date.now()).toISOString();
  if (typeof text !== 'string' || text.length < 2 || text.length > 32_000) {
    return {
      ok: false,
      error_code: 'BOOTSTRAP_MANIFEST_INVALID',
      source: 'primary_fallback',
      intake: primaryFallbackIntake(nowIso),
      message: '入口 manifest 字段不合法',
    };
  }
  return refreshActiveIntakeFromBootstrap({
    db: input.db,
    nowMs: input.nowMs,
    avoidRegistryId: input.avoidRegistryId,
    keepPreviousOnFailure: Boolean(input.avoidRegistryId),
    presentedManifest: text,
  });
}
