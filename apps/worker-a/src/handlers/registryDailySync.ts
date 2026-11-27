/**
 * 节点 → 注册中心 presence（POST /api/node/daily-sync，daily_sync_v5 / R-MSG-2c）。
 * 日常 Cron 只跑本入口；条件块 `pull_hint` 同 tick 辅拉。
 * force / 登记后仍可串 policy-digest + 推荐全量。
 *
 * M9-3-R1：只连 `registered_registries` 唯一一家；地址簿仍用于 known_registry_ids / directives。
 */
import type { Env } from '../env';
import { resolveIdentityDb } from '../db/bindings';
import type { PresenceRequestEnvelope } from '@hailuo/registry-protocol';
import { serializeProtoEnvelope } from '@hailuo/shared-utils';
import { insertOutboundEvent } from '../lib/outboundEvents';
import {
  applyRegistryDirectivesFromEnvelope,
  REGISTRY_DIRECTIVE_DAILY_SYNC_PATH,
} from '../lib/registryDirectives';
import type { RegistryEndpoint } from '../lib/registryEndpoints';
import { readRegistryEndpoints } from '../lib/registryEndpoints';
import { readRegisteredRegistry } from '../lib/registeredRegistries';
import {
  CONFIG_DAILY_SYNC_SCHEDULE_VERSION_KEY,
  CONFIG_DAILY_SYNC_UTC_SECOND_OF_DAY,
  CONFIG_SYNC_INTERVAL_DAYS,
  readSyncIntervalDays,
} from '../lib/dailySyncScheduleConfig';
import {
  DAILY_SYNC_PRESENCE_SCHEDULE_VERSION,
  DEFAULT_SYNC_INTERVAL_DAYS,
  normalizeSyncIntervalDays,
  syncMinIntervalMs,
} from '../lib/registryCronSchedule';
import {
  registryRouterFetchBound,
  markRegistryEndpointDailySyncSuccess,
  markRegistryEndpointUnreachable,
  resolveRegisteredRegistryForSync,
} from '../lib/registryRouter';
import {
  applyRegistryRecommendationsFromDailySync,
  CONFIG_RECOMMENDATIONS_ETAG,
  readRegistryRecommendedUsers,
  syncRegistryRecommendedUsers,
  type RegistryRecommendedUsersResponseItem,
} from './registryRecommendations';
import {
  applyRegistryOfficialFeedFromDailySync,
  pullRegistryOfficialFeedAfterRegistration,
  readRegistryOfficialFeedDiagnostics,
  type DailySyncOfficialFeedBlock,
} from './feedFetch';
import {
  getLookupResolveDayStats,
  type LookupResolveDayStats,
} from '../lib/lookupResolveStats';
import { readFederationLastLookup } from '../lib/federationLastLookup';
import { MAX_REGISTRY_ENDPOINTS } from '../lib/registryDirectives';
import {
  applyRegistryBlacklistFromDailySync,
  applyFederatedBlacklistFromDailySync,
  isFederationBlacklistEnforceEnabled,
  syncRegistryBlacklistToKv,
} from './registryBlacklistSync';
import type { RegistryBlacklistItem } from './registryBlacklistSync';
import { syncRegistryEndpointsToKv } from './registryEndpointsKvSync';
import { writeOperationLog } from '../lib/operationLog';
import {
  readRegistryPolicyPollDiagnostics,
  syncRegistryPolicyDigest,
} from './registryPolicyPoll';
import {
  clearConfigIntervalDays,
  getConfigIntervalDays,
  normalizeConfigIntervalDays,
  readOwnerUserId,
  upsertNodeSyncStateAfterSuccess,
} from '../lib/nodeSyncState';
const DAILY_SYNC_PATH = '/api/node/daily-sync';
const DAILY_SYNC_UNREACHABLE_FAIL_DAYS = 2;
/** 与 registryPolicyPoll 同源：presence 请求带出客户端游标 */
const CONFIG_POLICY_ETAG = 'registry_policy_digest_etag';
const CONFIG_BLACKLIST_ETAG = 'blacklist_remote_etag';
const CONFIG_RECOMMENDATIONS_ETAG_KEY = CONFIG_RECOMMENDATIONS_ETAG;

const CONFIG_LAST_SUCCESS = 'registry_daily_sync_last_success_at';
const CONFIG_LAST_STATUS = 'registry_daily_sync_last_status';
const CONFIG_LAST_ERROR = 'registry_daily_sync_last_error';
/** M16-DAILY-SYNC-COOLDOWN-1：站主手动「立即同步」独立锚点；与 cron 锚点 `CONFIG_LAST_SUCCESS` 物理隔离。 */
const CONFIG_LAST_MANUAL_AT = 'registry_daily_sync_last_manual_at';
/** M16-DAILY-SYNC-COOLDOWN-1：手动 daily-sync 节流窗口（小时）；站主要求 1 天，可由 env 覆盖。 */
const MANUAL_DAILY_SYNC_COOLDOWN_HOURS_DEFAULT = 24;

function isoNow(): string {
  return new Date().toISOString();
}

function dailySyncTargetUrl(endpoint: RegistryEndpoint): string {
  return `${endpoint.registry_url.replace(/\/$/, '')}${DAILY_SYNC_PATH}`;
}

