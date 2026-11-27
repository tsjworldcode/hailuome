/**
 * M32-2 / M-OPT-0e：近 30 天活跃度本地 D1 聚合，供 daily-sync `activity_summary` 自报。
 *
 * M-OPT-SPLIT-A6-5：按表真切三库
 *   - users.worker_b_url → resolveIdentityDb
 *   - posts COUNT / earliest / latest → resolveContentDb
 *   - post_likes / post_replies → resolveGovernanceDb（单表 COUNT，禁止跨库 JOIN posts）
 *   - owner_login_events（成功登录）→ resolveIdentityDb
 * 语义：likes/replies 不再 JOIN posts 过滤已删帖，可能轻微高估（fail-soft，与 M32 一致）。
 * 防身份关联：只上报聚合整数，不上传 IP / UA。
 *
 * R-MSG-4a：ActivitySummary 接口已迁入 @hailuo/registry-protocol；build 函数保留本地。
 *
 * R-MSG-6a：ACTIVITY_SUMMARY_POST_URL_ENABLED（默认 true）关闭时，不上报 earliest_post_url / latest_post_url。
 * R-MSG-6b：registry 侧 ActivitySummary 类型已定义为可选字段，收到 null 时写 null。
 */
import { resolveContentDb, resolveGovernanceDb, resolveIdentityDb } from '../db/bindings';
import type { Env } from '../env';
import { normalizeWorkerBOrigin } from '@hailuo/shared-utils';
import type { ActivitySummary } from '@hailuo/registry-protocol';

export const ACTIVITY_SUMMARY_PERIOD_DAYS = 30;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MAX_POST_URL_LEN = 512;
/** 近 30 天站主成功登录次数上限（节点源端 cap，与 registry lib ACTIVITY_LOGIN_MAX 对齐防节点自报刷榜） */
export const ACTIVITY_LOGIN_MAX = 10_000;
/** R-MSG-6a：上报首/末帖 URL。默认 true（向后兼容）；关闭后 activity_summary 不含这两个字段。 */
const ACTIVITY_SUMMARY_POST_URL_ENABLED_DEFAULT = true;

// R-MSG-4a：ActivitySummary 类型已迁入 @hailuo/registry-protocol
// export interface ActivitySummary { ... }

/** Worker B 公开帖 URL：{https origin}/posts/{post_id} */
export function buildPublicPostUrl(origin: string, postId: string): string | null {
  const normalized = normalizeWorkerBOrigin(origin);
  if (!normalized.startsWith('https://')) return null;
  const id = postId.trim();
  if (!id) return null;
  const url = `${normalized}/posts/${id}`;
  if (url.length > MAX_POST_URL_LEN) return null;
  return url;
}

function isoNow(): string {
  return new Date().toISOString();
}

function sinceIsoForPeriod(now: Date, periodDays: number): string {
  return new Date(now.getTime() - periodDays * MS_PER_DAY).toISOString();
}

async function readWorkerBUrl(env: Env): Promise<string | null> {
  const identityDb = resolveIdentityDb(env);
  const row = await identityDb
    .prepare(`SELECT worker_b_url FROM users LIMIT 1`)
    .first<{ worker_b_url: string | null }>();
  const url = row?.worker_b_url?.trim() ?? '';
  if (!url) return null;
  const normalized = normalizeWorkerBOrigin(url);
  if (!normalized.startsWith('https://')) return null;
  return normalized;
}

/**
 * 从本地 D1 聚合活跃度；失败或缺 worker_b_url 时返回 null（fail-soft，不阻断 daily-sync）。
 */
