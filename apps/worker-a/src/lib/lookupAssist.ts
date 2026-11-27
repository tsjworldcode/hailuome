/**
 * M-OPT-8b / 8c：节点间 handle 协助（L2 互粉 + L3 有限 FoF）。
 *
 * - L2：问已关注联系人「你 L1 是否认识 @handle？」
 * - L3：问联系人「你或你的联系人（再 1 跳 L1）是否认识？」——对端 fof 应答时只做 L1→L2，禁止再 FoF。
 * - 绝不回源注册中心；配额记 D1，不计 lookup_day。
 */

import type { Env } from '../env';
import { isManualRedirectStatus, OUTBOUND_PEER_UA, resolveSafeOutboundPeerUrl } from './fetchOutboundPeer';
import { resolveIdentityDb } from '../db/bindings';
import {
  LOOKUP_CACHE_TTL_SECONDS,
  resolveHandleFromL1,
  upsertLookupCacheEntry,
  type LocalLookupData,
  type NodeLookupSource,
} from './localNodeResolve';

/** 单次解析最多询问的联系人数（子请求预算） */
export const LOOKUP_L2_MAX_PEERS = 5;
export const LOOKUP_L3_MAX_PEERS = 5;
/** 单个对端超时（毫秒）；L3 略长因对端可能再问一层 */
export const LOOKUP_L2_PEER_TIMEOUT_MS = 2000;
export const LOOKUP_L3_PEER_TIMEOUT_MS = 3000;

export const LOOKUP_ASSIST_IN_DAY_LIMIT_DEFAULT = 200;
export const LOOKUP_ASSIST_OUT_DAY_LIMIT_DEFAULT = 50;
export const LOOKUP_L3_FOF_IN_DAY_LIMIT_DEFAULT = 100;
export const LOOKUP_L3_FOF_OUT_DAY_LIMIT_DEFAULT = 20;

export type AssistQuotaScope =
  | 'l2_assist_in_day'
  | 'l2_assist_out_day'
  | 'l3_fof_in_day'
  | 'l3_fof_out_day';

export type AssistAskMode = 'l1' | 'fof';

/** 默认开：未配置或非显式 false 均视为启用（海螺节点默认设置）。 */
export function isLookupL2MutualAssistEnabled(env: Env): boolean {
  const v = (env.LOOKUP_L2_MUTUAL_ASSIST_ENABLED ?? 'true').trim().toLowerCase();
  return v !== 'false' && v !== '0' && v !== 'off' && v !== 'no';
}

/** L3 FoF：海螺节点默认开；显式 false / 0 / off / no 关闭。 */
export function isLookupL3FofEnabled(env: Env): boolean {
  const v = (env.LOOKUP_L3_FOF_ENABLED ?? 'true').trim().toLowerCase();
  return v !== 'false' && v !== '0' && v !== 'off' && v !== 'no';
}