async function readSystemConfig(env: Env, key: string): Promise<string> {
  // A-5c-3：system_config 在 IDENTITY_DB，先解析
  const identityDb = resolveIdentityDb(env);
  const row = await identityDb
    .prepare(`SELECT value FROM system_config WHERE key = ?1 LIMIT 1`)
    .bind(key)
    .first<{ value: string }>();
  return row?.value?.trim() ?? '';
}

async function writeDailySyncMeta(
  env: Env,
  status: 'ok' | 'failed',
  errorMessage: string | null,
): Promise<void> {
  // A-5c-3：system_config 在 IDENTITY_DB，先解析（batch 同事务保留）
  const identityDb = resolveIdentityDb(env);
  const now = isoNow();
  await identityDb.batch([
    identityDb.prepare(
      `INSERT OR REPLACE INTO system_config (key, value, updated_at) VALUES (?, ?, ?)`,
    ).bind(CONFIG_LAST_STATUS, status, now),
    identityDb.prepare(
      `INSERT OR REPLACE INTO system_config (key, value, updated_at) VALUES (?, ?, ?)`,
    ).bind(CONFIG_LAST_ERROR, errorMessage ?? '', now),
    ...(status === 'ok'
      ? [identityDb.prepare(
        `INSERT OR REPLACE INTO system_config (key, value, updated_at) VALUES (?, ?, ?)`,
      ).bind(CONFIG_LAST_SUCCESS, now, now)]
      : []),
  ]);
}

async function shouldRunScheduledDailySync(env: Env, now: Date): Promise<boolean> {
  const last = await readSystemConfig(env, CONFIG_LAST_SUCCESS);
  if (!last) return true;
  const lastMs = Date.parse(last);
  if (!Number.isFinite(lastMs)) return true;
  // 最小间隔 = interval_days × 12h（默认 30 日 → 360h）
  const intervalDays = await readSyncIntervalDays(env);
  return now.getTime() - lastMs >= syncMinIntervalMs(intervalDays);
}

/** M16-DAILY-SYNC-COOLDOWN-1：站主手动「立即同步」被节流（1 天 1 次） */
export class ManualDailySyncCooldownError extends Error {
  constructor(
    readonly lastManualAt: string,
    readonly retryAfterSeconds: number,
    readonly retryAfterHours: number,
  ) {
    // 中文注释：节流命中走 429；前端用 retry_after_hours 直接显示「还需等待 N 小时」
    super(
      `手动 daily-sync 节流中：上次成功时间 ${lastManualAt}；还需等待 ${retryAfterHours} 小时`,
    );
    this.name = 'ManualDailySyncCooldownError';
  }
}

/** M16-DAILY-SYNC-COOLDOWN-1：节流窗口可由 env `MANUAL_DAILY_SYNC_COOLDOWN_HOURS` 覆盖；缺省 24。 */
function resolveManualDailySyncCooldownHours(env: Env): number {
  const raw = env.MANUAL_DAILY_SYNC_COOLDOWN_HOURS?.trim() ?? '';
  if (!raw) return MANUAL_DAILY_SYNC_COOLDOWN_HOURS_DEFAULT;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return MANUAL_DAILY_SYNC_COOLDOWN_HOURS_DEFAULT;
  return Math.min(n, 24 * 30); // 安全护栏：最多 30 天
}

/**
 * M16-DAILY-SYNC-COOLDOWN-1：站主手动 daily-sync 节流门闩。
 * - 仅记成功（失败不延长冷却，更友好；与官方公告限流「失败也计数」不同）
 * - 与 cron 锚点 `CONFIG_LAST_SUCCESS` 物理隔离，避免相互干扰
 * - 1 天节流（可由 env `MANUAL_DAILY_SYNC_COOLDOWN_HOURS` 覆盖）
 * 命中冷却 → 抛 `ManualDailySyncCooldownError`；未命中 → 静默通过（不写锚点，等成功后再写）
 */
export async function consumeManualDailySyncQuota(env: Env, now: Date): Promise<void> {
  const last = await readSystemConfig(env, CONFIG_LAST_MANUAL_AT);
  if (!last) return;
  const lastMs = Date.parse(last);
  if (!Number.isFinite(lastMs)) return; // 非法锚点视为无记录，不阻塞
  const cooldownHours = resolveManualDailySyncCooldownHours(env);
  const cooldownMs = cooldownHours * 3600 * 1000;
  const remainingMs = lastMs + cooldownMs - now.getTime();
  if (remainingMs <= 0) return; // 冷却已过
  const retryAfterSeconds = Math.max(1, Math.ceil(remainingMs / 1000));
  const retryAfterHours = Math.max(1, Math.ceil(remainingMs / (3600 * 1000)));
  throw new ManualDailySyncCooldownError(last, retryAfterSeconds, retryAfterHours);
}

