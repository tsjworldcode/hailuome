// Cron 任务处理函数（M1-2 + M3-4/5 + M13-2 budget）。
//
// 调度骨架（index.ts scheduled handler 调用；wrangler 仅挂 * * * * *）：
//   每分钟：refreshPostsCacheIfDirty（含 5 分钟硬节流，M3-5）
//   minute 0～5 + 7：runRotatedHourlyGc 有界切片（M13-19/19b；calibrate@7 避开 Feed；兼容 runHourlyGcSerial）
//   minute % 2/%5：runCronBudgeted 串行错峰（M13-2/10，见 handlers/cronBudget.ts）
//
// fail-soft 策略（方案优化.md §4.2）：
//   上报失败（网络超时 / 5xx）→ 写 outbound_events(status='failed')，不抛异常，
//   不中断 Cron；下一个 minute % 15 === 5 窗口自动重试（retries < 3）。
//
// 若节点尚未注册（D1 缺 node_api_token / owner_user_id），两个函数均静默跳过。

import type { Env } from '../env';
import { resolveContentDb, resolveGovernanceDb, resolveIdentityDb } from '../db/bindings';
import {
  gcCacheEntriesWithWaterLevel,
  gcOutboundEventsWithWaterLevel,
} from '../lib/d1Gc';
import { putPostsLatestWithMeta } from '../lib/publicCacheMeta';
import { tryConsumeNonSecurityCachePuts } from '../lib/cacheKvPutBudget';
import { clearPostsLatestCacheMeta } from '../lib/postsLatestCacheMeta';
import { refreshLatestFeedKv } from './feedFetch';
import type { RegistryEndpoint } from '../lib/registryEndpoints';
import {
  registryRouterFetchBound,
  resolvePrimaryRegistryEndpoint,
  resolveRegisteredRegistryForSync,
  resolveRegistryEndpoints,
} from '../lib/registryRouter';
import {
  applyRegistryDirectivesFromEnvelope,
  REGISTRY_DIRECTIVE_DAILY_SYNC_PATH,
} from '../lib/registryDirectives';
import { buildDailySyncPostBody, syncRegistryDaily } from './registryDailySync';
import { serializeProtoEnvelope } from '@hailuo/shared-utils';
import { syncRegistryEndpointsToKv } from './registryEndpointsKvSync';

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

