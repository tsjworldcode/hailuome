/**
 * CRON-SCHEDULE-AUDIT：GC 的外部删除预算。
 *
 * KV / R2 的 delete 走 binding，不占 Workers 外部子请求；
 * B2 / Filebase 的 delete 是 fetch，必须计入单次 invocation 的 50 子请求上限。
 * 每个 GC 任务每轮最多删 10 个外部 blob（与 cronBudget 的 estimate 10 对齐），
 * 超出的行保留到下一轮。
 */
export const MEDIA_GC_EXTERNAL_DELETE_CAP = 10;

export type ExternalDeleteBudget = {
  remaining: number;
};

export function createExternalDeleteBudget(
  cap: number = MEDIA_GC_EXTERNAL_DELETE_CAP,
): ExternalDeleteBudget {
  return { remaining: Math.max(0, cap) };
}

export function isExternalMediaBackend(backend: string): boolean {
  return backend === 'b2' || backend === 'filebase';
}

/** 外部后端占一个删除额度；binding 后端（kv/r2）永远放行。 */
export function takeExternalDeleteSlot(
  budget: ExternalDeleteBudget | undefined,
  backend: string,
): boolean {
  if (!isExternalMediaBackend(backend)) return true;
  if (!budget) return true;
  if (budget.remaining <= 0) return false;
  budget.remaining -= 1;
  return true;
}