/** M16-DAILY-SYNC-COOLDOWN-1：手动 daily-sync 成功时落锚（cron 成功时不动它） */
export async function markManualDailySyncSuccess(env: Env, now: Date): Promise<void> {
  const identityDb = resolveIdentityDb(env);
  await identityDb
    .prepare(
      `INSERT OR REPLACE INTO system_config (key, value, updated_at) VALUES (?, ?, ?)`,
    )
    .bind(CONFIG_LAST_MANUAL_AT, now.toISOString(), now.toISOString())
    .run()
    .catch((err) => console.warn('[daily-sync] 写入 last_manual_at 失败', err));
}

  /** buildDailySyncPostBody 附带元数据，供 200 后更新锚点。 */
  export type DailySyncPostBodyBuild = {
    envelope: PresenceRequestEnvelope;
    /** 本轮实际上报了 group_lifecycle 时的 computed_at；否则 null */
    groupLifecycleComputedAt: string | null;
  };

  /** 构建 presence POST body（可附带近 30 天 activity_summary + 三 etag 游标）。 */
  export async function buildDailySyncPostBody(
    env: Env,
    opts: { includeAggregates?: boolean; force?: boolean } = {},
  ): Promise<DailySyncPostBodyBuild> {
    // A-5c-3：readRegistryEndpoints 内部走 system_config → IDENTITY_DB
    const identityDb = resolveIdentityDb(env);
    const endpoints = await readRegistryEndpoints(identityDb);
    const payload: PresenceRequestEnvelope = {
      known_registry_ids: endpoints.map((e) => e.registry_id),
      channel: 'presence',
    };
    if (opts.force) {
      payload.force = true;
    }
    // R-MSG-2c：客户端游标 → 中心条件块（缺省=未知，可下发 pull_hint）
    const [policyEtag, blacklistEtag, recommendationsEtag] = await Promise.all([
      readSystemConfig(env, CONFIG_POLICY_ETAG),
      readSystemConfig(env, CONFIG_BLACKLIST_ETAG),
      readSystemConfig(env, CONFIG_RECOMMENDATIONS_ETAG_KEY),
    ]);
    if (policyEtag) payload.policy_etag = policyEtag;
    if (blacklistEtag) payload.blacklist_etag = blacklistEtag;
    if (recommendationsEtag) payload.recommendations_etag = recommendationsEtag;
    // M34-3：站主分层在线提示（无 IP）；缺会话时 engagement=unknown
    try {
      const { loadCronOwnerEngagementContext } = await import(
        '../services/ownerEngagement/cronEngagement'
      );
      const snap = await loadCronOwnerEngagementContext(env);
      payload.owner_activity_hint = {
        engagement: snap.ownerEngagement,
        last_owner_seen_at: snap.ownerLastSeenAt,
      };
    } catch (err) {
      console.warn('[daily-sync] 读取 owner_activity_hint 失败，跳过该块', err);
    }
    // M-OPT-0e：附带近 30 天帖/赞/登录次数（fail-soft；无 IP）
    try {
      const { buildActivitySummary } = await import('../lib/activitySummary');
      const summary = await buildActivitySummary(env);
      if (summary) {
        payload.activity_summary = summary;
      }
    } catch (err) {
      console.warn('[daily-sync] 聚合 activity_summary 失败，跳过该块', err);
    }
    // M16-GROUP-LIFECYCLE-V2-11a/13/14 + V2-20：interval_days 与 group_lifecycle **同生死**——
    // 任一缺失都不挂 `interval_days`（中心 `applyGroupLifecycleFromPresence` 仅在 raw 不 undefined 时校验）。
    // 旧行为：cachedInterval 不为 null 但 lifecycle 为 null 时仍挂 `interval_days`，语义不明。
    let groupLifecycleComputedAt: string | null = null;
    try {
      const ownerUserId = await readOwnerUserId(env);
      const cachedInterval = ownerUserId
        ? await getConfigIntervalDays(env, ownerUserId)
        : null;
      if (ownerUserId && cachedInterval != null) {
        const { buildGroupLifecycleSummary } = await import('../lib/groupLifecycleSummary');
        const lifecycle = await buildGroupLifecycleSummary(env, ownerUserId);
        if (lifecycle) {
          payload.group_lifecycle = lifecycle;
          payload.interval_days = cachedInterval;
          groupLifecycleComputedAt = lifecycle.computed_at;
        }
        // lifecycle === null（MESSAGING_DB 未绑 / 聚合失败）→ 两字段都不挂，下次重学
      }
      // 无缓存：先不上报 group_lifecycle（避免 INTERVAL_MISMATCH）；200 后学 data.interval_days
    } catch (err) {
      console.warn('[daily-sync] 聚合 group_lifecycle 失败，跳过该块', err);
    }
    // includeAggregates 已废弃：官方帖/黑名单走条件块 pull_hint / force 辅拉
    void opts.includeAggregates;
    return { envelope: payload, groupLifecycleComputedAt };
  }

