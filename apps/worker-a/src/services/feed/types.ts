/**
 * NCF-2A-0b：Feed 深模块 command / result / 窄依赖（禁止整包 Env）。
 * 契约见 docs/m-refactor-ncf-2-plan.md §5.2。
 */

export type FeedRunStatus = 'completed' | 'deferred' | 'partial' | 'error';

/** M13-16：增加 budget_deferred——非安全 put 日预算耗尽，保留 dirty 待补刷 */
export type KvPublishStatus = 'skipped' | 'ok' | 'failed' | 'budget_deferred';

export type FeedAggregateBudget = {
  externalFetchRemaining: number;
  /** 可选墙钟截止（ms epoch）；超时则剩余目标记入 deferredTargets */
  wallMsDeadline?: number;
};

export type FeedAggregateCommand = {
  scheduledAt: string;
  cursor?: string;
  cursorVersion?: number;
  /** 批大小，或显式关注 URL 列表（fixture / overflow 预留） */
  targetBatch: number | readonly string[];
  budget: FeedAggregateBudget;
  runId?: string;
};

export type FeedRunResult = {
  status: FeedRunStatus;
  fetched: number;
  failed: number;
  deferredTargets: string[];
  nextCursor: string | null;
  budgetUsed: number;
  kvPublish: KvPublishStatus;
  error_code?: string;
  /** M34-6：本轮尝试拉取的关注数（含失败；全退避时为 0） */
  followAttempted?: number;
  /** M34-6：follows 总数（用于 dormant 24h 全量扫进度） */
  totalFollows?: number;
};

export type FollowPullTarget = {
  id: string;
  fetch_url: string;
  followed_handle: string | null;
  fail_count: number;
  next_retry_at: string | null;
};

export type RemoteFeedPost = {
  id: string;
  content: string;
  sig: string;
  image_urls: string[];
  created_at: string;
  /** 远端帖子自带作者 handle（与 followed_handle 二选一） */
  author_handle?: string;
  post_kind?: 'original' | 'repost';
  repost_of?: {
    node_url?: string;
    post_id?: string;
    author_handle?: string;
  } | null;
};

export type RemoteFeedFetchResult = {
  posts: RemoteFeedPost[];
  movedHint: string;
};

export type FeedMigrateResult = {
  new_node_url: string;
  handle: string | null;
};

/** 拉取失败诊断（adapter 可挂在 Error 上） */
export type RemoteFeedPullErrorFields = {
  postsUrl?: string;
  httpStatus?: number | null;
  responseUrl?: string;
  bodySnippet?: string;
  tokenRetry?: boolean;
  movedHint?: string;
};

/**
 * 窄依赖口：核心只认这些，禁止 Env / ExecutionContext / Hono Context / 跨域 messaging。
 */
export type FeedAggregateDeps = {
  budget: {
    readonly remaining: number;
    take(n?: number): boolean;
  };
  followsRepo: {
    loadBatch(command: FeedAggregateCommand): Promise<{
      rows: FollowPullTarget[];
      totalFollows: number;
      cursorAdvancedTo: string | null;
    }>;
    markBatchOk(): Promise<void>;
    prepareMarkOk(followId: string, nowIso: string): unknown;
    prepareMarkFail(followId: string, nextRetryAt: string): unknown;
    /** 关注行没有 handle（URL 关注）时，用远端帖子作者回填，避免前端回落节点名。 */
    backfillHandle?(followId: string, handle: string): Promise<void>;
    /** follows 标记写 IDENTITY；与 feed_cache 分库，禁止并入 feedCache.batch */
    batchMarks(statements: unknown[]): Promise<void>;
  };
  remoteFeed: {
    fetchPosts(
      fetchUrl: string,
      opts: { followerNodeUrl: string; followerHandle?: string },
    ): Promise<RemoteFeedFetchResult>;
  };
  migrate: {
    worstCaseSubrequests(): number;
    tryMigrate(input: {
      followId: string;
      currentFetchUrl: string;
      followedHandle: string | null;
      movedHint: string;
    }): Promise<FeedMigrateResult | null>;
  };
  feedCache: {
    prepareUpsert(
      sourceUrl: string,
      post: RemoteFeedPost,
      fetchedAt: string,
      authorHandle?: string | null,
    ): unknown;
    prepareAbsentDelete(nodeUrl: string, postIds: readonly string[]): unknown;
    batch(statements: unknown[]): Promise<void>;
  };
  kvPublisher: {
    refreshLatest(partialFailedCount: number): Promise<KvPublishStatus>;
  };
  ownerContext: {
    getOwnerHandle(): Promise<string>;
    getFollowerNodeUrl(): Promise<string>;
  };
  clock: { nowIso(): string };
  logger: {
    info(msg: string, detail?: unknown): void;
    warn(msg: string, detail?: unknown): void;
    error(msg: string, detail?: unknown): void;
  };
  /** 可选：写 operation_logs；失败不得阻断聚合 */
  operationLog?: {
    write(
      event: string,
      message: string,
      details?: Record<string, unknown>,
      level?: 'info' | 'warn',
    ): void;
  };
  /** 失败退避 next_retry_at */
  computeNextRetryAt(failCount: number): string;
  /** 拼 posts URL（日志用） */
  resolvePostsUrl(fetchUrl: string): string;
};
