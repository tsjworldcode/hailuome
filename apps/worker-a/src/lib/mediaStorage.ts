/**
 * M5-B2 / M5-FB：媒体存储 D1 权威配置 + STATE_KV 运行态同步。
 * backend 选择仍用 system_config.images_storage（kv | b2 | filebase | r2）。
 */
import type { Env } from '../env';
import type { B2Config } from './b2upload';
import type { FilebaseConfig } from './filebaseupload';
import { resolveFilebaseRegion } from './filebaseupload';
import { resolveGovernanceDb, resolveIdentityDb } from '../db/bindings';

/** Worker B 读 B2 私有代理所需 JSON；含密钥，永不对公网暴露 */
export const MEDIA_B2_CONFIG_KV_KEY = 'node:media_b2_config';
export const MEDIA_B2_CONFIG_D1_ID = 'b2';

/** Worker B 读 Filebase 私有代理所需 JSON */
export const MEDIA_FILEBASE_CONFIG_KV_KEY = 'node:media_filebase_config';
export const MEDIA_FILEBASE_CONFIG_D1_ID = 'filebase';

export type ImagesStorageBackend = 'kv' | 'b2' | 'filebase' | 'r2';

/** D1 config_json 形态 */
export interface StoredB2Config {
  key_id: string;
  app_key: string;
  bucket_name: string;
  endpoint: string;
  region?: string;
}

export interface SanitizedB2Config {
  key_id: string;
  app_key_set: boolean;
  bucket_name: string;
  endpoint: string;
  region?: string;
}

/** Filebase D1 config_json 与 B2 同形 */
export type StoredFilebaseConfig = StoredB2Config;
export type SanitizedFilebaseConfig = SanitizedB2Config;

function nowIso(): string {
  return new Date().toISOString();
}

export function isStoredB2ConfigComplete(cfg: Partial<StoredB2Config> | null | undefined): cfg is StoredB2Config {
  return !!(
    cfg?.key_id?.trim() &&
    cfg?.app_key?.trim() &&
    cfg?.bucket_name?.trim() &&
    cfg?.endpoint?.trim()
  );
}

export function parseStoredB2Config(raw: string | null | undefined): StoredB2Config | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<StoredB2Config>;
    if (!isStoredB2ConfigComplete(parsed)) return null;
    const out: StoredB2Config = {
      key_id: parsed.key_id.trim(),
      app_key: parsed.app_key.trim(),
      bucket_name: parsed.bucket_name.trim(),
      endpoint: parsed.endpoint.trim(),
    };
    if (typeof parsed.region === 'string' && parsed.region.trim()) {
      out.region = parsed.region.trim();
    }
    return out;
  } catch {
    return null;
  }
}

export const isStoredFilebaseConfigComplete = isStoredB2ConfigComplete;

export function toB2UploadConfig(stored: StoredB2Config): B2Config {
  return {
    keyId: stored.key_id,
    appKey: stored.app_key,
    bucketName: stored.bucket_name,
    endpoint: stored.endpoint,
    region: stored.region,
  };
}

export function sanitizeB2Config(stored: StoredB2Config | null): SanitizedB2Config | null {
  if (!stored) return null;
  return {
    key_id: stored.key_id,
    app_key_set: !!stored.app_key,
    bucket_name: stored.bucket_name,
    endpoint: stored.endpoint,
    ...(stored.region ? { region: stored.region } : {}),
  };
}

export const sanitizeFilebaseConfig = sanitizeB2Config;
export const parseStoredFilebaseConfig = parseStoredB2Config;

export function toFilebaseUploadConfig(stored: StoredFilebaseConfig): FilebaseConfig {
  return {
    keyId: stored.key_id,
    appKey: stored.app_key,
    bucketName: stored.bucket_name,
    endpoint: stored.endpoint,
    region: stored.region,
  };
}

/** KV 同步用：与 StoredB2Config 同形，供 Worker B 签名 GET */
export function storedB2ConfigForKv(stored: StoredB2Config): StoredB2Config {
  return stored;
}