interface DailySyncResponseData {
  health?: unknown;
  official_feed?: DailySyncOfficialFeedBlock & {
    pull_hint?: string;
    etag?: string;
    deferred_to?: string;
  };
  blacklist?: {
    unchanged?: boolean;
    etag?: string;
    pull_hint?: string;
    items?: RegistryBlacklistItem[];
    deferred_to?: string;
  };
  /** M9-3-CL3 / M23-13L：全网黑名单块（生产默认 enforce 写 STATE_KV） */
  federated_blacklist?: {
    etag?: string;
    cert_epoch?: number | null;
    enforce_hint?: boolean;
    items?: Array<{ worker_b_url: string; did_v2?: string | null; reason?: string | null }>;
  };
  recommendations?: {
    unchanged?: boolean;
    etag?: string;
    pull_hint?: string;
    items?: RegistryRecommendedUsersResponseItem[];
    next_refresh_after?: string;
    error_code?: string;
    message?: string;
    deferred_to?: string;
  };
  synced_at?: string;
  sync_interval_days?: number;
  /** M16-GROUP-LIFECYCLE-V2-4b：中心群号窗基数；节点缓存到 config_interval_days */
  interval_days?: number;
  policy_poll_interval_days?: number;
  schedule_version?: string;
  channel?: string;
  policy_etag?: string;
  blacklist_etag?: string;
  recommendations_etag?: string;
}

