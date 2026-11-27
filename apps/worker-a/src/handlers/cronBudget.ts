/**
 * M13-2：Cron 外部 fetch 预算调度器（方案 B + M13-10 进块放宽）。
 *
 * - 外部 fetch 硬预算默认 50/invocation（Free Tier）
 * - D1/KV/R2 等 binding 调用不计入外部预算，且永不 defer
 * - 第一版：priority 降序串行 await + `[cron/budget]` 摘要日志
 * - M13-11：推荐用户 TTL 兜底挂回本表；全局黑名单主路径仍是 daily-sync（勿再挂独立整点 GET）
 */
import type { Env } from '../env';
import {
  retryFailedOutboundEvents,
  probeR2,
  probeB2,
  probeFilebase,
  calibrateFilebaseUsageCron,
  calibrateB2UsageCron,
  calibrateR2UsageCron,
  gcRevokedTokens,
  gcOutboundEvents,
  gcCacheEntries,
  gcLoginAttempts,
} from './cron';
import { gcFeedCache } from './feedFetch';
import { runScheduledInvocation } from '../services/feed/runScheduledInvocation';
import { FEED_SUBREQUEST_HARD_CAP } from './feedPullBatch';
import { syncBlacklistToKv } from './blacklistSync';
import { continueBlacklistKvBudgetSyncIfPending } from './registryBlacklistSync';
import { runUrgentPolicyPull } from './registryUrgentPolicy';
import { syncRegistryEndpointsToKv } from './registryEndpointsKvSync';
import { migrateRegistryEndpointsIfNeeded, syncPrimaryRegistryUrlFromEnvIfNeeded } from '../lib/registryEndpoints';
import { cleanupOperationLogs, writeOperationLog } from '../lib/operationLog';
import { captureCronErrors } from '../lib/cronErrorTap';
import { persistCronTaskHealth } from '../lib/cronTaskHealth';
import { gcInteractionNonces } from '../lib/interactionEnvelope';
import { gcDmRetention } from '../lib/dmGc';
import { gcMessagingMediaBlobs } from '../lib/messagingMediaGc';
import { gcOrphanKvImages, gcR2ToTargetWatermark } from '../lib/mediaStorageGc';
import {
  gcFriendRequestInbox,
  gcFriendRequestOutbox,
  gcFriendRequestRateBuckets,
  gcFriendRequestRetention,
} from '../lib/friendRequestRetention';
import { syncFofRecommendedUsersIfDue } from '../lib/fofRecommendations';
import {
  deliverUrlChangeNotifyJobs,
  URL_CHANGE_NOTIFY_BATCH,
} from '../lib/urlChangeNotify';
import { retryUrlChangeLocalReconcile } from '../lib/urlChangeLocalReconcile';
import {
  gcGroupRetention,
  retryGroupMediaMirrorBatch,
  retryGroupOutboxBatch,
  runGroupSyncCronBatch,
  runOwnerGroupMaintenanceCron,
} from '../lib/groupCron';
import {
  gcGroupJoinDecisionOutbox,
  retryGroupJoinDecisionOutboxBatch,
} from '../lib/groupJoinDecision';
import { runMessagingAutoShardCron } from '../lib/messagingAutoShard';
import {
  dormantFeedAggregateShouldRun,
  effectiveEngagementForCron,
  ensureDormantFeedSweepIfNeeded,
  loadCronOwnerEngagementContext,
  noteFeedPullBatchForCycle,
  type OwnerDormantFeedPolicy,
  type OwnerEngagement,
} from '../services/ownerEngagement/cronEngagement';
/** Cloudflare Free 计划单次 invocation 外部子请求上限 */
export const CRON_EXTERNAL_SUBREQUEST_CAP = 50;

/** Feed 单轮：≤20 关注（M7-30h-7：401/token/mutual 重试会放大子请求，保守 batch） */
export const FEED_AGGREGATE_EXTERNAL_ESTIMATE = 20;

/** M34-2：站主参与度门控；与 minuteGate 为「与」关系 */
export type OwnerEngagementGate = 'always' | 'active_only' | 'active_or_unknown';

export type CronBudgetContext = {
  minute: number;
  hour: number;
  /** M34-2：由 runCronBudgeted 注入 */
  ownerEngagement: OwnerEngagement;
  ownerDormantFeedPolicy: OwnerDormantFeedPolicy;
  /** M34-6：上次全关注扫完时间；null=从未 */
  feedPullCycleOkAt: string | null;
  /** M34-6：24h 地板扫尾进行中 */
  feedDormantSweepActive: boolean;
};

export type CronBudgetTask = {
  id: string;
  priority: number;
  minuteGate: (ctx: CronBudgetContext) => boolean;
  /** 默认 always；feed 另用 policy 在 minuteGate；换域 notify 等为 active_only（群发信/同步永不 gate） */
  ownerEngagementGate?: OwnerEngagementGate;
  /** 外部 fetch 估算；0 表示 D1/KV-only，永不因预算 defer */
  estimatedExternalSubrequests: number;
  estimatedCloudflareServiceOps?: number;
  /** 外部预算不足时是否可推迟到下一 5 分钟块 */
  deferrable?: boolean;
  run: (env: Env) => Promise<void>;
};