export async function readImagesStorage(env: Env): Promise<ImagesStorageBackend> {
  // images_storage 在 system_config（IDENTITY_DB）
  const db = resolveIdentityDb(env);
  try {
    const row = await db
      .prepare(`SELECT value FROM system_config WHERE key = 'images_storage' LIMIT 1`)
      .first<{ value: string }>();
    if (row?.value === 'b2' || row?.value === 'r2' || row?.value === 'filebase') return row.value;
  } catch (err) {
    console.error('[mediaStorage] 读 images_storage 失败，回落 kv', err);
  }
  return 'kv';
}

export async function readB2ProbeStatus(env: Env): Promise<string> {
  // b2_probe_status 在 system_config（IDENTITY_DB）
  const db = resolveIdentityDb(env);
  try {
    const row = await db
      .prepare(`SELECT value FROM system_config WHERE key = 'b2_probe_status' LIMIT 1`)
      .first<{ value: string }>();
    return row?.value ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

export async function readStoredB2ConfigFromD1(env: Env): Promise<StoredB2Config | null> {
  const db = resolveGovernanceDb(env);
  try {
    const row = await db
      .prepare(`SELECT config_json FROM media_storage_config WHERE id = ? LIMIT 1`)
      .bind(MEDIA_B2_CONFIG_D1_ID)
      .first<{ config_json: string }>();
    return parseStoredB2Config(row?.config_json);
  } catch (err) {
    console.error('[mediaStorage] 读 D1 B2 配置失败', err);
    return null;
  }
}
export function readB2ConfigFromEnv(env: Env): StoredB2Config | null {
  if (!env.B2_KEY_ID || !env.B2_APP_KEY || !env.B2_BUCKET_NAME || !env.B2_ENDPOINT) {
    return null;
  }
  const cfg: StoredB2Config = {
    key_id: env.B2_KEY_ID,
    app_key: env.B2_APP_KEY,
    bucket_name: env.B2_BUCKET_NAME,
    endpoint: env.B2_ENDPOINT,
  };
  if (env.B2_REGION?.trim()) cfg.region = env.B2_REGION.trim();
  return cfg;
}

export async function resolveB2Config(env: Env): Promise<StoredB2Config | null> {
  const fromD1 = await readStoredB2ConfigFromD1(env);
  if (fromD1) return fromD1;
  return readB2ConfigFromEnv(env);
}

export async function syncB2ConfigToKv(env: Env, stored: StoredB2Config): Promise<void> {
  await env.STATE_KV.put(MEDIA_B2_CONFIG_KV_KEY, JSON.stringify(storedB2ConfigForKv(stored)));
}

export async function clearB2ConfigFromKv(env: Env): Promise<void> {
  await env.STATE_KV.delete(MEDIA_B2_CONFIG_KV_KEY);
}

/**
 * B2 轻量探针：PUT 1 字节 → DELETE（与 cron probeB2 同形）。
 * PATCH 保存与 Cron 共用。
 */
export async function probeB2WithConfig(stored: StoredB2Config): Promise<void> {
  const { AwsClient } = await import('aws4fetch');
  const upload = toB2UploadConfig(stored);
  const region =
    upload.region ??
    upload.endpoint.match(/s3\.([^.]+)\.backblazeb2\.com/)?.[1] ??
    'us-east-1';
  const aws = new AwsClient({
    accessKeyId: upload.keyId,
    secretAccessKey: upload.appKey,
    service: 's3',
    region,
  });

  const probeKey = `_probe_${Date.now()}`;
  const baseUrl = `${upload.endpoint}/${upload.bucketName}/${probeKey}`;

  const putRes = await aws.fetch(baseUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Length': '1',
      'x-amz-content-sha256': 'UNSIGNED-PAYLOAD',
    },
    body: new Uint8Array([0x00]),
  });
  if (!putRes.ok) {
    throw new Error(`B2 PUT ${putRes.status}: ${(await putRes.text()).slice(0, 200)}`);
  }

  const delRes = await aws.fetch(baseUrl, { method: 'DELETE' });
  if (!delRes.ok && delRes.status !== 404) {
    throw new Error(`B2 DELETE ${delRes.status}: ${(await delRes.text()).slice(0, 200)}`);
  }
}

