/**
 * NCF-REG-RETRY-1：出站重试等待纯函数（无 D1 / Env 依赖）。
 * 定上限 Full Jitter + 优先 Retry-After；**不**做指数退避（sync/cron 预算钉死）。
 */

/** `Retry-After` 等待封顶，避免无限挂死。 */
export const RETRY_AFTER_CAP_MS = 30_000;

/**
 * Full Jitter：均匀分布在 [0, delayMs)。
 * 减轻多节点墙钟对齐 + 固定退避造成的重试尖峰（雷鸣群）。
 */
export function fullJitterMs(delayMs: number, random: () => number = Math.random): number {
  if (!(delayMs > 0)) return 0;
  const r = random();
  const unit = Number.isFinite(r) ? Math.min(Math.max(r, 0), 1 - Number.EPSILON) : 0;
  return Math.floor(unit * delayMs);
}

/**
 * 解析 `Retry-After`：纯数字秒，或 HTTP-date。
 * 非法 / 空 → null（调用方回落 Full Jitter）。
 */
export function parseRetryAfterMs(
  header: string | null | undefined,
  nowMs: number = Date.now(),
): number | null {
  if (header == null) return null;
  const raw = String(header).trim();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) {
    const sec = Number(raw);
    if (!Number.isFinite(sec) || sec < 0) return null;
    return Math.floor(sec * 1000);
  }
  const then = Date.parse(raw);
  if (!Number.isFinite(then)) return null;
  return Math.max(0, Math.floor(then - nowMs));
}

/**
 * 可重试等待毫秒：有 `Retry-After` 则优先并封顶 {@link RETRY_AFTER_CAP_MS}；
 * 否则 Full Jitter(profileDelayMs)。**不**改失败分类语义。
 */
export function computeRegistryRetryWaitMs(opts: {
  profileDelayMs: number;
  retryAfterHeader?: string | null;
  nowMs?: number;
  random?: () => number;
}): number {
  const parsed = parseRetryAfterMs(opts.retryAfterHeader, opts.nowMs ?? Date.now());
  if (parsed != null) {
    return Math.min(parsed, RETRY_AFTER_CAP_MS);
  }
  return fullJitterMs(opts.profileDelayMs, opts.random ?? Math.random);
}
