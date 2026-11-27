// M4-3 / M4-4：Cron Feed 拉取 helpers + 官方公告落库。
//
// 聚合入口（NCF-2A）：services/feed runScheduledInvocation → runFeedAggregation。
// 本文件保留：单节点 fetchNodePosts、官方公告 helpers、probe、KV 刷新、兼容 fetchAndAggregateFeed。
//
// 约束：
//   - 单次 Cron 子请求硬上限 FEED_SUBREQUEST_HARD_CAP=48（services/feed 生产 adapter）
//   - fail-soft：任意来源失败只记日志，不中断其它来源拉取
//   - feed:latest 内容指纹去重（M13-10），避免 2 分钟拉取打穿 KV 写配额
//   - 迁址禁止盲信未签名 Location / 裸 header URL（必须 well-known 验签）

import type { Env } from '../env';
import { resolveGovernanceDb, resolveIdentityDb } from '../db/bindings';
import { buildReadMutualProofForOwner } from '../routes/read-mutual-proof';
import type { ReadMutualProof } from '@hailuo/shared-types';
import { gcFeedCacheWithWaterLevel } from '../lib/d1Gc';
import { putFeedLatestWithMeta } from '../lib/publicCacheMeta';
import { tryConsumeNonSecurityCachePuts } from '../lib/cacheKvPutBudget';
import { registryFetch } from '../lib/registryFetch';
import { resolvePrimaryRegistryEndpoint, resolvePrimaryRegistryUrl } from '../lib/registryRouter';
import { writeOperationLog } from '../lib/operationLog';
import { resolveLocalPublicBaseUrl } from '../lib/localPublicBaseUrl';
import { readMovedHintFromHeaders } from '../lib/followUrlMigrate';
import { CronSubrequestBudget } from '../lib/cronSubrequestBudget';
import { isManualRedirectStatus, resolveSafeOutboundPeerUrl } from '../lib/fetchOutboundPeer';

/** 单条帖子的 Worker B 响应格式（GET /posts items）。 */
interface RemotePost {
  id: string;
  content: string;
  sig: string;
  image_urls: string[];
  created_at: string;
  /** Worker B 帖子自带的作者 handle（远端权威；followed_handle 缺失时用它） */
  author_handle?: string;
  /** 对方 /posts 合并列表中的官方公告项；Cron 拉关注对象时应过滤掉 */
  source_type?: 'official';
  node_url?: string;
  /** M9-1：纯转发帖 */
  post_kind?: 'original' | 'repost';
  repost_of?: {
    node_url: string;
    post_id: string;
    author_handle: string;
  } | null;
}

/** Worker B GET /posts 响应。 */
interface WorkerBPostsResponse {
  ok: boolean;
  data?: {
    items: RemotePost[];
    has_more: boolean;
    cursor: string | null;
  };
}

/** 注册中心 GET /api/posts/feed 的公开图片投影。 */
interface RegistryOfficialImage {
  url: string;
  storage: 'r2' | 'kv';
  mime: string;
  width: number | null;
  height: number | null;
  alt: string | null;
}

/** 注册中心官方公告 feed 项。 */
interface RegistryOfficialPost {
  post_id: string;
  category: string;
  title: string;
  body: string;
  body_format: string;
  tags: string[];
  images: RegistryOfficialImage[];
  published_at: string;
  updated_at: string;
}

/** 注册中心 GET /api/posts/feed 响应。 */
interface RegistryOfficialFeedResponse {
  ok: boolean;
  data?: {
    items: RegistryOfficialPost[];
    pagination?: {
      next_since: string | null;
      limit: number;
      has_more: boolean;
    };
  };
  error_code?: string;
  message?: string;
}

/**
 * 单节点拉取超时（毫秒）。
 *
 * M5-P7：5s 让慢节点快速进入 fail_count，不拖住整轮 cron。
 */
const NODE_FETCH_TIMEOUT_MS = 5_000;

/** 注册中心官方公告每页上限；与注册中心契约 MAX_LIMIT=50 对齐。 */
const REGISTRY_OFFICIAL_FEED_LIMIT = 50;

/** 官方公告每轮最多追 3 页：40 个关注节点 + 3 个官方 feed 请求 = 43 子请求。 */
const REGISTRY_OFFICIAL_FEED_MAX_PAGES = 3;

/**
 * 新部署节点没有本地官方公告游标时，从最近 180 天开始补拉。
 * 注册中心 feed 按 published_at 升序返回；用近期窗口可避免首次部署被很旧公告占满。
 */
const REGISTRY_OFFICIAL_BOOTSTRAP_DAYS = 180;

/** 官方公告默认低频检查间隔：每日最多拉一次注册中心（Cron 每 5 分钟仍会跑关注聚合，但 shouldPull 节流）。 */
const REGISTRY_OFFICIAL_FEED_MIN_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** 每个节点稳定错峰 0~30 分钟，避免同一 UTC 日边界形成尖峰。 */
const REGISTRY_OFFICIAL_FEED_JITTER_MS = 30 * 60 * 1000;

/** 增量游标回退 1 分钟，容忍同秒发布、多节点时钟边界和严格大于查询。 */
const REGISTRY_OFFICIAL_SINCE_OVERLAP_MS = 60 * 1000;

/** 本地缓存最新时间如果明显在未来，视为脏游标并回到 bootstrap 窗口。 */
const REGISTRY_OFFICIAL_FUTURE_DRIFT_MS = 5 * 60 * 1000;

/** 站主手动拉取官方公告的每日上限；计数写 D1，不占 KV 写配额。 */
const REGISTRY_OFFICIAL_MANUAL_PULL_DAILY_LIMIT = 3;