/** 当前 UTC ISO 8601 字符串。 */
function isoNow(): string {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// M-DS-3：legacy health 上报已弃用，统一 daily-sync
// ---------------------------------------------------------------------------

/**
 * @deprecated M-DS-3 / M-OPT-12：Cron 与生产路径只走 daily-sync；勿再新增调用方。
 * 保留仅为兼容旧脚本/测试 import（内部强制转调 syncRegistryDaily）。
 */
export async function reportHealthToRegistry(env: Env): Promise<void> {
  console.warn('[cron/health] reportHealthToRegistry 已弃用（M-OPT-12），转 syncRegistryDaily');
  await syncRegistryDaily(env, { force: true });
}

function legacyHealthTargetToDailySync(targetUrl: string): string {
  return targetUrl.replace(/\/api\/node\/health\/?$/, '/api/node/daily-sync');
}

function dailySyncTargetUrl(endpoint: RegistryEndpoint): string {
  return `${endpoint.registry_url.replace(/\/$/, '')}/api/node/daily-sync`;
}

async function postDailySyncToEndpoint(
  env: Env,
  endpoint: RegistryEndpoint,
  body: string,
) {
  // M9-3-R1：重试也绑定传入凭证，不回查地址簿拼 token
  return registryRouterFetchBound(env, '/api/node/daily-sync', endpoint, {
    method: 'POST',
    body,
    profile: 'cron',
    skipOutboundAudit: true,
  });
}

// ---------------------------------------------------------------------------
// outbound_events 失败重试
// ---------------------------------------------------------------------------

/**
 * 扫描 outbound_events 中 status='failed' AND retries < 3 的记录并重试（最多 3 条）。
 *
 * M-DS-3：遗留 registry/health 失败事件也改走 daily-sync 重试。
 * 其他 kind（index/post、index/comment）M4-2 时补全。
 *
 * CRON-SCHEDULE-AUDIT：cronBudget 对本任务的外部估算固定 3，原 LIMIT 10 会单次最多 10 次外部，
 * 在 5/35 群槽上和群任务叠加后可能超过 50；批大小与估算对齐为 3。
 */
export const OUTBOUND_RETRY_BATCH = 3;

export async function retryFailedOutboundEvents(env: Env): Promise<void> {
  // A-5c-3 勘误：outbound_events 表在 IDENTITY_DB（migration-identity/0003）；A-5b 误归 GOVERNANCE_DB 修正
  const identityDb = resolveIdentityDb(env);
  let rows: Array<{ id: string; kind: string; target_url: string; retries: number }>;

  try {
    const { results } = await identityDb
      .prepare(
        `SELECT id, kind, target_url, retries
           FROM outbound_events
          WHERE status = 'failed' AND retries < 3
          ORDER BY created_at ASC
          LIMIT ?`,
      )
      .bind(OUTBOUND_RETRY_BATCH)
      .all<{ id: string; kind: string; target_url: string; retries: number }>();
    rows = results ?? [];
  } catch (err) {
    // D1 查询失败静默处理，不阻断 Cron
    console.error('[cron/retry] 查询 outbound_events 失败', err);
    return;
  }

  if (rows.length === 0) return;

  console.log(`[cron/retry] 待重试 ${rows.length} 条 outbound_events`);

  for (const row of rows) {
    if (row.kind === 'registry/health' || row.kind === 'registry/daily-sync') {
      const targetUrl = row.kind === 'registry/health'
        ? legacyHealthTargetToDailySync(row.target_url)
        : row.target_url;
      await retryDailySyncEvent(env, identityDb, row.id, targetUrl);
    } else if (row.kind === 'index/post' || row.kind === 'index/comment') {
      // M4-2：index/post / index/comment 重试（表结构不变，payload 需在创建时存入 payload_hash）
      await retryIndexEvent(env, identityDb, row.id, row.kind);
    } else {
      // 未知 kind，仅记日志
      console.log(`[cron/retry] ${row.id} kind=${row.kind} 未知类型，跳过`);
    }
  }
}

/** 重试单条 registry/daily-sync outbound_event。 */
async function retryDailySyncEvent(
  env: Env,
  identityDb: D1Database,
  eventId: string,
  targetUrl: string,
): Promise<void> {
  // M9-3-R1：优先已登记权威表；其次才按 URL 匹配地址簿
  const registered = await resolveRegisteredRegistryForSync(env);
  const allEndpoints = await resolveRegistryEndpoints(env);
  const normalizedTarget = targetUrl.replace(/\/$/, '');
  const endpoint = (registered && (
    dailySyncTargetUrl(registered) === normalizedTarget
    || registered.registry_url.replace(/\/$/, '') === normalizedTarget.replace(/\/api\/node\/daily-sync$/, '')
  ))
    ? registered
    : allEndpoints.find(
      (e) => dailySyncTargetUrl(e) === normalizedTarget
        || e.registry_url.replace(/\/$/, '') === normalizedTarget.replace(/\/api\/node\/daily-sync$/, ''),
    );

  if (!endpoint?.node_api_token?.trim()) {
    console.info(`[cron/retry] ${eventId} 无法匹配已登记/地址簿 endpoint，跳过`);
    return;
  }

  const primary = registered ?? await resolvePrimaryRegistryEndpoint(env);
  const includeAggregates = endpoint.registry_id === (primary?.registry_id ?? endpoint.registry_id);
  const { envelope } = await buildDailySyncPostBody(env, { includeAggregates });
  const body = serializeProtoEnvelope(envelope as unknown as Record<string, unknown>);

  let routerResult: Awaited<ReturnType<typeof postDailySyncToEndpoint>>;
  try {
    routerResult = await postDailySyncToEndpoint(env, endpoint, body);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('节点尚未注册')) {
      console.info(`[cron/retry] ${eventId} 节点尚未注册，跳过`);
      return;
    }
    await identityDb
      .prepare(`UPDATE outbound_events SET retries = retries + 1, finished_at = ? WHERE id = ?`)
      .bind(isoNow(), eventId)
      .run()
      .catch((dbErr) => console.error('[cron/retry] 更新 retries 失败', dbErr));
    console.error(`[cron/retry] ${eventId} daily-sync 重试网络异常`, message);
    return;
  }

  const res = routerResult.response;
  const now = isoNow();
  if (res.ok) {
    try {
      const parsed = await res.json() as Record<string, unknown>;
      const result = await applyRegistryDirectivesFromEnvelope(
        env,
        identityDb,
        parsed,
        endpoint,
        REGISTRY_DIRECTIVE_DAILY_SYNC_PATH,
      );
      if (result.status === 'applied') {
        await syncRegistryEndpointsToKv(env);
      }
    } catch {
      // directives 解析失败不阻断重试状态更新
    }
    await identityDb
      .prepare(
        `UPDATE outbound_events
            SET status = 'ok', http_code = ?, finished_at = ?,
                registry_id = ?, router_attempts = ?, router_detail = ?
          WHERE id = ?`,
      )
      .bind(
        res.status,
        now,
        endpoint.registry_id,
        routerResult.attempts,
        routerResult.router_detail.slice(0, 500),
        eventId,
      )
      .run()
      .catch((dbErr) => console.error('[cron/retry] 更新 status 失败', dbErr));
    console.log(`[cron/retry] ${eventId} daily-sync 重试成功 ${res.status}`);
  } else {
    await identityDb
      .prepare(`UPDATE outbound_events SET retries = retries + 1, http_code = ?, finished_at = ? WHERE id = ?`)
      .bind(res.status, now, eventId)
      .run()
      .catch((dbErr) => console.error('[cron/retry] 更新 retries 失败', dbErr));
    console.warn(`[cron/retry] ${eventId} daily-sync 重试失败 ${res.status}`);
  }
}

