/**
 * registry daily-sync / official-feed / pull-probe / recommended-users（M-REFACTOR-1a）
 * R-MSG-2e：urgent policy 手动触发
 */
import type { Hono } from 'hono';
import {
  probeFollowNodePulls,
  pullRegistryOfficialFeedNow,
  readRegistryOfficialFeedDiagnostics,
  RegistryOfficialManualPullLimitError,
} from '../../handlers/feedFetch';
import { readRegistryRecommendedUsers } from '../../handlers/registryRecommendations';
import {
  readRegistryDailySyncDiagnostics,
  syncRegistryDaily,
  consumeManualDailySyncQuota,
  ManualDailySyncCooldownError,
} from '../../handlers/registryDailySync';
import {
  readUrgentPullCount,
  runUrgentPolicyPull,
  runUrgentPolicyPullForced,
  URGENT_PULL_DAILY_LIMIT,
} from '../../handlers/registryUrgentPolicy';
import type { LocalReadsAppEnv } from './app';

export function registerRegistrySyncRoutes(app: Hono<LocalReadsAppEnv>): void {
  app.get('/registry-daily-sync-status', async (c) => {
    try {
      const diagnostics = await readRegistryDailySyncDiagnostics(c.env);
      return c.json({ ok: true, data: diagnostics });
    } catch (err) {
      console.error('[local-reads/registry-sync] daily-sync 诊断查询失败', err);
      return c.json(
        { ok: false, error_code: 'INTERNAL_ERROR', message: '查询注册中心日同步状态失败，请稍后重试' },
        500,
      );
    }
  });

  app.post('/registry-daily-sync/run', async (c) => {
    try {
      // M16-DAILY-SYNC-COOLDOWN-1：站主手动 daily-sync 1 天节流（前后端双层）
      // - 仅记成功（失败不延长冷却，更友好）
      // - 与 cron 锚点 `registry_daily_sync_last_success_at` 物理隔离
      // - 命中冷却 → 429 + error_code MANUAL_DAILY_SYNC_COOLDOWN
      try {
        await consumeManualDailySyncQuota(c.env, new Date());
      } catch (cooldownErr) {
        if (cooldownErr instanceof ManualDailySyncCooldownError) {
          return c.json(
            {
              ok: false,
              error_code: 'MANUAL_DAILY_SYNC_COOLDOWN',
              message: cooldownErr.message,
              data: {
                last_manual_at: cooldownErr.lastManualAt,
                retry_after_seconds: cooldownErr.retryAfterSeconds,
                retry_after_hours: cooldownErr.retryAfterHours,
              },
            },
            429,
          );
        }
        throw cooldownErr;
      }
      // markManualSuccess：仅本站主按钮成功落冷却锚点；登记 force 不占额度
      await syncRegistryDaily(c.env, { force: true, markManualSuccess: true });
      const diagnostics = await readRegistryDailySyncDiagnostics(c.env);
      return c.json({
        ok: true,
        data: { message: '注册中心 daily-sync 已触发', diagnostics },
      });
    } catch (err) {
      console.error('[local-reads/registry-sync] 手动 daily-sync 失败', err);
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('节点尚未注册')) {
        return c.json(
          { ok: false, error_code: 'NODE_NOT_REGISTERED', message: '节点尚未注册，请先完成登记' },
          409,
        );
      }
      return c.json(
        { ok: false, error_code: 'DAILY_SYNC_FAILED', message: message.slice(0, 300) },
        500,
      );
    }
  });

  app.get('/registry-official-feed-status', async (c) => {
    try {
      const diagnostics = await readRegistryOfficialFeedDiagnostics(c.env);
      return c.json({ ok: true, data: diagnostics });
    } catch (err) {
      console.error('[local-reads/registry-sync] 注册中心官方 feed 诊断查询失败', err);
      return c.json(
        { ok: false, error_code: 'INTERNAL_ERROR', message: '查询注册中心公告同步状态失败，请稍后重试' },
        500,
      );
    }
  });

  app.post('/registry-official-feed/pull', async (c) => {
    try {
      const result = await pullRegistryOfficialFeedNow(c.env);
      return c.json({ ok: true, data: result });
    } catch (err) {
      if (err instanceof RegistryOfficialManualPullLimitError) {
        return c.json(
          {
            ok: false,
            error_code: 'REGISTRY_OFFICIAL_PULL_LIMITED',
            message: err.message,
            data: { date: err.date, limit: err.limit },
          },
          429,
        );
      }
      console.error('[local-reads/registry-sync] 手动拉取注册中心官方 feed 失败', err);
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('node_api_token') || message.includes('owner_user_id')) {
        return c.json(
          {
            ok: false,
            error_code: 'NODE_NOT_REGISTERED',
            message: '节点尚未注册：请先完成注册中心登记，再拉取官方公告',
          },
          409,
        );
      }
      return c.json(
        { ok: false, error_code: 'REGISTRY_OFFICIAL_PULL_FAILED', message: '手动拉取官方公告失败，请稍后重试' },
        500,
      );
    }
  });

  app.post('/follows/pull-probe', async (c) => {
    try {
      const data = await probeFollowNodePulls(c.env);
      return c.json({ ok: true, data });
    } catch (err) {
      console.error('[local-reads/registry-sync] 关注节点拉取探测失败', err);
      return c.json(
        {
          ok: false,
          error_code: 'FOLLOW_PULL_PROBE_FAILED',
          message: '关注节点拉取探测失败，请稍后重试',
        },
        500,
      );
    }
  });

  /** M34-2：站主分层在线 + 关注流自动同步是否因 dormant 暂停 */
  app.get('/online-status', async (c) => {
    try {
      const {
        loadCronOwnerEngagementContext,
        effectiveEngagementForCron,
        isDormantFeedFloorDue,
      } = await import('../../services/ownerEngagement/cronEngagement');
      const snap = await loadCronOwnerEngagementContext(c.env);
      const effective = effectiveEngagementForCron(snap.ownerEngagement);
      const floorDue =
        snap.feedDormantSweepActive || isDormantFeedFloorDue(snap.feedPullCycleOkAt);
      // M34-6：dormant+skip 时若 24h 地板到期/扫尾中 → floor（仍会自动拉）
      const feedAutoSync =
        effective === 'active'
          ? 'running'
          : snap.ownerDormantFeedPolicy === 'normal'
            ? 'running'
            : snap.ownerDormantFeedPolicy === 'slow'
              ? 'slow'
              : floorDue
                ? 'floor'
                : 'paused';
      return c.json({
        ok: true,
        data: {
          owner_engagement: snap.ownerEngagement,
          owner_last_seen_at: snap.ownerLastSeenAt,
          feed_auto_sync: feedAutoSync,
          feed_pull_last_ok_at: snap.feedPullLastOkAt,
          feed_pull_cycle_ok_at: snap.feedPullCycleOkAt,
          feed_dormant_sweep_active: snap.feedDormantSweepActive,
          owner_dormant_feed_policy: snap.ownerDormantFeedPolicy,
        },
      });
    } catch (err) {
      console.error('[local-reads/registry-sync] online-status 失败', err);
      return c.json(
        { ok: false, error_code: 'ONLINE_STATUS_FAILED', message: '读取在线状态失败' },
        500,
      );
    }
  });

  /**
   * M34-2：站主手动跑一轮关注流聚合（绕过 dormant skip）。
   * 仍受单次子请求预算约束；非「无限拉全量」。
   */
  app.post('/feed-aggregate/run', async (c) => {
    try {
      const { runScheduledInvocation } = await import('../../services/feed/runScheduledInvocation');
      const {
        ensureDormantFeedSweepIfNeeded,
        noteFeedPullBatchForCycle,
      } = await import('../../services/ownerEngagement/cronEngagement');
      const { writeOperationLog } = await import('../../lib/operationLog');
      await ensureDormantFeedSweepIfNeeded(c.env);
      const result = await runScheduledInvocation(c.env);
      await noteFeedPullBatchForCycle(c.env, {
        attempted: result.feed.followAttempted ?? 0,
        totalFollows: result.feed.totalFollows ?? 0,
      });
      await writeOperationLog(c.env, {
        source: 'worker-a',
        level: 'info',
        event: 'feed_manual_aggregate',
        message: '站主手动触发关注流同步',
        details: {
          status: result.feed.status,
          fetched: result.feed.fetched,
          failed: result.feed.failed,
        },
      });
      return c.json({
        ok: true,
        data: {
          status: result.feed.status,
          fetched: result.feed.fetched,
          failed: result.feed.failed,
          next_cursor: result.feed.nextCursor,
          kv_publish: result.feed.kvPublish,
        },
      });
    } catch (err) {
      console.error('[local-reads/registry-sync] feed-aggregate/run 失败', err);
      return c.json(
        {
          ok: false,
          error_code: 'FEED_AGGREGATE_RUN_FAILED',
          message: '手动同步关注流失败，请稍后重试',
        },
        500,
      );
    }
  });

  app.get('/registry-recommended-users', async (c) => {
    const excludeFollowingParam = c.req.query('exclude_following');
    const excludeFollowing =
      excludeFollowingParam === undefined ||
      excludeFollowingParam === '' ||
      excludeFollowingParam === 'true' ||
      excludeFollowingParam === '1';

    try {
      const data = await readRegistryRecommendedUsers(c.env, { excludeFollowing });
      return c.json({ ok: true, data });
    } catch (err) {
      console.error('[local-reads/registry-sync] 注册中心推荐用户缓存查询失败', err);
      return c.json(
        { ok: false, error_code: 'REGISTRY_RECOMMENDATIONS_READ_FAILED', message: '查询推荐用户失败，请稍后重试' },
        500,
      );
    }
  });

  // ── R-MSG-2e：urgent 策略旁路 ──────────────────────────────────────

  /** 当前 urgent 辅拉开关状态与配额使用情况 */
  app.get('/registry-urgent-policies/status', async (c) => {
    try {
      const enabled = c.env.URGENT_POLICY_PULL_ENABLED === 'true';
      const quotaUsed = await readUrgentPullCount(c.env);
      return c.json({
        ok: true,
        data: {
          enabled,
          quota_used: quotaUsed,
          quota_limit: URGENT_PULL_DAILY_LIMIT,
          quota_remaining: Math.max(0, URGENT_PULL_DAILY_LIMIT - quotaUsed),
          note: enabled
            ? '紧急策略旁路已开启；Cron 每小时自动轮询'
            : '紧急策略旁路未开启（默认）；可通过 POST /registry-urgent-policies/run 手动触发',
        },
      });
    } catch (err) {
      console.error('[local-reads/registry-sync] urgent 策略状态查询失败', err);
      return c.json(
        { ok: false, error_code: 'INTERNAL_ERROR', message: '查询紧急策略状态失败' },
        500,
      );
    }
  });

  /**
   * 手动触发 urgent 辅拉（绕过 URGENT_POLICY_PULL_ENABLED 开关，仍受每日 24 次配额限制）。
   * 用于：开关关闭时站主主动检查、或开关开启但希望立即刷新。
   */
  app.post('/registry-urgent-policies/run', async (c) => {
    try {
      const result = await runUrgentPolicyPullForced(c.env);
      return c.json({ ok: true, data: result });
    } catch (err) {
      console.error('[local-reads/registry-sync] 手动 urgent 辅拉失败', err);
      return c.json(
        { ok: false, error_code: 'URGENT_PULL_FAILED', message: '手动触发紧急策略辅拉失败，请稍后重试' },
        500,
      );
    }
  });
}