export type CronBudgetTaskResult = {
  id: string;
  status: 'ran' | 'skipped_gate' | 'skipped_engagement' | 'deferred';
  durationMs: number;
  estimatedExternalSubrequests: number;
  deferredReason?: string;
  /** CRON-ERROR-VISIBILITY：任务体内 catch 后 console.error 的次数（0/undefined = 干净） */
  errors?: number;
  /** 失败样本（脱敏截断，最多 3 条） */
  errorSamples?: string[];
};

export type CronBudgetSummary = {
  results: CronBudgetTaskResult[];
  externalRemaining: number;
  cloudflareOpsTotal: number;
};

function logBudgetSummary(ctx: CronBudgetContext, summary: CronBudgetSummary): void {
  const ran = summary.results.filter((r) => r.status === 'ran').map((r) => r.id);
  const deferred = summary.results.filter((r) => r.status === 'deferred');
  const skippedEngagement = summary.results
    .filter((r) => r.status === 'skipped_engagement')
    .map((r) => r.id);
  // CRON-ERROR-VISIBILITY：把「ran 但内部报错」单独列出来，别被 ran 掩盖
  const errors = summary.results
    .filter((r) => (r.errors ?? 0) > 0)
    .map((r) => ({ id: r.id, errors: r.errors, sample: r.errorSamples?.[0] ?? '' }));
  console.log(
    '[cron/budget]',
    JSON.stringify({
      minute: ctx.minute,
      hour: ctx.hour,
      ownerEngagement: ctx.ownerEngagement,
      ownerDormantFeedPolicy: ctx.ownerDormantFeedPolicy,
      // M13-19：external* / cloudflareOps* 均为调度估算，禁止当平台实测
      externalBudgetProvenance: 'estimated_not_measured',
      externalRemaining: summary.externalRemaining,
      cloudflareOpsTotal: summary.cloudflareOpsTotal,
      ran,
      skippedEngagement,
      errors,
      deferred: deferred.map((d) => ({ id: d.id, reason: d.deferredReason })),
    }),
  );
}

function passesOwnerEngagementGate(task: CronBudgetTask, ctx: CronBudgetContext): boolean {
  const gate = task.ownerEngagementGate ?? 'always';
  if (gate === 'always') return true;
  if (gate === 'active_only') return ctx.ownerEngagement === 'active';
  if (gate === 'active_or_unknown') {
    return ctx.ownerEngagement === 'active' || ctx.ownerEngagement === 'unknown';
  }
  return true;
}

/**
 * 5 分钟块内任务：按 priority 串行执行，仅对外部 fetch 做硬预算 defer。
 * M34-2：开头读一次 owner_engagement，注入 ctx。
 */