// ---------------------------------------------------------------------------
// M3-5：posts:latest 刷 KV（被每分钟 cron 调用）
// ---------------------------------------------------------------------------

/** 发帖/删帖后立即刷新时可绕过 Cron 5 分钟节流（仍走同一套 dirty 判定与 D1→KV 逻辑）。 */
export interface RefreshPostsCacheOptions {
  bypassThrottle?: boolean;
  /**
   * M-OPT-SPLIT-A6-6：忽略 dirty=false，强制刷 KV。
   * 用于「posts 已写入但 system_config dirty 置位失败」的 Scheme C 兜底。
   */
  force?: boolean;
  /**
   * M13-16：`security`（删帖等）不消耗非安全 put 日预算；默认 `normal`。
   */
  priority?: 'security' | 'normal';
}

/**
 * 检查 posts_latest_dirty 标记，若为 true 且距上次刷新 ≥ 5 分钟，
 * 则读 D1 最近 50 条帖子并写入 POSTS_CACHE_KV['posts:latest']。
 *
 * 5 分钟硬节流说明：
 *   Free Tier KV 写 1,000 次/天。每分钟触发但至多 12 次/小时刷新，
 *   实际写入次数 ≤ 288 次/天，远低于限额。
 *   发帖/删帖经 waitUntil 调用时可传 bypassThrottle:true 立即刷新。
 *
 * fail-soft：KV.put 失败时记录日志，不抛出，不影响其他 Cron 分支。
 */
