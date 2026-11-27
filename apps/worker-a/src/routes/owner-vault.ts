/**
 * M-VAULT-2 / VAULT-PRE-REG-KEY：站主保险箱外层包裹 GET/PUT。
 * Worker 只存 wrapped_vault_json，永不解密；明文 vault 仅在浏览器。
 * 存储键：有 users.handle 用 handle；否则 fp:<公钥指纹>（登记前可用）。
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env, AppVariables } from '../env';
import { resolveIdentityDb } from '../db/bindings';
import { resolveVaultOwnerKey } from '../lib/ownerVaultKey';

type AppEnv = { Bindings: Env; Variables: AppVariables };
type VaultContext = Context<AppEnv>;

/** 与私信 wrapped-key 同级上限，足够 AES-GCM 包裹 JSON */
const WRAPPED_VAULT_JSON_MAX = 8192;

export const ownerVaultApp = new Hono<AppEnv>();

function errorJson(
  c: VaultContext,
  status: 400 | 404 | 500,
  code: 'VAULT_NOT_FOUND' | 'VAULT_INVALID_BODY' | 'INTERNAL_ERROR',
  message: string,
): Response {
  // 字面量须出现在本文件，供 error-code-manifest 扫描 error_code: '…'
  if (code === 'VAULT_NOT_FOUND') {
    return c.json({ ok: false, error_code: 'VAULT_NOT_FOUND', message }, status);
  }
  if (code === 'VAULT_INVALID_BODY') {
    return c.json({ ok: false, error_code: 'VAULT_INVALID_BODY', message }, status);
  }
  return c.json({ ok: false, error_code: 'INTERNAL_ERROR', message }, status);
}

function parseWrappedVaultJson(value: unknown): string | null {
  const json = typeof value === 'string' ? value.trim() : JSON.stringify(value ?? {});
  if (!json || json.length > WRAPPED_VAULT_JSON_MAX) return null;
  return json;
}

function parseKeyVersion(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : 1;
}

// GET /api/owner/wrapped-vault — 无行 → 404 VAULT_NOT_FOUND
ownerVaultApp.get('/wrapped-vault', async (c) => {
  const ownerKey = await resolveVaultOwnerKey(c.env);
  if (!ownerKey) {
    return errorJson(c, 500, 'INTERNAL_ERROR', '节点未配置身份公钥，无法定位保险箱');
  }
  try {
    const row = await resolveIdentityDb(c.env)
      .prepare(
        `SELECT owner_handle, wrapped_vault_json, key_version, updated_at
           FROM owner_wrapped_vault
          WHERE owner_handle = ?`,
      )
      .bind(ownerKey.key)
      .first<{
        owner_handle: string;
        wrapped_vault_json: string;
        key_version: number;
        updated_at: string;
      }>();
    if (!row) {
      return errorJson(c, 404, 'VAULT_NOT_FOUND', '尚未创建保险箱外层包裹');
    }
    return c.json({
      ok: true,
      data: {
        wrapped_vault_json: row.wrapped_vault_json,
        key_version: row.key_version,
        updated_at: row.updated_at,
      },
    });
  } catch (err) {
    // 禁止日志打印 wrapped_vault_json / password
    console.error('[owner-vault] GET failed');
    return errorJson(c, 500, 'INTERNAL_ERROR', '读取保险箱失败，请稍后重试');
  }
});

// PUT /api/owner/wrapped-vault — 浏览器已 wrap，Worker 只存
ownerVaultApp.put('/wrapped-vault', async (c) => {
  let body: Record<string, unknown> | null = null;
  try {
    const raw = await c.req.json();
    body =
      raw && typeof raw === 'object' && !Array.isArray(raw)
        ? (raw as Record<string, unknown>)
        : null;
  } catch {
    body = null;
  }
  if (!body) return errorJson(c, 400, 'VAULT_INVALID_BODY', '请求体必须为 JSON');

  const wrappedVaultJson = parseWrappedVaultJson(body.wrapped_vault_json);
  if (!wrappedVaultJson) {
    return errorJson(c, 400, 'VAULT_INVALID_BODY', 'wrapped_vault_json 无效或过长');
  }
  const keyVersion = parseKeyVersion(body.key_version);
  const ownerKey = await resolveVaultOwnerKey(c.env);
  if (!ownerKey) {
    return errorJson(c, 500, 'INTERNAL_ERROR', '节点未配置身份公钥，无法写入保险箱');
  }

  const updatedAt = new Date().toISOString();
  try {
    await resolveIdentityDb(c.env)
      .prepare(
        `INSERT OR REPLACE INTO owner_wrapped_vault
         (owner_handle, wrapped_vault_json, key_version, updated_at)
         VALUES (?, ?, ?, ?)`,
      )
      .bind(ownerKey.key, wrappedVaultJson, keyVersion, updatedAt)
      .run();
  } catch (err) {
    console.error('[owner-vault] PUT failed');
    return errorJson(c, 500, 'INTERNAL_ERROR', '写入保险箱失败，请稍后重试');
  }

  return c.json({
    ok: true,
    data: {
      wrapped_vault_json: wrappedVaultJson,
      key_version: keyVersion,
      updated_at: updatedAt,
    },
  });
});