export async function writeB2ProbeStatus(env: Env, status: string): Promise<void> {
  // b2_probe_status 在 system_config（IDENTITY_DB）
  const db = resolveIdentityDb(env);
  await db
    .prepare(
      `INSERT OR REPLACE INTO system_config (key, value, updated_at) VALUES ('b2_probe_status', ?, ?)`,
    )
    .bind(status, nowIso())
    .run();
}

export async function persistB2ConfigD1(
  env: Env,
  stored: StoredB2Config,
  probeStatus: string,
): Promise<void> {
  // media_storage_config 在 GOVERNANCE_DB；system_config（b2_probe_status）在 IDENTITY_DB
  // 跨库 D1 batch 不支持，拆为顺序写（best-effort；单边失败不影响另一边）
  const govDb = resolveGovernanceDb(env);
  const idDb = resolveIdentityDb(env);
  const iso = nowIso();
  await govDb
    .prepare(
      `INSERT OR REPLACE INTO media_storage_config (id, config_json, updated_at) VALUES (?, ?, ?)`,
    )
    .bind(MEDIA_B2_CONFIG_D1_ID, JSON.stringify(stored), iso)
    .run();
  await idDb
    .prepare(
      `INSERT OR REPLACE INTO system_config (key, value, updated_at) VALUES ('b2_probe_status', ?, ?)`,
    )
    .bind(probeStatus, iso)
    .run();
}

export async function setImagesStorage(env: Env, backend: ImagesStorageBackend): Promise<void> {
  // system_config 在 IDENTITY_DB
  const db = resolveIdentityDb(env);
  await db
    .prepare(
      `INSERT OR REPLACE INTO system_config (key, value, updated_at) VALUES ('images_storage', ?, ?)`,
    )
    .bind(backend, nowIso())
    .run();
}

export async function clearB2ConfigD1(env: Env): Promise<void> {
  // media_storage_config 在 GOVERNANCE_DB；system_config（b2_probe_status）在 IDENTITY_DB
  const govDb = resolveGovernanceDb(env);
  const idDb = resolveIdentityDb(env);
  const iso = nowIso();
  await govDb
    .prepare(
      `INSERT OR REPLACE INTO media_storage_config (id, config_json, updated_at) VALUES (?, ?, ?)`,
    )
    .bind(MEDIA_B2_CONFIG_D1_ID, '{}', iso)
    .run();
  await idDb
    .prepare(
      `INSERT OR REPLACE INTO system_config (key, value, updated_at) VALUES ('b2_probe_status', ?, ?)`,
    )
    .bind('unconfigured', iso)
    .run();
}

// ---------------------------------------------------------------------------
// Filebase（M5-FB）
// ---------------------------------------------------------------------------

