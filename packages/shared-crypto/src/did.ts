/**
 * DID 层（海螺身份）。
 *
 * 唯一合法形态：did:hailuo:<64hex>
 * 算法：SHA-256(raw 32B Ed25519 pubkey) → 64 小写 hex
 *
 * 不兼容 did:sayfree:* / did:hailuo:v2: / 短 DID（项目未上线，无存量义务）。
 * 与注册中心 workers/registry-gateway/src/lib/ids.ts 必须字节一致。
 */

import { hexToBytes } from '@hailuo/shared-utils';

/** 现行 DID 方法前缀 */
export const HAILUO_DID_PREFIX = 'did:hailuo:';

/** 与 HAILUO_DID_PREFIX 同值；列名与历史符号保留 did_v2。 */
export const HAILUO_DID_V2_PREFIX = HAILUO_DID_PREFIX;

/**
 * @deprecated 曾短暂使用 did:sayfree:；现仅接受 did:hailuo:。
 */
export const SAYFREE_DID_PREFIX = 'did:sayfree:';

const DID_HASH_RE = /^[0-9a-f]{64}$/;

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // 中文注释：拷贝为独立 ArrayBuffer，避免 TS 对 SharedArrayBuffer 的 BufferSource 收窄报错
  const input = new Uint8Array(bytes);
  const hash = await crypto.subtle.digest('SHA-256', input);
  const arr = new Uint8Array(hash);
  let hex = '';
  for (const b of arr) hex += b.toString(16).padStart(2, '0');
  return hex;
}

/** raw 32B → DID 哈希（64 hex） */
export async function computeDidV2HashFromRaw(rawPubkey: Uint8Array): Promise<string> {
  if (rawPubkey.length !== 32) {
    throw new Error(`DID requires 32-byte raw pubkey (got ${rawPubkey.length})`);
  }
  return sha256Hex(rawPubkey);
}

/** raw 32B → did:hailuo:<64hex> */
export async function pubkeyRawToDidV2(rawPubkey: Uint8Array): Promise<string> {
  const hash = await computeDidV2HashFromRaw(rawPubkey);
  return `${HAILUO_DID_PREFIX}${hash}`;
}

/** Ed25519 公钥 hex（64 字符）→ DID */
export async function pubkeyHexToDidV2(publicKeyHex: string): Promise<string> {
  return pubkeyRawToDidV2(hexToBytes(publicKeyHex));
}

/** 主入口：公钥 hex → DID */
export async function pubkeyToDid(publicKeyHex: string): Promise<string> {
  return pubkeyHexToDidV2(publicKeyHex);
}

/** 从 DID URI 解析 64 hex；非法或 sayfree / 旧 v2 前缀一律 null */
export function parseDidV2(did: string): string | null {
  const trimmed = did.trim().toLowerCase();
  // 中文注释：明确拒绝 sayfree 与旧 hailuo v2 前缀
  if (trimmed.startsWith('did:sayfree:')) return null;
  if (!trimmed.startsWith(HAILUO_DID_PREFIX)) return null;
  const hash = trimmed.slice(HAILUO_DID_PREFIX.length);
  if (!DID_HASH_RE.test(hash)) return null;
  return hash;
}

export type DidLookupResult = { pubkey: string; node_url: string };

/**
 * 解析 DID 并通过 lookupFn 查节点。
 * lookupFn 收到 64 hex 哈希（不含前缀）。
 */
export async function resolveDid(
  did: string,
  lookupFn: (didHash: string) => Promise<DidLookupResult | null>,
): Promise<DidLookupResult | null> {
  const hash = parseDidV2(did);
  if (!hash) return null;
  return lookupFn(hash);
}