export async function refreshPostsCacheIfDirty(
  env: Env,
  options?: RefreshPostsCacheOptions,
): Promise<void> {
  // M5-P8 优化：把原来两次独立 SELECT system_config 合并为单次 IN 查询。
  // 大多数 cron 触发时 dirty=false，会在此处直接返回，单次 RTT 更经济。
  // A-5b：system_config → IDENTITY_DB，posts → CONTENT_DB
  const identityDb = resolveIdentityDb(env);
  const contentDb = resolveContentDb(env);
  let dirtyValue: string | undefined;
  let lastAt: string = '';
  try {
    const result = await identityDb
      .prepare(
        `SELECT key, value FROM system_config
          WHERE key IN ('posts_latest_dirty', 'posts_latest_last_refresh_at')`,
      )
      .all<{ key: string; value: string }>();
    for (const row of result.results ?? []) {
      if (row.key === 'posts_latest_dirty') dirtyValue = row.value;
      else if (row.key === 'posts_latest_last_refresh_at') lastAt = row.value ?? '';
    }
  } catch (err) {
    console.error('[cron/posts-cache] 读 system_config（dirty + last_refresh_at）失败', err);
    return;
  }

  if (dirtyValue !== 'true' && !options?.force) {
    return; // 未脏，跳过（最常见路径）
  }

  // 5 分钟硬节流（Cron 路径）；发帖/删帖 waitUntil 刷新时 bypassThrottle 跳过。
  if (!options?.bypassThrottle && lastAt) {
    const lastMs = Date.parse(lastAt);
    if (!isNaN(lastMs) && Date.now() - lastMs < 5 * 60 * 1000) {
      console.log('[cron/posts-cache] 5 分钟节流中，跳过本次刷新');
      return;
    }
  }

  // 3. 读 D1 最近 50 条未删除帖子（按发布时间倒序；M9-1 含转发元数据）
  // A-5b：posts → CONTENT_DB
  let rows: Array<{
    id: string;
    content: string;
    sig: string;
    image_keys: string;
    created_at: string;
    post_kind: string;
    repost_of_node_url: string | null;
    repost_of_post_id: string | null;
    repost_of_author_handle: string | null;
  }>;
  try {
    const result = await contentDb
      .prepare(
        `SELECT id, content, sig, image_keys, created_at,
                post_kind, repost_of_node_url, repost_of_post_id, repost_of_author_handle
           FROM posts
          WHERE deleted_at IS NULL
          ORDER BY created_at DESC, id DESC
          LIMIT 50`,
      )
      .all<{
        id: string;
        content: string;
        sig: string;
        image_keys: string;
        created_at: string;
        post_kind: string;
        repost_of_node_url: string | null;
        repost_of_post_id: string | null;
        repost_of_author_handle: string | null;
      }>();
    rows = result.results ?? [];
  } catch (err) {
    console.error('[cron/posts-cache] D1 查询失败', err);
    return;
  }

  // 4. M13-16：非安全路径先占日 put 预算；不足则保留 dirty 待补刷（可慢不可丢）
  const priority = options?.priority ?? 'normal';
  const budget = await tryConsumeNonSecurityCachePuts(identityDb, env, 1, { priority });
  if (!budget.allowed) {
    console.log(
      `[cron/posts-cache] 非安全缓存预算不足，推迟 KV 发布（used=${budget.used}/${budget.limit} day=${budget.day} reason=${budget.reason}）`,
    );
    return;
  }

  // 5. 写 POSTS_CACHE_KV envelope（M13-3：单次 put，替换数组 + :meta 双写）
  try {
    await putPostsLatestWithMeta(env, rows);
  } catch (err) {
    console.error('[cron/posts-cache] KV put 失败', err);
    return; // KV 写失败时保留 dirty=true，下次重试
  }

  const now = isoNow();

  // M13-18：dirty + last_refresh_at 同属 IDENTITY_DB system_config，合批 1 次 D1 API。
  // 行写仍为 2（batch 不计减行写）；失败整批回滚 → dirty 保持 true，下轮可补刷（可慢不可丢）。
  // 禁止与 CONTENT_DB/posts 混进同一 batch（跨库会静默写错库，见 MSG-FIX-6）。
  try {
    await clearPostsLatestCacheMeta(identityDb, now);
  } catch (err) {
    console.error('[cron/posts-cache] 清除 dirty + 更新 last_refresh_at 失败', err);
  }

  console.log(`[cron/posts-cache] 刷新完成，写入 ${rows.length} 条帖子至 POSTS_CACHE_KV`);
}

// ---------------------------------------------------------------------------
// M-F2：feed:latest 刷 KV（取关清缓存后，由每分钟 cron 触发）
// ---------------------------------------------------------------------------

