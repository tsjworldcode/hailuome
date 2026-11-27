/**
 * NCF-2A：生产 adapter — Env 只出现在本文件，核心不见 Env。
 */
import { resolveGovernanceDb, resolveIdentityDb } from '../../../db/bindings';
import { URL_MOVE_CHAIN_MAX_HOPS } from '@hailuo/shared-types';
import type { Env } from '../../../env';
import {
  computeNextRetryAt,
  loadFollowBatchForPull,
  markFeedPullBatchOk,
  FEED_PULL_BATCH_SIZE,
  type FollowPullRow,
} from '../../../handlers/feedPullBatch';
import {
  FollowNodePullError,
  fetchNodePosts,
  prepareFeedCacheUpsert,
  prepareFeedCacheAbsentPostIdsDelete,
  refreshLatestFeedKv,
  resolveFollowFetchBaseUrl,
} from '../../../handlers/feedFetch';
import { tryMigrateFollowAfterMovedHint } from '../../../lib/followUrlMigrate';
import { writeOperationLog } from '../../../lib/operationLog';
import { resolveLocalPublicBaseUrl } from '../../../lib/localPublicBaseUrl';
import {
  CronSubrequestBudget,
  worstCaseUrlMigrateSubrequests,
} from '../../../lib/cronSubrequestBudget';
import { createExternalFetchBudget } from '../budget';
import type { FeedAggregateCommand, FeedAggregateDeps, KvPublishStatus, RemoteFeedFetchResult } from '../types';

function mapFollowRow(row: FollowPullRow) {
  return {
    id: row.id,
    fetch_url: row.fetch_url,
    followed_handle: row.followed_handle,
    fail_count: row.fail_count,
    next_retry_at: row.next_retry_at,
  };
}

/**
 * 用 command.budget 建共享预算；remote/migrate 与核心共用同一计数器。
 * CronSubrequestBudget 与 ExternalFetchBudget 同形，优先复用前者以便 fetchNodePosts 直接 take。
 */
