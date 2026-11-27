import type { Env } from '../env.d';
import { resolveGovernanceDb, resolveIdentityDb } from '../db/bindings';
import { readFollowIdentityRows } from '../lib/followIdentityRows';
import {
  getFofRecommendationsMeta,
  listFofRecommendedUsers,
  FOOF_DISPLAY_LIMIT,
  type FofRecommendedUser,
} from '../lib/fofRecommendations';
import {
  buildFollowIdentityIndex,
  filterRegistryRecommendedUsers,
  isRecommendedUserFollowed,
  recommendedWorkerBUrls,
} from '../lib/registryRecommendedFilter';
import { registryFetchWithRouterMeta } from '../lib/registryFetch';
import { writeOperationLog } from '../lib/operationLog';

const RECOMMENDATION_LIMIT = 10;
/** 兼容旧诊断 next_refresh_after；调度已改 7 日错峰 Cron */
const RECOMMENDATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const CONFIG_KEYS = {
  lastCheckedAt: 'registry_recommended_users_last_checked_at',
  lastStatus: 'registry_recommended_users_last_status',
  lastError: 'registry_recommended_users_last_error',
  lastFetchedCount: 'registry_recommended_users_last_fetched_count',
  /** M9-3-9：实际成功响应的注册中心 registry_id（主失败 failover 备用时有值） */
  sourceRegistryId: 'registry_recommended_users_source_registry_id',
  /** R-MSG-2c：presence 条件块游标 */
  etag: 'registry_recommendations_etag',
};

/** presence / diagnostics 共用推荐 etag 键 */
export const CONFIG_RECOMMENDATIONS_ETAG = CONFIG_KEYS.etag;

export interface RegistryRecommendedUser {
  user_id: string;
  handle: string;
  node_url: string;
  worker_b_url: string;
  health_status: string;
  profile_status: string;
  pubkey_fingerprint: string;
  registered_at: string;
  last_health_at: string | null;
  reason: string;
  fetched_at: string;
}

export interface RegistryRecommendedUsersResponseItem {
  user_id: string;
  handle: string;
  node_url: string;
  worker_b_url: string;
  health_status: string;
  profile_status: string;
  pubkey_fingerprint: string;
  registered_at: string;
  last_health_at: string | null;
  reason: string;
}

interface RegistryRecommendedUsersEnvelope {
  ok: true;
  data: {
    items: RegistryRecommendedUsersResponseItem[];
    generated_at: string;
    recommendation_date: string;
    next_refresh_after: string;
    source: 'registry';
  };
}

export async function syncRegistryRecommendedUsersIfDue(env: Env, now = new Date()): Promise<void> {
  const identityDb = resolveIdentityDb(env);
  const lastCheckedAt = await readConfig(identityDb, CONFIG_KEYS.lastCheckedAt);
  if (lastCheckedAt) {
    const lastMs = Date.parse(lastCheckedAt);
    if (!Number.isNaN(lastMs) && now.getTime() - lastMs < RECOMMENDATION_TTL_MS) {
      return;
    }
  }
  await syncRegistryRecommendedUsers(env, { now });
}

