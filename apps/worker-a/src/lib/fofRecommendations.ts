/**
 * M17-4-2b：好友的好友（FoF）推荐刷新
 *
 * - 每小时采样 ≤5 位互粉好友 → 拉对方 Worker B `/users/:handle/friends`
 * - 聚合打分（mutual_count）→ 过滤自己 / 已关注 / 黑名单 / 官方推荐重叠
 * - 落库 GOVERNANCE `fof_recommended_users`（每次最多 5 条）
 * - 元数据 system_config → IDENTITY（禁跨库单 batch）
 */
import { normalizeWorkerBOrigin } from '@hailuo/shared-utils';
import { isManualRedirectStatus, resolveSafeOutboundPeerUrl } from './fetchOutboundPeer';
import type { Env } from '../env';
import { resolveGovernanceDb, resolveIdentityDb } from '../db/bindings';
import { resolveFollowFetchBaseUrl } from '../handlers/feedFetch';
import { buildReadMutualProofForOwner } from '../routes/read-mutual-proof';
import { isNodeBlacklisted } from './blacklistLookup';
import { resolveLocalPublicBaseUrl } from './localPublicBaseUrl';
import {
  listAcceptedMutualPeers,
  MUTUAL_FRIENDS_PROJECTION_MAX,
  type MutualFriendProjectionItem,
  type MutualPeerRow,
} from './mutualFriendsProjection';

/** 右栏 / 落库条数上限（用户拍板：每次最多 5） */
export const FOOF_DISPLAY_LIMIT = 5;
/** 每轮询问的互粉好友数 */
export const FOOF_SAMPLE_FRIENDS = 5;
/** 刷新间隔 */
export const FOOF_REFRESH_TTL_MS = 60 * 60 * 1000;
/** 单次出站超时 */
const PEER_FETCH_TIMEOUT_MS = 5_000;

const CONFIG_KEYS = {
  lastRefreshedAt: 'fof_recommended_users_last_refreshed_at',
  lastStatus: 'fof_recommended_users_last_status',
  lastError: 'fof_recommended_users_last_error',
  lastCount: 'fof_recommended_users_last_count',
} as const;

export type FofRecommendedUser = {
  readonly handle: string;
  readonly node_url: string;
  readonly worker_b_url: string;
  readonly display_name: string;
  readonly mutual_count: number;
  readonly reason: 'friend_of_friend';
  readonly fetched_at: string;
};

export type FofRefreshResult = {
  readonly skipped: boolean;
  readonly reason?: 'disabled' | 'ttl' | 'no_peers';
  readonly written: number;
  readonly sampled: number;
  readonly fetched_peers: number;
  readonly errors: number;
};

type CandidateAgg = {
  handle: string;
  node_url: string;
  display_name: string;
  mutual_count: number;
};

/** 显式 false/0/off 关闭；默认开 */
export function isFofRecommendationsEnabled(env: Env): boolean {
  const raw = (env.FOOF_RECOMMENDATIONS_ENABLED ?? 'true').trim().toLowerCase();
  return raw !== 'false' && raw !== '0' && raw !== 'off';
}

export async function syncFofRecommendedUsersIfDue(
  env: Env,
  now = new Date(),
): Promise<FofRefreshResult> {
  if (!isFofRecommendationsEnabled(env)) {
    return { skipped: true, reason: 'disabled', written: 0, sampled: 0, fetched_peers: 0, errors: 0 };
  }

  const identityDb = resolveIdentityDb(env);
  const lastAt = await readConfig(identityDb, CONFIG_KEYS.lastRefreshedAt);
  if (lastAt) {
    const lastMs = Date.parse(lastAt);
    if (!Number.isNaN(lastMs) && now.getTime() - lastMs < FOOF_REFRESH_TTL_MS) {
      return { skipped: true, reason: 'ttl', written: 0, sampled: 0, fetched_peers: 0, errors: 0 };
    }
  }

  return refreshFofRecommendedUsers(env, { now });
}