/**
 * M-F2：检查 `feed_latest_dirty` 标记，若为 true 则把 `feed_cache` 重刷进
 * `feed:latest` KV，成功后清标记。
 *
 * 为什么走 Cron 而不是 HTTP 路径直接刷：
 *   F-01 红线——KV 写 Free Tier 仅 1,000 次/天，D1 是 100,000 次/天（差 100 倍）。
 *   取关是 HTTP 请求，若每次都同步刷 KV，KV 写次数会被用户操作放大。
 *   故取关只删 D1 行 + 置 D1 脏标记，由本函数（每分钟 cron）统一刷 KV。
 *
 * KV 写次数控制：
 *   - dirty=false 时只 1 次 SELECT，直接返回（最常见路径，0 KV 写）
 *   - dirty=true 时刷 1 次；`putFeedLatestWithMeta` 内含内容指纹去重
 *     （M13-10），内容未变则跳过 put → 实际 KV 写 0 次
 *   - 每分钟最多 1 次，理论上界 1,440 次/天，但仅在 dirty 时才可能写；
 *     指纹去重后真实写入远低于上限。
 *
 * fail-soft：任何失败只记日志，不抛；dirty 保持 true，下轮重试。
 */
export async function refreshFeedLatestIfDirty(env: Env): Promise<void> {
  // system_config → IDENTITY_DB
  let dirty = false;
  try {
    const row = await resolveIdentityDb(env)
      .prepare(`SELECT value FROM system_config WHERE key = 'feed_latest_dirty' LIMIT 1`)
      .first<{ value: string }>();
    dirty = row?.value === 'true';
  } catch (err) {
    console.error('[cron/feed-cache] 读 feed_latest_dirty 失败', err);
    return;
  }
  if (!dirty) return; // 未脏 → 不刷（0 KV 写）

  // feed_cache → GOVERNANCE_DB；refreshLatestFeedKv 内部失败不抛，返回 failed / budget_deferred
  const status = await refreshLatestFeedKv(env, 0, { priority: 'normal' });
  if (status === 'failed') {
    console.error('[cron/feed-cache] 刷 feed:latest 失败，保留 dirty=true 待下轮重试');
    return;
  }
  if (status === 'budget_deferred') {
    console.log('[cron/feed-cache] 非安全缓存预算不足，保留 feed_latest_dirty 待补刷');
    return;
  }

  // 刷成功（含 skipped：内容未变）→ 清标记
  try {
    await resolveIdentityDb(env)
      .prepare(
        `UPDATE system_config SET value = 'false', updated_at = ?
          WHERE key = 'feed_latest_dirty'`,
      )
      .bind(isoNow())
      .run();
  } catch (err) {
    console.error('[cron/feed-cache] 清除 feed_latest_dirty 失败', err);
    return;
  }
  console.log(`[cron/feed-cache] feed:latest 已刷新（kvPublish=${status}），dirty 已清除`);
}

// ---------------------------------------------------------------------------
// M3-4：整点 GC（每 60 分钟，minute === 0）
// ---------------------------------------------------------------------------

/**
 * 清理 30 天前的已吊销 Token（revoked_tokens 表防堆积）。
 * A-5b：revoked_tokens → GOVERNANCE_DB
 * fail-soft：失败只记日志，不抛出。
 */
export async function gcRevokedTokens(env: Env): Promise<void> {
  const governanceDb = resolveGovernanceDb(env);
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  await governanceDb
    .prepare(`DELETE FROM revoked_tokens WHERE revoked_at < ?`)
    .bind(cutoff)
    .run()
    .catch((err) => console.error('[cron/gc] revoked_tokens GC 失败', err));
  console.log('[cron/gc] gcRevokedTokens 完成');
}

/**
 * 清理已完成（status='ok'）的 outbound_events（M9-15 水位感知 + 分片 DELETE）。
 * A-5c-3 勘误：outbound_events 表在 IDENTITY_DB（migration-identity/0003）；A-5b 误归 GOVERNANCE_DB 修正
 * fail-soft：失败只记日志，不抛出。
 */