function parsePositiveLimit(raw: string | undefined, fallback: number): number {
  if (!raw?.trim()) return fallback;
  const n = parseInt(raw.trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function assistDayBucket(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

function assistLimit(env: Env, scope: AssistQuotaScope): number {
  switch (scope) {
    case 'l2_assist_in_day':
      return parsePositiveLimit(env.LOOKUP_ASSIST_IN_DAY_LIMIT, LOOKUP_ASSIST_IN_DAY_LIMIT_DEFAULT);
    case 'l2_assist_out_day':
      return parsePositiveLimit(env.LOOKUP_ASSIST_OUT_DAY_LIMIT, LOOKUP_ASSIST_OUT_DAY_LIMIT_DEFAULT);
    case 'l3_fof_in_day':
      return parsePositiveLimit(env.LOOKUP_L3_FOF_IN_DAY_LIMIT, LOOKUP_L3_FOF_IN_DAY_LIMIT_DEFAULT);
    case 'l3_fof_out_day':
      return parsePositiveLimit(env.LOOKUP_L3_FOF_OUT_DAY_LIMIT, LOOKUP_L3_FOF_OUT_DAY_LIMIT_DEFAULT);
    default:
      return LOOKUP_ASSIST_OUT_DAY_LIMIT_DEFAULT;
  }
}

/** D1 原子扣减；满额返回 false（fail-closed）。 */
export async function tryConsumeAssistQuota(
  env: Env,
  scope: AssistQuotaScope,
): Promise<boolean> {
  const limit = assistLimit(env, scope);
  const bucket = assistDayBucket();
  const nowIso = new Date().toISOString();
  try {
    // registry_quota_buckets → IDENTITY_DB（migrations-identity/0012；拆库勘误后统一）
    const result = await resolveIdentityDb(env).prepare(
      `INSERT INTO registry_quota_buckets (scope, bucket, count, updated_at)
       VALUES (?1, ?2, 1, ?3)
       ON CONFLICT(scope, bucket) DO UPDATE SET
         count = count + 1,
         updated_at = excluded.updated_at
       WHERE count < ?4
       RETURNING count`,
    )
      .bind(scope, bucket, nowIso, limit)
      .all<{ count: number }>();
    return (result.results?.length ?? 0) > 0;
  } catch (err) {
    console.error('[lookupAssist] 配额写入失败', scope, err);
    return false;
  }
}

export interface L2AssistPeer {
  peer_url: string;
  handle: string | null;
}

/** 已关注且有公开 Worker B 的联系人。 */
export async function listL2AssistPeers(
  env: Env,
  limit = LOOKUP_L2_MAX_PEERS,
): Promise<L2AssistPeer[]> {
  try {
    // follows → IDENTITY_DB
    const res = await resolveIdentityDb(env).prepare(
      `SELECT COALESCE(NULLIF(TRIM(followed_worker_b_url), ''), follower_node_url) AS peer_url,
              followed_handle
         FROM follows
        WHERE followed_handle IS NOT NULL AND TRIM(followed_handle) != ''
        ORDER BY followed_at DESC
        LIMIT ?1`,
    )
      .bind(limit)
      .all<{ peer_url: string; followed_handle: string | null }>();

    const out: L2AssistPeer[] = [];
    const seen = new Set<string>();
    for (const row of res.results ?? []) {
      const url = (row.peer_url ?? '').trim().replace(/\/+$/, '');
      if (!url.startsWith('http://') && !url.startsWith('https://')) continue;
      const key = url.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ peer_url: url, handle: row.followed_handle });
    }
    return out;
  } catch (err) {
    console.error('[lookupAssist] 列举协助联系人失败', err);
    return [];
  }
}

/** 本机应答：仅 L1。 */
export async function answerLookupAssistFromL1(
  env: Env,
  handle: string,
): Promise<LocalLookupData | null> {
  return resolveHandleFromL1(env, handle);
}

/**
 * FoF 应答：L1 →（若开启 L2）向本机联系人再问一层 L1。
 * 禁止在此路径再发起 fof，切断递归洪水。
 */
export async function answerLookupAssistWithOptionalFof(
  env: Env,
  handle: string,
  mode: AssistAskMode,
): Promise<{ data: LocalLookupData; via: 'l1' | 'l2' } | null> {
  const l1 = await answerLookupAssistFromL1(env, handle);
  if (l1) return { data: l1, via: 'l1' };

  if (mode !== 'fof') return null;
  if (!isLookupL3FofEnabled(env)) return null;
  // 对端扩散仅走 L2（对端的联系人 L1），不再带 fof
  if (!isLookupL2MutualAssistEnabled(env)) return null;

  const l2 = await tryResolveHandleViaL2Mutual(env, handle, {
    // 应答路径同步写缓存即可
  });
  if (l2.kind !== 'hit') return null;
  return { data: l2.data, via: 'l2' };
}

interface AssistPeerResponse {
  ok?: boolean;
  data?: {
    user_id?: string;
    handle?: string;
    node_url?: string;
    worker_b_url?: string | null;
    registry_status?: string | null;
    health_status?: string | null;
    pubkey_fingerprint?: string;
  };
}

async function fetchPeerAssist(
  env: Env,
  peerUrl: string,
  handle: string,
  opts: { mode: AssistAskMode; timeoutMs: number; resolveSource: NodeLookupSource },
): Promise<LocalLookupData | null> {
  const base = peerUrl.replace(/\/+$/, '');
  const q = opts.mode === 'fof' ? '?fof=1' : '';
  const url = resolveSafeOutboundPeerUrl(
    env,
    `${base}/lookup-assist/${encodeURIComponent(handle)}${q}`,
  );
  if (!url) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      redirect: 'manual',
      headers: { Accept: 'application/json', 'User-Agent': OUTBOUND_PEER_UA },
    });
    if (isManualRedirectStatus(res.status) || res.status === 404 || !res.ok) return null;
    const body = (await res.json()) as AssistPeerResponse;
    if (!body?.ok || !body.data) return null;
    const nodeUrl = String(body.data.worker_b_url || body.data.node_url || '')
      .trim()
      .replace(/\/+$/, '');
    if (!nodeUrl) return null;
    const resolvedHandle = String(body.data.handle || handle).trim();
    return {
      user_id: String(body.data.user_id ?? ''),
      handle: resolvedHandle,
      node_url: String(body.data.node_url ?? nodeUrl).trim().replace(/\/+$/, '') || nodeUrl,
      worker_b_url: nodeUrl,
      registry_status: body.data.registry_status ?? null,
      health_status: body.data.health_status ?? null,
      pubkey_fingerprint: String(body.data.pubkey_fingerprint ?? ''),
      resolve_source: opts.resolveSource,
      cache_ttl_seconds: LOOKUP_CACHE_TTL_SECONDS,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export type LayerResolveOutcome =
  | { kind: 'hit'; data: LocalLookupData }
  | { kind: 'miss' }
  | { kind: 'skipped' };

/** @deprecated 使用 LayerResolveOutcome */
export type L2ResolveOutcome = LayerResolveOutcome;

async function cacheAndHit(
  env: Env,
  data: LocalLookupData,
  source: NodeLookupSource,
  waitUntil?: (promise: Promise<unknown>) => void,
): Promise<LayerResolveOutcome> {
  const payload = { ...data, resolve_source: source };
  const cacheWrite = upsertLookupCacheEntry(env, {
    handle: data.handle,
    user_id: data.user_id,
    node_url: data.node_url,
    worker_b_url: data.worker_b_url,
    pubkey_fingerprint: data.pubkey_fingerprint,
    registry_status: data.registry_status,
    health_status: data.health_status,
    response_json: JSON.stringify(payload),
  });
  if (waitUntil) waitUntil(cacheWrite);
  else await cacheWrite;
  return { kind: 'hit', data: { ...data, resolve_source: source } };
}

/**
 * L2：向联系人公开读入口询问（仅对端 L1）。
 */
export async function tryResolveHandleViaL2Mutual(
  env: Env,
  handle: string,
  opts: { waitUntil?: (promise: Promise<unknown>) => void } = {},
): Promise<LayerResolveOutcome> {
  if (!isLookupL2MutualAssistEnabled(env)) return { kind: 'skipped' };

  const peers = await listL2AssistPeers(env, LOOKUP_L2_MAX_PEERS);
  if (peers.length === 0) return { kind: 'skipped' };

  const allowed = await tryConsumeAssistQuota(env, 'l2_assist_out_day');
  if (!allowed) {
    console.info('[lookupAssist] 出站日配额已满，跳过 L2');
    return { kind: 'skipped' };
  }

  const settled = await Promise.allSettled(
    peers.map((p) =>
      fetchPeerAssist(env, p.peer_url, handle, {
        mode: 'l1',
        timeoutMs: LOOKUP_L2_PEER_TIMEOUT_MS,
        resolveSource: 'l2_mutual',
      }),
    ),
  );

  for (const item of settled) {
    if (item.status !== 'fulfilled' || !item.value) continue;
    return cacheAndHit(env, item.value, 'l2_mutual', opts.waitUntil);
  }

  return { kind: 'miss' };
}

/**
 * L3：有限 FoF——向联系人带 fof=1；对端最多再扩 1 跳 L1，禁止递归。
 */
export async function tryResolveHandleViaL3Fof(
  env: Env,
  handle: string,
  opts: { waitUntil?: (promise: Promise<unknown>) => void } = {},
): Promise<LayerResolveOutcome> {
  if (!isLookupL3FofEnabled(env)) return { kind: 'skipped' };
  // FoF 依赖对端协助入口；L2 总开关关时对端也无法应答 fof 扩散
  if (!isLookupL2MutualAssistEnabled(env)) return { kind: 'skipped' };

  const peers = await listL2AssistPeers(env, LOOKUP_L3_MAX_PEERS);
  if (peers.length === 0) return { kind: 'skipped' };

  const allowed = await tryConsumeAssistQuota(env, 'l3_fof_out_day');
  if (!allowed) {
    console.info('[lookupAssist] L3 FoF 出站日配额已满，跳过');
    return { kind: 'skipped' };
  }

  const settled = await Promise.allSettled(
    peers.map((p) =>
      fetchPeerAssist(env, p.peer_url, handle, {
        mode: 'fof',
        timeoutMs: LOOKUP_L3_PEER_TIMEOUT_MS,
        resolveSource: 'l3_fof',
      }),
    ),
  );

  for (const item of settled) {
    if (item.status !== 'fulfilled' || !item.value) continue;
    return cacheAndHit(env, item.value, 'l3_fof', opts.waitUntil);
  }

  return { kind: 'miss' };
}
