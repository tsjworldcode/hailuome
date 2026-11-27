/**
 * M17 · 加好友频控（origin 端 + 跨节点 inbox 双窗口）
 *
 * 计划 §九.2 定稿限额：
 *   - 发起方：20 次/小时/节点 + 100 次/天/节点
 *   - 跨节点 inbox：100 次/小时/源节点
 *
 * ## M17-FIX-2 改造（修 P0-2）
 *
 * 原实现用 `INSERT ... ON CONFLICT DO UPDATE SET count = count + 1 WHERE count < ?`，
 * **D1/SQLite 实测 WHERE 子句被忽略**（Indexed ON CONFLICT WHERE 不被 SQLite 引擎支持），
 * 导致频控形同虚设：origin 端每分钟可发无限次请求。
 *
 * 现改两步法（plan §四.2.2）：
 *   1. SELECT count 读当前桶值
 *   2. 若已达上限 → return false（拒）
 *   3. 否则 UPSERT count = count + 1（**无** WHERE 子句，SQLite 100% 兼容）
 *   4. 二次 SELECT count 校验；若 race 致 >maxCount → 回滚 -1 + return false
 *
 * race 边界：两个并发请求都读到 count < maxCount，都 +1，最终可能 count = maxCount + 1；
 * 二次校验拦下其中一个回滚 -1，**最终 count 不会超过 maxCount**。
 * 最坏情况下有 1 个并发误通过（D1 单 isolate 顺序执行，race 极小）。
 *
 * ## fail-open 兜底
 *
 * 表缺失 / D1 异常 → 不阻断主流程，按 plan §9.3 + §6.4 默认策略放行。
 */

import type { Env } from '../env.d';
import { resolveGovernanceDb } from '../db/bindings';

// ---- 限额常量（计划 §九.2） ---------------------------------------------

/** origin 端每小时发起上限（含本地 + 跨节点） */
export const FRIEND_REQUEST_ORIGIN_RATE_PER_HOUR = 20;

/** origin 端每天发起上限 */
export const FRIEND_REQUEST_ORIGIN_RATE_PER_DAY = 100;

/** 跨节点 inbox 每小时每源节点上限（M17-1c inbox lib 复用） */
export const FRIEND_REQUEST_INBOX_RATE_PER_HOUR = 100;

// ---- 窗口键 + 时间桶 helper --------------------------------------------

/**
 * 频控 bucket_key 前缀区分：
 *   - origin:<node_url>:<window>          发起方（按本节点公开基址）
 *   - inbox:<source_node_url>:<window>    跨节点 inbox（按源节点公开基址）
 * 复用 `dmRateBucketKey` 拼接模式但独立命名空间，避免后续与 DM 频控耦合。
 */
export function friendRequestRateBucketKey(
  scope: 'origin' | 'inbox',
  nodeUrl: string,
  window: string,
): string {
  return `${scope}:${nodeUrl}:${window}`;
}

/** 小时桶（UTC 整点 ISO 字符串）。 */
export function currentHourBucketIso(): string {
  const d = new Date();
  d.setUTCMinutes(0, 0, 0);
  return d.toISOString();
}

/** 天桶（UTC 整天 YYYY-MM-DD）。 */
export function currentDayBucketIso(): string {
  return new Date().toISOString().slice(0, 10);
}

// ---- 通用两步法 helper（plan §四.2.2） ----------------------------------

/**
 * 检查并递增单窗口计数。返回 true = 通过；false = 已达上限或 race 边界被拦下。
 *
 * 三步：
 *   1. SELECT count 预检：已 ≥ maxCount 直接 false（避免 +1 后再回滚）
 *   2. UPSERT count + 1（无 WHERE 子句，SQLite 100% 兼容）
 *   3. SELECT count 二次校验：>maxCount → 回滚 -1 + false（race 兜底）
 */