export async function gcOutboundEvents(env: Env): Promise<void> {
  try {
    const identityDb = resolveIdentityDb(env);
    const result = await gcOutboundEventsWithWaterLevel(identityDb);
    console.log(
      `[cron/gc] gcOutboundEvents 完成 tier=${result.tier} rows=${result.rowCount} bytes=${result.bytes} deleted=${result.deleted} retentionMs=${result.retentionMs}`,
    );
  } catch (err) {
    console.error('[cron/gc] outbound_events GC 失败', err);
  }
}

/** M4-2：重试单条 index/post 或 index/comment outbound_event。
 *
 * 当前节点索引上报（POST /api/posts/index、POST /api/comments/index）
 * 在 M4-2 阶段为 forward stub：
 *   - 真实 payload 需在事件创建时序列化存入 payload_hash 字段（后续步骤实装）。
 *   - 在 payload 存储机制完善前，重试只做 retries +1 并记日志，避免卡死重试队列。
 */
async function retryIndexEvent(
  env: Env,
  identityDb: D1Database,
  eventId: string,
  kind: string,
): Promise<void> {
  // payload_hash 在未来实装时将存储序列化的事件 payload；
  // 当前阶段无真实 payload，仅递增 retries，使事件最终到达上限（3次）后自然停止重试。
  await identityDb
    .prepare(`UPDATE outbound_events SET retries = retries + 1, finished_at = ? WHERE id = ?`)
    .bind(isoNow(), eventId)
    .run()
    .catch((dbErr) => console.error(`[cron/retry] ${kind} 更新 retries 失败`, dbErr));
  console.log(
    `[cron/retry] ${eventId} kind=${kind} 暂无 payload，retries +1（待索引上报实装后填充）`,
  );
}

/**
 * 清理过期 cache_entries（M9-15 水位感知 + 分片 DELETE）。
 * A-5b：cache_entries → IDENTITY_DB（lookup 缓存表在 identity 库 0004）
 * fail-soft：失败只记日志，不抛出。
 */
export async function gcCacheEntries(env: Env): Promise<void> {
  try {
    const identityDb = resolveIdentityDb(env);
    const result = await gcCacheEntriesWithWaterLevel(identityDb);
    console.log(
      `[cron/gc] gcCacheEntries 完成 tier=${result.tier} rows=${result.rowCount} bytes=${result.bytes} deleted=${result.deleted} retentionMs=${result.retentionMs}`,
    );
  } catch (err) {
    console.error('[cron/gc] cache_entries GC 失败', err);
  }
}

/**
 * M2-1b：清理 1 天前的 login_attempts 行（失败频控窗口 15min + 锁定 5min，
 * 远小于 1 天；正常登录成功也会立即 DELETE 对应行，1 天前还遗留的基本是
 * 攻击者发起后再无尝试的"僵尸 IP"）。
 *
 * A-5b：login_attempts → IDENTITY_DB
 * 走 D1 不走 KV：本表本身就是 D1 频控（rule 11 + F-01），cron 清理保持同库。
 * fail-soft：失败只记日志，不抛出。
 *
 * 单次扫描代价：表索引为 `idx_login_attempts_last_attempt(last_attempt_at)`，
 * DELETE 走索引区间扫描，行数量级 ≤ 几千行（被攻击节点的极端态），耗时可忽略。
 */
export async function gcLoginAttempts(env: Env): Promise<void> {
  const identityDb = resolveIdentityDb(env);
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  await identityDb
    .prepare(`DELETE FROM login_attempts WHERE last_attempt_at < ?`)
    .bind(cutoff)
    .run()
    .catch((err) => console.error('[cron/gc] login_attempts GC 失败', err));
  console.log('[cron/gc] gcLoginAttempts 完成');
}

// ---------------------------------------------------------------------------
// M5-0：R2 可用性探针（每 30 分钟触发一次，minute % 30 === 0）
// ---------------------------------------------------------------------------