async function persistRegistryRecommendedUsers(
  env: Env,
  items: RegistryRecommendedUsersResponseItem[],
  fetchedAt: string,
  sourceRegistryId: string,
): Promise<void> {
  const governanceDb = resolveGovernanceDb(env);
  const identityDb = resolveIdentityDb(env);
  const recommendationStatements = [
    governanceDb.prepare('DELETE FROM registry_recommended_users'),
    ...items.map((item) =>
      governanceDb
        .prepare(
          `INSERT INTO registry_recommended_users (
           user_id, handle, node_url, worker_b_url,
           health_status, profile_status, pubkey_fingerprint,
           registered_at, last_health_at, reason, fetched_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          item.user_id,
          item.handle,
          item.node_url,
          item.worker_b_url,
          item.health_status,
          item.profile_status,
          item.pubkey_fingerprint,
          item.registered_at,
          item.last_health_at,
          item.reason,
          fetchedAt,
        ),
    ),
  ];

  // 两个库不能共用一个 D1 batch：先原子替换推荐缓存，再串行写 IDENTITY_DB 元数据。
  await governanceDb.batch(recommendationStatements);
  await identityDb.batch([
    configStmt(identityDb, CONFIG_KEYS.lastCheckedAt, fetchedAt, fetchedAt),
    configStmt(identityDb, CONFIG_KEYS.lastStatus, 'ok', fetchedAt),
    configStmt(identityDb, CONFIG_KEYS.lastFetchedCount, String(items.length), fetchedAt),
    configStmt(identityDb, CONFIG_KEYS.lastError, '', fetchedAt),
    configStmt(identityDb, CONFIG_KEYS.sourceRegistryId, sourceRegistryId, fetchedAt),
    // R-MSG-2c：日级 etag 与中心 formatRecommendationsEtag 对齐
    configStmt(identityDb, CONFIG_KEYS.etag, `W/"rec:${fetchedAt.slice(0, 10)}"`, fetchedAt),
  ]);
}

/** M-DS-1：从 daily-sync recommendations 块落库。 */
export async function applyRegistryRecommendationsFromDailySync(
  env: Env,
  block: {
    unchanged?: boolean;
    etag?: string;
    pull_hint?: string;
    items?: RegistryRecommendedUsersResponseItem[];
    next_refresh_after?: string;
    error_code?: string;
    message?: string;
  },
  sourceRegistryId: string,
): Promise<void> {
  // R-MSG-2c：unchanged / 仅 pull_hint 时禁止用空 items 覆盖本地推荐缓存
  if (block.unchanged === true) {
    const etag = block.etag?.trim();
    if (etag) {
      const identityDb = resolveIdentityDb(env);
      const now = new Date().toISOString();
      await identityDb
        .prepare(
          `INSERT OR REPLACE INTO system_config (key, value, updated_at) VALUES (?, ?, ?)`,
        )
        .bind(CONFIG_KEYS.etag, etag, now)
        .run()
        .catch(() => {});
    }
    return;
  }
  if (block.pull_hint === 'recommendations/users') {
    // 由调用方同 tick 走 syncRegistryRecommendedUsers；此处只记 etag
    const etag = block.etag?.trim();
    if (etag) {
      const identityDb = resolveIdentityDb(env);
      const now = new Date().toISOString();
      await identityDb
        .prepare(
          `INSERT OR REPLACE INTO system_config (key, value, updated_at) VALUES (?, ?, ?)`,
        )
        .bind(CONFIG_KEYS.etag, etag, now)
        .run()
        .catch(() => {});
    }
    return;
  }

  const fetchedAt = new Date().toISOString();
  const items = Array.isArray(block.items) ? block.items : [];
  await persistRegistryRecommendedUsers(env, items, fetchedAt, sourceRegistryId);
  const etag = block.etag?.trim();
  if (etag) {
    const identityDb = resolveIdentityDb(env);
    await identityDb
      .prepare(
        `INSERT OR REPLACE INTO system_config (key, value, updated_at) VALUES (?, ?, ?)`,
      )
      .bind(CONFIG_KEYS.etag, etag, fetchedAt)
      .run()
      .catch(() => {});
  }
  await writeOperationLog(env, {
    source: 'worker-a',
    level: 'info',
    event: 'registry_recommendations_daily_sync_ok',
    message: `daily-sync 推荐用户落库：${items.length} 个`,
    details: {
      fetched_count: items.length,
      source_registry_id: sourceRegistryId,
      next_refresh_after: block.next_refresh_after ?? null,
    },
  });
}

export async function syncRegistryRecommendedUsers(
  env: Env,
  opts: { now?: Date } = {},
): Promise<{ fetched_count: number; fetched_at: string }> {
  const now = opts.now ?? new Date();
  const fetchedAt = now.toISOString();
  await writeOperationLog(env, {
    source: 'worker-a',
    level: 'info',
    event: 'registry_recommendations_pull_start',
    message: '开始拉取注册中心推荐用户',
    details: { limit: RECOMMENDATION_LIMIT },
  });

  try {
    const path = `/api/recommendations/users?limit=${RECOMMENDATION_LIMIT}`;
    // M9-3-R2：推荐用户与其它已认证 API 一样，只连 registered_registries 唯一一家。
    const fetchResult = await registryFetchWithRouterMeta(env, path, { profile: 'cron' });
    const res = fetchResult.response;
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`registry returned ${res.status}: ${text.slice(0, 300)}`);
    }
    const payload = JSON.parse(text) as RegistryRecommendedUsersEnvelope;
    const items = Array.isArray(payload?.data?.items) ? payload.data.items : [];

    await persistRegistryRecommendedUsers(env, items, fetchedAt, fetchResult.registryId);
    await writeOperationLog(env, {
      source: 'worker-a',
      level: 'info',
      event: 'registry_recommendations_pull_ok',
      message: `注册中心推荐用户拉取完成：${items.length} 个`,
      details: {
        fetched_count: items.length,
        source_registry_id: fetchResult.registryId,
        failover_switched: fetchResult.failoverSwitched,
        router_detail: fetchResult.routerDetail,
      },
    });
    return { fetched_count: items.length, fetched_at: fetchedAt };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const identityDb = resolveIdentityDb(env);
    await identityDb.batch([
      configStmt(identityDb, CONFIG_KEYS.lastCheckedAt, fetchedAt, fetchedAt),
      configStmt(identityDb, CONFIG_KEYS.lastStatus, 'error', fetchedAt),
      configStmt(identityDb, CONFIG_KEYS.lastFetchedCount, '0', fetchedAt),
      configStmt(identityDb, CONFIG_KEYS.lastError, message.slice(0, 500), fetchedAt),
    ]);
    await writeOperationLog(env, {
      source: 'worker-a',
      level: 'warn',
      event: 'registry_recommendations_pull_failed',
      message: '注册中心推荐用户拉取失败',
      details: { error: message },
    });
    throw err;
  }
}

export async function readRegistryRecommendedUsers(
  env: Env,
  opts: { excludeFollowing?: boolean } = {},
): Promise<{
  items: RegistryRecommendedUser[];
  last_checked_at: string | null;
  last_status: string | null;
  last_error: string | null;
  last_fetched_count: number;
  next_refresh_after: string | null;
  last_source_registry_id: string | null;
  hidden_following_count: number;
  displayed_count: number;
  /** M17-4-2c：好友的好友（官方 items 之后展示） */
  fof_items: FofLocalApiItem[];
  fof_last_refreshed_at: string | null;
  fof_next_refresh_after: string | null;
}> {
  const excludeFollowing = opts.excludeFollowing !== false;

  const governanceDb = resolveGovernanceDb(env);
  const identityDb = resolveIdentityDb(env);
  const [itemsRes, config, followRows, fofRows, fofMeta] = await Promise.all([
    governanceDb
      .prepare(
        `SELECT user_id, handle, node_url, worker_b_url,
                health_status, profile_status, pubkey_fingerprint,
                registered_at, last_health_at, reason, fetched_at
           FROM registry_recommended_users
          ORDER BY fetched_at DESC, handle ASC
          LIMIT ?`,
      )
      .bind(RECOMMENDATION_LIMIT)
      .all<RegistryRecommendedUser>(),
    readConfigs(identityDb, Object.values(CONFIG_KEYS)),
    excludeFollowing ? readFollowIdentityRows(env) : Promise.resolve([]),
    listFofRecommendedUsers(env),
    getFofRecommendationsMeta(env),
  ]);

  const rawItems = itemsRes.results ?? [];
  const followIndex = excludeFollowing ? buildFollowIdentityIndex(followRows) : null;
  const filtered = excludeFollowing && followIndex
    ? filterRegistryRecommendedUsers(rawItems, followIndex)
    : {
        items: rawItems,
        hidden_following_count: 0,
        displayed_count: rawItems.length,
      };

  const lastCheckedAt = config[CONFIG_KEYS.lastCheckedAt] ?? null;
  const nextRefreshAfter = lastCheckedAt
    ? new Date(Date.parse(lastCheckedAt) + RECOMMENDATION_TTL_MS).toISOString()
    : null;

  const fof_items = buildFofItemsForLocalApi(fofRows, filtered.items, followIndex);

  return {
    items: filtered.items,
    last_checked_at: lastCheckedAt,
    last_status: config[CONFIG_KEYS.lastStatus] ?? null,
    last_error: config[CONFIG_KEYS.lastError] || null,
    last_fetched_count: Number(config[CONFIG_KEYS.lastFetchedCount] ?? 0),
    next_refresh_after: nextRefreshAfter,
    last_source_registry_id: config[CONFIG_KEYS.sourceRegistryId] ?? null,
    hidden_following_count: filtered.hidden_following_count,
    displayed_count: filtered.displayed_count,
    fof_items,
    fof_last_refreshed_at: fofMeta.last_refreshed_at,
    fof_next_refresh_after: fofMeta.next_refresh_after,
  };
}

/** 本地 API 暴露的 FoF 行（无邮箱/公钥/共同好友名单） */
export type FofLocalApiItem = {
  handle: string;
  node_url: string;
  worker_b_url: string;
  display_name: string;
  mutual_count: number;
  reason: 'friend_of_friend';
  fetched_at: string;
};

function buildFofItemsForLocalApi(
  rows: readonly FofRecommendedUser[],
  officialItems: readonly RegistryRecommendedUser[],
  followIndex: ReturnType<typeof buildFollowIdentityIndex> | null,
): FofLocalApiItem[] {
  const officialUrls = new Set<string>();
  for (const item of officialItems) {
    for (const url of recommendedWorkerBUrls(item)) {
      if (url) officialUrls.add(url);
    }
  }

  const out: FofLocalApiItem[] = [];
  for (const row of rows) {
    if (out.length >= FOOF_DISPLAY_LIMIT) break;
    const urls = recommendedWorkerBUrls(row);
    if (urls.some((u) => officialUrls.has(u))) continue;
    if (followIndex && isRecommendedUserFollowed(row, followIndex)) continue;
    out.push({
      handle: row.handle,
      node_url: row.node_url,
      worker_b_url: row.worker_b_url || row.node_url,
      display_name: row.display_name || '',
      mutual_count: row.mutual_count,
      reason: 'friend_of_friend',
      fetched_at: row.fetched_at,
    });
  }
  return out;
}

async function readConfig(db: D1Database, key: string): Promise<string | null> {
  const row = await db
    .prepare('SELECT value FROM system_config WHERE key = ? LIMIT 1')
    .bind(key)
    .first<{ value: string }>();
  return row?.value ?? null;
}

async function readConfigs(db: D1Database, keys: string[]): Promise<Record<string, string>> {
  if (keys.length === 0) return {};
  const placeholders = keys.map((_, i) => `?${i + 1}`).join(', ');
  const res = await db
    .prepare(`SELECT key, value FROM system_config WHERE key IN (${placeholders})`)
    .bind(...keys)
    .all<{ key: string; value: string }>();
  const out: Record<string, string> = {};
  for (const row of res.results ?? []) out[row.key] = row.value;
  return out;
}

function configStmt(db: D1Database, key: string, value: string, updatedAt: string): D1PreparedStatement {
  return db
    .prepare('INSERT OR REPLACE INTO system_config (key, value, updated_at) VALUES (?, ?, ?)')
    .bind(key, value, updatedAt);
}