export async function runCronBudgeted(
  env: Env,
  ctx: { minute: number; hour: number },
  tasks: readonly CronBudgetTask[],
): Promise<CronBudgetSummary> {
  const loaded = await loadCronOwnerEngagementContext(env);
  const fullCtx: CronBudgetContext = {
    minute: ctx.minute,
    hour: ctx.hour,
    ownerEngagement: loaded.ownerEngagement,
    ownerDormantFeedPolicy: loaded.ownerDormantFeedPolicy,
    feedPullCycleOkAt: loaded.feedPullCycleOkAt,
    feedDormantSweepActive: loaded.feedDormantSweepActive,
  };

  let externalRemaining = CRON_EXTERNAL_SUBREQUEST_CAP;
  let cloudflareOpsTotal = 0;
  const results: CronBudgetTaskResult[] = [];

  const sorted = [...tasks].sort((a, b) => b.priority - a.priority);

  for (const task of sorted) {
    if (!task.minuteGate(fullCtx)) {
      results.push({
        id: task.id,
        status: 'skipped_gate',
        durationMs: 0,
        estimatedExternalSubrequests: task.estimatedExternalSubrequests,
      });
      // M34-2：偶数分钟本可跑 Feed，但因 dormant+skip 被 minuteGate 拦住 → 写站主可见日志
      if (
        task.id === 'feed-aggregate' &&
        fullCtx.minute % 2 === 0 &&
        effectiveEngagementForCron(fullCtx.ownerEngagement) === 'dormant' &&
        fullCtx.ownerDormantFeedPolicy === 'skip'
      ) {
        void writeOperationLog(env, {
          source: 'worker-a',
          level: 'info',
          event: 'feed_skipped_owner_dormant',
          message: '站主未活跃，已跳过关注流自动聚合',
          details: {
            owner_engagement: fullCtx.ownerEngagement,
            policy: fullCtx.ownerDormantFeedPolicy,
            minute: fullCtx.minute,
          },
        });
      }
      continue;
    }

    if (!passesOwnerEngagementGate(task, fullCtx)) {
      results.push({
        id: task.id,
        status: 'skipped_engagement',
        durationMs: 0,
        estimatedExternalSubrequests: task.estimatedExternalSubrequests,
        deferredReason: `owner_engagement=${fullCtx.ownerEngagement}`,
      });
      if (task.id === 'feed-aggregate') {
        void writeOperationLog(env, {
          source: 'worker-a',
          level: 'info',
          event: 'feed_skipped_owner_dormant',
          message: '站主未活跃，已跳过关注流自动聚合',
          details: {
            owner_engagement: fullCtx.ownerEngagement,
            policy: fullCtx.ownerDormantFeedPolicy,
            minute: fullCtx.minute,
          },
        });
      }
      continue;
    }

    const ext = Math.max(0, task.estimatedExternalSubrequests);
    cloudflareOpsTotal += task.estimatedCloudflareServiceOps ?? 0;

    if (ext > 0 && ext > externalRemaining && task.deferrable !== false) {
      results.push({
        id: task.id,
        status: 'deferred',
        durationMs: 0,
        estimatedExternalSubrequests: ext,
        deferredReason: `external_budget_insufficient need=${ext} remaining=${externalRemaining}`,
      });
      continue;
    }

    const started = Date.now();
    // CRON-ERROR-VISIBILITY：任务内部普遍 catch + console.error，这里只在该任务窗口内计次
    const tap = captureCronErrors();
    let captured: { count: number; samples: string[] } = { count: 0, samples: [] };
    try {
      await task.run(env);
    } catch (err) {
      console.error(`[cron/budget] task ${task.id} 失败`, err);
    } finally {
      captured = tap.dispose();
    }
    const durationMs = Date.now() - started;
    if (ext > 0) {
      externalRemaining = Math.max(0, externalRemaining - ext);
    }
    results.push({
      id: task.id,
      status: 'ran',
      durationMs,
      estimatedExternalSubrequests: ext,
      ...(captured.count > 0 ? { errors: captured.count, errorSamples: captured.samples } : {}),
    });
  }

  const summary: CronBudgetSummary = { results, externalRemaining, cloudflareOpsTotal };
  logBudgetSummary(fullCtx, summary);
  // 可观测性落库必须 fail-soft，不能反过来让 Cron 失败
  try {
    await persistCronTaskHealth(env, summary);
  } catch (err) {
    console.error('[cron/health] 落库失败', err);
  }
  return summary;
}

/**
 * M13-19 / M13-19b：整点峰值拆成 UTC minute 有界切片。
 * - minute 0～5：纯 D1 GC，不占外部 fetch 50 池（可与同分钟 Feed 并行 waitUntil）。
 * - minute 7：`calibrate`（Filebase/B2/R2 可能发起外部 HTTP / ListObjects）——
 *   必须落在非 heavy 分钟（`%2!==0 && %5!==0`），避免与 Feed 并行撞 50 子请求硬上限。
 * 其它分钟返回 null → no-op。安全相关（吊销 Token / interaction nonce）固定 minute 0。
 */
export type HourlyGcSliceId =
  | 'security_tokens'
  | 'outbound_events'
  | 'cache_entries'
  | 'login_attempts'
  | 'feed_cache'
  | 'operation_logs'
  | 'calibrate';

export function selectHourlyGcSlice(minute: number): HourlyGcSliceId | null {
  switch (minute) {
    case 0:
      return 'security_tokens';
    case 1:
      return 'outbound_events';
    case 2:
      return 'cache_entries';
    case 3:
      return 'login_attempts';
    case 4:
      return 'feed_cache';
    case 5:
      return 'operation_logs';
    // M13-19b：勿再挂 minute 6（偶数 → Feed 进块，与校准外部 fetch 并行 waitUntil 易超 50）
    case 7:
      return 'calibrate';
    default:
      return null;
  }
}

/** 逐分钟仿真用：0～59 哪些分钟有 GC/校准切片（含错峰后的 7，不含已退役的 6） */
export function listHourlyGcSliceMinutes(): number[] {
  return [0, 1, 2, 3, 4, 5, 7];
}

/**
 * M13-19：按分钟跑单切片。
 * 纯 D1 切片不占外部池；`calibrate` 可能占外部池，故挂非 heavy 分钟（调用方在 runCronBudgeted 之外）。
 */
