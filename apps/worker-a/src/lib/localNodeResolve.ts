/**
 * M-OPT-1c · L1 本地节点解析（联系人优先）。
 *
 * 顺序：follows（已关注）→ cache_entries（历史精确 lookup）
 * 命中则不计 registry lookup 日配额，也不回源注册中心。
 */

import { resolveIdentityDb } from '../db/bindings';
import type { Env } from '../env';
import { resolveLocalPublicBaseUrl } from './localPublicBaseUrl';
import {
  canonicalizeHandleQualified,
  formatQualifiedHandle,
  handleQualifiedLookupKeys,
  isPrimaryRegistryId,
} from './handleQualified';

/** L1 / cache_entries TTL：≥7 日（计划 r3 §3.2） */
export const LOOKUP_CACHE_TTL_SECONDS = 7 * 24 * 60 * 60;

export type LocalLookupSource = 'l1_follows' | 'l1_cache';
/** 含 L0 本站 / L2/L3/L4；统一解析器成功响应用 */
export type NodeLookupSource = LocalLookupSource | 'l0_self' | 'l2_mutual' | 'l3_fof' | 'l4_registry';

/** 与 Worker A GET /api/lookup 成功 data 同形的最小字段（前端/关注可消费） */
export interface LocalLookupData {
  user_id: string;
  handle: string;
  node_url: string;
  worker_b_url: string | null;
  registry_status: string | null;
  health_status: string | null;
  pubkey_fingerprint: string;
  /** 便于排障：L1 / L4 来源 */
  resolve_source: NodeLookupSource;
  [key: string]: unknown;
}

function normalizeHandle(handle: string): string {
  return handle.trim().toLowerCase().replace(/^@+/, '');
}

/** 与搜人入口一致：下划线视同连字符，便于 BOOTSTRAP_HANDLE 与登记名对齐 */
function normalizeHandleKey(handle: string): string {
  return normalizeHandle(handle).replace(/_/g, '-');
}