async function readConsecutiveFailDays(env: Env, registryId: string): Promise<number> {
  const raw = await readSystemConfig(env, `registry_daily_sync_fail_days_${registryId}`);
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function utcDateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function previousUtcDateKey(dateKey: string): string {
  const ms = Date.parse(`${dateKey}T00:00:00.000Z`);
  if (!Number.isFinite(ms)) return '';
  return new Date(ms - 86_400_000).toISOString().slice(0, 10);
}

/** M-DS-2b：按自然日累计失败；连续 2 天失败标 endpoint unreachable。 */
async function recordDailySyncEndpointFailure(
  env: Env,
  registryId: string,
  now: Date,
): Promise<void> {
  // A-5c-3：system_config + registry_endpoints 都在 IDENTITY_DB（前者 migration 0090，后者 system_config 内 JSON）
  const identityDb = resolveIdentityDb(env);
  const today = utcDateKey(now);
  const lastDateKey = `registry_daily_sync_fail_date_${registryId}`;
  const daysKey = `registry_daily_sync_fail_days_${registryId}`;
  const last = await readSystemConfig(env, lastDateKey);
  if (last === today) return;

  let consecutive = 1;
  if (last && last === previousUtcDateKey(today)) {
    consecutive = (await readConsecutiveFailDays(env, registryId)) + 1;
  }

  const updatedAt = now.toISOString();
  await identityDb.batch([
    identityDb.prepare(
      `INSERT OR REPLACE INTO system_config (key, value, updated_at) VALUES (?, ?, ?)`,
    ).bind(lastDateKey, today, updatedAt),
    identityDb.prepare(
      `INSERT OR REPLACE INTO system_config (key, value, updated_at) VALUES (?, ?, ?)`,
    ).bind(daysKey, String(consecutive), updatedAt),
  ]);

  if (consecutive >= DAILY_SYNC_UNREACHABLE_FAIL_DAYS) {
    await markRegistryEndpointUnreachable(env, identityDb, registryId);
    await syncRegistryEndpointsToKv(env).catch((err) => {
      console.warn('[cron/daily-sync] unreachable 后同步 registry endpoints KV 失败', err);
    });
    console.warn(
      `[cron/daily-sync] ${registryId} 连续 ${consecutive} 日日同步失败，已标 unreachable`,
    );
  }
}

async function recordDailySyncEndpointSuccess(env: Env, registryId: string): Promise<void> {
  // A-5c-3：system_config + registry_endpoints 都在 IDENTITY_DB
  const identityDb = resolveIdentityDb(env);
  const updatedAt = isoNow();
  await identityDb.batch([
    identityDb.prepare(`DELETE FROM system_config WHERE key = ?`).bind(`registry_daily_sync_fail_date_${registryId}`),
    identityDb.prepare(`DELETE FROM system_config WHERE key = ?`).bind(`registry_daily_sync_fail_days_${registryId}`),
  ]).catch((err) => {
    console.warn('[cron/daily-sync] 清理 fail_days 失败', err);
  });
  await markRegistryEndpointDailySyncSuccess(env, identityDb, registryId);
  await syncRegistryEndpointsToKv(env).catch((err) => {
    console.warn('[cron/daily-sync] 成功后同步 registry endpoints KV 失败', err);
  });
  void updatedAt;
}

async function postDailySyncToEndpoint(
  env: Env,
  endpoint: RegistryEndpoint,
  body: string,
) {
  // M9-3-R1：凭证来自传入的 registered_registries 映射，不回查地址簿拼 token
  return registryRouterFetchBound(env, DAILY_SYNC_PATH, endpoint, {
    method: 'POST',
    body,
    profile: 'cron',
    skipOutboundAudit: true,
  });
}

async function handleDailySyncDirectives(
  env: Env,
  envelope: Record<string, unknown>,
  endpoint: RegistryEndpoint,
): Promise<void> {
  // A-5c-3：directives 内部写 system_config + registry_endpoints，均在 IDENTITY_DB
  const identityDb = resolveIdentityDb(env);
  const result = await applyRegistryDirectivesFromEnvelope(
    env,
    identityDb,
    envelope,
    endpoint,
    REGISTRY_DIRECTIVE_DAILY_SYNC_PATH,
  );
  if (result.status === 'applied') {
    await syncRegistryEndpointsToKv(env);
    console.log('[cron/daily-sync/directives]', JSON.stringify(result));
  } else if (
    result.reason !== 'no_directives'
    && result.reason !== 'invalid_json'
  ) {
    console.warn('[cron/daily-sync/directives]', JSON.stringify(result));
  }
}

async function applyPrimaryAggregatesFromDailySync(
  env: Env,
  endpoint: RegistryEndpoint,
  data: DailySyncResponseData,
): Promise<void> {
  // A-5c-3：所有 system_config 写都在 IDENTITY_DB，先解析闭包
  const identityDb = resolveIdentityDb(env);
  const sourceUrl = endpoint.registry_url.replace(/\/$/, '');
  const now = isoNow();

  // 中心下发的 presence 间隔写回本地（缺省 30）
  if (data.sync_interval_days !== undefined) {
    const interval = normalizeSyncIntervalDays(data.sync_interval_days, DEFAULT_SYNC_INTERVAL_DAYS);
    await identityDb.prepare(
      `INSERT OR REPLACE INTO system_config(key, value, updated_at) VALUES(?, ?, ?)`,
    )
      .bind(CONFIG_SYNC_INTERVAL_DAYS, String(interval), now)
      .run()
      .catch((err) => console.warn('[cron/daily-sync] 写入 sync_interval_days 失败', err));
  }
  // R-MSG-2c：routine 忽略 policy_poll_interval_days（仍兼容落库供诊断）
  if (data.policy_poll_interval_days !== undefined) {
    const n = Math.floor(Number(data.policy_poll_interval_days));
    if (n === 1 || n === 2 || n === 3 || n === 7) {
      await identityDb.prepare(
        `INSERT OR REPLACE INTO system_config(key, value, updated_at) VALUES(?, ?, ?)`,
      )
        .bind('policy_poll_interval_days', String(n), now)
        .run()
        .catch((err) => console.warn('[cron/daily-sync] 写入 policy_poll_interval_days 失败', err));
    }
  }

  // R-MSG-2c：响应语义版本落库（错峰 salt 仍为 daily_sync_v4）
  const scheduleVersion =
    typeof data.schedule_version === 'string' && data.schedule_version.trim()
      ? data.schedule_version.trim()
      : DAILY_SYNC_PRESENCE_SCHEDULE_VERSION;
  await identityDb.prepare(
    `INSERT OR REPLACE INTO system_config(key, value, updated_at) VALUES(?, ?, ?)`,
  )
    .bind(CONFIG_DAILY_SYNC_SCHEDULE_VERSION_KEY, scheduleVersion, now)
    .run()
    .catch((err) => console.warn('[cron/daily-sync] 写入 schedule_version 失败', err));

  const feed = data.official_feed;
  const bl = data.blacklist;
  const rec = data.recommendations;

  // 官方公告：pull_hint → 同 tick 辅拉；unchanged / 内联 items 走 apply
  if (feed) {
    const feedDeferred = Boolean(feed.deferred_to);
    if (feed.pull_hint === 'posts/feed') {
      try {
        await pullRegistryOfficialFeedAfterRegistration(env);
        const etag = (feed.etag ?? data.policy_etag)?.trim();
        if (etag) {
          await identityDb.prepare(
            `INSERT OR REPLACE INTO system_config(key, value, updated_at) VALUES(?, ?, ?)`,
          )
            .bind(CONFIG_POLICY_ETAG, etag, now)
            .run();
        }
      } catch (err) {
        console.warn('[cron/daily-sync] pull_hint posts/feed 辅拉失败', err);
      }
    } else if (!feed.error_code && !feedDeferred) {
      await applyRegistryOfficialFeedFromDailySync(env, sourceUrl, feed);
      if (feed.unchanged && feed.etag?.trim()) {
        await identityDb.prepare(
          `INSERT OR REPLACE INTO system_config(key, value, updated_at) VALUES(?, ?, ?)`,
        )
          .bind(CONFIG_POLICY_ETAG, feed.etag.trim(), now)
          .run()
          .catch(() => {});
      }
    }
  }

  // 黑名单：pull_hint → GET /api/blacklist；否则走块落库
  if (bl) {
    const blDeferred = Boolean(bl.deferred_to);
    if (bl.pull_hint === 'blacklist') {
      try {
        await syncRegistryBlacklistToKv(env);
      } catch (err) {
        console.warn('[cron/daily-sync] pull_hint blacklist 辅拉失败', err);
      }
    } else if (!blDeferred) {
      await applyRegistryBlacklistFromDailySync(env, bl);
    }
  }

  if (data.federated_blacklist) {
    await applyFederatedBlacklistFromDailySync(env, data.federated_blacklist);
  }

  // 推荐：pull_hint → 同 tick GET；unchanged 只记 etag，禁止空 items 覆盖
  if (rec && !rec.error_code) {
    const recDeferred = Boolean(rec.deferred_to);
    if (rec.pull_hint === 'recommendations/users') {
      try {
        await syncRegistryRecommendedUsers(env);
        const etag = (rec.etag ?? data.recommendations_etag)?.trim();
        if (etag) {
          await identityDb.prepare(
            `INSERT OR REPLACE INTO system_config(key, value, updated_at) VALUES(?, ?, ?)`,
          )
            .bind(CONFIG_RECOMMENDATIONS_ETAG_KEY, etag, now)
            .run();
        }
      } catch (err) {
        console.warn('[cron/daily-sync] pull_hint recommendations 辅拉失败', err);
      }
    } else if (!recDeferred) {
      await applyRegistryRecommendationsFromDailySync(env, rec, endpoint.registry_id);
    }
  }
}

async function syncDailySyncToSingleEndpoint(
  env: Env,
  endpoint: RegistryEndpoint,
  body: string,
  applyAggregates: boolean,
  /** 本轮上报的 group_lifecycle.computed_at；200 后写入锚点 */
  groupLifecycleComputedAt: string | null = null,
): Promise<boolean> {
  // A-5c-3：outbound_events 表在 IDENTITY_DB（migration-identity/0003），先解析闭包
  const identityDb = resolveIdentityDb(env);
  const targetUrl = dailySyncTargetUrl(endpoint);

  let routerResult: Awaited<ReturnType<typeof postDailySyncToEndpoint>>;
  try {
    routerResult = await postDailySyncToEndpoint(env, endpoint, body);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('节点尚未注册')) {
      console.info(`[cron/daily-sync] ${endpoint.registry_id} 节点尚未注册，跳过`);
      return false;
    }

    await insertOutboundEvent(identityDb, {
      kind: 'registry/daily-sync',
      targetUrl,
      status: 'failed',
      httpCode: null,
      errCode: 'NETWORK_ERROR',
      errMessage: message,
      registryId: endpoint.registry_id,
      routerAttempts: 0,
      routerDetail: message.slice(0, 500),
    });
    await recordDailySyncEndpointFailure(env, endpoint.registry_id, new Date());
    console.error(`[cron/daily-sync] ${endpoint.registry_id} 网络异常`, message);
    return false;
  }

  const res = routerResult.response;

  if (res.ok) {
    let parsed: { ok?: boolean; data?: DailySyncResponseData } & Record<string, unknown> | null = null;
    try {
      parsed = await res.json() as { ok?: boolean; data?: DailySyncResponseData } & Record<string, unknown>;
    } catch {
      parsed = null;
    }

    if (parsed) {
      await handleDailySyncDirectives(env, parsed, endpoint);
    }

    if (applyAggregates && parsed?.ok && parsed.data) {
      await applyPrimaryAggregatesFromDailySync(env, endpoint, parsed.data);
    }

    // V2-11a / V2-14：200 后缓存 data.interval_days；有上报块则前进锚点
    try {
      const ownerUserId = await readOwnerUserId(env);
      if (ownerUserId) {
        const learned = normalizeConfigIntervalDays(parsed?.data?.interval_days);
        await upsertNodeSyncStateAfterSuccess(env, ownerUserId, {
          configIntervalDays: learned,
          lastDailySyncReportedAt: groupLifecycleComputedAt,
        });
      }
    } catch (err) {
      console.warn('[cron/daily-sync] 写入 node_sync_state 失败', err);
    }

    await insertOutboundEvent(identityDb, {
      kind: 'registry/daily-sync',
      targetUrl,
      status: 'ok',
      httpCode: res.status,
      errCode: null,
      errMessage: null,
      registryId: endpoint.registry_id,
      routerAttempts: routerResult.attempts,
      routerDetail: routerResult.router_detail,
    });
    console.log(`[cron/daily-sync] ${endpoint.registry_id} 同步成功 ${res.status}`);
    await recordDailySyncEndpointSuccess(env, endpoint.registry_id);
    return true;
  }

  let errCode: string | null = null;
  let errMessage: string | null = null;
  try {
    const json = await res.json() as { error_code?: string; message?: string };
    errCode = json.error_code ?? null;
    errMessage = json.message ?? null;
  } catch {
    // 非 JSON 忽略
  }

  // 中心 INTERVAL 已变：清本地缓存，下次 omit 块再学新值；V2-20 升级为可观测事件
  if (errCode === 'GROUP_LIFECYCLE_INTERVAL_MISMATCH') {
    try {
      const ownerUserId = await readOwnerUserId(env);
      if (ownerUserId) {
        // V2-20：先记运营事件（说明中心窗长已变），再清缓存；站主可在 Settings 看到时间线
        await writeOperationLog(env, {
          source: 'worker-a',
          level: 'warn',
          event: 'group_lifecycle_interval_mismatch',
          message: '中心 INTERVAL_DAYS 已变：清本地 config_interval_days，下次重学',
          details: {
            primary_id: endpoint.registry_id,
            cached_interval_days: 'cleared',
          },
        }).catch((err) => console.warn('[cron/daily-sync] 写 MISMATCH 运营事件失败', err));
        await clearConfigIntervalDays(env, ownerUserId);
        console.warn('[cron/daily-sync] INTERVAL_MISMATCH：已清 config_interval_days，下次重学');
      }
    } catch (err) {
      console.warn('[cron/daily-sync] 清 config_interval_days 失败', err);
    }
  }

  await insertOutboundEvent(identityDb, {
    kind: 'registry/daily-sync',
    targetUrl,
    status: 'failed',
    httpCode: res.status,
    errCode,
    errMessage,
    registryId: endpoint.registry_id,
    routerAttempts: routerResult.attempts,
    routerDetail: routerResult.router_detail,
  });
  console.warn(`[cron/daily-sync] ${endpoint.registry_id} 同步失败 ${res.status} ${errCode ?? ''}`);
  await recordDailySyncEndpointFailure(env, endpoint.registry_id, new Date());
  return false;
}