export async function runRotatedHourlyGc(
  env: Env,
  minute: number,
  hour: number,
): Promise<HourlyGcSliceId | null> {
  const slice = selectHourlyGcSlice(minute);
  if (!slice) return null;

  switch (slice) {
    case 'security_tokens':
      await gcRevokedTokens(env);
      try {
        const deleted = await gcInteractionNonces(env);
        if (deleted > 0) console.log(`[cron/gc] gcInteractionNonces 完成 deleted=${deleted}`);
      } catch (err) {
        console.error('[cron/gc] interaction_nonces GC 失败', err);
      }
      break;
    case 'outbound_events':
      await gcOutboundEvents(env);
      break;
    case 'cache_entries':
      await gcCacheEntries(env);
      break;
    case 'login_attempts':
      await gcLoginAttempts(env);
      break;
    case 'feed_cache':
      await gcFeedCache(env);
      break;
    case 'operation_logs':
      await cleanupOperationLogs(env);
      break;
    case 'calibrate':
      if (hour % 6 === 0) {
        await calibrateFilebaseUsageCron(env);
      }
      // B2 无 Platform 用量 API：每日 UTC 03:00 低频 ListObjects 校准（Class C 成本可控）
      if (hour === 3) {
        await calibrateB2UsageCron(env);
      }
      // R2：每日 UTC 04:00 校准（CF /usage API 或 binding list 回落）
      if (hour === 4) {
        await calibrateR2UsageCron(env);
      }
      break;
    default:
      break;
  }
  console.log(`[cron/gc] rotated slice=${slice} minute=${minute} hour=${hour}`);
  return slice;
}

/**
 * 兼容旧入口：顺序跑完全部切片（测试 / 手工；含 minute 7 校准）。
 * 生产调度请用 `runRotatedHourlyGc`。
 */
export async function runHourlyGcSerial(env: Env, hour: number): Promise<void> {
  for (const minute of listHourlyGcSliceMinutes()) {
    await runRotatedHourlyGc(env, minute, hour);
  }
}

/**
 * M13-19：按可用外部子请求收窄本轮关注批（可慢不可停：至少 1）。
 * 账本分列：此为调度估算，不是平台实测 CPU/连接数。
 */
export function resolveFeedTargetBatch(
  externalRemaining: number,
  opts?: { defaultBatch?: number; subrequestsPerFollow?: number },
): number {
  const defaultBatch = opts?.defaultBatch ?? 20;
  const perFollow = opts?.subrequestsPerFollow ?? 2;
  if (!Number.isFinite(externalRemaining) || externalRemaining <= 0) return 1;
  return Math.max(1, Math.min(defaultBatch, Math.floor(externalRemaining / perFollow)));
}

/**
 * M13-12：无 Feed 的 %5 分钟（5/15/25/35/45）——群外部任务专槽，避免与 Feed 抢 50 池被 defer。
 * 不用「短任务优先」：同一分钟若先跑群再跑 Feed，剩余预算不够 40，Following 会被推迟。
 */
export function isGroupExternalSlotMinute(minute: number): boolean {
  return minute % 5 === 0 && minute % 2 !== 0;
}

/**
 * M13-2 方案 B 错峰表 + M13-10 Feed 双分钟 + M13-12 群专槽。
 * index 进块条件：minute%2===0 || minute%5===0；各 task 再用 minuteGate 细分。
 * Feed 仅偶数分钟；群外部任务仅 5/15/25/35/45（无 Feed）。
 */
