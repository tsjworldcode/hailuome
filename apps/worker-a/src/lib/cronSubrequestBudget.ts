/**
 * M7-30h-7 / M7-30j-4：Cron 外部 fetch 子请求硬预算计数器。
 */
export class CronSubrequestBudget {
  remaining: number;
  constructor(cap: number) {
    this.remaining = cap;
  }
  /** 预占 n 个子请求；不足返回 false */
  take(n = 1): boolean {
    if (this.remaining < n) return false;
    this.remaining -= n;
    return true;
  }
}

/** 单次迁址最坏子请求：well-known + /users，乘链式 hop 上限 */
export function worstCaseUrlMigrateSubrequests(maxHops: number): number {
  return Math.max(0, maxHops) * 2;
}
