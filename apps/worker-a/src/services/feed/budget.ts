/**
 * NCF-2A：外部 fetch 子请求预算（与 CronSubrequestBudget 同形，供核心/fixture 共用）。
 */

export type ExternalFetchBudget = {
  readonly remaining: number;
  take(n?: number): boolean;
};

export function createExternalFetchBudget(cap: number): ExternalFetchBudget {
  let remaining = Math.max(0, Math.floor(cap));
  return {
    get remaining() {
      return remaining;
    },
    take(n = 1): boolean {
      const need = Math.max(0, Math.floor(n));
      if (remaining < need) return false;
      remaining -= need;
      return true;
    },
  };
}

export function budgetUsed(initialCap: number, budget: ExternalFetchBudget): number {
  return Math.max(0, Math.floor(initialCap) - budget.remaining);
}
