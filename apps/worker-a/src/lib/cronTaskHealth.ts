/**
 * CRON-ERROR-VISIBILITY：把「任务跑了但内部报错」持久化到 D1，供排障与设置页读取。
 *
 * 为什么需要：`[cron/budget]` 的 `ran` 只代表任务函数被调用过；任务内部 catch 后
 * console.error 就结束了（2026-11-26 换域通知缺表缺列即如此，连续 6 次部署无人发现）。
 *
 * 存储选择：`system_config.cron_task_health`（IDENTITY_DB，单行 JSON）。
 * - 健康稳态只做 1 次读、0 次写（不产生每分钟写放大，Free Tier D1 写额度友好）；
 * - 只有出现错误或错误恢复时才写；
 * - 连续失败达到阈值时额外打 `[cron/health]` 日志，便于 wrangler tail / 日志检索告警。
 */
import type { CronBudgetSummary } from '../handlers/cronBudget';
import { resolveIdentityDb } from '../db/bindings';
import type { Env } from '../env';

export const CRON_TASK_HEALTH_KEY = 'cron_task_health';
export const CRON_TASK_HEALTH_ALERT_THRESHOLD = 3;

export type CronTaskHealthEntry = {
  consecutive_errors: number;
  last_error_at: string | null;
  last_error_sample: string;
  last_ok_at: string | null;
};

export type CronTaskHealthMap = Record<string, CronTaskHealthEntry>;

function parseHealth(raw: string | null | undefined): CronTaskHealthMap {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as CronTaskHealthMap;
  } catch {
    return {};
  }
}

/**
 * 汇总本轮所有 `ran` 任务的错误计数并落库。
 * 失败必须 fail-soft：可观测性不能反过来把 Cron 弄挂。
 */
export async function persistCronTaskHealth(
  env: Env,
  summary: CronBudgetSummary,
): Promise<void> {
  const ran = summary.results.filter((r) => r.status === 'ran');
  if (ran.length === 0) return;

  const db = resolveIdentityDb(env);
  const row = await db
    .prepare(`SELECT value FROM system_config WHERE key = ? LIMIT 1`)
    .bind(CRON_TASK_HEALTH_KEY)
    .first<{ value: string }>();
  const previous = parseHealth(row?.value);
  const next: CronTaskHealthMap = { ...previous };
  const nowIso = new Date().toISOString();
  let changed = false;

  for (const result of ran) {
    const errors = result.errors ?? 0;
    const prev = previous[result.id];
    if (errors > 0) {
      const consecutive = (prev?.consecutive_errors ?? 0) + 1;
      next[result.id] = {
        consecutive_errors: consecutive,
        last_error_at: nowIso,
        last_error_sample: result.errorSamples?.[0] ?? '',
        last_ok_at: prev?.last_ok_at ?? null,
      };
      changed = true;
      if (consecutive >= CRON_TASK_HEALTH_ALERT_THRESHOLD) {
        console.warn(
          `[cron/health] ${result.id} 连续 ${consecutive} 次执行报错：${next[result.id].last_error_sample}`,
        );
      }
      continue;
    }
    // 无错误：只有「从失败恢复」或已存在健康记录时才刷新 last_ok_at，
    // 避免健康稳态每分钟写一次 D1。
    if (prev) {
      next[result.id] = {
        consecutive_errors: 0,
        last_error_at: prev.last_error_at,
        last_error_sample: prev.last_error_sample,
        last_ok_at: nowIso,
      };
      changed = true;
    }
  }

  if (!changed) return;

  await db
    .prepare(
      `INSERT INTO system_config (key, value, updated_at) VALUES (?1, ?2, ?3)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .bind(CRON_TASK_HEALTH_KEY, JSON.stringify(next), nowIso)
    .run();
}