const REGISTRY_OFFICIAL_FEED_STATUS_KEYS = [
  'registry_official_feed_last_status',
  'registry_official_feed_last_checked_at',
  'registry_official_feed_last_source_url',
  'registry_official_feed_last_fetched_count',
  'registry_official_feed_last_insert_count',
  'registry_official_feed_last_error',
] as const;

type RegistryOfficialFeedStatusKey = typeof REGISTRY_OFFICIAL_FEED_STATUS_KEYS[number];

export class RegistryOfficialManualPullLimitError extends Error {
  constructor(
    readonly date: string,
    readonly limit: number,
  ) {
    super(`今日手动拉取官方公告次数已达上限（${limit} 次）`);
    this.name = 'RegistryOfficialManualPullLimitError';
  }
}

/** Cron 拉取失败时附带 HTTP 诊断字段，便于 operation_logs 与手动 probe 对齐。 */
export class FollowNodePullError extends Error {
  readonly postsUrl: string;
  readonly httpStatus: number | null;
  readonly responseUrl: string;
  readonly bodySnippet: string;
  readonly tokenRetry: boolean;
  /** M7-30f-3：失败响应上仍可能带迁址头 */
  readonly movedHint: string;

  constructor(input: {
    message: string;
    postsUrl: string;
    httpStatus?: number | null;
    responseUrl?: string;
    bodySnippet?: string;
    tokenRetry?: boolean;
    movedHint?: string;
  }) {
    super(input.message);
    this.name = 'FollowNodePullError';
    this.postsUrl = input.postsUrl;
    this.httpStatus = input.httpStatus ?? null;
    this.responseUrl = input.responseUrl ?? input.postsUrl;
    this.bodySnippet = input.bodySnippet ?? '';
    this.tokenRetry = input.tokenRetry ?? false;
    this.movedHint = input.movedHint ?? '';
  }
}

/** 关注拉取只认 Worker B 根 origin，避免误存 /health、/posts 或 Pages 深链拼成 …/posts/posts。 */
export function resolveFollowFetchBaseUrl(nodeUrl: string): string {
  const trimmed = stripTrailingSlash(nodeUrl.trim());
  if (!trimmed) return trimmed;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return trimmed;
    }
    return parsed.origin;
  } catch {
    return trimmed;
  }
}

async function readResponseBodySnippet(res: Response, maxLen = 200): Promise<string> {
  try {
    return (await res.text()).slice(0, maxLen);
  } catch {
    return '';
  }
}

/** 识别 Cloudflare 平台层 fetch 失败（非 Worker B 业务 JSON）。 */
function explainCloudflareFetchFailure(httpStatus: number, bodySnippet: string): string | null {
  if (/error code:\s*1042/i.test(bodySnippet)) {
    return 'Cloudflare 1042：同账号 Worker A 不能默认同域 fetch 其它 Worker B 的 workers.dev（浏览器直访正常）。请在 Worker A wrangler.toml 启用 compatibility_flags 含 global_fetch_strictly_public 后重新 deploy';
  }
  if (httpStatus === 404 && bodySnippet.includes('error code:')) {
    return `Cloudflare 平台拒绝子请求（响应：${bodySnippet.slice(0, 80)}）`;
  }
  return null;
}

/** M7-30f-3：拉取结果附带迁址响应头提示（仍须 well-known 验签后才改 follows）。 */
export interface FetchNodePostsResult {
  posts: RemotePost[];
  movedHint: string;
}

