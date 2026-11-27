/**
 * M13-16：非安全公开缓存 KV put 日预算（权威状态在 IDENTITY_DB.system_config）。
 *
 * 公式（默认，可用 env.CACHE_KV_PUT_BUDGET_PER_DAY 覆盖可分配额）：
 *   可分配 = 安全水位 500 − 安全预留 100 − 图片 100 − 单帖 50 − 其它部署 50 = 200
 *
 * - priority=security（删帖/封禁等）：一律放行，不消耗本计数。
 * - priority=normal（Feed/posts 普通刷新）：先 CAS 占额，不足则拒绝并保留 dirty 待补刷。
 * - 预算器自身只写 D1，不以每次 KV put 再记一份额度账。
 */
export const CACHE_KV_BUDGET_DAY_KEY = 'cache_kv_budget_utc_day';
export const CACHE_KV_BUDGET_USED_KEY = 'cache_kv_budget_used';

/** 项目安全水位（非 Cloudflare 官方硬限） */
export const CACHE_KV_SAFETY_WATERMARK_PER_DAY = 500;
export const CACHE_KV_RESERVE_SECURITY = 100;
export const CACHE_KV_RESERVE_IMAGE = 100;
export const CACHE_KV_RESERVE_POST_INDIVIDUAL = 50;
export const CACHE_KV_RESERVE_OTHER_DEPLOY = 50;

/** 默认可分配给 feed:latest + posts:latest 的非安全 put/天 */
export const CACHE_KV_DEFAULT_ALLOCATABLE_PER_DAY =
  CACHE_KV_SAFETY_WATERMARK_PER_DAY -
  CACHE_KV_RESERVE_SECURITY -
  CACHE_KV_RESERVE_IMAGE -
  CACHE_KV_RESERVE_POST_INDIVIDUAL -
  CACHE_KV_RESERVE_OTHER_DEPLOY;

export type CacheKvPutPriority = 'security' | 'normal';

export type TryConsumeCacheKvPutResult = {
  allowed: boolean;
  reason: 'security_bypass' | 'consumed' | 'budget_exhausted' | 'zero' | 'cas_conflict';
  used: number;
  limit: number;
  day: string;
};

function isoNow(): string {
  return new Date().toISOString();
}

/** UTC 日历日 YYYY-MM-DD（与账本日界一致） */
export function utcDayString(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** 解析本节点非安全缓存可分配 put 上限 */
export function resolveAllocatableNonSecurityPuts(env: {
  CACHE_KV_PUT_BUDGET_PER_DAY?: string;
}): number {
  const raw = env.CACHE_KV_PUT_BUDGET_PER_DAY?.trim();
  if (raw && /^\d+$/.test(raw)) {
    return Math.max(0, Number.parseInt(raw, 10));
  }
  return CACHE_KV_DEFAULT_ALLOCATABLE_PER_DAY;
}

async function readDayAndUsed(
  db: D1Database,
): Promise<{ day: string; used: number }> {
  const result = await db
    .prepare(
      `SELECT key, value FROM system_config
        WHERE key IN (?, ?)`,
    )
    .bind(CACHE_KV_BUDGET_DAY_KEY, CACHE_KV_BUDGET_USED_KEY)
    .all<{ key: string; value: string }>();

  let day = '';
  let used = 0;
  for (const row of result.results ?? []) {
    if (row.key === CACHE_KV_BUDGET_DAY_KEY) day = row.value ?? '';
    else if (row.key === CACHE_KV_BUDGET_USED_KEY) {
      const n = Number.parseInt(row.value ?? '0', 10);
      used = Number.isFinite(n) && n >= 0 ? n : 0;
    }
  }
  return { day, used };
}

/**
 * 尝试占用非安全缓存 put 额度。
 * multi-isolate：用 `UPDATE … WHERE value = ?` 乐观 CAS；冲突则拒绝（保留 dirty，下轮再试）。
 */
export async function tryConsumeNonSecurityCachePuts(
  db: D1Database,
  env: { CACHE_KV_PUT_BUDGET_PER_DAY?: string },
  putsNeeded: number,
  opts?: { priority?: CacheKvPutPriority; now?: Date },
): Promise<TryConsumeCacheKvPutResult> {
  const day = utcDayString(opts?.now);
  const limit = resolveAllocatableNonSecurityPuts(env);

  if (opts?.priority === 'security') {
    return { allowed: true, reason: 'security_bypass', used: -1, limit, day };
  }
  if (putsNeeded <= 0) {
    return { allowed: true, reason: 'zero', used: 0, limit, day };
  }

  const nowIso = isoNow();

  // 自愈：缺键则插入（迁移未 apply 的本地库也能跑）
  try {
    await db.batch([
      db
        .prepare(
          `INSERT OR IGNORE INTO system_config (key, value, updated_at) VALUES (?, ?, ?)`,
        )
        .bind(CACHE_KV_BUDGET_DAY_KEY, day, nowIso),
      db
        .prepare(
          `INSERT OR IGNORE INTO system_config (key, value, updated_at) VALUES (?, '0', ?)`,
        )
        .bind(CACHE_KV_BUDGET_USED_KEY, nowIso),
    ]);
  } catch (err) {
    console.error('[cacheKvPutBudget] 确保预算键失败', err);
    // fail-soft：预算器故障时拒绝普通写，避免无账乱跑；安全路径不走这里
    return { allowed: false, reason: 'budget_exhausted', used: 0, limit, day };
  }

  let { day: storedDay, used } = await readDayAndUsed(db);

  if (storedDay !== day) {
    // UTC 日界：重置 used（两步串行；随后 CAS 仍按 used=0 占额）
    try {
      await db
        .prepare(
          `UPDATE system_config SET value = ?, updated_at = ? WHERE key = ?`,
        )
        .bind(day, nowIso, CACHE_KV_BUDGET_DAY_KEY)
        .run();
      await db
        .prepare(
          `UPDATE system_config SET value = '0', updated_at = ? WHERE key = ?`,
        )
        .bind(nowIso, CACHE_KV_BUDGET_USED_KEY)
        .run();
      used = 0;
      storedDay = day;
    } catch (err) {
      console.error('[cacheKvPutBudget] 日界重置失败', err);
      return { allowed: false, reason: 'budget_exhausted', used, limit, day };
    }
  }

  if (used + putsNeeded > limit) {
    return { allowed: false, reason: 'budget_exhausted', used, limit, day };
  }

  const next = used + putsNeeded;
  try {
    const upd = await db
      .prepare(
        `UPDATE system_config SET value = ?, updated_at = ?
          WHERE key = ? AND value = ?`,
      )
      .bind(String(next), nowIso, CACHE_KV_BUDGET_USED_KEY, String(used))
      .run();
    if ((upd.meta?.changes ?? 0) === 0) {
      return { allowed: false, reason: 'cas_conflict', used, limit, day };
    }
  } catch (err) {
    console.error('[cacheKvPutBudget] CAS 占额失败', err);
    return { allowed: false, reason: 'cas_conflict', used, limit, day };
  }

  return { allowed: true, reason: 'consumed', used: next, limit, day };
}
