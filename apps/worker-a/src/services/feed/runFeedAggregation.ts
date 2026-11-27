/**
 * NCF-2A-0b：Feed 聚合核心（窄 deps，无 Env）。
 * Cron / 未来 Queue consumer 共用本函数。
 */
import { budgetUsed } from './budget';
import { decideFeedRunStatus } from './decideStatus';
import type {
  FeedAggregateCommand,
  FeedAggregateDeps,
  FeedRunResult,
  RemoteFeedFetchResult,
  RemoteFeedPost,
  RemoteFeedPullErrorFields,
} from './types';

/** 每 Cron 最多迁址关注数（与历史 feedFetch 一致） */
const FEED_URL_MIGRATE_BUDGET = 3;

function asPullError(reason: unknown): RemoteFeedPullErrorFields & { message: string } {
  if (reason && typeof reason === 'object') {
    const o = reason as RemoteFeedPullErrorFields & { message?: string };
    return {
      message: typeof o.message === 'string' ? o.message : String(reason),
      postsUrl: o.postsUrl,
      httpStatus: o.httpStatus ?? null,
      responseUrl: o.responseUrl,
      bodySnippet: o.bodySnippet,
      tokenRetry: o.tokenRetry,
      movedHint: o.movedHint ?? '',
    };
  }
  return { message: String(reason), movedHint: '' };
}