/**
 * 探测 HAILUO_IMAGE_R2 是否可用，并将结果写入 D1 system_config.r2_probe_status。
 *
 * 探针逻辑：
 *   1. 若 env.HAILUO_IMAGE_R2 未绑定（不绑卡的账号）→ 写 'unavailable'，立即返回。
 *   2. 否则写入一个 1 字节测试对象，成功后立即删除 → 写 'ok'。
 *   3. 任何异常 → 写 'fail'，fail-soft 不抛出（F-13：R2 不可用不能阻塞节点）。
 *
 * status 取值（对应 0002_node_metadata.sql 注释）：
 *   'unknown'     — 初始值，尚未跑过探针
 *   'ok'          — 探针成功，R2 当前可用
 *   'unavailable' — binding 未注入（不绑卡或未配置 r2_buckets）
 *   'fail'        — binding 存在但写入/删除抛出异常
 */
export async function probeR2(env: Env): Promise<void> {
  // system_config → IDENTITY_DB（A-5）
  const identityDb = resolveIdentityDb(env);
  // 1. 未绑定 R2 binding → 标记 unavailable，无需探针
  if (!env.HAILUO_IMAGE_R2) {
    await identityDb
      .prepare(`UPDATE system_config SET value = 'unavailable', updated_at = ? WHERE key = 'r2_probe_status'`)
      .bind(isoNow())
      .run()
      .catch((err) => console.error('[cron/r2probe] 写 unavailable 失败', err));
    console.log('[cron/r2probe] HAILUO_IMAGE_R2 未绑定，r2_probe_status=unavailable');
    return;
  }

  // 2. 写测试对象 → 立即删除 → 标记 ok
  const probeKey = `_probe_${Date.now()}`;
  try {
    await env.HAILUO_IMAGE_R2.put(probeKey, new Uint8Array([0x00]));
    await env.HAILUO_IMAGE_R2.delete(probeKey);
    await identityDb
      .prepare(`UPDATE system_config SET value = 'ok', updated_at = ? WHERE key = 'r2_probe_status'`)
      .bind(isoNow())
      .run()
      .catch((err) => console.error('[cron/r2probe] 写 ok 失败', err));
    console.log('[cron/r2probe] R2 探针成功，r2_probe_status=ok');
  } catch (err) {
    // 3. 探针失败 → 标记 fail，fail-soft（F-13）
    console.error('[cron/r2probe] R2 探针异常', err);
    await identityDb
      .prepare(`UPDATE system_config SET value = 'fail', updated_at = ? WHERE key = 'r2_probe_status'`)
      .bind(isoNow())
      .run()
      .catch((dbErr) => console.error('[cron/r2probe] 写 fail 失败', dbErr));
  }
}

// ---------------------------------------------------------------------------
// M5-C8：B2 可用性探针（每 30 分钟触发一次，minute % 30 === 0）
// ---------------------------------------------------------------------------

/**
 * 探测 Backblaze B2 是否可用，并将结果写入 D1 system_config.b2_probe_status。
 *
 * 探针逻辑（与 probeR2 对称）：
 *   1. 5 个 B2_* env vars 不全 → 写 'unconfigured'，立即返回（用户未启用 B2）
 *   2. 否则用 aws4fetch 写一个 1 字节测试对象 → DELETE → 写 'ok'
 *   3. 任何异常 → 写 'fail'，fail-soft 不抛出
 *
 * 子请求开销：成功路径 2 次（PUT + DELETE），符合 50 子请求上限的"GC 同批"约定。
 */
