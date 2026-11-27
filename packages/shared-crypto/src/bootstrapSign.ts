/**
 * 海螺入口 V3 多签验签（NCF-EV-3-1 · BS-EV-3 配对）
 *
 * 与 `hailuo-bootstrap/shared/manifestSign.ts` 同源（独立物理副本；防止跨仓 import）。
 * OR 语义：signers[] 任一 sig 验签通过即通过。
 *
 * **安全要求**（必须先做白名单校验再调用本函数）：
 *  - signers[i].pubkey_b64 必须命中 `matchesBootstrapTrustSigner`（v1 / v2）
 *  - 否则 `BOOTSTRAP_SIGNER_PUBKEY_UNKNOWN`（由 `bootstrapIntake.ts` 报）
 *  - signers[i].pubkey_version 必须是正整数（V1 manifest 隐式 = 2；V2 manifest 显式 ≥ 1）
 *
 * **验签字节**：
 *  - 派生 payload = { ...payload, pubkey_version: signers[i].pubkey_version }
 *  - signers[i].sig = signManifestV2(derivedPayload, signers[i].privateKey) 字节
 *  - signers[i].sig 必须 = signers[i].pubkey_b64 验签 derivedPayload 通过的字节
 *
 * 私钥永不进本仓库（节点只验签，不签发）。
 */

import { decodeBase64Flexible } from './ed25519';

const ALG = { name: 'Ed25519' } as const;

/** v0.2 manifest payload（NCF 端消费层用；非空轮换截止时间一并验签）。 */
export interface BootstrapManifestPayloadV2ForSign {
  readonly type: 'HAILUO_BOOTSTRAP_MANIFEST_V2';
  readonly pubkey_version: number;
  readonly manifest_version: number;
  readonly issued_at: string;
  readonly roster_synced_at: string;
  readonly intake: { readonly registry_id: string; readonly registry_url: string; readonly trust_pubkey: string };
  readonly rotation_window_end_at?: string | null;
}

/** v0.3 manifest signers[] 元素（NCF 端消费层用）。 */
export interface BootstrapManifestSigner {
  readonly pubkey_b64: string;
  readonly pubkey_version: number;
  readonly sig: string;
}

/** 公开 textEncoder 单例。 */
const TEXT_ENCODER = new TextEncoder();

/** §4.2 拼串 v0.2（与 BSP 端 canonicalizeManifestV2 字节级一致；非空截止时间追加在最后）。 */
export function canonicalizeManifestV2ForVerify(
  payload: BootstrapManifestPayloadV2ForSign,
): Uint8Array {
  const ordered: Record<string, unknown> = {
    type: payload.type,
    pubkey_version: payload.pubkey_version,
    manifest_version: payload.manifest_version,
    issued_at: payload.issued_at,
    roster_synced_at: payload.roster_synced_at,
    intake: {
      registry_id: payload.intake.registry_id,
      registry_url: payload.intake.registry_url,
      trust_pubkey: payload.intake.trust_pubkey,
    },
  };
  if (typeof payload.rotation_window_end_at === 'string' && payload.rotation_window_end_at.length > 0) {
    ordered.rotation_window_end_at = payload.rotation_window_end_at;
  }
  return TEXT_ENCODER.encode(JSON.stringify(ordered));
}

/** crypto.subtle.verify 期望 BufferSource；TS web lib 严格分 ArrayBuffer/SharedArrayBuffer，本 helper 显式拷为 ArrayBuffer。 */
function toBufferSource(u8: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(u8.byteLength);
  new Uint8Array(out).set(u8);
  return out;
}

async function importPublicKey(rawB64: string): Promise<CryptoKey> {
  const raw = decodeBase64Flexible(rawB64);
  if (raw.length !== 32) {
    throw new Error(`[bootstrapSign] Ed25519 public key must be 32 raw bytes, got ${raw.length}`);
  }
  return crypto.subtle.importKey('raw', toBufferSource(raw), ALG, false, ['verify']);
}

/**
 * v0.2 单签验签（NCF 端本地实现；与 BSP 端 verifyManifestV2 字节级一致）。
 * 用于 signers[] OR 验签内层（每个 signers[i] 独立验签）。
 */
export async function verifyManifestV2ForMulti(
  payload: BootstrapManifestPayloadV2ForSign,
  sig: string,
  publicKeyRawB64: string,
): Promise<boolean> {
  const bytes = canonicalizeManifestV2ForVerify(payload);
  const key = await importPublicKey(publicKeyRawB64);
  const sigBytes = decodeBase64Flexible(sig);
  if (sigBytes.length !== 64) return false;
  return crypto.subtle.verify(ALG, key, toBufferSource(sigBytes), toBufferSource(bytes));
}

/**
 * v0.3 多签验签（NCF-EV-3-1 · OR 语义）：signers[] 任一 sig 验签通过即通过。
 *
 * **重要**：本函数**不做**白名单校验（不持有运营面锚点）；
 * 调用方必须先用 `matchesBootstrapTrustSigner` 对每个 signers[i].pubkey_b64 校验。
 * 否则攻击者可注入任意公钥（其对应私钥签的 sig 也会通过 OR 验签）。
 */
export async function verifyManifestV2Multi(
  payload: BootstrapManifestPayloadV2ForSign,
  signers: readonly BootstrapManifestSigner[],
): Promise<boolean> {
  if (!Array.isArray(signers) || signers.length === 0) return false;
  for (const s of signers) {
    if (!s || typeof s.pubkey_b64 !== 'string' || s.pubkey_b64.length === 0) return false;
    if (!Number.isInteger(s.pubkey_version) || s.pubkey_version <= 0) return false;
    if (typeof s.sig !== 'string' || s.sig.length === 0) return false;
    const derivedPayload: BootstrapManifestPayloadV2ForSign = {
      ...payload,
      pubkey_version: s.pubkey_version,
    };
    const ok = await verifyManifestV2ForMulti(derivedPayload, s.sig, s.pubkey_b64);
    if (ok) return true; // OR 语义：任一通过即通过
  }
  return false;
}