export async function refreshFofRecommendedUsers(
  env: Env,
  options?: { now?: Date },
): Promise<FofRefreshResult> {
  const now = options?.now ?? new Date();
  const fetchedAt = now.toISOString();
  const identityDb = resolveIdentityDb(env);

  try {
    const ownUrlRaw = await resolveLocalPublicBaseUrl(env);
    let ownUrl = '';
    try {
      ownUrl = ownUrlRaw ? normalizeWorkerBOrigin(ownUrlRaw) : '';
    } catch {
      ownUrl = ownUrlRaw.replace(/\/+$/, '').toLowerCase();
    }

    const own = await identityDb
      .prepare(`SELECT handle FROM users LIMIT 1`)
      .first<{ handle: string }>();
    const ownHandle = (own?.handle ?? '').trim().toLowerCase();

    const peers = await listAcceptedMutualPeers(env, { limit: 200 });
    if (peers.length === 0) {
      await persistFofRecommendedUsers(env, [], fetchedAt, 'ok', '');
      return { skipped: true, reason: 'no_peers', written: 0, sampled: 0, fetched_peers: 0, errors: 0 };
    }

    const sample = samplePeersRoundRobin(peers, FOOF_SAMPLE_FRIENDS, now.getUTCHours());
    const followingUrls = await loadFollowingUrlSet(env);
    const officialUrls = await loadOfficialRecommendedUrlSet(env);

    const agg = new Map<string, CandidateAgg>();
    let fetchedPeers = 0;
    let errors = 0;

    for (const peer of sample) {
      const items = await fetchPeerFriendsProjection(env, peer, ownUrl, ownHandle);
      if (items === null) {
        errors += 1;
        continue;
      }
      fetchedPeers += 1;
      for (const item of items) {
        mergeCandidate(agg, item, ownUrl, ownHandle, followingUrls, officialUrls);
      }
    }

    const ranked = [...agg.values()].sort((a, b) => {
      if (b.mutual_count !== a.mutual_count) return b.mutual_count - a.mutual_count;
      return a.handle.localeCompare(b.handle);
    });

    const top: FofRecommendedUser[] = [];
    for (const row of ranked) {
      if (top.length >= FOOF_DISPLAY_LIMIT) break;
      // 二次黑名单（异步）；merge 时未 await
      if (await isNodeBlacklisted(env, row.node_url)) continue;
      top.push({
        handle: row.handle,
        node_url: row.node_url,
        worker_b_url: row.node_url,
        display_name: row.display_name,
        mutual_count: row.mutual_count,
        reason: 'friend_of_friend',
        fetched_at: fetchedAt,
      });
    }

    await persistFofRecommendedUsers(env, top, fetchedAt, 'ok', '');
    return {
      skipped: false,
      written: top.length,
      sampled: sample.length,
      fetched_peers: fetchedPeers,
      errors,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[fofRecommendations] 刷新失败', err);
    try {
      await writeFofMeta(env, fetchedAt, 'error', message.slice(0, 200), 0);
    } catch {
      /* meta 失败不抛 */
    }
    return { skipped: false, written: 0, sampled: 0, fetched_peers: 0, errors: 1 };
  }
}

/** 供 2c / 诊断读取 */
export async function listFofRecommendedUsers(env: Env): Promise<FofRecommendedUser[]> {
  const governanceDb = resolveGovernanceDb(env);
  const rows = await governanceDb
    .prepare(
      `SELECT handle, node_url, worker_b_url, display_name, mutual_count, fetched_at
         FROM fof_recommended_users
        ORDER BY mutual_count DESC, fetched_at DESC
        LIMIT ?`,
    )
    .bind(FOOF_DISPLAY_LIMIT)
    .all<{
      handle: string;
      node_url: string;
      worker_b_url: string;
      display_name: string;
      mutual_count: number;
      fetched_at: string;
    }>();

  return (rows.results ?? []).map((r) => ({
    handle: r.handle,
    node_url: r.node_url,
    worker_b_url: r.worker_b_url || r.node_url,
    display_name: r.display_name || '',
    mutual_count: Number(r.mutual_count) || 1,
    reason: 'friend_of_friend' as const,
    fetched_at: r.fetched_at,
  }));
}

export async function getFofRecommendationsMeta(env: Env): Promise<{
  last_refreshed_at: string | null;
  last_status: string | null;
  last_error: string | null;
  last_count: number;
  next_refresh_after: string | null;
}> {
  const identityDb = resolveIdentityDb(env);
  const [at, status, err, count] = await Promise.all([
    readConfig(identityDb, CONFIG_KEYS.lastRefreshedAt),
    readConfig(identityDb, CONFIG_KEYS.lastStatus),
    readConfig(identityDb, CONFIG_KEYS.lastError),
    readConfig(identityDb, CONFIG_KEYS.lastCount),
  ]);
  let next: string | null = null;
  if (at) {
    const ms = Date.parse(at);
    if (!Number.isNaN(ms)) {
      next = new Date(ms + FOOF_REFRESH_TTL_MS).toISOString();
    }
  }
  return {
    last_refreshed_at: at,
    last_status: status,
    last_error: err || null,
    last_count: Number.parseInt(count ?? '0', 10) || 0,
    next_refresh_after: next,
  };
}

// ── 内部 ──────────────────────────────────────────────

export function samplePeersRoundRobin(
  peers: readonly MutualPeerRow[],
  take: number,
  utcHour: number,
): MutualPeerRow[] {
  if (peers.length <= take) return [...peers];
  const start = utcHour % peers.length;
  const out: MutualPeerRow[] = [];
  for (let i = 0; i < take; i++) {
    out.push(peers[(start + i) % peers.length]!);
  }
  return out;
}

function mergeCandidate(
  agg: Map<string, CandidateAgg>,
  item: MutualFriendProjectionItem,
  ownUrl: string,
  ownHandle: string,
  followingUrls: ReadonlySet<string>,
  officialUrls: ReadonlySet<string>,
): void {
  const handle = (item.handle ?? '').trim().toLowerCase();
  if (!handle || (ownHandle && handle === ownHandle)) return;

  let nodeUrl: string;
  try {
    nodeUrl = normalizeWorkerBOrigin(item.node_url);
  } catch {
    return;
  }
  if (!nodeUrl) return;
  if (ownUrl && nodeUrl === ownUrl) return;
  if (followingUrls.has(nodeUrl)) return;
  if (officialUrls.has(nodeUrl)) return;

  const prev = agg.get(nodeUrl);
  if (prev) {
    prev.mutual_count += 1;
    if (!prev.display_name && item.display_name) prev.display_name = item.display_name;
    if (!prev.handle && handle) prev.handle = handle;
  } else {
    agg.set(nodeUrl, {
      handle,
      node_url: nodeUrl,
      display_name: (item.display_name ?? '').trim(),
      mutual_count: 1,
    });
  }
}

async function fetchPeerFriendsProjection(
  env: Env,
  peer: MutualPeerRow,
  ownUrl: string,
  ownHandle: string,
): Promise<MutualFriendProjectionItem[] | null> {
  const base = resolveFollowFetchBaseUrl(peer.node_url);
  const handle = encodeURIComponent(peer.handle);
  const url = `${base}/users/${handle}/friends?limit=${MUTUAL_FRIENDS_PROJECTION_MAX}`;

  try {
    let res = await fetchWithTimeout(env, url, {});
    if (!res) return null;
    if (res.status === 401 || res.status === 403) {
      const token = await issueFollowerTokenForPeer(env, base, ownUrl, ownHandle);
      if (!token) return null;
      res = await fetchWithTimeout(env, url, {
        Authorization: `Bearer ${token}`,
      });
      if (!res) return null;
    }
    if (!res.ok) return null;
    const json = (await res.json()) as {
      ok?: boolean;
      data?: { items?: MutualFriendProjectionItem[] };
    };
    if (!json.ok || !Array.isArray(json.data?.items)) return [];
    return json.data.items;
  } catch {
    return null;
  }
}

async function issueFollowerTokenForPeer(
  env: Env,
  peerBase: string,
  ownUrl: string,
  ownHandle: string,
): Promise<string | null> {
  if (!ownUrl) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PEER_FETCH_TIMEOUT_MS);
  try {
    const body: Record<string, unknown> = {
      follower_node_url: ownUrl.replace(/\/+$/, ''),
    };
    if (ownHandle) body.follower_handle = ownHandle;

    const tokenUrl = resolveSafeOutboundPeerUrl(env, `${peerBase}/api/follower-tokens`);
    if (!tokenUrl) return null;
    let res = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
      redirect: 'manual',
    });
    if (isManualRedirectStatus(res.status)) return null;

    if (!res.ok && res.status === 403) {
      let errorCode = '';
      try {
        const errJson = (await res.json()) as { error_code?: string };
        errorCode = typeof errJson.error_code === 'string' ? errJson.error_code : '';
      } catch {
        errorCode = '';
      }
      if (errorCode === 'NOT_MUTUAL_FOLLOW') {
        const proof = await buildReadMutualProofForOwner(env, peerBase);
        if (proof) {
          body.read_mutual_proof = proof;
          res = await fetch(tokenUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify(body),
            signal: controller.signal,
            redirect: 'manual',
          });
          if (isManualRedirectStatus(res.status)) return null;
        }
      }
    }

    if (!res.ok) return null;
    const json = (await res.json()) as { ok?: boolean; data?: { token?: string } };
    return json.ok && typeof json.data?.token === 'string' ? json.data.token : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchWithTimeout(
  env: Env,
  url: string,
  headers: Record<string, string>,
): Promise<Response | null> {
  const safeUrl = resolveSafeOutboundPeerUrl(env, url);
  if (!safeUrl) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PEER_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(safeUrl, {
      method: 'GET',
      headers: { Accept: 'application/json', ...headers },
      signal: controller.signal,
      redirect: 'manual',
    });
    if (isManualRedirectStatus(res.status)) return null;
    return res;
  } finally {
    clearTimeout(timer);
  }
}