export async function probeB2(env: Env): Promise<void> {
  const { readMediaStorageMode } = await import('../lib/mediaStorageUsage');
  const mode = await readMediaStorageMode(env);
  // system_config → IDENTITY_DB（A-5）
  const identityDb = resolveIdentityDb(env);
  const imagesStorage = await (async () => {
    try {
      const row = await identityDb
        .prepare(`SELECT value FROM system_config WHERE key = 'images_storage' LIMIT 1`)
        .first<{ value: string }>();
      return row?.value ?? 'kv';
    } catch {
      return 'kv';
    }
  })();

  const { resolveB2Config, probeB2WithConfig, writeB2ProbeStatus } = await import('../lib/mediaStorage');
  const stored = await resolveB2Config(env);

  // router 模式：有 B2 配置就探针；manual 模式：仅 images_storage=b2 时探针
  if (mode === 'manual' && imagesStorage === 'kv') {
    await identityDb
      .prepare(`UPDATE system_config SET value = 'unconfigured', updated_at = ? WHERE key = 'b2_probe_status'`)
      .bind(isoNow())
      .run()
      .catch((err) => console.error('[cron/b2probe] 写 unconfigured 失败', err));
    return;
  }

  if (!stored) {
    await writeB2ProbeStatus(env, 'unconfigured').catch((err) =>
      console.error('[cron/b2probe] 写 unconfigured 失败', err),
    );
    return;
  }

  if (mode === 'manual' && imagesStorage !== 'b2') {
    return;
  }

  try {
    await probeB2WithConfig(stored);
    await writeB2ProbeStatus(env, 'ok');
    console.log('[cron/b2probe] B2 探针成功，b2_probe_status=ok');
  } catch (err) {
    console.error('[cron/b2probe] B2 探针异常', err);
    await writeB2ProbeStatus(env, 'fail').catch((dbErr) =>
      console.error('[cron/b2probe] 写 fail 失败', dbErr),
    );
  }
}

/** M5-FB：Filebase 探针，与 B2 同批（minute % 30 === 0） */
export async function probeFilebase(env: Env): Promise<void> {
  const { readMediaStorageMode } = await import('../lib/mediaStorageUsage');
  const mode = await readMediaStorageMode(env);
  // system_config → IDENTITY_DB（A-5）
  const identityDb = resolveIdentityDb(env);
  const imagesStorage = await (async () => {
    try {
      const row = await identityDb
        .prepare(`SELECT value FROM system_config WHERE key = 'images_storage' LIMIT 1`)
        .first<{ value: string }>();
      return row?.value ?? 'kv';
    } catch {
      return 'kv';
    }
  })();

  const { resolveFilebaseConfig, probeFilebaseWithConfig, writeFilebaseProbeStatus } = await import('../lib/mediaStorage');
  const stored = await resolveFilebaseConfig(env);

  if (mode === 'manual' && imagesStorage === 'kv') {
    await identityDb
      .prepare(`UPDATE system_config SET value = 'unconfigured', updated_at = ? WHERE key = 'filebase_probe_status'`)
      .bind(isoNow())
      .run()
      .catch((err) => console.error('[cron/filebaseprobe] 写 unconfigured 失败', err));
    return;
  }

  if (!stored) {
    await writeFilebaseProbeStatus(env, 'unconfigured').catch((err) =>
      console.error('[cron/filebaseprobe] 写 unconfigured 失败', err),
    );
    return;
  }

  if (mode === 'manual' && imagesStorage !== 'filebase') {
    return;
  }

  try {
    await probeFilebaseWithConfig(stored);
    await writeFilebaseProbeStatus(env, 'ok');
    console.log('[cron/filebaseprobe] Filebase 探针成功，filebase_probe_status=ok');
  } catch (err) {
    console.error('[cron/filebaseprobe] Filebase 探针异常', err);
    await writeFilebaseProbeStatus(env, 'fail').catch((dbErr) =>
      console.error('[cron/filebaseprobe] 写 fail 失败', dbErr),
    );
  }
}

/** M5-SR：Filebase Platform API 用量校准（每 6h，fail-soft） */
export async function calibrateFilebaseUsageCron(env: Env): Promise<void> {
  const { calibrateFilebaseUsage } = await import('../lib/mediaStorageUsage');
  await calibrateFilebaseUsage(env);
}

/** M5-SR-P2b：B2 ListObjectsV2 低频用量校准（每日 1 次，fail-soft） */
export async function calibrateB2UsageCron(env: Env): Promise<void> {
  const { calibrateB2Usage } = await import('../lib/mediaStorageUsage');
  await calibrateB2Usage(env);
}

/** M5-SR-P2c：R2 CF /usage API 或 binding list 低频校准（每日 1 次，fail-soft） */
export async function calibrateR2UsageCron(env: Env): Promise<void> {
  const { calibrateR2Usage } = await import('../lib/mediaStorageUsage');
  await calibrateR2Usage(env);
}