export function createProductionFeedDeps(
  env: Env,
  command: FeedAggregateCommand,
): { deps: FeedAggregateDeps; budget: CronSubrequestBudget } {
  const cap = command.budget.externalFetchRemaining;
  // 与历史路径一致：硬上限走 CronSubrequestBudget（fetchNodePosts / 迁址共用）
  const budget = new CronSubrequestBudget(cap);

  const deps: FeedAggregateDeps = {
    budget,
    followsRepo: {
      async loadBatch(cmd) {
        // 显式 URL 列表：fixture / overflow 预留；生产 Cron 仍走 D1 游标 batch
        if (Array.isArray(cmd.targetBatch)) {
          const rows = cmd.targetBatch.map((url, i) => ({
            id: `url:${i}:${url}`,
            fetch_url: url,
            followed_handle: null,
            fail_count: 0,
            next_retry_at: null,
          }));
          return { rows, totalFollows: rows.length, cursorAdvancedTo: null };
        }
        const batch = await loadFollowBatchForPull(env);
        return {
          rows: batch.rows.map(mapFollowRow),
          totalFollows: batch.totalFollows,
          cursorAdvancedTo: batch.cursorAdvancedTo,
        };
      },
      markBatchOk: () => markFeedPullBatchOk(env),
      async backfillHandle(followId, handle) {
        // URL 关注没有 followed_handle；用远端帖子作者回填（只填空值，不覆盖用户手填）。
        await resolveIdentityDb(env)
          .prepare(
            `UPDATE follows SET followed_handle = ?
              WHERE id = ? AND (followed_handle IS NULL OR followed_handle = '')`,
          )
          .bind(handle, followId)
          .run();
      },
      prepareMarkOk(followId, nowIso) {
        return resolveIdentityDb(env)
          .prepare(
            `UPDATE follows SET last_active = ?, fail_count = 0, next_retry_at = NULL WHERE id = ?`,
          )
          .bind(nowIso, followId);
      },
      prepareMarkFail(followId, nextRetryAt) {
        return resolveIdentityDb(env)
          .prepare(`UPDATE follows SET fail_count = fail_count + 1, next_retry_at = ? WHERE id = ?`)
          .bind(nextRetryAt, followId);
      },
      async batchMarks(statements) {
        if (statements.length === 0) return;
        // follows → IDENTITY_DB；与 feed_cache 两步串行，禁止跨库单 batch
        await resolveIdentityDb(env).batch(statements as D1PreparedStatement[]);
      },
    },
    remoteFeed: {
      async fetchPosts(fetchUrl, opts) {
        try {
          const result = await fetchNodePosts(env, fetchUrl, {
            followerNodeUrl: opts.followerNodeUrl,
            followerHandle: opts.followerHandle,
            budget,
          });
          return {
            posts: result.posts as RemoteFeedFetchResult['posts'],
            movedHint: result.movedHint,
          };
        } catch (err: unknown) {
          if (err instanceof FollowNodePullError) {
            // 把诊断字段挂到 Error 上，供核心 asPullError 读取
            const wrapped = new Error(err.message) as Error & {
              postsUrl?: string;
              httpStatus?: number | null;
              responseUrl?: string;
              bodySnippet?: string;
              tokenRetry?: boolean;
              movedHint?: string;
            };
            wrapped.postsUrl = err.postsUrl;
            wrapped.httpStatus = err.httpStatus;
            wrapped.responseUrl = err.responseUrl;
            wrapped.bodySnippet = err.bodySnippet;
            wrapped.tokenRetry = err.tokenRetry;
            wrapped.movedHint = err.movedHint;
            throw wrapped;
          }
          throw err;
        }
      },
    },
    migrate: {
      worstCaseSubrequests: () => worstCaseUrlMigrateSubrequests(URL_MOVE_CHAIN_MAX_HOPS),
      tryMigrate: (input) =>
        tryMigrateFollowAfterMovedHint(env, {
          followId: input.followId,
          currentFetchUrl: input.currentFetchUrl,
          followedHandle: input.followedHandle,
          movedHint: input.movedHint,
          budget,
        }),
    },
    feedCache: {
      prepareUpsert: (sourceUrl, post, fetchedAt, authorHandle) =>
        prepareFeedCacheUpsert(
          env,
          sourceUrl,
          post as Parameters<typeof prepareFeedCacheUpsert>[2],
          fetchedAt,
          authorHandle,
        ),
      prepareAbsentDelete: (nodeUrl, postIds) =>
        prepareFeedCacheAbsentPostIdsDelete(env, nodeUrl, postIds),
      batch: async (statements) => {
        if (statements.length === 0) return;
        // feed_cache → GOVERNANCE_DB
        await resolveGovernanceDb(env).batch(statements as D1PreparedStatement[]);
      },
    },
    kvPublisher: {
      async refreshLatest(partialFailedCount): Promise<KvPublishStatus> {
        return refreshLatestFeedKv(env, partialFailedCount);
      },
    },
    ownerContext: {
      async getOwnerHandle() {
        try {
          const ownerRow = await resolveIdentityDb(env)
            .prepare('SELECT handle FROM users LIMIT 1')
            .first<{ handle: string }>();
          return ownerRow?.handle?.trim() ?? '';
        } catch {
          return '';
        }
      },
      getFollowerNodeUrl: () => resolveLocalPublicBaseUrl(env),
    },
    clock: { nowIso: () => new Date().toISOString() },
    logger: {
      info: (msg, detail) => (detail === undefined ? console.log(msg) : console.log(msg, detail)),
      warn: (msg, detail) => (detail === undefined ? console.warn(msg) : console.warn(msg, detail)),
      error: (msg, detail) => (detail === undefined ? console.error(msg) : console.error(msg, detail)),
    },
    operationLog: {
      write(event, message, details, level = 'info') {
        void writeOperationLog(env, {
          source: 'worker-a',
          level,
          event,
          message,
          details,
        });
      },
    },
    computeNextRetryAt: (failCount) => computeNextRetryAt(failCount),
    resolvePostsUrl: (fetchUrl) =>
      `${resolveFollowFetchBaseUrl(fetchUrl)}/posts?limit=20&scope=local`,
  };

  return { deps, budget };
}

/** 供测试：纯 ExternalFetchBudget 工厂（不绑 Env） */
export function createTestBudget(cap: number) {
  return createExternalFetchBudget(cap);
}

export { FEED_PULL_BATCH_SIZE };