async function loadFollowingUrlSet(env: Env): Promise<Set<string>> {
  const identityDb = resolveIdentityDb(env);
  const rows = await identityDb
    .prepare(`SELECT follower_node_url FROM follows`)
    .all<{ follower_node_url: string }>();
  const set = new Set<string>();
  for (const r of rows.results ?? []) {
    try {
      set.add(normalizeWorkerBOrigin(r.follower_node_url));
    } catch {
      /* skip */
    }
  }
  return set;
}

async function loadOfficialRecommendedUrlSet(env: Env): Promise<Set<string>> {
  const governanceDb = resolveGovernanceDb(env);
  try {
    const rows = await governanceDb
      .prepare(`SELECT node_url, worker_b_url FROM registry_recommended_users`)
      .all<{ node_url: string; worker_b_url: string }>();
    const set = new Set<string>();
    for (const r of rows.results ?? []) {
      for (const raw of [r.worker_b_url, r.node_url]) {
        try {
          if (raw) set.add(normalizeWorkerBOrigin(raw));
        } catch {
          /* skip */
        }
      }
    }
    return set;
  } catch {
    return new Set();
  }
}

async function persistFofRecommendedUsers(
  env: Env,
  items: readonly FofRecommendedUser[],
  fetchedAt: string,
  status: string,
  error: string,
): Promise<void> {
  const governanceDb = resolveGovernanceDb(env);
  const stmts = [
    governanceDb.prepare('DELETE FROM fof_recommended_users'),
    ...items.map((item) =>
      governanceDb
        .prepare(
          `INSERT INTO fof_recommended_users (
             node_url, handle, display_name, worker_b_url, mutual_count, fetched_at
           ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          item.node_url,
          item.handle,
          item.display_name,
          item.worker_b_url,
          item.mutual_count,
          fetchedAt,
        ),
    ),
  ];
  await governanceDb.batch(stmts);
  await writeFofMeta(env, fetchedAt, status, error, items.length);
}

async function writeFofMeta(
  env: Env,
  fetchedAt: string,
  status: string,
  error: string,
  count: number,
): Promise<void> {
  const identityDb = resolveIdentityDb(env);
  await identityDb.batch([
    configStmt(identityDb, CONFIG_KEYS.lastRefreshedAt, fetchedAt, fetchedAt),
    configStmt(identityDb, CONFIG_KEYS.lastStatus, status, fetchedAt),
    configStmt(identityDb, CONFIG_KEYS.lastError, error, fetchedAt),
    configStmt(identityDb, CONFIG_KEYS.lastCount, String(count), fetchedAt),
  ]);
}

function configStmt(db: D1Database, key: string, value: string, updatedAt: string) {
  return db
    .prepare(
      `INSERT INTO system_config (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .bind(key, value, updatedAt);
}

async function readConfig(db: D1Database, key: string): Promise<string | null> {
  const row = await db
    .prepare(`SELECT value FROM system_config WHERE key = ? LIMIT 1`)
    .bind(key)
    .first<{ value: string }>();
  return row?.value ?? null;
}