async function checkAndIncrementBucket(
  env: Env,
  bucketKey: string,
  windowIso: string,
  maxCount: number,
): Promise<boolean> {
  const governanceDb = resolveGovernanceDb(env);
  // 步骤 1：预检当前计数（未达上限才 +1）
  const current = await governanceDb
    .prepare(
      `SELECT count FROM friend_request_rate_buckets WHERE bucket_key = ?`,
    )
    .bind(bucketKey)
    .first<{ count: number }>()
    .catch(() => null);

  if (current && (current.count ?? 0) >= maxCount) {
    return false;
  }

  // 步骤 2：UPSERT +1（无 WHERE 子句，SQLite/D1 100% 兼容）
  await governanceDb
    .prepare(
      `INSERT INTO friend_request_rate_buckets (bucket_key, count, window_start)
       VALUES (?, 1, ?)
       ON CONFLICT (bucket_key) DO UPDATE
       SET count = friend_request_rate_buckets.count + 1`,
    )
    .bind(bucketKey, windowIso)
    .run()
    .catch((err: unknown) => {
      // 抛出供外层 catch（避免静默吞掉"表不存在"以外的异常）
      throw err;
    });

  // 步骤 3：二次校验（race 兜底）
  const after = await governanceDb
    .prepare(
      `SELECT count FROM friend_request_rate_buckets WHERE bucket_key = ?`,
    )
    .bind(bucketKey)
    .first<{ count: number }>()
    .catch(() => null);

  const afterCount = after?.count ?? 0;
  if (afterCount > maxCount) {
    // race 边界：超过上限 → 回滚 -1
    await governanceDb
      .prepare(
        `UPDATE friend_request_rate_buckets
            SET count = MAX(0, count - 1)
          WHERE bucket_key = ?`,
      )
      .bind(bucketKey)
      .run()
      .catch(() => null);
    return false;
  }

  return true;
}

// ---- 三个公开入口 ------------------------------------------------------

/**
 * 检查并递增 origin 端双窗口计数（小时 + 天）。
 * 返回 true = 通过；false = 任一窗口已达上限。
 *
 * 任一窗口被拒则回滚另一窗口的 +1（应用层补偿；两步法之间用顺序 D1 调用）。
 * 即使回滚失败，下次 hour/day 窗口翻篇也会自然恢复；不阻断主流程。
 */
export async function checkAndIncrementFriendRequestOriginRate(
  env: Env,
  originNodeUrl: string,
): Promise<boolean> {
  const windowHour = currentHourBucketIso();
  const windowDay = currentDayBucketIso();
  const hourKey = friendRequestRateBucketKey('origin', originNodeUrl, windowHour);
  const dayKey = friendRequestRateBucketKey('origin', originNodeUrl, windowDay);

  try {
    // 小时窗：限 FRIEND_REQUEST_ORIGIN_RATE_PER_HOUR
    const hourPass = await checkAndIncrementBucket(
      env,
      hourKey,
      windowHour,
      FRIEND_REQUEST_ORIGIN_RATE_PER_HOUR,
    );
    if (!hourPass) {
      return false;
    }

    // 天窗：限 FRIEND_REQUEST_ORIGIN_RATE_PER_DAY
    const dayPass = await checkAndIncrementBucket(
      env,
      dayKey,
      windowDay,
      FRIEND_REQUEST_ORIGIN_RATE_PER_DAY,
    );
    if (!dayPass) {
      // 天窗拒：回滚小时窗的 +1（应用层补偿）
      await resolveGovernanceDb(env)
        .prepare(
          `UPDATE friend_request_rate_buckets
              SET count = MAX(0, count - 1)
            WHERE bucket_key = ?`,
        )
        .bind(hourKey)
        .run()
        .catch(() => null);
      return false;
    }

    return true;
  } catch (err) {
    // 表不存在 / D1 异常 → fail-open（plan §9.3 + §6.4 默认策略：表未就绪不阻断）
    console.warn('[friendRequestRateLimit] 频控表读取失败，按 fail-open 放行', err);
    return true;
  }
}

/**
 * 跨节点 inbox 频控（M17-1c inbox lib 复用）。
 * 仅小时窗口；来源节点维度计数。
 */
export async function checkAndIncrementFriendRequestInboxRate(
  env: Env,
  sourceNodeUrl: string,
): Promise<boolean> {
  const windowHour = currentHourBucketIso();
  const bucketKey = friendRequestRateBucketKey('inbox', sourceNodeUrl, windowHour);

  try {
    return await checkAndIncrementBucket(
      env,
      bucketKey,
      windowHour,
      FRIEND_REQUEST_INBOX_RATE_PER_HOUR,
    );
  } catch (err) {
    console.warn('[friendRequestRateLimit] inbox 频控失败，按 fail-open 放行', err);
    return true;
  }
}