export type SyncRegistryDailyOptions = {
  /** 登记完成 / Settings 手动：跳过本地 interval×12h 节流，并向中心带 force */
  force?: boolean;
  /**
   * M16-DAILY-SYNC-COOLDOWN-1：仅 Settings「立即同步」成功时写手动冷却锚点。
   * 登记完成 / 弃用 health 转调等其它 force 路径不得置 true，避免误占 24h 冷却。
   */
  markManualSuccess?: boolean;
};

/**
 * presence 主入口（Cron / 登记后 / Settings 手动）。
 * force 时额外跑 policy-digest + 推荐名单，便于站主立刻拿到公告/黑名单/推荐。
 */
export async function syncRegistryDaily(
  env: Env,
  opts: SyncRegistryDailyOptions = {},
): Promise<void> {
  const now = new Date();

  if (!opts.force && !(await shouldRunScheduledDailySync(env, now))) {
    const intervalDays = await readSyncIntervalDays(env);
    console.info(`[cron/daily-sync] 距上次成功不足 ${intervalDays * 12}h，跳过`);
    return;
  }

  const target = await resolveRegisteredRegistryForSync(env);
  if (!target) {
    console.info('[cron/daily-sync] 无已登记注册中心（registered_registries 空），跳过');
    return;
  }

  const scheduledSecondRaw = await readSystemConfig(env, CONFIG_DAILY_SYNC_UTC_SECOND_OF_DAY);

  await writeOperationLog(env, {
    source: 'worker-a',
    level: 'info',
    event: 'registry_daily_sync_start',
    message: '开始注册中心 presence sync',
    details: {
      endpoints: [target.registry_id],
      primary_id: target.registry_id,
      daily_sync_utc_second_of_day: scheduledSecondRaw || null,
      force: Boolean(opts.force),
      source: 'registered_registries',
      channel: 'presence',
    },
  });

  const { envelope, groupLifecycleComputedAt } = await buildDailySyncPostBody(env, {
    force: Boolean(opts.force),
  });
  const body = serializeProtoEnvelope(envelope as unknown as Record<string, unknown>);
  const ok = await syncDailySyncToSingleEndpoint(
    env,
    target,
    body,
    true,
    groupLifecycleComputedAt,
  );

  if (ok) {
    await writeDailySyncMeta(env, 'ok', null);
    await writeOperationLog(env, {
      source: 'worker-a',
      level: 'info',
      event: 'registry_daily_sync_ok',
      message: '注册中心 presence sync 完成',
      details: { primary_id: target.registry_id, source: 'registered_registries' },
    });
    if (opts.force) {
      // M16-DAILY-SYNC-COOLDOWN-1：仅 markManualSuccess 写手动锚点（登记/弃用 health 的 force 不写）
      if (opts.markManualSuccess) {
        await markManualDailySyncSuccess(env, new Date());
      }
      await syncRegistryPolicyDigest(env, { force: true }).catch((err) => {
        console.warn('[cron/daily-sync] force 后 policy-digest 失败', err);
      });
      // 中文注释：立即同步也拉推荐，不走 7 日错峰门闩
      await syncRegistryRecommendedUsers(env).catch((err) => {
        console.warn('[cron/daily-sync] force 后 recommendations 失败', err);
      });
    }
  } else {
    await writeDailySyncMeta(env, 'failed', 'registered_registry_failed');
    await writeOperationLog(env, {
      source: 'worker-a',
      level: 'warn',
      event: 'registry_daily_sync_failed',
      message: '注册中心 presence sync 已登记中心失败',
      details: { primary_id: target.registry_id, source: 'registered_registries' },
    });
  }
}

