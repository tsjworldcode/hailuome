/**
 * M9-3-CL4：最近一次 L4 联邦 lookup 摘要（D1 system_config，低频写）。
 * 供 Settings 诊断展示 home/via/stale；不存 peer 拓扑。
 */

import type { Env } from '../env';
import { resolveIdentityDb } from '../db/bindings';

export const FEDERATION_LAST_LOOKUP_KEY = 'federation_last_lookup_json';

export interface FederationLastLookupSnapshot {
  handle: string;
  home_registry_id: string | null;
  resolved_via_registry_id: string | null;
  route_version: number | null;
  route_stale: boolean | null;
  error_code: string | null;
  http_status: number;
  at: string;
}

export async function writeFederationLastLookup(
  env: Env,
  snap: FederationLastLookupSnapshot,
): Promise<void> {
  const now = snap.at || new Date().toISOString();
  const value = JSON.stringify({ ...snap, at: now });
  // A-5c-2：system_config 在 IDENTITY_DB（M-OPT-SPLIT-2 §3.3）
  const identityDb = resolveIdentityDb(env);
  try {
    await identityDb.prepare(
      `INSERT INTO system_config (key, value, updated_at) VALUES (?1, ?2, ?3)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
      .bind(FEDERATION_LAST_LOOKUP_KEY, value, now)
      .run();
  } catch (err) {
    console.warn('[federation/last_lookup] 写 system_config 失败', err);
  }
}

export async function readFederationLastLookup(
  env: Env,
): Promise<FederationLastLookupSnapshot | null> {
  // A-5c-2：同上
  const identityDb = resolveIdentityDb(env);
  try {
    const row = await identityDb.prepare(
      `SELECT value FROM system_config WHERE key = ?1 LIMIT 1`,
    )
      .bind(FEDERATION_LAST_LOOKUP_KEY)
      .first<{ value: string }>();
    if (!row?.value?.trim()) return null;
    const parsed = JSON.parse(row.value) as Partial<FederationLastLookupSnapshot>;
    if (typeof parsed.handle !== 'string') return null;
    return {
      handle: parsed.handle,
      home_registry_id:
        typeof parsed.home_registry_id === 'string' ? parsed.home_registry_id : null,
      resolved_via_registry_id:
        typeof parsed.resolved_via_registry_id === 'string'
          ? parsed.resolved_via_registry_id
          : null,
      route_version:
        typeof parsed.route_version === 'number' ? parsed.route_version : null,
      route_stale:
        typeof parsed.route_stale === 'boolean' ? parsed.route_stale : null,
      error_code: typeof parsed.error_code === 'string' ? parsed.error_code : null,
      http_status: typeof parsed.http_status === 'number' ? parsed.http_status : 0,
      at: typeof parsed.at === 'string' ? parsed.at : '',
    };
  } catch {
    return null;
  }
}