export async function buildActivitySummary(env: Env, now = new Date()): Promise<ActivitySummary | null> {
  try {
    const workerBOrigin = await readWorkerBUrl(env);
    if (!workerBOrigin) return null;

    const sinceIso = sinceIsoForPeriod(now, ACTIVITY_SUMMARY_PERIOD_DAYS);
    const contentDb = resolveContentDb(env);
    const governanceDb = resolveGovernanceDb(env);
    const identityDb = resolveIdentityDb(env);

    const postsRow = await contentDb
      .prepare(
        `SELECT COUNT(*) AS posts_count
         FROM posts
         WHERE deleted_at IS NULL AND created_at >= ?1`,
      )
      .bind(sinceIso)
      .first<{ posts_count: number }>();

    const postsCount = Number(postsRow?.posts_count ?? 0);
    if (!Number.isFinite(postsCount) || postsCount < 0) return null;

    // A-6-5：禁跨库 JOIN posts；单表 COUNT，可能含已删帖上的互动（轻微高估）
    const likesRow = await governanceDb
      .prepare(
        `SELECT COUNT(*) AS likes_count
         FROM post_likes
         WHERE created_at >= ?1`,
      )
      .bind(sinceIso)
      .first<{ likes_count: number }>();

    const repliesRow = await governanceDb
      .prepare(
        `SELECT COUNT(*) AS replies_count
         FROM post_replies
         WHERE deleted_at IS NULL
           AND created_at >= ?1`,
      )
      .bind(sinceIso)
      .first<{ replies_count: number }>();

    // M-OPT-0e：只计成功登录；不读 ip_hash / UA（防身份关联）
    const loginRow = await identityDb
      .prepare(
        `SELECT COUNT(*) AS login_count
         FROM owner_login_events
         WHERE success = 1 AND logged_in_at >= ?1`,
      )
      .bind(sinceIso)
      .first<{ login_count: number }>();

    const likesCount = Number(likesRow?.likes_count ?? 0);
    const repliesCount = Number(repliesRow?.replies_count ?? 0);
    const loginCount = Number(loginRow?.login_count ?? 0);
    if (!Number.isFinite(likesCount) || likesCount < 0) return null;
    if (!Number.isFinite(repliesCount) || repliesCount < 0) return null;
    if (!Number.isFinite(loginCount) || loginCount < 0) return null;

    const summary: ActivitySummary = {
      period_days: ACTIVITY_SUMMARY_PERIOD_DAYS,
      posts_count: Math.floor(postsCount),
      likes_count: Math.floor(likesCount),
      replies_count: Math.floor(repliesCount),
      // 节点源端 cap：登录计数 >10K 时截到 10K（与 registry lib ACTIVITY_LOGIN_MAX 对齐；
      // 防节点 owner_login_events 表被自填异常值后冲榜；registry parseAndValidateActivitySummary
      // 仍兜底拒绝 >10K，故本 cap 是 fail-soft 防 UI 评分异常）。
      login_count: Math.min(Math.floor(loginCount), ACTIVITY_LOGIN_MAX),
      computed_at: isoNow(),
    };

    // R-MSG-6a：ACTIVITY_SUMMARY_POST_URL_ENABLED（默认 true）关闭时，不上报 URL
    const postUrlEnabled = env.ACTIVITY_SUMMARY_POST_URL_ENABLED !== 'false' &&
      env.ACTIVITY_SUMMARY_POST_URL_ENABLED !== '0';

    if (postUrlEnabled && summary.posts_count > 0) {
      const earliest = await contentDb
        .prepare(
          `SELECT id FROM posts
           WHERE deleted_at IS NULL AND created_at >= ?1
           ORDER BY created_at ASC LIMIT 1`,
        )
        .bind(sinceIso)
        .first<{ id: string }>();

      const latest = await contentDb
        .prepare(
          `SELECT id FROM posts
           WHERE deleted_at IS NULL AND created_at >= ?1
           ORDER BY created_at DESC LIMIT 1`,
        )
        .bind(sinceIso)
        .first<{ id: string }>();

      const earliestUrl = earliest?.id
        ? buildPublicPostUrl(workerBOrigin, earliest.id)
        : null;
      const latestUrl = latest?.id
        ? buildPublicPostUrl(workerBOrigin, latest.id)
        : null;

      if (!earliestUrl || !latestUrl) {
        console.error('[activity-summary] posts_count>0 但无法拼装公开帖 URL');
        return null;
      }

      summary.earliest_post_url = earliestUrl;
      summary.latest_post_url = latestUrl;
    }
    // 开关关闭时：posts_count 等聚合字段正常返回，但 URL 字段不出现在对象里（?: 可选属性）

    return summary;
  } catch (err) {
    console.error('[activity-summary] D1 聚合失败', err);
    return null;
  }
}