/** 登记完成后立即 presence + policy 探测（跳过周期节流）。 */
export async function syncRegistryDailyOnRegistration(env: Env): Promise<void> {
  await syncRegistryDaily(env, { force: true });
}

export interface RegistryDailySyncDiagnostics {
  last_success_at: string | null;
  last_status: string | null;
  last_error: string | null;
  /** M16-DAILY-SYNC-COOLDOWN-1：手动「立即同步」最近成功时间；与 cron 锚点独立。 */
  last_manual_at: string | null;
  /** presence 间隔（日），默认 30 */
  sync_interval_days: number;
  /** policy-digest 探测诊断 */
  policy_poll: Awaited<ReturnType<typeof readRegistryPolicyPollDiagnostics>>;
  official_feed: Awaited<ReturnType<typeof readRegistryOfficialFeedDiagnostics>>;
  blacklist: {
    remote_etag: string | null;
    last_sync_at: string | null;
  };
  recommendations: {
    last_checked_at: string | null;
    last_status: string | null;
    last_fetched_count: number;
    last_error: string | null;
  };
  endpoints: Array<{
    registry_id: string;
    status: string;
    fail_streak: number;
    consecutive_fail_days: number;
    last_ok_at: string | null;
    last_fail_at: string | null;
  }>;
  /** M9-3-R1：已登记权威中心（≤1） */
  registered: {
    registry_id: string;
    status: string;
    fail_streak: number;
    last_ok_at: string | null;
    last_fail_at: string | null;
  } | null;
  /** M-OPT-8：当日 handle 解析分层命中与 L4 占比 */
  lookup_resolve: LookupResolveDayStats;
  /** M9-3-CL4：联邦诊断（无 peer 拓扑） */
  federation: {
    home_registry_id: string | null;
    endpoints_count: number;
    endpoints_cap: number;
    last_lookup: {
      handle: string;
      home_registry_id: string | null;
      resolved_via_registry_id: string | null;
      route_version: number | null;
      route_stale: boolean | null;
      error_code: string | null;
      http_status: number;
      at: string;
    } | null;
    federated_blacklist: {
      etag: string | null;
      cert_epoch: number | null;
      item_count: number | null;
      updated_at: string | null;
      enforce: boolean;
    };
  };
}

