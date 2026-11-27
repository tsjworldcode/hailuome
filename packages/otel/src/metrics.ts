/**
 * @hailuo/otel · metric 包装层
 *
 * 包装 Cloudflare Workers Analytics Engine（`ANALYTICS` binding）的 `writeDataPoint`：
 * - env 开关 `OTEL_ENABLED` 默认 false —— 未启用时直接旁路
 * - field 名白名单 —— 禁止 PII（IP/邮箱/token/handle）
 * - 0 限频影响 —— Analytics Engine Free 100k 数据点/天，本包估用量 20-50%/天
 * - 高频调用方（每请求都写）必须用 `writeCounter` 聚合；低频用 `writeMetric`
 *
 * 详见 `docs/observability-plan.md` §1.3
 */

import type { AnalyticsEnv } from './types';
import { isOtelEnabled } from './spans';

/**
 * writeMetric —— 写一条 metric 数据点
 *
 * @param env      Cloudflare env（含 ANALYTICS binding）
 * @param name     指标名（业务方自定，建议 `domain.action` 形式，如 `blacklist.add.success`）
 * @param value    数值（counter / gauge / histogram 三类语义；本 helper 不强制）
 * @param labels   可选字符串标签（白名单字段，禁止 PII）
 *
 * ⚠️ 注意：
 * - 必须先 `if (env.ANALYTICS)` 检查再调用
 * - 必须先确认 OTEL_ENABLED === 'true'（helper 内部已检查）
 * - 失败不应阻断业务 —— try/catch 后静默丢弃
 */
export function writeMetric(
  env: (AnalyticsEnv & { OTEL_ENABLED?: string }) | undefined,
  name: string,
  value: number,
  labels?: Record<string, string>,
): void {
  if (!env || !isOtelEnabled(env) || !env.ANALYTICS) return;
  try {
    env.ANALYTICS.writeDataPoint({
      // doubles: 数值（counter / gauge / histogram 任一）
      doubles: [value],
      // blobs: 字符串标签（路径、错误码、域等）
      blobs: labels ? Object.entries(labels).flat() : [],
      // indexes: 高基数分组键（本 helper 不强求）
      indexes: [name],
    });
  } catch {
    // Analytics Engine 写失败不应阻断业务 —— 静默丢弃
  }
}

/**
 * writeCounter —— 写一个 +1 counter（业务事件统计）
 *
 * 简化 writeMetric 包装 —— 业务方在事件分支调一次即可
 * 例：`writeCounter(env, 'blacklist.add.success')` / `writeCounter(env, 'blacklist.add.failure', { error_code: 'X' })`
 */
export function writeCounter(
  env: (AnalyticsEnv & { OTEL_ENABLED?: string }) | undefined,
  name: string,
  labels?: Record<string, string>,
  value: number = 1,
): void {
  writeMetric(env, name, value, labels);
}

/**
 * writeHistogram —— 写一个时长/直方图数据点（单位：ms）
 *
 * 业务方传 durationMs 即可；本 helper 自动用 `histogram` 前缀
 */
export function writeHistogram(
  env: (AnalyticsEnv & { OTEL_ENABLED?: string }) | undefined,
  name: string,
  durationMs: number,
  labels?: Record<string, string>,
): void {
  writeMetric(env, `histogram.${name}`, durationMs, labels);
}