function stripTrailingSlash(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

/**
 * L0：搜的是本站站主正式名时，直接回本节点公开入口，不耗 L4 配额、不依赖注册中心。
 * 覆盖 handle_qualified（主中心可为裸名）/ handle@registry_id / BOOTSTRAP 正规化名。
 */
export async function resolveOwnNodeByHandle(
  env: Env,
  handle: string,
): Promise<LocalLookupData | null> {
  const key = normalizeHandleKey(handle);
  if (!key) return null;

  const workerB = await resolveLocalPublicBaseUrl(env);
  if (!workerB) return null;

  try {
    const { results } = await resolveIdentityDb(env).prepare(
      `SELECT key, value FROM system_config
        WHERE key IN ('handle_qualified', 'owner_user_id', 'proof_pubkey_fingerprint', 'registered_registries')`,
    ).all<{ key: string; value: string }>();
    const map: Record<string, string> = {};
    for (const row of results ?? []) map[row.key] = row.value;

    const user = await resolveIdentityDb(env).prepare(
      `SELECT handle FROM users LIMIT 1`,
    ).first<{ handle: string }>();

    const candidates = new Set<string>();
    const hqRaw = map.handle_qualified?.trim() || '';
    const hq = hqRaw ? canonicalizeHandleQualified(hqRaw) : '';
    // 正式名（含主中心裸名）及其历史 @reg1 等价键
    if (hq) {
      for (const k of handleQualifiedLookupKeys(hq)) {
        candidates.add(normalizeHandleKey(k));
      }
    }

    const localHandle = (user?.handle || env.BOOTSTRAP_HANDLE || '').trim();
    const localNorm = localHandle
      ? normalizeHandleKey(localHandle.split('@')[0] || localHandle)
      : '';

    let registryId = '';
    try {
      const regs = JSON.parse(map.registered_registries || '[]') as unknown;
      if (Array.isArray(regs) && regs[0] && typeof regs[0] === 'object') {
        const id = (regs[0] as { registry_id?: string }).registry_id;
        if (typeof id === 'string' && id.trim()) registryId = id.trim().toLowerCase();
      }
    } catch {
      // ignore bad JSON
    }
    if (localNorm && registryId) {
      const synthesized = formatQualifiedHandle(localNorm, registryId);
      for (const k of handleQualifiedLookupKeys(synthesized)) {
        candidates.add(normalizeHandleKey(k));
      }
      // 主中心：裸 local 即正式名
      if (isPrimaryRegistryId(registryId)) {
        candidates.add(localNorm);
      }
    }

    if (!candidates.has(key)) return null;

    const displayHandle = hq ? normalizeHandle(hq) : key;
    return {
      user_id: map.owner_user_id?.trim() || '',
      handle: displayHandle,
      node_url: workerB,
      worker_b_url: workerB,
      registry_status: 'active',
      health_status: null,
      pubkey_fingerprint: map.proof_pubkey_fingerprint?.trim() || '',
      resolve_source: 'l0_self',
    };
  } catch (err) {
    console.error('[localNodeResolve] 本站自查失败', err);
    return null;
  }
}

function isoNow(): string {
  return new Date().toISOString();
}

export function isoLookupCacheExpiry(nowMs = Date.now()): string {
  return new Date(nowMs + LOOKUP_CACHE_TTL_SECONDS * 1000).toISOString();
}

/**
 * 从 follows 按 handle 解析公开节点 URL（不回源）。
 * handle 为空的旧关注行无法命中本路径。
 */
export async function resolveHandleFromFollows(
  env: Env,
  handle: string,
): Promise<LocalLookupData | null> {
  const key = normalizeHandle(handle);
  if (!key) return null;

  try {
    const row = await resolveIdentityDb(env).prepare(
      `SELECT follower_node_url, followed_handle, followed_worker_b_url, followed_display_name
         FROM follows
        WHERE lower(followed_handle) = ?
        LIMIT 1`,
    )
      .bind(key)
      .first<{
        follower_node_url: string;
        followed_handle: string | null;
        followed_worker_b_url: string | null;
        followed_display_name: string | null;
      }>();

    if (!row?.follower_node_url?.trim()) return null;

    const nodeUrl = (row.followed_worker_b_url || row.follower_node_url).trim().replace(/\/+$/, '');
    if (!nodeUrl) return null;

    return {
      user_id: '',
      handle: (row.followed_handle || key).trim(),
      node_url: nodeUrl,
      worker_b_url: nodeUrl,
      registry_status: null,
      health_status: null,
      pubkey_fingerprint: '',
      display_name: row.followed_display_name || '',
      resolve_source: 'l1_follows',
    };
  } catch (err) {
    console.error('[localNodeResolve] follows 查询失败', err);
    return null;
  }
}

/** 从 cache_entries 读取未过期条目（不回源、不扣配额）。 */
export async function resolveHandleFromCacheEntries(
  env: Env,
  handle: string,
): Promise<LocalLookupData | null> {
  const key = normalizeHandle(handle);
  if (!key) return null;

  try {
    const row = await resolveIdentityDb(env).prepare(
      `SELECT response_json FROM cache_entries
        WHERE lower(handle) = ? AND expires_at > ?
        LIMIT 1`,
    )
      .bind(key, isoNow())
      .first<{ response_json: string }>();

    if (!row?.response_json) return null;

    const data = JSON.parse(row.response_json) as Record<string, unknown>;
    const nodeUrl = String(data.worker_b_url || data.node_url || '').trim();
    if (!nodeUrl) return null;

    return {
      ...data,
      user_id: String(data.user_id ?? ''),
      handle: String(data.handle ?? key),
      node_url: String(data.node_url ?? nodeUrl),
      worker_b_url: (data.worker_b_url as string | null | undefined) ?? nodeUrl,
      registry_status: (data.registry_status as string | null | undefined) ?? null,
      health_status: (data.health_status as string | null | undefined) ?? null,
      pubkey_fingerprint: String(data.pubkey_fingerprint ?? ''),
      resolve_source: 'l1_cache',
    };
  } catch (err) {
    console.error('[localNodeResolve] cache_entries 查询失败', err);
    return null;
  }
}

/** L1 总入口：follows → cache_entries。 */
export async function resolveHandleFromL1(
  env: Env,
  handle: string,
): Promise<LocalLookupData | null> {
  const fromFollows = await resolveHandleFromFollows(env, handle);
  if (fromFollows) return fromFollows;
  return resolveHandleFromCacheEntries(env, handle);
}

/**
 * 关注成功或 lookup 回源成功后写入 / 刷新 cache_entries（7 日 TTL）。
 * 失败 fail-soft，不抛给调用方。
 */
export async function upsertLookupCacheEntry(
  env: Env,
  data: {
    handle: string;
    user_id?: string;
    node_url: string;
    worker_b_url?: string | null;
    pubkey_fingerprint?: string;
    registry_status?: string | null;
    health_status?: string | null;
    response_json?: string;
  },
): Promise<void> {
  const handle = normalizeHandle(data.handle);
  const nodeUrl = data.node_url.trim().replace(/\/+$/, '');
  if (!handle || !nodeUrl) return;

  const now = isoNow();
  const expiresAt = isoLookupCacheExpiry();
  const workerB = (data.worker_b_url || nodeUrl).trim().replace(/\/+$/, '');
  const payload =
    data.response_json ??
    JSON.stringify({
      user_id: data.user_id ?? '',
      handle,
      node_url: nodeUrl,
      worker_b_url: workerB,
      registry_status: data.registry_status ?? null,
      health_status: data.health_status ?? null,
      pubkey_fingerprint: data.pubkey_fingerprint ?? '',
      resolve_source: 'l1_follows',
    });

  try {
    await resolveIdentityDb(env).prepare(
      `INSERT OR REPLACE INTO cache_entries
         (handle, user_id, node_url, worker_b_url, pubkey_fingerprint,
          registry_status, health_status, response_json, fetched_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        handle,
        data.user_id ?? '',
        nodeUrl,
        workerB,
        data.pubkey_fingerprint ?? '',
        data.registry_status ?? null,
        data.health_status ?? null,
        payload,
        now,
        expiresAt,
      )
      .run();
  } catch (err) {
    console.error('[localNodeResolve] cache_entries 写入失败', err);
  }
}