/** M-DS-2a：Settings 读取上次日同步与各块摘要。 */
export async function readRegistryDailySyncDiagnostics(env: Env): Promise<RegistryDailySyncDiagnostics> {
  // A-5c-3：readRegisteredRegistry / readRegistryEndpoints 都接 D1Database 入参，内部走 system_config → IDENTITY_DB
  const identityDb = resolveIdentityDb(env);
  const [officialFeed, recommendations, endpoints, registered, lookupResolve, lastLookup, policyPoll] =
    await Promise.all([
      readRegistryOfficialFeedDiagnostics(env),
      readRegistryRecommendedUsers(env),
      readRegistryEndpoints(identityDb),
      readRegisteredRegistry(identityDb),
      getLookupResolveDayStats(env),
      readFederationLastLookup(env),
      readRegistryPolicyPollDiagnostics(env),
    ]);

  const blacklistEtag = await readSystemConfig(env, 'blacklist_remote_etag');
  const blacklistSyncAt = await readSystemConfig(env, 'blacklist_remote_last_sync_at');
  const fedSnapshotRaw = await readSystemConfig(env, 'federated_blacklist_snapshot');
  let fedEtag: string | null = null;
  let fedCertEpoch: number | null = null;
  let fedItemCount: number | null = null;
  let fedUpdatedAt: string | null = null;
  if (fedSnapshotRaw) {
    try {
      const snap = JSON.parse(fedSnapshotRaw) as {
        etag?: string | null;
        cert_epoch?: number | null;
        item_count?: number | null;
        updated_at?: string | null;
      };
      fedEtag = typeof snap.etag === 'string' ? snap.etag : null;
      fedCertEpoch = typeof snap.cert_epoch === 'number' ? snap.cert_epoch : null;
      fedItemCount = typeof snap.item_count === 'number' ? snap.item_count : null;
      fedUpdatedAt = typeof snap.updated_at === 'string' ? snap.updated_at : null;
    } catch {
      /* ignore */
    }
  }

  const endpointRows = await Promise.all(
    endpoints.map(async (ep) => ({
      registry_id: ep.registry_id,
      status: ep.status,
      fail_streak: ep.fail_streak,
      consecutive_fail_days: await readConsecutiveFailDays(env, ep.registry_id),
      last_ok_at: ep.last_ok_at ?? null,
      last_fail_at: ep.last_fail_at ?? null,
    })),
  );

  return {
    last_success_at: (await readSystemConfig(env, CONFIG_LAST_SUCCESS)) || null,
    last_status: (await readSystemConfig(env, CONFIG_LAST_STATUS)) || null,
    last_error: (await readSystemConfig(env, CONFIG_LAST_ERROR)) || null,
    last_manual_at: (await readSystemConfig(env, CONFIG_LAST_MANUAL_AT)) || null,
    sync_interval_days: await readSyncIntervalDays(env),
    policy_poll: policyPoll,
    official_feed: officialFeed,
    blacklist: {
      remote_etag: blacklistEtag || null,
      last_sync_at: blacklistSyncAt || null,
    },
    recommendations: {
      last_checked_at: recommendations.last_checked_at,
      last_status: recommendations.last_status,
      last_fetched_count: recommendations.last_fetched_count,
      last_error: recommendations.last_error,
    },
    endpoints: endpointRows,
    registered: registered
      ? {
        registry_id: registered.registry_id,
        status: registered.status,
        fail_streak: registered.fail_streak,
        last_ok_at: registered.last_ok_at ?? null,
        last_fail_at: registered.last_fail_at ?? null,
      }
      : null,
    lookup_resolve: lookupResolve,
    // M9-3-CL4：联邦诊断只读块（禁止 peer 枚举）
    federation: {
      home_registry_id: registered?.registry_id ?? null,
      endpoints_count: endpoints.length,
      endpoints_cap: MAX_REGISTRY_ENDPOINTS,
      last_lookup: lastLookup,
      federated_blacklist: {
        etag: fedEtag,
        cert_epoch: fedCertEpoch,
        item_count: fedItemCount,
        updated_at: fedUpdatedAt,
        enforce: isFederationBlacklistEnforceEnabled(env),
      },
    },
  };
}