export async function runFeedAggregation(
  command: FeedAggregateCommand,
  deps: FeedAggregateDeps,
): Promise<FeedRunResult> {
  const initialCap = command.budget.externalFetchRemaining;
  const empty = (patch: Partial<FeedRunResult>): FeedRunResult => ({
    status: 'completed',
    fetched: 0,
    failed: 0,
    deferredTargets: [],
    nextCursor: null,
    budgetUsed: budgetUsed(initialCap, deps.budget),
    kvPublish: 'skipped',
    ...patch,
  });

  let followRows;
  let nextCursor: string | null = null;
  let totalFollows = 0;
  try {
    const batch = await deps.followsRepo.loadBatch(command);
    followRows = batch.rows;
    nextCursor = batch.cursorAdvancedTo;
    totalFollows = batch.totalFollows;
    if (batch.totalFollows > 0 && batch.rows.length === 0) {
      deps.logger.info('[cron/feed] 关注节点均在退避窗口内，跳过本轮关注拉取');
    }
  } catch (err) {
    deps.logger.error('[cron/feed] 读取关注 batch 失败', err);
    return empty({
      status: 'error',
      error_code: 'FEED_BATCH_LOAD_FAILED',
      budgetUsed: budgetUsed(initialCap, deps.budget),
      followAttempted: 0,
      totalFollows: 0,
    });
  }

  if (followRows.length === 0) {
    deps.logger.info('[cron/feed] 无关注节点，跳过本轮聚合');
    return empty({ nextCursor, followAttempted: 0, totalFollows });
  }

  const ownerHandle = await deps.ownerContext.getOwnerHandle();
  const followerNodeUrl = await deps.ownerContext.getFollowerNodeUrl();
  const deferredTargets: string[] = [];
  const fetchResults: Array<
    | { status: 'fulfilled'; value: RemoteFeedFetchResult }
    | { status: 'rejected'; reason: unknown }
    | { status: 'deferred' }
  > = [];

  for (const row of followRows) {
    if (
      command.budget.wallMsDeadline !== undefined &&
      Date.now() >= command.budget.wallMsDeadline
    ) {
      deferredTargets.push(row.id);
      fetchResults.push({ status: 'deferred' });
      continue;
    }
    if (deps.budget.remaining <= 0) {
      deps.logger.warn('[cron/feed] 子请求硬上限已达，剩余关注推迟下轮');
      deferredTargets.push(row.id);
      fetchResults.push({ status: 'deferred' });
      continue;
    }
    try {
      const value = await deps.remoteFeed.fetchPosts(row.fetch_url, {
        followerNodeUrl,
        followerHandle: ownerHandle || undefined,
      });
      fetchResults.push({ status: 'fulfilled', value });
    } catch (reason) {
      fetchResults.push({ status: 'rejected', reason });
    }
  }

  // 预算耗尽后未进入 fetch 的行已记 deferred；补齐循环后仍未 push 的不应发生
  // M-OPT-SPLIT-7：feed_cache→GOVERNANCE；follows mark→IDENTITY；两步串行禁跨库 batch
  const feedCacheStatements: unknown[] = [];
  const followMarkStatements: unknown[] = [];
  const now = deps.clock.nowIso();
  let insertCount = 0;
  let fetchedOk = 0;
  let batchFailedCount = 0;
  const worstMigrateSubs = deps.migrate.worstCaseSubrequests();
  let migrateBudgetLeft = FEED_URL_MIGRATE_BUDGET;
  let migrateOkCount = 0;

  for (let i = 0; i < fetchResults.length; i++) {
    const result = fetchResults[i]!;
    const follow = followRows[i]!;
    if (result.status === 'deferred') continue;

    let effectiveFetchUrl = follow.fetch_url;
    let authorHandle = follow.followed_handle?.trim() || null;
    let posts: RemoteFeedPost[] | null = null;
    let pullFailed = false;
    let pullErr: RemoteFeedPullErrorFields & { message: string } | null = null;
    let failReason = '';

    if (result.status === 'fulfilled') {
      posts = result.value.posts;
      const movedHint = result.value.movedHint;
      if (movedHint && migrateBudgetLeft > 0 && deps.budget.remaining >= worstMigrateSubs) {
        migrateBudgetLeft -= 1;
        const migrated = await deps.migrate.tryMigrate({
          followId: follow.id,
          currentFetchUrl: follow.fetch_url,
          followedHandle: follow.followed_handle,
          movedHint,
        });
        if (migrated) {
          migrateOkCount += 1;
          effectiveFetchUrl = migrated.new_node_url;
          if (migrated.handle) authorHandle = migrated.handle;
          try {
            const retry = await deps.remoteFeed.fetchPosts(migrated.new_node_url, {
              followerNodeUrl,
              followerHandle: ownerHandle || undefined,
            });
            posts = retry.posts;
          } catch (retryErr) {
            deps.logger.warn(
              `[cron/feed] 迁址后重试拉取失败 ${migrated.new_node_url}`,
              retryErr instanceof Error ? retryErr.message : retryErr,
            );
          }
          deps.operationLog?.write(
            'follow_url_migrated',
            `关注节点迁址：${follow.fetch_url} → ${migrated.new_node_url}`,
            {
              follow_id: follow.id,
              old_url: follow.fetch_url,
              new_url: migrated.new_node_url,
              handle: migrated.handle,
            },
          );
        }
      }
    } else {
      pullFailed = true;
      pullErr = asPullError(result.reason);
      failReason = pullErr.message;
      const movedHint = pullErr.movedHint ?? '';
      if (movedHint && migrateBudgetLeft > 0 && deps.budget.remaining >= worstMigrateSubs) {
        migrateBudgetLeft -= 1;
        const migrated = await deps.migrate.tryMigrate({
          followId: follow.id,
          currentFetchUrl: follow.fetch_url,
          followedHandle: follow.followed_handle,
          movedHint,
        });
        if (migrated) {
          migrateOkCount += 1;
          effectiveFetchUrl = migrated.new_node_url;
          if (migrated.handle) authorHandle = migrated.handle;
          try {
            const retry = await deps.remoteFeed.fetchPosts(migrated.new_node_url, {
              followerNodeUrl,
              followerHandle: ownerHandle || undefined,
            });
            posts = retry.posts;
            pullFailed = false;
            pullErr = null;
            failReason = '';
          } catch (retryErr) {
            pullFailed = true;
            pullErr = asPullError(retryErr);
            failReason = pullErr.message;
          }
          deps.operationLog?.write(
            'follow_url_migrated',
            `关注节点迁址（失败路径）：${follow.fetch_url} → ${migrated.new_node_url}`,
            {
              follow_id: follow.id,
              old_url: follow.fetch_url,
              new_url: migrated.new_node_url,
              handle: migrated.handle,
              retry_ok: !pullFailed,
            },
          );
        }
      }
    }

    if (!pullFailed && posts) {
      fetchedOk += 1;
      // URL 关注没有 handle 时，用远端帖子自带的 author_handle 自动回填 follows；
      // 用户不需要再手填 handle，时间线也不会回落节点域名。
      if (!authorHandle) {
        const discovered = posts.find((p) => p.author_handle?.trim())?.author_handle?.trim();
        if (discovered) {
          authorHandle = discovered;
          if (deps.followsRepo.backfillHandle) {
            try {
              await deps.followsRepo.backfillHandle(follow.id, discovered);
            } catch (err) {
              deps.logger.warn(
                `[cron/feed] 回填 followed_handle 失败 ${follow.id}`,
                err instanceof Error ? err.message : err,
              );
            }
          }
        }
      }
      for (const post of posts) {
        feedCacheStatements.push(
          deps.feedCache.prepareUpsert(effectiveFetchUrl, post, now, authorHandle),
        );
        insertCount += 1;
      }
      feedCacheStatements.push(
        deps.feedCache.prepareAbsentDelete(
          effectiveFetchUrl,
          posts.map((p) => p.id),
        ),
      );
      followMarkStatements.push(deps.followsRepo.prepareMarkOk(follow.id, now));
    } else {
      batchFailedCount += 1;
      const postsUrl = pullErr?.postsUrl ?? deps.resolvePostsUrl(effectiveFetchUrl);
      const nextRetryAt = deps.computeNextRetryAt(follow.fail_count + 1);
      const logMessage = pullErr?.bodySnippet
        ? `关注节点拉取失败：${effectiveFetchUrl} — ${failReason}（${postsUrl}）响应：${pullErr.bodySnippet.slice(0, 120)}`
        : `关注节点拉取失败：${effectiveFetchUrl} — ${failReason}（${postsUrl}）`;
      followMarkStatements.push(deps.followsRepo.prepareMarkFail(follow.id, nextRetryAt));
      deps.logger.warn(`[cron/feed] 节点 ${effectiveFetchUrl} 拉取失败`, failReason);
      deps.operationLog?.write(
        'follow_node_pull_failed',
        logMessage,
        {
          fetch_url: effectiveFetchUrl,
          posts_url: postsUrl,
          http_status: pullErr?.httpStatus ?? null,
          response_url: pullErr?.responseUrl ?? '',
          body_snippet: pullErr?.bodySnippet?.slice(0, 200) ?? '',
          token_retry: pullErr?.tokenRetry ?? false,
          error: failReason.slice(0, 500),
        },
        'warn',
      );
    }
  }

  // 先 GOVERNANCE(feed_cache) 再 IDENTITY(follows)；禁止合并单 binding batch
  if (feedCacheStatements.length > 0) {
    try {
      await deps.feedCache.batch(feedCacheStatements);
    } catch (err) {
      deps.logger.error('[cron/feed] feed_cache batch 写入失败', err);
      return empty({
        status: 'error',
        fetched: fetchedOk,
        failed: batchFailedCount,
        deferredTargets,
        nextCursor,
        error_code: 'FEED_CACHE_BATCH_FAILED',
        budgetUsed: budgetUsed(initialCap, deps.budget),
        followAttempted: followRows.length,
        totalFollows,
      });
    }
  }
  if (followMarkStatements.length > 0) {
    try {
      await deps.followsRepo.batchMarks(followMarkStatements);
    } catch (err) {
      deps.logger.error('[cron/feed] follows mark batch 写入失败', err);
      return empty({
        status: 'error',
        fetched: fetchedOk,
        failed: batchFailedCount,
        deferredTargets,
        nextCursor,
        error_code: 'FEED_CACHE_BATCH_FAILED',
        budgetUsed: budgetUsed(initialCap, deps.budget),
        followAttempted: followRows.length,
        totalFollows,
      });
    }
  }

  let kvPublish: FeedRunResult['kvPublish'] = 'skipped';
  try {
    kvPublish = await deps.kvPublisher.refreshLatest(batchFailedCount);
    if (followRows.length > 0 && batchFailedCount === 0 && deferredTargets.length === 0) {
      await deps.followsRepo.markBatchOk();
    }
  } catch (err) {
    deps.logger.error('[cron/feed] 写 KV feed:latest 失败', err);
    kvPublish = 'failed';
  }

  const status = decideFeedRunStatus({
    fetched: fetchedOk,
    failed: batchFailedCount,
    deferredCount: deferredTargets.length,
  });

  deps.logger.info(
    `[cron/feed] 聚合完成：拉取 ${followRows.length} 个关注节点，写入 ${insertCount} 条到 feed_cache，` +
      `迁址 ${migrateOkCount} 个，kvPublish=${kvPublish} status=${status}`,
  );
  deps.operationLog?.write(
    'feed_aggregate_done',
    `Feed 聚合完成：关注节点 ${followRows.length} 个`,
    {
      inserted_count: insertCount,
      follow_count: followRows.length,
      url_migrated_count: migrateOkCount,
      status,
      kv_publish: kvPublish,
      deferred_count: deferredTargets.length,
    },
  );

  return {
    status,
    fetched: fetchedOk,
    failed: batchFailedCount,
    deferredTargets,
    nextCursor,
    budgetUsed: budgetUsed(initialCap, deps.budget),
    kvPublish,
    followAttempted: followRows.length,
    totalFollows,
  };
}
