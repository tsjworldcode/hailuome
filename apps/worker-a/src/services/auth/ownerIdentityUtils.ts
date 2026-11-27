/**
 * NCF-2B-4：站主登记身份解析（adapter 层；可含 Env，核心 runGetOwnerMe 不直接引用）。
 */
import { resolveIdentityDb } from '../../db/bindings';
import {
  computePubkeyFingerprint,
  ed25519PubkeyHexToRegistryBase64,
  pubkeyHexToDidV2,
} from '@hailuo/shared-crypto';
import type { Env } from '../../env';
import { readRegisteredRegistries } from '../../lib/registeredRegistries';
import {
  canonicalizeHandleQualified,
  formatQualifiedHandle,
} from '../../lib/handleQualified';

export type OwnerRegistryIdentity = {
  userId: string;
  pubkeyFingerprint: string;
  didV2: string;
  handleQualified: string;
};

export async function loadOwnerRegistryIdentity(env: Env): Promise<OwnerRegistryIdentity> {
  const { results } = await resolveIdentityDb(env)
    .prepare(
      `SELECT key, value FROM system_config
        WHERE key IN ('owner_user_id', 'proof_pubkey_fingerprint', 'did_v2', 'handle_qualified')`,
    )
    .all<{ key: string; value: string }>();
  const map: Record<string, string> = {};
  for (const row of results ?? []) map[row.key] = row.value;
  return {
    userId: map.owner_user_id ?? '',
    pubkeyFingerprint: map.proof_pubkey_fingerprint ?? '',
    didV2: map.did_v2 ?? '',
    handleQualified: map.handle_qualified?.trim() ?? '',
  };
}

/** 正式名：优先 system_config；缺失时按主中心裸名 / 其它中心 @id 合成（M9-PH-1） */
export async function resolveOwnerHandleQualified(
  env: Env,
  handle: string,
  cached: string,
): Promise<string> {
  if (cached) return canonicalizeHandleQualified(cached);
  const local = handle.trim().toLowerCase().split('@')[0] || '';
  if (!local) return '';
  try {
    const regs = await readRegisteredRegistries(resolveIdentityDb(env));
    const registryId = regs[0]?.registry_id?.trim();
    if (registryId) return formatQualifiedHandle(local, registryId);
  } catch {
    // 合成失败时不阻断 /auth/me
  }
  return '';
}

export async function resolvePubkeyFingerprint(
  env: Env,
  pubkeyHex: string,
  cachedFingerprint?: string,
): Promise<string> {
  const identity = cachedFingerprint !== undefined
    ? { pubkeyFingerprint: cachedFingerprint }
    : await loadOwnerRegistryIdentity(env);
  if (!pubkeyHex) return '';
  try {
    // 注册中心按 base64 形式的 raw Ed25519 公钥计算指纹；这里用同一输入重算，避免旧节点缓存了 hex 指纹。
    return await computePubkeyFingerprint(ed25519PubkeyHexToRegistryBase64(pubkeyHex));
  } catch {
    return identity.pubkeyFingerprint;
  }
}

/** 优先读登记落库的 did_v2；缺失时用公钥派生，保证个人主页可展示 DID。 */
export async function resolveOwnerDidV2(cachedDid: string, pubkeyHex: string): Promise<string> {
  if (cachedDid) return cachedDid;
  if (!pubkeyHex) return '';
  try {
    return await pubkeyHexToDidV2(pubkeyHex);
  } catch {
    return '';
  }
}
