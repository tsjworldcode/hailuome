/**
 * 浏览器领取入口说明后、交给节点之前的验签。
 * 公钥与 apps/worker-a/src/lib/bootstrapIntakeTrustAnchor.ts 的钉死公钥同一串。
 * 节点收到原文后会再用同一套规则验一次。这里不读取、不上送浏览器地址。
 */

const BOOTSTRAP_TRUST_PUBKEY_B64 = 'y8KluZ+k6Q4nZDAVHp0Qp1ZXpUNQP9niFELpoUuyPtk=';
const BOOTSTRAP_TRUST_PUBKEY_VERSION = 2;
const ROSTER_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const TOP_LEVEL_KEYS_V1 = ['type', 'manifest_version', 'issued_at', 'roster_synced_at', 'intake'] as const;
const TOP_LEVEL_KEYS_V2 = ['type', 'pubkey_version', 'manifest_version', 'issued_at', 'roster_synced_at', 'intake'] as const;
const INTAKE_KEYS = ['registry_id', 'registry_url', 'trust_pubkey'] as const;

export type BrowserBootstrapCheck =
  | { ok: true; registryId: string }
  | { ok: false; message: string };

function isIso8601Utc(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(s);
}

function base64ToBytes(b64: string): Uint8Array {
  const n = b64.replace(/-/g, '+').replace(/_/g, '/');
  const pad = n.length % 4 === 0 ? '' : '='.repeat(4 - (n.length % 4));
  const bin = atob(n + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

function canonicalize(row: Record<string, unknown>, keys: readonly string[], includeWindow: boolean): Uint8Array {
  const ordered: Record<string, unknown> = {};
  const intakeRaw = row.intake as Record<string, unknown>;
  for (const key of keys) {
    if (key === 'intake') {
      const intake: Record<string, unknown> = {};
      for (const ik of INTAKE_KEYS) intake[ik] = intakeRaw[ik];
      ordered.intake = intake;
    } else {
      ordered[key] = row[key];
    }
  }
  const windowEnd = row.rotation_window_end_at;
  if (includeWindow && typeof windowEnd === 'string' && windowEnd.length > 0) {
    ordered.rotation_window_end_at = windowEnd;
  }
  return new TextEncoder().encode(JSON.stringify(ordered));
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

async function verifySig(payload: Uint8Array, sigB64: string, pubB64: string): Promise<boolean> {
  const pubRaw = base64ToBytes(pubB64);
  const sig = base64ToBytes(sigB64);
  if (pubRaw.length !== 32 || sig.length !== 64) return false;
  const spkiPrefix = new Uint8Array([
    0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
  ]);
  const spki = new Uint8Array(spkiPrefix.length + pubRaw.length);
  spki.set(spkiPrefix, 0);
  spki.set(pubRaw, spkiPrefix.length);
  try {
    const key = await crypto.subtle.importKey('spki', toArrayBuffer(spki), { name: 'Ed25519' }, false, ['verify']);
    return await crypto.subtle.verify(
      { name: 'Ed25519' },
      key,
      toArrayBuffer(sig),
      toArrayBuffer(payload),
    );
  } catch {
    return false;
  }
}

/** 用钉死的入口公钥验这段原文。通过后才可以交给节点。 */
export async function verifyBootstrapManifestText(raw: string, nowMs = Date.now()): Promise<BrowserBootstrapCheck> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, message: '入口说明无法读取' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, message: '入口说明无法读取' };
  }
  const row = parsed as Record<string, unknown>;
  if ('alternates' in row) return { ok: false, message: '入口说明含有不允许的备用列表' };
  const intake = row.intake;
  if (!intake || typeof intake !== 'object' || Array.isArray(intake)) {
    return { ok: false, message: '入口说明缺少接待中心' };
  }
  const inn = intake as Record<string, unknown>;
  for (const key of INTAKE_KEYS) {
    if (typeof inn[key] !== 'string' || !String(inn[key]).trim()) {
      return { ok: false, message: '入口说明缺少接待中心' };
    }
  }
  if (typeof row.issued_at !== 'string' || !isIso8601Utc(row.issued_at)) {
    return { ok: false, message: '入口说明时间无效' };
  }
  if (typeof row.roster_synced_at !== 'string' || !isIso8601Utc(row.roster_synced_at)) {
    return { ok: false, message: '入口说明时间无效' };
  }
  const syncedMs = Date.parse(row.roster_synced_at);
  if (!Number.isFinite(syncedMs) || nowMs - syncedMs < 0 || nowMs - syncedMs > ROSTER_MAX_AGE_MS) {
    return { ok: false, message: '入口名册已过期' };
  }
  if (typeof row.sig !== 'string' || !row.sig.trim()) {
    return { ok: false, message: '入口说明缺少签名' };
  }
  if (!Number.isInteger(row.manifest_version) || (row.manifest_version as number) <= 0) {
    return { ok: false, message: '入口说明版本无效' };
  }

  let payload: Uint8Array;
  if (row.type === 'HAILUO_BOOTSTRAP_MANIFEST_V1') {
    payload = canonicalize(row, TOP_LEVEL_KEYS_V1, false);
  } else if (row.type === 'HAILUO_BOOTSTRAP_MANIFEST_V2') {
    if (row.pubkey_version !== BOOTSTRAP_TRUST_PUBKEY_VERSION) {
      return { ok: false, message: '入口说明的公钥版本与本节点不一致' };
    }
    payload = canonicalize(row, TOP_LEVEL_KEYS_V2, true);
  } else {
    return { ok: false, message: '入口说明类型无法识别' };
  }

  const ok = await verifySig(payload, row.sig.trim(), BOOTSTRAP_TRUST_PUBKEY_B64);
  if (!ok) return { ok: false, message: '入口说明签名无效' };
  return { ok: true, registryId: String(inn.registry_id).trim() };
}