/** 拉取单个节点的帖子列表（只取第一页，最多 20 条）。protected 模式 401 后申请粉丝 Token；mutual-only 403 时带 read_mutual_proof 重试。 */
export async function fetchNodePosts(
  env: Env,
  nodeUrl: string,
  opts: {
    followerNodeUrl?: string;
    followerHandle?: string;
    budget?: CronSubrequestBudget;
  } = {},
): Promise<FetchNodePostsResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NODE_FETCH_TIMEOUT_MS);
  const base = resolveFollowFetchBaseUrl(nodeUrl);
  const postsUrl = `${base}/posts?limit=20&scope=local`;
  let tokenRetry = false;
  try {
    if (opts.budget && !opts.budget.take(1)) {
      throw new FollowNodePullError({
        message: 'Cron 子请求预算已用尽',
        postsUrl,
        tokenRetry: false,
      });
    }
    const safePostsUrl = resolveSafeOutboundPeerUrl(env, postsUrl);
    if (!safePostsUrl) {
      throw new FollowNodePullError({
        message: '对端地址未通过出站校验',
        postsUrl,
      });
    }
    let res = await fetch(safePostsUrl, {
      headers: {
        Accept: 'application/json',
        // 便于在 Worker B / CF 日志里区分 Cron 子请求与浏览器直访；不是拉取失败根因判断。
        'User-Agent': 'hailuo-node-cron/1.0',
      },
      signal: controller.signal,
      redirect: 'manual',
    });
    if (isManualRedirectStatus(res.status)) {
      throw new FollowNodePullError({
        message: '对端返回重定向，已拒绝跟随',
        postsUrl: safePostsUrl,
        httpStatus: res.status,
      });
    }

    // 对方 Worker B 若已切 enforced，需携带本节点 WORKER_B_URL 签发的粉丝 Token。
    if (res.status === 401 && opts.followerNodeUrl) {
      const token = await fetchRemoteFollowerToken(
        env,
        base,
        opts.followerNodeUrl,
        opts.followerHandle,
        undefined,
        opts.budget,
      );
      tokenRetry = Boolean(token);
      if (token) {
        if (opts.budget && !opts.budget.take(1)) {
          throw new FollowNodePullError({
            message: 'Cron 子请求预算已用尽（token 重试）',
            postsUrl,
            tokenRetry,
          });
        }
        res = await fetch(safePostsUrl, {
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${token}`,
            'User-Agent': 'hailuo-node-cron/1.0',
          },
          signal: controller.signal,
          redirect: 'manual',
        });
        if (isManualRedirectStatus(res.status)) {
          throw new FollowNodePullError({
            message: '对端返回重定向，已拒绝跟随',
            postsUrl: safePostsUrl,
            httpStatus: res.status,
            tokenRetry,
          });
        }
      }
    }

    const movedHint = readMovedHintFromHeaders(res.headers);

    if (!res.ok) {
      const bodySnippet = await readResponseBodySnippet(res);
      const platformHint = explainCloudflareFetchFailure(res.status, bodySnippet);
      const detail = tokenRetry ? '（已尝试申请粉丝 Token 仍失败）' : '';
      const message = platformHint ?? `HTTP ${res.status}${detail}`;
      throw new FollowNodePullError({
        message,
        postsUrl,
        httpStatus: res.status,
        responseUrl: res.url || postsUrl,
        bodySnippet,
        tokenRetry,
        movedHint,
      });
    }
    const json = await res.json() as WorkerBPostsResponse;
    if (!json.ok || !Array.isArray(json.data?.items)) {
      throw new FollowNodePullError({
        message: '响应格式异常',
        postsUrl,
        httpStatus: res.status,
        responseUrl: res.url || postsUrl,
        bodySnippet: JSON.stringify(json).slice(0, 200),
        tokenRetry,
      });
    }
    return {
      posts: json.data.items.filter((item) => item.source_type !== 'official'),
      movedHint,
    };
  } catch (err) {
    if (err instanceof FollowNodePullError) {
      throw err;
    }
    if (err instanceof Error && err.name === 'AbortError') {
      throw new FollowNodePullError({
        message: '请求超时',
        postsUrl,
        tokenRetry,
      });
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** 向被关注节点的 Worker B 申请粉丝 Token（Cron 拉 Feed 用，无浏览器缓存）。 */
async function fetchRemoteFollowerToken(
  env: Env,
  targetWorkerBUrl: string,
  followerNodeUrl: string,
  followerHandle?: string,
  readMutualProof?: ReadMutualProof,
  budget?: CronSubrequestBudget,
): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NODE_FETCH_TIMEOUT_MS);
  const base = resolveFollowFetchBaseUrl(targetWorkerBUrl);
  try {
    const body: Record<string, unknown> = {
      follower_node_url: stripTrailingSlash(followerNodeUrl),
    };
    if (followerHandle) {
      body.follower_handle = followerHandle;
    }
    if (readMutualProof) {
      body.read_mutual_proof = readMutualProof;
    }
    if (budget && !budget.take(1)) return null;
    const tokenUrl = resolveSafeOutboundPeerUrl(env, `${base}/api/follower-tokens`);
    if (!tokenUrl) return null;
    const res = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
      redirect: 'manual',
    });
    if (isManualRedirectStatus(res.status)) return null;
    if (res.ok) {
      const json = await res.json() as { ok?: boolean; data?: { token?: string } };
      const token = json.ok && typeof json.data?.token === 'string' ? json.data.token : '';
      return token || null;
    }
    // mutual-only：首次无 proof 会 403，生成证明后重试一次
    if (!readMutualProof && res.status === 403) {
      let errorCode = '';
      try {
        const errJson = await res.json() as { error_code?: string };
        errorCode = typeof errJson.error_code === 'string' ? errJson.error_code : '';
      } catch {
        errorCode = '';
      }
      if (errorCode === 'NOT_MUTUAL_FOLLOW') {
        const proof = await buildReadMutualProofForOwner(env, base);
        if (proof) {
          return fetchRemoteFollowerToken(
            env,
            targetWorkerBUrl,
            followerNodeUrl,
            followerHandle,
            proof,
            budget,
          );
        }
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 当前 UTC ISO 8601 字符串。 */
function isoNow(): string {
  return new Date().toISOString();
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function buildRegistryOfficialFeedPath(since: string): string {
  const query = new URLSearchParams();
  query.set('limit', String(REGISTRY_OFFICIAL_FEED_LIMIT));
  query.set('since', since);
  return `/api/posts/feed?${query.toString()}`;
}

function bootstrapOfficialSince(nowMs = Date.now()): string {
  return new Date(nowMs - REGISTRY_OFFICIAL_BOOTSTRAP_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

function stableHash(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function registryOfficialFeedJitterMs(env: Env): number {
  // 仅作抖动种子，非公开基址拼装；勿读 WORKER_B_URL（换域不应改变抖动相位依赖）
  const seed = env.BOOTSTRAP_HANDLE || env.REGISTRY_URL || 'hailuo';
  return stableHash(seed) % REGISTRY_OFFICIAL_FEED_JITTER_MS;
}

async function loadSystemConfigValue(env: Env, key: string): Promise<string | null> {
  // system_config → IDENTITY_DB（A-5）
  const row = await resolveIdentityDb(env)
    .prepare(`SELECT value FROM system_config WHERE key = ?`)
    .bind(key)
    .first<{ value: string }>();
  return row?.value ?? null;
}

async function shouldPullRegistryOfficialFeed(env: Env, now = new Date()): Promise<{
  shouldPull: boolean;
  nextCheckAt: string | null;
  reason: 'missing_last_checked' | 'invalid_last_checked' | 'due' | 'throttled';
}> {
  const lastChecked = await loadSystemConfigValue(env, 'registry_official_feed_last_checked_at');
  if (!lastChecked) {
    return { shouldPull: true, nextCheckAt: null, reason: 'missing_last_checked' };
  }

  const lastMs = Date.parse(lastChecked);
  if (!Number.isFinite(lastMs)) {
    return { shouldPull: true, nextCheckAt: null, reason: 'invalid_last_checked' };
  }

  // 中文注释：低频间隔 + 稳定错峰，避免成千上万节点在同一分钟同时拉官方公告。
  const nextMs = lastMs + REGISTRY_OFFICIAL_FEED_MIN_INTERVAL_MS + registryOfficialFeedJitterMs(env);
  if (now.getTime() >= nextMs) {
    return { shouldPull: true, nextCheckAt: new Date(nextMs).toISOString(), reason: 'due' };
  }
  return { shouldPull: false, nextCheckAt: new Date(nextMs).toISOString(), reason: 'throttled' };
}

async function writeRegistryOfficialFeedStatus(
  env: Env,
  values: Partial<Record<RegistryOfficialFeedStatusKey, string>>,
): Promise<void> {
  const updatedAt = isoNow();
  // system_config 在 IDENTITY_DB（A-2 §0090 汇总）。
  const identityDb = resolveIdentityDb(env);
  const batchStatements = Object.entries(values).map(([key, value]) =>
    identityDb
      .prepare(`INSERT OR REPLACE INTO system_config (key, value, updated_at) VALUES (?, ?, ?)`)
      .bind(key, value ?? '', updatedAt),
  );
  if (batchStatements.length === 0) return;

  try {
    await identityDb.batch(batchStatements);
  } catch (err) {
    // 诊断状态不能影响主 cron；失败只记日志，避免阻断关注节点聚合。
    console.warn('[cron/feed] 写入注册中心官方 feed 诊断状态失败', err);
  }
}

async function writeSystemConfigValues(env: Env, values: Record<string, string>): Promise<void> {
  const updatedAt = isoNow();
  // system_config 在 IDENTITY_DB（A-2 §0090 汇总）。
  const identityDb = resolveIdentityDb(env);
  const batchStatements = Object.entries(values).map(([key, value]) =>
    identityDb
      .prepare(`INSERT OR REPLACE INTO system_config (key, value, updated_at) VALUES (?, ?, ?)`)
      .bind(key, value, updatedAt),
  );
  if (batchStatements.length > 0) {
    await identityDb.batch(batchStatements);
  }
}

async function consumeManualOfficialPullQuota(env: Env, now = new Date()): Promise<{
  date: string;
  used: number;
  remaining: number;
}> {
  const date = now.toISOString().slice(0, 10);
  const keys = ['registry_official_manual_pull_date', 'registry_official_manual_pull_count'];
  // system_config → IDENTITY_DB（A-5）
  const rows = await resolveIdentityDb(env)
    .prepare(`SELECT key, value FROM system_config WHERE key IN (?, ?)`)
    .bind(...keys)
    .all<{ key: string; value: string }>();
  const map: Record<string, string> = {};
  for (const row of rows.results ?? []) {
    map[row.key] = row.value;
  }

  const oldCount = map.registry_official_manual_pull_date === date
    ? Number.parseInt(map.registry_official_manual_pull_count ?? '0', 10)
    : 0;
  const safeOldCount = Number.isFinite(oldCount) && oldCount > 0 ? oldCount : 0;
  if (safeOldCount >= REGISTRY_OFFICIAL_MANUAL_PULL_DAILY_LIMIT) {
    throw new RegistryOfficialManualPullLimitError(date, REGISTRY_OFFICIAL_MANUAL_PULL_DAILY_LIMIT);
  }

  const used = safeOldCount + 1;
  // 中文注释：手动拉取按“尝试次数”计数，失败也计入，避免反复点击压注册中心。
  await writeSystemConfigValues(env, {
    registry_official_manual_pull_date: date,
    registry_official_manual_pull_count: String(used),
  });
  return {
    date,
    used,
    remaining: Math.max(0, REGISTRY_OFFICIAL_MANUAL_PULL_DAILY_LIMIT - used),
  };
}

async function loadLatestOfficialPublishedAt(env: Env, sourceUrl: string): Promise<string | null> {
  // feed_cache → GOVERNANCE_DB（A-5）
  const row = await resolveGovernanceDb(env)
    .prepare(
      `SELECT MAX(created_at) AS latest
         FROM feed_cache
        WHERE node_url = ?`,
    )
    .bind(sourceUrl)
    .first<{ latest: string | null }>();
  return row?.latest ?? null;
}

async function resolveOfficialSince(env: Env, sourceUrl: string, nowMs = Date.now()): Promise<string> {
  const latest = await loadLatestOfficialPublishedAt(env, sourceUrl);
  if (!latest) return bootstrapOfficialSince(nowMs);

  const latestMs = Date.parse(latest);
  if (!Number.isFinite(latestMs) || latestMs > nowMs + REGISTRY_OFFICIAL_FUTURE_DRIFT_MS) {
    // 中文注释：缓存里若出现未来时间，继续拿它当 since 会导致永久拉不到历史公告。
    return bootstrapOfficialSince(nowMs);
  }

  return new Date(Math.max(0, latestMs - REGISTRY_OFFICIAL_SINCE_OVERLAP_MS)).toISOString();
}

/** M-DS-1：供 daily-sync 请求体计算 official_feed_since。 */
export async function resolveOfficialFeedSinceForSync(
  env: Env,
  sourceUrl: string,
  nowMs = Date.now(),
): Promise<string> {
  return resolveOfficialSince(env, sourceUrl, nowMs);
}

export type DailySyncOfficialFeedBlock = {
  unchanged?: boolean;
  items?: RegistryOfficialPost[];
  pagination?: { has_more?: boolean; next_since?: string | null };
  error_code?: string;
  message?: string;
};

/** M-DS-1：从 daily-sync official_feed 块写入 feed_cache。 */
export async function applyRegistryOfficialFeedFromDailySync(
  env: Env,
  sourceUrl: string,
  block: DailySyncOfficialFeedBlock,
): Promise<{ inserted_count: number; has_more: boolean; next_since: string | null }> {
  if (block.unchanged) {
    const now = isoNow();
    await writeRegistryOfficialFeedStatus(env, {
      registry_official_feed_last_status: 'ok',
      registry_official_feed_last_checked_at: now,
      registry_official_feed_last_source_url: sourceUrl,
      registry_official_feed_last_error: '',
    });
    return { inserted_count: 0, has_more: false, next_since: null };
  }

  const items = Array.isArray(block.items) ? block.items : [];
  const posts = items.map(mapRegistryOfficialPost);
  const now = isoNow();
  const inserted = await writeOfficialPostsAndRefreshLatest(env, sourceUrl, posts, now);
  await writeRegistryOfficialFeedStatus(env, {
    registry_official_feed_last_status: 'ok',
    registry_official_feed_last_checked_at: now,
    registry_official_feed_last_source_url: sourceUrl,
    registry_official_feed_last_fetched_count: String(posts.length),
    registry_official_feed_last_insert_count: String(inserted),
    registry_official_feed_last_error: '',
  });
  return {
    inserted_count: inserted,
    has_more: Boolean(block.pagination?.has_more),
    next_since: block.pagination?.next_since ?? null,
  };
}

/** M-DS-1：daily-sync 返回 has_more 时同日最多再追 N 页 GET /api/posts/feed。 */
export async function pullExtraRegistryOfficialFeedPages(
  env: Env,
  since: string,
  maxPages: number,
): Promise<void> {
  const primary = await resolvePrimaryRegistryEndpoint(env);
  const sourceUrl = stripTrailingSlash(primary?.registry_url ?? env.REGISTRY_URL);
  const targetRegistryId = primary?.registry_id;
  const posts: RemotePost[] = [];
  let cursor = since;

  for (let page = 0; page < maxPages; page++) {
    const path = buildRegistryOfficialFeedPath(cursor);
    const res = await registryFetch(env, path, { profile: 'cron', targetRegistryId });
    if (!res.ok) {
      throw new Error(`注册中心官方 feed 补拉 HTTP ${res.status}`);
    }
    const json = await res.json() as RegistryOfficialFeedResponse;
    if (!json.ok || !Array.isArray(json.data?.items)) {
      throw new Error('注册中心官方 feed 补拉响应格式异常');
    }
    const items = json.data.items;
    posts.push(...items.map(mapRegistryOfficialPost));
    const nextSince = json.data.pagination?.next_since ?? items[items.length - 1]?.published_at ?? cursor;
    if (!json.data.pagination?.has_more || items.length === 0 || !nextSince || nextSince === cursor) {
      break;
    }
    cursor = nextSince;
  }

  if (posts.length > 0) {
    const now = isoNow();
    const inserted = await writeOfficialPostsAndRefreshLatest(env, sourceUrl, posts, now);
    await writeRegistryOfficialFeedStatus(env, {
      registry_official_feed_last_status: 'ok',
      registry_official_feed_last_checked_at: now,
      registry_official_feed_last_source_url: sourceUrl,
      registry_official_feed_last_fetched_count: String(posts.length),
      registry_official_feed_last_insert_count: String(inserted),
      registry_official_feed_last_error: '',
    });
  }
}

function mapRegistryOfficialPost(post: RegistryOfficialPost): RemotePost {
  const title = post.title.trim();
  const body = post.body.trim();
  const content = [title, body].filter(Boolean).join('\n\n');
  const imageUrls = (post.images ?? [])
    .map((img) => img.url)
    .filter((url): url is string => typeof url === 'string' && url.length > 0);

  return {
    id: post.post_id,
    content,
    sig: '',
    image_urls: imageUrls,
    created_at: post.published_at,
    // 官方公告显式标记作者，避免前端从 registry host 派生占位
    author_handle: 'hailuo-registry',
  };
}

/**
 * 拉取注册中心官方公告。
 *
 * 官方 feed 是节点级鉴权接口，必须走 registryFetch 自动注入 node token + Ed25519 请求签名。
 * 本函数只返回可写入 feed_cache 的统一 RemotePost，不在内部写库。
 */
async function fetchRegistryOfficialPosts(env: Env): Promise<{ sourceUrl: string; posts: RemotePost[] }> {
  const primary = await resolvePrimaryRegistryEndpoint(env);
  const sourceUrl = stripTrailingSlash(primary?.registry_url ?? env.REGISTRY_URL);
  const targetRegistryId = primary?.registry_id;
  let since = await resolveOfficialSince(env, sourceUrl);

  const posts: RemotePost[] = [];
  for (let page = 0; page < REGISTRY_OFFICIAL_FEED_MAX_PAGES; page++) {
    const path = buildRegistryOfficialFeedPath(since);
    const res = await registryFetch(env, path, {
      profile: 'cron',
      targetRegistryId,
    });
    if (!res.ok) {
      let detail = '';
      try {
        const json = await res.json() as { error_code?: string; message?: string };
        detail = `${json.error_code ?? ''} ${json.message ?? ''}`.trim();
      } catch {
        detail = await res.text().catch(() => '');
      }
      throw new Error(`注册中心官方 feed HTTP ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`);
    }

    const json = await res.json() as RegistryOfficialFeedResponse;
    if (!json.ok || !Array.isArray(json.data?.items)) {
      throw new Error('注册中心官方 feed 响应格式异常');
    }

    const items = json.data.items;
    posts.push(...items.map(mapRegistryOfficialPost));

    const nextSince: string = json.data.pagination?.next_since ?? items[items.length - 1]?.published_at ?? since;
    if (!json.data.pagination?.has_more || items.length === 0 || !nextSince || nextSince === since) {
      break;
    }
    since = nextSince;
  }

  return { sourceUrl, posts };
}

export async function readRegistryOfficialFeedDiagnostics(env: Env): Promise<{
  registry_url: string;
  node_credentials_configured: boolean;
  node_signature_configured: boolean;
  last_status: string | null;
  last_checked_at: string | null;
  last_source_url: string | null;
  last_fetched_count: number;
  last_insert_count: number;
  last_error: string | null;
  cached_official_count: number;
  latest_official_created_at: string | null;
}> {
  const sourceUrl = await resolvePrimaryRegistryUrl(env);
  const statusKeys = [...REGISTRY_OFFICIAL_FEED_STATUS_KEYS, 'node_api_token', 'owner_user_id'];
  const placeholders = statusKeys.map(() => '?').join(', ');
  // system_config → IDENTITY；feed_cache → GOVERNANCE（A-5）
  const identityDb = resolveIdentityDb(env);
  const governanceDb = resolveGovernanceDb(env);
  const configResult = await identityDb
    .prepare(`SELECT key, value FROM system_config WHERE key IN (${placeholders})`)
    .bind(...statusKeys)
    .all<{ key: string; value: string }>();
  const config: Record<string, string> = {};
  for (const row of configResult.results ?? []) {
    config[row.key] = row.value;
  }

  const cacheRow = await governanceDb
    .prepare(
      `SELECT COUNT(*) AS count, MAX(created_at) AS latest
         FROM feed_cache
        WHERE node_url = ?`,
    )
    .bind(sourceUrl)
    .first<{ count: number; latest: string | null }>();

  return {
    registry_url: sourceUrl,
    node_credentials_configured: Boolean(config.node_api_token && config.owner_user_id),
    node_signature_configured: Boolean(env.ED25519_PRIVATE_KEY && env.ED25519_PUBLIC_KEY),
    last_status: config.registry_official_feed_last_status ?? null,
    last_checked_at: config.registry_official_feed_last_checked_at ?? null,
    last_source_url: config.registry_official_feed_last_source_url ?? null,
    last_fetched_count: Number(config.registry_official_feed_last_fetched_count ?? 0),
    last_insert_count: Number(config.registry_official_feed_last_insert_count ?? 0),
    last_error: config.registry_official_feed_last_error ?? null,
    cached_official_count: Number(cacheRow?.count ?? 0),
    latest_official_created_at: cacheRow?.latest ?? null,
  };
}

/** M9-1-4：转发引用序列化为 feed_cache.repost_of_json */
function serializeRepostOfJson(
  repostOf: RemotePost['repost_of'],
): string | null {
  if (!repostOf?.node_url || !repostOf?.post_id) return null;
  return JSON.stringify({
    node_url: repostOf.node_url,
    post_id: repostOf.post_id,
    author_handle: repostOf.author_handle?.trim() || 'unknown',
  });
}

export function prepareFeedCacheUpsert(
  env: Env,
  sourceUrl: string,
  post: RemotePost,
  fetchedAt: string,
  authorHandle?: string | null,
): D1PreparedStatement {
  const cacheId = `${sourceUrl}#${post.id}`;
  const postKind = post.post_kind === 'repost' ? 'repost' : 'original';
  const repostOfJson = postKind === 'repost' ? serializeRepostOfJson(post.repost_of) : null;
  return resolveGovernanceDb(env)
    .prepare(
      `INSERT OR REPLACE INTO feed_cache
         (id, node_url, content, sig, image_urls, post_id, created_at, fetched_at, author_handle,
          post_kind, repost_of_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      cacheId,
      sourceUrl,
      post.content,
      post.sig ?? '',
      JSON.stringify(post.image_urls ?? []),
      post.id,
      post.created_at,
      fetchedAt,
      // 关注行显式 handle 优先（用户填的“关注对象”）；URL 关注没有 handle 时用远端帖子作者，
      // 避免前端回落到节点域名占位。
      authorHandle?.trim() || post.author_handle?.trim() || null,
      postKind,
      repostOfJson,
    );
}

/**
 * M13-8：按 post_id diff 清理该节点陈旧缓存（替代每轮 DELETE 整节点）。
 * 拉取 0 条时仍清空该 node_url，与旧「先删后写」语义一致。
 */
export function prepareFeedCacheAbsentPostIdsDelete(
  env: Env,
  nodeUrl: string,
  postIds: readonly string[],
): D1PreparedStatement {
  const governanceDb = resolveGovernanceDb(env);
  if (postIds.length === 0) {
    return governanceDb.prepare(`DELETE FROM feed_cache WHERE node_url = ?`).bind(nodeUrl);
  }
  const placeholders = postIds.map(() => '?').join(', ');
  return governanceDb
    .prepare(
      `DELETE FROM feed_cache WHERE node_url = ? AND post_id NOT IN (${placeholders})`,
    )
    .bind(nodeUrl, ...postIds);
}

async function writeOfficialPostsAndRefreshLatest(
  env: Env,
  officialSourceUrl: string,
  officialPosts: RemotePost[],
  fetchedAt: string,
): Promise<number> {
  const batchStatements = officialPosts.map((post) =>
    prepareFeedCacheUpsert(env, officialSourceUrl, post, fetchedAt),
  );
  if (batchStatements.length > 0) {
    await resolveGovernanceDb(env).batch(batchStatements);
  }
  await refreshLatestFeedKv(env);
  return batchStatements.length;
}

/** NCF-2A：返回 kvPublish 状态；失败不抛、不假装 ok。 */
export async function refreshLatestFeedKv(
  env: Env,
  partialFailedCount = 0,
  options?: { priority?: 'security' | 'normal' },
): Promise<'skipped' | 'ok' | 'failed' | 'budget_deferred'> {
  try {
    // feed_cache → GOVERNANCE_DB（A-5）
    const feedResult = await resolveGovernanceDb(env)
      .prepare(
        `SELECT id, node_url, content, sig, image_urls, post_id, created_at, author_handle,
                post_kind, repost_of_json
           FROM feed_cache
          ORDER BY created_at DESC
          LIMIT 50`,
      )
      .all<{
        id: string;
        node_url: string;
        content: string;
        sig: string;
        image_urls: string;
        post_id: string;
        created_at: string;
        author_handle: string | null;
        post_kind: string;
        repost_of_json: string | null;
      }>();
    const feedRows = (feedResult.results ?? []).map((row) => ({
      ...row,
      ...(row.author_handle ? { author_handle: row.author_handle } : {}),
      ...(row.post_kind === 'repost' && row.repost_of_json
        ? { post_kind: 'repost' as const, repost_of_json: row.repost_of_json }
        : {}),
    }));

    // M13-16：先指纹探测；仅在将实际 put 时占预算（未变 → 0 put、不占额）
    const probe = await putFeedLatestWithMeta(env, feedRows, partialFailedCount, {
      dryRunFingerprintOnly: true,
    });
    if (probe.skippedUnchanged) {
      console.log('[cron/feed] feed:latest 内容未变，跳过 KV put');
      return 'skipped';
    }

    const priority = options?.priority ?? 'normal';
    const budget = await tryConsumeNonSecurityCachePuts(
      resolveIdentityDb(env),
      env,
      1,
      { priority },
    );
    if (!budget.allowed) {
      console.log(
        `[cron/feed] 非安全缓存预算不足，推迟 feed:latest（used=${budget.used}/${budget.limit} day=${budget.day} reason=${budget.reason}）`,
      );
      // 可慢不可停：置 dirty，额度恢复后由 refreshFeedLatestIfDirty / 下轮聚合补刷
      try {
        const now = new Date().toISOString();
        await resolveIdentityDb(env)
          .prepare(
            `INSERT OR REPLACE INTO system_config (key, value, updated_at) VALUES ('feed_latest_dirty', 'true', ?)`,
          )
          .bind(now)
          .run();
      } catch (err) {
        console.warn('[cron/feed] 预算推迟后置 feed_latest_dirty 失败（下轮仍会再试）', err);
      }
      return 'budget_deferred';
    }

    const kvResult = await putFeedLatestWithMeta(env, feedRows, partialFailedCount);
    if (kvResult.skippedUnchanged) {
      // 竞态：占额后内容又被写成相同——可接受（少见）；额度已扣不回滚（保守）
      console.log('[cron/feed] feed:latest 内容未变，跳过 KV put');
      return 'skipped';
    }
    return 'ok';
  } catch (err) {
    console.error('[cron/feed] 写 KV feed:latest 失败', err);
    return 'failed';
  }
}

export async function pullRegistryOfficialFeedNow(env: Env): Promise<{
  fetched_count: number;
  inserted_count: number;
  remaining_today: number;
  quota_date: string;
}> {
  const quota = await consumeManualOfficialPullQuota(env);
  let officialSourceUrl = await resolvePrimaryRegistryUrl(env);
  let officialPosts: RemotePost[] = [];

  await writeOperationLog(env, {
    source: 'worker-a',
    level: 'info',
    event: 'registry_feed_manual_pull_start',
    message: '站主手动拉取注册中心官方公告',
    details: {
      registry_url: officialSourceUrl,
      quota_date: quota.date,
      remaining_today: quota.remaining,
    },
  });

  try {
    const official = await fetchRegistryOfficialPosts(env);
    officialSourceUrl = official.sourceUrl;
    officialPosts = official.posts;
    const now = isoNow();
    const officialInsertCount = await writeOfficialPostsAndRefreshLatest(
      env,
      officialSourceUrl,
      officialPosts,
      now,
    );

    await writeOperationLog(env, {
      source: 'worker-a',
      level: 'info',
      event: 'registry_feed_manual_pull_ok',
      message: `手动拉取注册中心官方公告完成：${officialInsertCount} 条`,
      details: {
        official_source_url: officialSourceUrl,
        fetched_count: officialPosts.length,
        inserted_count: officialInsertCount,
        remaining_today: quota.remaining,
      },
    });
    await writeRegistryOfficialFeedStatus(env, {
      registry_official_feed_last_status: 'ok',
      registry_official_feed_last_checked_at: now,
      registry_official_feed_last_source_url: officialSourceUrl,
      registry_official_feed_last_fetched_count: String(officialPosts.length),
      registry_official_feed_last_insert_count: String(officialInsertCount),
      registry_official_feed_last_error: '',
    });

    return {
      fetched_count: officialPosts.length,
      inserted_count: officialInsertCount,
      remaining_today: quota.remaining,
      quota_date: quota.date,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await writeOperationLog(env, {
      source: 'worker-a',
      level: 'warn',
      event: 'registry_feed_manual_pull_failed',
      message,
      details: {
        official_source_url: officialSourceUrl,
        fetched_count: officialPosts.length,
        remaining_today: quota.remaining,
      },
    });
    await writeRegistryOfficialFeedStatus(env, {
      registry_official_feed_last_status: 'failed',
      registry_official_feed_last_checked_at: isoNow(),
      registry_official_feed_last_source_url: officialSourceUrl,
      registry_official_feed_last_fetched_count: String(officialPosts.length),
      registry_official_feed_last_insert_count: '0',
      registry_official_feed_last_error: message.slice(0, 500),
    });
    throw err;
  }
}

export async function pullRegistryOfficialFeedAfterRegistration(env: Env): Promise<{
  fetched_count: number;
  inserted_count: number;
}> {
  let officialSourceUrl = await resolvePrimaryRegistryUrl(env);
  let officialPosts: RemotePost[] = [];

  await writeOperationLog(env, {
    source: 'worker-a',
    level: 'info',
    event: 'registry_feed_registration_pull_start',
    message: '注册完成后自动拉取一次注册中心官方公告',
    details: { registry_url: officialSourceUrl },
  });

  try {
    const official = await fetchRegistryOfficialPosts(env);
    officialSourceUrl = official.sourceUrl;
    officialPosts = official.posts;
    const now = isoNow();
    const officialInsertCount = await writeOfficialPostsAndRefreshLatest(
      env,
      officialSourceUrl,
      officialPosts,
      now,
    );

    await writeOperationLog(env, {
      source: 'worker-a',
      level: 'info',
      event: 'registry_feed_registration_pull_ok',
      message: `注册完成后官方公告拉取完成：${officialInsertCount} 条`,
      details: {
        official_source_url: officialSourceUrl,
        fetched_count: officialPosts.length,
        inserted_count: officialInsertCount,
      },
    });
    await writeRegistryOfficialFeedStatus(env, {
      registry_official_feed_last_status: 'ok',
      registry_official_feed_last_checked_at: now,
      registry_official_feed_last_source_url: officialSourceUrl,
      registry_official_feed_last_fetched_count: String(officialPosts.length),
      registry_official_feed_last_insert_count: String(officialInsertCount),
      registry_official_feed_last_error: '',
    });

    return {
      fetched_count: officialPosts.length,
      inserted_count: officialInsertCount,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await writeOperationLog(env, {
      source: 'worker-a',
      level: 'warn',
      event: 'registry_feed_registration_pull_failed',
      message,
      details: {
        official_source_url: officialSourceUrl,
        fetched_count: officialPosts.length,
      },
    });
    await writeRegistryOfficialFeedStatus(env, {
      registry_official_feed_last_status: 'failed',
      registry_official_feed_last_checked_at: isoNow(),
      registry_official_feed_last_source_url: officialSourceUrl,
      registry_official_feed_last_fetched_count: String(officialPosts.length),
      registry_official_feed_last_insert_count: '0',
      registry_official_feed_last_error: message.slice(0, 500),
    });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// M4-3 + M4-4：fetchAndAggregateFeed — 兼容出口（实现已迁 NCF-2A 深模块）
// ---------------------------------------------------------------------------

/**
 * 兼容旧调用点（如 follows 手动刷新）。
 * 唯一实现：services/feed runScheduledInvocation → runFeedAggregation。
 * 使用动态 import，避免 feedFetch ↔ production adapter 静态环依赖。
 */
export async function fetchAndAggregateFeed(env: Env): Promise<void> {
  const { runScheduledInvocation } = await import('../services/feed/runScheduledInvocation');
  await runScheduledInvocation(env);
}

/** 站主手动探测各关注节点 GET /posts（与 Cron 同路径），不写 feed_cache。 */
export async function probeFollowNodePulls(env: Env): Promise<{
  items: Array<{
    fetch_url: string;
    posts_url: string;
    ok: boolean;
    post_count: number;
    error: string | null;
    http_status: number | null;
    response_url: string | null;
    body_snippet: string | null;
    token_retry: boolean;
  }>;
}> {
  // follows → IDENTITY_DB（A-5）
  const result = await resolveIdentityDb(env)
    .prepare(
      `SELECT COALESCE(NULLIF(followed_worker_b_url, ''), follower_node_url) AS fetch_url
         FROM follows
        ORDER BY last_active DESC
        LIMIT 40`,
    )
    .all<{ fetch_url: string }>();
  const rows = result.results ?? [];

  let ownerHandle = '';
  try {
    // users 表在 IDENTITY_DB（A-2 §0001）。
    const ownerRow = await resolveIdentityDb(env).prepare('SELECT handle FROM users LIMIT 1').first<{ handle: string }>();
    ownerHandle = ownerRow?.handle?.trim() ?? '';
  } catch {
    ownerHandle = '';
  }

  const followerNodeUrl = await resolveLocalPublicBaseUrl(env);
  const items = await Promise.all(
    rows.map(async (row) => {
      const postsUrl = `${resolveFollowFetchBaseUrl(row.fetch_url)}/posts?limit=20`;
      try {
        const posts = await fetchNodePosts(env, row.fetch_url, {
          followerNodeUrl,
          followerHandle: ownerHandle || undefined,
        });
        return {
          fetch_url: row.fetch_url,
          posts_url: postsUrl,
          ok: true,
          post_count: posts.posts.length,
          error: null,
          http_status: 200,
          response_url: postsUrl,
          body_snippet: null,
          token_retry: false,
        };
      } catch (err) {
        const pullErr = err instanceof FollowNodePullError ? err : null;
        return {
          fetch_url: row.fetch_url,
          posts_url: pullErr?.postsUrl ?? postsUrl,
          ok: false,
          post_count: 0,
          error: err instanceof Error ? err.message : String(err),
          http_status: pullErr?.httpStatus ?? null,
          response_url: pullErr?.responseUrl ?? null,
          body_snippet: pullErr?.bodySnippet ?? null,
          token_retry: pullErr?.tokenRetry ?? false,
        };
      }
    }),
  );

  return { items };
}

// M9-15：gcFeedCache — 整点 GC（水位感知 retention + 分片 DELETE）
// ---------------------------------------------------------------------------

/**
 * 清理过期 feed_cache 条目（按水位动态 retention + 分片 DELETE）。
 *
 * fail-soft：失败只记日志，不抛出。
 */
export async function gcFeedCache(env: Env): Promise<void> {
  try {
    // feed_cache → GOVERNANCE_DB（A-5）；gc helper 仍收 D1Database
    const result = await gcFeedCacheWithWaterLevel(resolveGovernanceDb(env));
    console.log(
      `[cron/gc] gcFeedCache 完成 tier=${result.tier} rows=${result.rowCount} bytes=${result.bytes} deleted=${result.deleted} retentionMs=${result.retentionMs}`,
    );
  } catch (err) {
    console.error('[cron/gc] feed_cache GC 失败', err);
  }
}
