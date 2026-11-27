/**
 * M5-SR：Workers 请求体上限（Cloudflare 账号套餐约束，非 B2/Filebase 自身限制）。
 * Free/Pro 100 MB；Business 200 MB；Enterprise 默认 500 MB。
 */
import type { Env } from '../env';

/** Free / Pro 默认应用层上限 */
export const DEFAULT_MEDIA_MAX_REQUEST_BYTES = 100 * 1024 * 1024;

/** Business 套餐 Workers 请求体上限 */
export const BUSINESS_MEDIA_MAX_REQUEST_BYTES = 200 * 1024 * 1024;

/** Enterprise 套餐 Workers 请求体默认上限 */
export const ENTERPRISE_MEDIA_MAX_REQUEST_BYTES = 500 * 1024 * 1024;

/** 解析 B2/R2/Filebase 单请求体上限；operator 通过 env 覆盖 */
export function resolveMaxMediaRequestBytes(env: Env): number {
  const raw = env.MEDIA_MAX_REQUEST_BYTES?.trim();
  if (raw) {
    const n = parseInt(raw, 10);
    if (!Number.isNaN(n) && n > 0) return n;
  }
  return DEFAULT_MEDIA_MAX_REQUEST_BYTES;
}