export async function readFilebaseProbeStatus(env: Env): Promise<string> {
  // filebase_probe_status 在 system_config（IDENTITY_DB）
  const db = resolveIdentityDb(env);
  try {
    const row = await db
      .prepare(`SELECT value FROM system_config WHERE key = 'filebase_probe_status' LIMIT 1`)
      .first<{ value: string }>();
    return row?.value ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

export async function readStoredFilebaseConfigFromD1(env: Env): Promise<StoredFilebaseConfig | null> {
  const db = resolveGovernanceDb(env);
  try {
    const row = await db
      .prepare(`SELECT config_json FROM media_storage_config WHERE id = ? LIMIT 1`)
      .bind(MEDIA_FILEBASE_CONFIG_D1_ID)
      .first<{ config_json: string }>();
    return parseStoredFilebaseConfig(row?.config_json);
  } catch (err) {
    console.error('[mediaStorage] 读 D1 Filebase 配置失败', err);
    return null;
  }
}

export async function resolveFilebaseConfig(env: Env): Promise<StoredFilebaseConfig | null> {
  return readStoredFilebaseConfigFromD1(env);
}

export async function syncFilebaseConfigToKv(env: Env, stored: StoredFilebaseConfig): Promise<void> {
  await env.STATE_KV.put(MEDIA_FILEBASE_CONFIG_KV_KEY, JSON.stringify(stored));
}

export async function clearFilebaseConfigFromKv(env: Env): Promise<void> {
  await env.STATE_KV.delete(MEDIA_FILEBASE_CONFIG_KV_KEY);
}

export async function probeFilebaseWithConfig(stored: StoredFilebaseConfig): Promise<void> {
  const { AwsClient } = await import('aws4fetch');
  const upload = toFilebaseUploadConfig(stored);
  const aws = new AwsClient({
    accessKeyId: upload.keyId,
    secretAccessKey: upload.appKey,
    service: 's3',
    region: resolveFilebaseRegion(upload),
  });

  const probeKey = `_probe_${Date.now()}`;
  const baseUrl = `${upload.endpoint}/${upload.bucketName}/${probeKey}`;

  const putRes = await aws.fetch(baseUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Length': '1',
      'x-amz-content-sha256': 'UNSIGNED-PAYLOAD',
    },
    body: new Uint8Array([0x00]),
  });
  if (!putRes.ok) {
    throw new Error(`Filebase PUT ${putRes.status}: ${(await putRes.text()).slice(0, 200)}`);
  }

  const delRes = await aws.fetch(baseUrl, { method: 'DELETE' });
  if (!delRes.ok && delRes.status !== 404) {
    throw new Error(`Filebase DELETE ${delRes.status}: ${(await delRes.text()).slice(0, 200)}`);
  }
}

export async function writeFilebaseProbeStatus(env: Env, status: string): Promise<void> {
  // filebase_probe_status 在 system_config（IDENTITY_DB）
  const db = resolveIdentityDb(env);
  await db
    .prepare(
      `INSERT OR REPLACE INTO system_config (key, value, updated_at) VALUES ('filebase_probe_status', ?, ?)`,
    )
    .bind(status, nowIso())
    .run();
}

export async function persistFilebaseConfigD1(
  env: Env,
  stored: StoredFilebaseConfig,
  probeStatus: string,
): Promise<void> {
  // media_storage_config 在 GOVERNANCE_DB；system_config（filebase_probe_status）在 IDENTITY_DB
  const govDb = resolveGovernanceDb(env);
  const idDb = resolveIdentityDb(env);
  const iso = nowIso();
  await govDb
    .prepare(
      `INSERT OR REPLACE INTO media_storage_config (id, config_json, updated_at) VALUES (?, ?, ?)`,
    )
    .bind(MEDIA_FILEBASE_CONFIG_D1_ID, JSON.stringify(stored), iso)
    .run();
  await idDb
    .prepare(
      `INSERT OR REPLACE INTO system_config (key, value, updated_at) VALUES ('filebase_probe_status', ?, ?)`,
    )
    .bind(probeStatus, iso)
    .run();
}

export async function clearFilebaseConfigD1(env: Env): Promise<void> {
  // media_storage_config 在 GOVERNANCE_DB；system_config（filebase_probe_status）在 IDENTITY_DB
  const govDb = resolveGovernanceDb(env);
  const idDb = resolveIdentityDb(env);
  const iso = nowIso();
  await govDb
    .prepare(
      `INSERT OR REPLACE INTO media_storage_config (id, config_json, updated_at) VALUES (?, ?, ?)`,
    )
    .bind(MEDIA_FILEBASE_CONFIG_D1_ID, '{}', iso)
    .run();
  await idDb
    .prepare(
      `INSERT OR REPLACE INTO system_config (key, value, updated_at) VALUES ('filebase_probe_status', ?, ?)`,
    )
    .bind('unconfigured', iso)
    .run();
}

export function isHttpsUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:';
  } catch {
    return false;
  }
}
