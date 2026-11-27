/**
 * VAULT-PRE-REG-KEY：保险箱外层存储键解析与登记迁键。
 * - 有 users.handle → 用 handle
 * - 否则 → fp:<SHA-256(utf8(规范化公钥 hex)) 前 32 hex>
 * Worker 永不接触 vault 明文 / password。
 */
import type { Env } from '../env';
import { resolveIdentityDb } from '../db/bindings';

export const VAULT_PUBKEY_FP_PREFIX = 'fp:' as const;

export type VaultOwnerKeyKind = 'handle' | 'pubkey_fp';

export type VaultOwnerKey = {
  readonly kind: VaultOwnerKeyKind;
  readonly key: string;
};

/** 规范化 Ed25519 公钥 hex：小写、去 0x；非法则 null */
export function normalizeEd25519PubkeyHex(raw: string | undefined | null): string | null {
  if (raw == null) return null;
  let s = String(raw).trim().toLowerCase();
  if (s.startsWith('0x')) s = s.slice(2);
  if (!/^[0-9a-f]{64}$/.test(s)) return null;
  return s;
}

/**
 * 计划钉死算法：SHA-256(utf8(64hex)) → 小写 hex 前 32 字符。
 * 与 registry `key_<16hex>` 指纹不同用途，禁止混用。
 */
export async function vaultPubkeyFpSuffix(pubkeyHexNormalized: string): Promise<string> {
  const data = new TextEncoder().encode(pubkeyHexNormalized);
  const hash = await crypto.subtle.digest('SHA-256', data);
  const bytes = new Uint8Array(hash);
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex.slice(0, 32);
}

export function formatVaultPubkeyFpKey(fpSuffix: string): string {
  return `${VAULT_PUBKEY_FP_PREFIX}${fpSuffix}`;
}

export async function vaultOwnerKeyFromPubkeyEnv(
  ed25519PublicKey: string | undefined | null,
): Promise<VaultOwnerKey | null> {
  const normalized = normalizeEd25519PubkeyHex(ed25519PublicKey);
  if (!normalized) return null;
  const suffix = await vaultPubkeyFpSuffix(normalized);
  return { kind: 'pubkey_fp', key: formatVaultPubkeyFpKey(suffix) };
}

async function readLocalUserHandle(env: Env): Promise<string | null> {
  const row = await resolveIdentityDb(env)
    .prepare(`SELECT handle FROM users LIMIT 1`)
    .first<{ handle: string }>();
  const handle = row?.handle?.trim();
  return handle ? handle : null;
}

/**
 * 将指纹键行迁到 users.handle。
 * 若 handle 行已存在：以指纹行密文覆盖 handle 行后删指纹行（禁止静默丢密文）。
 */
export async function migrateOwnerWrappedVaultFpToHandle(
  env: Env,
  newHandle: string,
): Promise<{ migrated: boolean; reason: string }> {
  const handle = String(newHandle || '').trim();
  if (!handle) return { migrated: false, reason: 'empty_handle' };

  const fpKey = await vaultOwnerKeyFromPubkeyEnv(env.ED25519_PUBLIC_KEY);
  if (!fpKey) return { migrated: false, reason: 'no_pubkey' };

  const db = resolveIdentityDb(env);
  const fpRow = await db
    .prepare(
      `SELECT wrapped_vault_json, key_version, updated_at
         FROM owner_wrapped_vault
        WHERE owner_handle = ?`,
    )
    .bind(fpKey.key)
    .first<{ wrapped_vault_json: string; key_version: number; updated_at: string }>();

  if (!fpRow) return { migrated: false, reason: 'no_fp_row' };

  const handleRow = await db
    .prepare(`SELECT owner_handle FROM owner_wrapped_vault WHERE owner_handle = ?`)
    .bind(handle)
    .first<{ owner_handle: string }>();

  if (handleRow) {
    // 指纹行有密文 → 覆盖到 handle，再删指纹行
    await db.batch([
      db
        .prepare(
          `INSERT OR REPLACE INTO owner_wrapped_vault
           (owner_handle, wrapped_vault_json, key_version, updated_at)
           VALUES (?, ?, ?, ?)`,
        )
        .bind(handle, fpRow.wrapped_vault_json, fpRow.key_version, fpRow.updated_at),
      db.prepare(`DELETE FROM owner_wrapped_vault WHERE owner_handle = ?`).bind(fpKey.key),
    ]);
  } else {
    await db
      .prepare(`UPDATE owner_wrapped_vault SET owner_handle = ? WHERE owner_handle = ?`)
      .bind(handle, fpKey.key)
      .run();
  }

  // 禁止日志打印 wrapped JSON
  console.log('[owner-vault] migrated vault key pubkey_fp → handle');
  return { migrated: true, reason: 'ok' };
}

/** 解析当前节点外层主键；无公钥且无 handle → null（调用方 500） */
export async function resolveVaultOwnerKey(env: Env): Promise<VaultOwnerKey | null> {
  const handle = await readLocalUserHandle(env);
  if (handle) {
    // 补偿：登记时迁键失败则在后续读写前再试
    try {
      await migrateOwnerWrappedVaultFpToHandle(env, handle);
    } catch {
      console.error('[owner-vault] migrate fp→handle compensation failed');
    }
    return { kind: 'handle', key: handle };
  }
  return vaultOwnerKeyFromPubkeyEnv(env.ED25519_PUBLIC_KEY);
}