export function buildCronBudgetTasks(): CronBudgetTask[] {
  return [
    {
      id: 'feed-aggregate',
      priority: 100,
      // M13-10：每 2 分钟；M34-2：dormant 按 OWNER_DORMANT_FEED_POLICY；M34-6：+24h 全量地板
      minuteGate: (ctx) => {
        if (ctx.minute % 2 !== 0) return false;
        if (effectiveEngagementForCron(ctx.ownerEngagement) === 'active') return true;
        return dormantFeedAggregateShouldRun(ctx.ownerDormantFeedPolicy, ctx.minute, {
          cycleOkAt: ctx.feedPullCycleOkAt,
          sweepActive: ctx.feedDormantSweepActive,
        });
      },
      // 策略已在 minuteGate；此处 always，避免与 slow/normal/地板双重拦截
      ownerEngagementGate: 'always',
      estimatedExternalSubrequests: FEED_AGGREGATE_EXTERNAL_ESTIMATE,
      estimatedCloudflareServiceOps: 12,
      deferrable: false,
      // NCF-2A：唯一 Feed 入口 runScheduledInvocation → runFeedAggregation
      run: async (env) => {
        await ensureDormantFeedSweepIfNeeded(env);
        // M13-19：按本轮可用外部硬帽收批（常态仍 = FEED_PULL_BATCH_SIZE）；耗尽时 ≥1 变慢不取消
        const targetBatch = resolveFeedTargetBatch(FEED_SUBREQUEST_HARD_CAP);
        const { feed } = await runScheduledInvocation(env, { targetBatch });
        await noteFeedPullBatchForCycle(env, {
          attempted: feed.followAttempted ?? 0,
          totalFollows: feed.totalFollows ?? 0,
        });
      },
    },
    {
      id: 'retry-outbound',
      priority: 80,
      // 仅落在无 Feed 的 %15===5（5/35）；避开 20/50 与 Feed 叠峰
      minuteGate: ({ minute }) => minute % 15 === 5 && minute % 2 !== 0,
      estimatedExternalSubrequests: 3,
      deferrable: true,
      run: async (env) => { await retryFailedOutboundEvents(env); },
    },
    {
      // M7-30h-5：换域本地 reconcile 重试（纯 D1，无外部子请求）
      id: 'url-change-reconcile',
      priority: 74,
      minuteGate: ({ minute }) => minute % 10 === 8,
      estimatedExternalSubrequests: 0,
      deferrable: true,
      run: async (env) => {
        try {
          const r = await retryUrlChangeLocalReconcile(env);
          if (r.processed > 0) {
            console.log('[cron/url-change-reconcile]', JSON.stringify(r));
          }
        } catch (err) {
          console.error('[cron/url-change-reconcile] 失败', err);
        }
      },
    },
    {
      // M7-30f-4：换域联系人 events；挂 %10===5（进块且奇数无 Feed）；优先于群任务，预算不足则 defer
      id: 'url-change-notify',
      priority: 75,
      // GRP-SYNC-STARVE-FIX / CRON-SCHEDULE-AUDIT：Cron 只在「偶数分钟 或 %5 分钟」进块，
      // 不能放到 7/17 这类奇数非 %5 分钟（任务永远不会被调用）。改到 8/18/…（偶数，与 Feed 共分钟）；
      // 批大小 8 → Feed 40 + 通知 8 = 48。
      minuteGate: ({ minute }) => minute % 10 === 8,
      ownerEngagementGate: 'active_only',
      estimatedExternalSubrequests: URL_CHANGE_NOTIFY_BATCH,
      deferrable: true,
      run: async (env) => {
        try {
          await deliverUrlChangeNotifyJobs(env);
        } catch (err) {
          console.error('[cron/url-change-notify] 失败', err);
        }
      },
    },
    {
      id: 'probe-storage',
      priority: 70,
      // M34-2：active 仍每 30 分；dormant 降为每 6 小时（minute===10 且 hour%6===0）
      minuteGate: (ctx) => {
        if (effectiveEngagementForCron(ctx.ownerEngagement) === 'active') {
          return ctx.minute % 30 === 10;
        }
        return ctx.minute === 10 && ctx.hour % 6 === 0;
      },
      estimatedExternalSubrequests: 3,
      deferrable: true,
      run: async (env) => {
        await probeR2(env);
        await probeB2(env);
        await probeFilebase(env);
      },
    },
    {
      id: 'migrate-registry-endpoints',
      priority: 50,
      // CRON-SCHEDULE-AUDIT：原挂 %5 群槽，与群任务抢 1 个外部预算；迁到 6/26/46（偶数进块、非群槽）。
      // 实际最多 2 次外部（迁移探测 + well-known 复核），估算同步改为 2。
      minuteGate: ({ minute }) => minute % 20 === 6,
      estimatedExternalSubrequests: 2,
      deferrable: true,
      run: async (env) => {
        const result = await migrateRegistryEndpointsIfNeeded(env);
        if (result.status === 'migrated' || result.status === 'repaired') {
          console.log('[cron/registry-endpoints/migrate]', JSON.stringify(result));
          await syncRegistryEndpointsToKv(env);
        } else if (result.status === 'failed') {
          console.warn('[cron/registry-endpoints/migrate]', JSON.stringify(result));
        }
        // M9-PH-TA-2：改 REGISTRY_URL / 锚点漂移时强制 well-known 验签后再改写 [0]
        const synced = await syncPrimaryRegistryUrlFromEnvIfNeeded(env);
        if (synced.status === 'synced' || synced.status === 'repaired') {
          console.log('[cron/registry-endpoints/sync-primary]', JSON.stringify(synced));
          await syncRegistryEndpointsToKv(env);
        } else if (synced.status === 'failed') {
          console.warn('[cron/registry-endpoints/sync-primary]', JSON.stringify(synced));
        }
      },
    },
    {
      id: 'group-sync-batch',
      priority: 45,
      minuteGate: ({ minute }) => isGroupExternalSlotMinute(minute),
      // M34-2b：群成员义务 — dormant 也必须 sync（收发/转发），不得 active_only
      estimatedExternalSubrequests: 10,
      deferrable: true,
      run: async (env) => {
        try {
          await runGroupSyncCronBatch(env, new Date().getUTCMinutes());
        } catch (err) {
          console.error('[cron/gc] group-sync-batch 失败', err);
        }
      },
    },
    {
      id: 'group-outbox-retry',
      priority: 44,
      minuteGate: ({ minute }) => isGroupExternalSlotMinute(minute),
      // M34-2b：群发信义务 — outbox 重试永不因 dormant 跳过
      estimatedExternalSubrequests: 5,
      deferrable: true,
      run: async (env) => {
        try {
          const n = await retryGroupOutboxBatch(env);
          if (n > 0) console.log('[cron/group] outbox retry', n);
        } catch (err) {
          console.error('[cron/group] group-outbox-retry 失败', err);
        }
      },
    },
    {
      // REL-FIX-7：入群审批结果回推 outbox 重投（≤5 条/tick，各 1 外部 fetch）
      // 挂既有群外部任务槽（5/15/25/35/45），不增 Cron 槽
      id: 'group-join-decision-outbox',
      priority: 43,
      minuteGate: ({ minute }) => isGroupExternalSlotMinute(minute),
      estimatedExternalSubrequests: 5,
      deferrable: true,
      run: async (env) => {
        try {
          const n = await retryGroupJoinDecisionOutboxBatch(env);
          if (n > 0) console.log('[cron/group] join-decision outbox retry', n);
        } catch (err) {
          console.error('[cron/group] group-join-decision-outbox 失败', err);
        }
      },
    },
    {
      id: 'group-gc-retention',
      priority: 43,
      // CRON-SCHEDULE-AUDIT：B2/Filebase 删除群图 blob 是外部 fetch（每轮上限 10）。
      // 移到 14/34/54（偶数进块、非群槽，与 Feed 共分钟），估算 10；不再和群消息义务抢 5/15/25/35/45。
      minuteGate: ({ minute }) => minute % 20 === 14,
      estimatedExternalSubrequests: 10,
      // SEC-5：在既有估算上加一次补钥过期桶 DELETE；不是实际调用数硬上限。
      estimatedCloudflareServiceOps: 7,
      run: async (env) => {
        try {
          await gcGroupRetention(env);
          await gcGroupJoinDecisionOutbox(env);
        } catch (err) {
          console.error('[cron/gc] group-gc-retention 失败', err);
        }
      },
    },
    {
      id: 'messaging-auto-shard',
      priority: 42,
      minuteGate: ({ minute }) => isGroupExternalSlotMinute(minute),
      estimatedExternalSubrequests: 0,
      estimatedCloudflareServiceOps: 8,
      run: async (env) => {
        try {
          const result = await runMessagingAutoShardCron(env);
          if (!result.skipped && ((result.rowsMoved ?? 0) > 0 || result.routed)) {
            console.log('[cron/messaging-auto-shard]', JSON.stringify(result));
          }
        } catch (err) {
          console.error('[cron/messaging-auto-shard] 失败', err);
        }
      },
    },
    {
      id: 'group-owner-maintenance',
      priority: 42,
      // CRON-SCHEDULE-AUDIT：原挂 15/45 群槽 + 估算 0，但 triggerPendingRebuilds 的 catchup fanout
      // 最多 8 次外部；预算紧时会被挤掉或超 50。改为 4/24/44（偶数进块、非群槽，与 Feed 共分钟），
      // 估算 8；Feed 40 + 本任务 8 = 48；单次最多重建 1 个群（GROUP_PENDING_REBUILD_BATCH）。
      minuteGate: ({ minute }) => minute % 20 === 4,
      estimatedExternalSubrequests: 8,
      estimatedCloudflareServiceOps: 4,
      run: async (env) => {
        try {
          await runOwnerGroupMaintenanceCron(env);
        } catch (err) {
          console.error('[cron/group] owner-maintenance 失败', err);
        }
      },
    },
    {
      id: 'group-media-mirror-retry',
      priority: 41,
      minuteGate: ({ minute }) => isGroupExternalSlotMinute(minute),
      // M34-2b：群媒体投递同样属成员义务，dormant 不停
      // CRON-SCHEDULE-AUDIT：每条媒体最多 2 次外部（从发送方拉取 + B2/Filebase 写入），
      // 批大小已对齐为 2 → 估算 4（原批 10 / 估算 3 会单次超 50）。
      estimatedExternalSubrequests: 4,
      deferrable: true,
      run: async (env) => {
        try {
          const n = await retryGroupMediaMirrorBatch(env);
          if (n > 0) console.log('[cron/group] mirror retry', n);
        } catch (err) {
          console.error('[cron/group] group-media-mirror-retry 失败', err);
        }
      },
    },
    {
      id: 'gc-dm-retention',
      priority: 40,
      // CRON-SCHEDULE-AUDIT：B2/Filebase 删除 DM blob 是外部 fetch（每轮上限 10）。
      // 移到 12/32/52（偶数进块、非群槽，与 Feed 共分钟），估算 10。
      minuteGate: ({ minute }) => minute % 20 === 12,
      estimatedExternalSubrequests: 10,
      estimatedCloudflareServiceOps: 4,
      run: async (env) => {
        try {
          const result = await gcDmRetention(env);
          const total = result.messages + result.wrappedKeys + result.nonces + result.rateBuckets;
          if (total > 0 || result.errors.length > 0) {
            console.log('[cron/gc] gcDmRetention', JSON.stringify(result));
          }
        } catch (err) {
          console.error('[cron/gc] dm retention GC 失败', err);
        }
      },
    },
    {
      // M-AUDIT-FIX-2：私信媒体 GC（孤儿 pending 超时 + abandoned + retain_until 过期）
      // 复用 minute % 5 群外部任务槽位，不增新 Cron
      id: 'messaging-media-gc',
      priority: 38,
      // CRON-SCHEDULE-AUDIT：同上，B2/Filebase 删除是外部 fetch（每轮上限 10）。
      // 移到 16/36/56（偶数进块、非群槽，与 Feed 共分钟），估算 10。
      minuteGate: ({ minute }) => minute % 20 === 16,
      estimatedExternalSubrequests: 10,
      estimatedCloudflareServiceOps: 3,
      run: async (env) => {
        try {
          const result = await gcMessagingMediaBlobs(env);
          const total = result.pendingExpired + result.abandoned + result.expiredRetain;
          if (total > 0 || result.bytesReclaimed > 0 || result.errors.length > 0) {
            console.log('[cron/gc] gcMessagingMediaBlobs', JSON.stringify(result));
          }
        } catch (err) {
          console.error('[cron/gc] messaging media GC 失败', err);
        }
      },
    },
    {
      // M8-14-8：R2 高水位 GC（≥ 90% → 清到 ≤ 70%）
      //   Tier 1：released_at / abandoned / retain_until 过期（已逻辑释放）
      //   Tier 2：active 按 created_at ASC + 跨 CONTENT_DB 校验无未删帖引用
      // 复用 isGroupExternalSlotMinute 槽（5/15/25/35/45），不增 Cron 槽
      // R2 delete 走 binding 不计外部子请求；空跑（未超水位）仅查 1 行 r2 row + 2 行 system_config
      id: 'r2-gc',
      priority: 38,
      minuteGate: ({ minute }) => isGroupExternalSlotMinute(minute),
      estimatedExternalSubrequests: 0,
      estimatedCloudflareServiceOps: 6,
      run: async (env) => {
        try {
          const result = await gcR2ToTargetWatermark(env);
          if (
            !result.skipped ||
            result.tier1Deleted > 0 ||
            result.tier2Deleted > 0 ||
            result.errors.length > 0
          ) {
            console.log('[cron/gc] gcR2ToTargetWatermark', JSON.stringify(result));
          }
        } catch (err) {
          console.error('[cron/gc] r2 GC 失败', err);
        }
      },
    },
    {
      // M8-14-10d：IMAGE_KV 孤儿图自动 GC（列举 kv: · 跳被未删帖/头像引用 · 删 bytes + 登记释放 + 末尾校准）
      // 与 r2-gc / messaging-media-gc 同槽位 isGroupExternalSlotMinute（5/15/25/35/45），不增 Cron 槽
      // 默认 maxKeys=5000（M8-14-10d 调高，原 500 永远扫不完大桶场景）
      // 纯 binding + D1，外部 fetch 估 0；estimatedCloudflareServiceOps 保守 6
      // 站主不活跃也跑 — 容量治理是站点运维责任，不能因 dormant 停
      id: 'orphan-kv-gc',
      priority: 37,
      minuteGate: ({ minute }) => isGroupExternalSlotMinute(minute),
      ownerEngagementGate: 'always',
      estimatedExternalSubrequests: 0,
      estimatedCloudflareServiceOps: 6,
      deferrable: true,
      run: async (env) => {
        try {
          const result = await gcOrphanKvImages(env, { maxKeys: 5000 });
          if (
            result.scanned > 0 ||
            result.deleted > 0 ||
            result.bytesReclaimed > 0 ||
            result.errors.length > 0
          ) {
            console.log('[cron/gc] orphan-kv-gc', JSON.stringify(result));
          }
        } catch (err) {
          console.error('[cron/gc] orphan-kv-gc 失败', err);
        }
      },
    },
    {
      // M17-1g：加好友 30 天过期 + accepted 缺 follows 双写 Repair + 频控桶 GC（D1-only）
      // REL-FIX-1：同槽 outbox pending_retry **真重投**（≤5 条/tick）+ 24h giveup；不增 Cron 槽
      // M-F3：同槽 inbox pending_retry 重投递（≤10 条/tick，各 1 外部 fetch）
      // FRIEND-REQUEST-OUTBOX-ORDER-1（2026-11-25）：priority 39→51。
      // 原优先级低于 group-sync(45)/group-outbox(44)/group-join(43)；
      // 5/15/25/35/45 槽位群任务先消耗外部预算后，本任务 25 预算永远 insufficient → deferred，
      // 回执只写 pending_retry 却永不重投（面板一直「正在重试」）。好友回执是用户可见信任信号，
      // 必须排在群批量同步之前；群任务被挤到下一槽位可接受（它们有自己的 10 分钟节奏）。
      id: 'friend-request-gc',
      priority: 51,
      minuteGate: ({ minute }) => isGroupExternalSlotMinute(minute),
      // inbox 10 + outbox 5（最坏每条 1～2 fetch；预算按批上限计）
      // SEC-7 增强：Repair 补 pin 另需外部 fetch，封顶 FRIEND_REQUEST_REPAIR_PIN_FETCH_CAP(10)
      // → 本任务最坏外部子请求 = 10 + 5 + 10 = 25，仍在 CRON_EXTERNAL_SUBREQUEST_CAP(50) 内
      estimatedExternalSubrequests: 25,
      estimatedCloudflareServiceOps: 8,
      run: async (env) => {
        try {
          const result = await gcFriendRequestRetention(env);
          const rate = await gcFriendRequestRateBuckets(env);
          const outbox = await gcFriendRequestOutbox(env);
          const inbox = await gcFriendRequestInbox(env);
          const total =
            result.expired +
            result.repaired_origin +
            result.repaired_target +
            rate.deleted +
            outbox.given_up +
            outbox.acked +
            inbox.given_up +
            inbox.acked;
          if (
            total > 0 ||
            outbox.scanned > 0 ||
            inbox.scanned > 0 ||
            result.errors.length > 0 ||
            rate.errors.length > 0 ||
            outbox.errors.length > 0 ||
            inbox.errors.length > 0
          ) {
            console.log(
              '[cron/gc] friendRequestRetention',
              JSON.stringify({
                ...result,
                rate_buckets_deleted: rate.deleted,
                rate_errors: rate.errors,
                outbox_scanned: outbox.scanned,
                outbox_acked: outbox.acked,
                outbox_given_up: outbox.given_up,
                outbox_errors: outbox.errors,
                inbox_scanned: inbox.scanned,
                inbox_acked: inbox.acked,
                inbox_given_up: inbox.given_up,
                inbox_errors: inbox.errors,
              }),
            );
          }
        } catch (err) {
          console.error('[cron/gc] friend-request-gc 失败', err);
        }
      },
    },
    {
      // M17-4-2b：好友的好友推荐刷新（1h TTL；采样 ≤5 好友节点；落库 ≤5）
      // 挂 :25（亦属 %5 进块），不增 Cron 槽
      id: 'fof-recommendations-if-due',
      priority: 41,
      // CRON-SCHEDULE-AUDIT：原挂 minute 25（群槽），群任务恒占满 50 → 本任务永远 defer，
      // 好友推荐从未真正刷新。改挂 2/22/42（偶数进块、非群槽，与 Feed 共分钟：40+10=50）；
      // TTL 1h 由函数内部判断，多排几次只多一次 D1 读，不会重复抓取，到期后最多 20 分钟刷新。
      minuteGate: ({ minute }) => minute % 20 === 2,
      estimatedExternalSubrequests: 10,
      estimatedCloudflareServiceOps: 4,
      run: async (env) => {
        try {
          const result = await syncFofRecommendedUsersIfDue(env);
          if (!result.skipped || result.reason === 'no_peers') {
            console.log('[cron/fof] fof-recommendations-if-due', JSON.stringify(result));
          }
        } catch (err) {
          console.error('[cron/fof] fof-recommendations-if-due 失败', err);
        }
      },
    },
    {
      id: 'sync-blacklist-kv',
      priority: 30,
      // 本地黑名单全量 diff + B-2 registry/federated 分轮 pending 续灌（同分钟门控，不新开 Cron）
      minuteGate: ({ minute }) => isGroupExternalSlotMinute(minute),
      // pending 续灌 registry 时可能 1 次 registryFetch；无 pending 则为 0
      estimatedExternalSubrequests: 1,
      estimatedCloudflareServiceOps: 4,
      run: async (env) => {
        try {
          await continueBlacklistKvBudgetSyncIfPending(env);
        } catch (err) {
          console.error('[cron/blacklist-kv-budget] pending 续灌失败', err);
        }
        await syncBlacklistToKv(env);
      },
    },
    // R-MSG-2e：紧急策略旁路（urgent digest）；默认关闭；开启后每小时轮询
    // minute === 35（UTC）落入 isGroupExternalSlotMinute（35%5=0 且 35%2=1），不与 Feed 竞争
    {
      id: 'urgent-policy-pull',
      priority: 25,
      // CRON-SCHEDULE-AUDIT：原挂 35（群槽），群任务占满后恒 defer；
      // 迁到 30（偶数进块、非群槽，且该分钟只有 Feed：40+3=43）。
      minuteGate: ({ minute }) => minute === 30,
      estimatedExternalSubrequests: 3,
      deferrable: true,
      run: async (env) => {
        try {
          const result = await runUrgentPolicyPull(env);
          if (result.pulled || result.message.includes('已达上限')) {
            console.info('[cron/urgent-policy]', JSON.stringify(result));
          }
        } catch (err) {
          console.error('[cron/urgent-policy] 失败', err);
        }
      },
    },
    // 推荐拉取改由 presence 条件块 / force（R-MSG-2c 停周期 Cron）
    {
      id: 'sync-registry-endpoints-kv',
      priority: 20,
      minuteGate: ({ minute }) => isGroupExternalSlotMinute(minute),
      estimatedExternalSubrequests: 0,
      estimatedCloudflareServiceOps: 2,
      run: async (env) => { await syncRegistryEndpointsToKv(env); },
    },
  ];
}
