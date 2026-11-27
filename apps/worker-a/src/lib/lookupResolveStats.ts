/**
 * M-OPT-8：统一解析器分层命中日指标（D1）。
 * L4 占比 = l4_registry / (l1 + l2_mutual + l3_fof + l4_registry)。
 */

import type { Env } from '../env';
import { resolveIdentityDb } from '../db/bindings';

export type LookupResolveMetricSource =
  | 'l0_self'
  | 'l1_follows'
  | 'l1_cache'
  | 'l2_mutual'
  | 'l2_miss'
  | 'l2_skipped'
  | 'l3_fof'
  | 'l3_miss'
  | 'l3_skipped'
  | 'l4_registry'
  | 'l4_quota_exceeded'
  | 'l4_not_found'
  | 'l4_error';

export interface LookupResolveDayStats {
  day: string;
  counts: Record<LookupResolveMetricSource, number>;
  /** 成功解析次数（L1 + L2 + L3 + L4 成功） */
  success_total: number;
  /** L4 成功占成功解析的比例；无成功样本时为 null */
  l4_ratio: number | null;
  /** L1（follows+cache）成功占成功解析的比例 */
  l1_ratio: number | null;
  /** L2 互粉协助成功占成功解析的比例 */
  l2_ratio: number | null;
  /** L3 FoF 成功占成功解析的比例 */
  l3_ratio: number | null;
}

const ZERO_COUNTS: Record<LookupResolveMetricSource, number> = {
  l0_self: 0,
  l1_follows: 0,
  l1_cache: 0,
  l2_mutual: 0,
  l2_miss: 0,
  l2_skipped: 0,
  l3_fof: 0,
  l3_miss: 0,
  l3_skipped: 0,
  l4_registry: 0,
  l4_quota_exceeded: 0,
  l4_not_found: 0,
  l4_error: 0,
};

function utcDayKey(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** 记一次分层命中；fail-soft，不阻断 lookup 主路径。 */
export async function recordLookupResolve(
  env: Env,
  source: LookupResolveMetricSource,
): Promise<void> {
  const day = utcDayKey();
  const nowIso = new Date().toISOString();
  // URL-CHANGE-SCHEMA-FIX 同类：lookup_resolve_day_stats 实际在 IDENTITY_DB（migrations-identity/0045）
  const identityDb = resolveIdentityDb(env);
  try {
    await identityDb.prepare(
      `INSERT INTO lookup_resolve_day_stats (day, source, count, updated_at)
       VALUES (?1, ?2, 1, ?3)
       ON CONFLICT(day, source) DO UPDATE SET
         count = count + 1,
         updated_at = excluded.updated_at`,
    )
      .bind(day, source, nowIso)
      .run();
  } catch (err) {
    console.error('[lookupResolveStats] 写入失败', source, err);
  }
}

/** 只读：当日各 source 计数与 L4 占比。 */
export async function getLookupResolveDayStats(
  env: Env,
  now = new Date(),
): Promise<LookupResolveDayStats> {
  const day = utcDayKey(now);
  const counts = { ...ZERO_COUNTS };
  // MIGRATION-COVERAGE：同上（IDENTITY_DB）
  const identityDb = resolveIdentityDb(env);
  try {
    const rows = await identityDb.prepare(
      `SELECT source, count FROM lookup_resolve_day_stats WHERE day = ?1`,
    )
      .bind(day)
      .all<{ source: string; count: number }>();
    for (const row of rows.results ?? []) {
      if (row.source in counts) {
        counts[row.source as LookupResolveMetricSource] = Number(row.count) || 0;
      }
    }
  } catch (err) {
    console.error('[lookupResolveStats] 读取失败', err);
  }

  const successTotal =
    counts.l0_self +
    counts.l1_follows +
    counts.l1_cache +
    counts.l2_mutual +
    counts.l3_fof +
    counts.l4_registry;
  const l4Ratio = successTotal > 0 ? counts.l4_registry / successTotal : null;
  const l1Ratio =
    successTotal > 0 ? (counts.l1_follows + counts.l1_cache) / successTotal : null;
  const l2Ratio = successTotal > 0 ? counts.l2_mutual / successTotal : null;
  const l3Ratio = successTotal > 0 ? counts.l3_fof / successTotal : null;

  return {
    day,
    counts,
    success_total: successTotal,
    l4_ratio: l4Ratio,
    l1_ratio: l1Ratio,
    l2_ratio: l2Ratio,
    l3_ratio: l3Ratio,
  };
}
