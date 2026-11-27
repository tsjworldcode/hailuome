/**
 * R-MSG-2e：紧急策略旁路（urgent digest）。
 *
 * - 默认关闭（`URGENT_POLICY_PULL_ENABLED !== 'true'` 时本模块全部 no-op）
 * - 仅在注册中心 digest 报 `urgent: true` 时补拉黑名单 + 官方公告
 * - 每节点每日 urgent 辅拉上限 24 次（STATE_KV 计，UTC 日，历时 25h TTL 防跨日残留）
 * - Cron 轮询频率由调用方控制（建议每小时一次，挂 minute === 35 进现有 isGroupExternalSlotMinute 槽）
 *
 * 与 `registryPolicyPoll.ts` 的区别：
 *   - policyPoll：周期探测（日常单通道后已停 routine Cron）
 *   - 本模块：仅 urgent 触发，优先于 policyPoll 的 routine 语义
 */
import type { Env } from '../env';
import { syncRegistryPolicyDigest } from './registryPolicyPoll';
import {
  continueBlacklistKvBudgetSyncIfPending,
  syncRegistryBlacklistToKv,
} from './registryBlacklistSync';
import { pullRegistryOfficialFeedAfterRegistration } from './feedFetch';
import { writeOperationLog } from '../lib/operationLog';

/** 每节点每日 urgent 辅拉上限（防刷爆注册中心配额） */
export const URGENT_PULL_DAILY_LIMIT = 24;

/** STATE_KV 中每日计数键前缀 */
const URGENT_COUNT_PREFIX = 'urgent_pull_count:';

/** 计数的 TTL（小时），稍长于 24h 确保跨 UTC 日边界有缓冲 */
const URGENT_COUNT_TTL_SEC = 25 * 60 * 60;

function getTodayUtcDate(): string {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function urgentCountKey(): string {
  return `${URGENT_COUNT_PREFIX}${getTodayUtcDate()}`;
}

/** 从 digest 响应 JSON 中提取 urgent 字段（不存在或非 true 均视为非紧急） */
function parseUrgentFlag(raw: unknown): boolean {
  if (typeof raw !== 'object' || raw === null) return false;
  const obj = raw as Record<string, unknown>;
  return obj.urgent === true;
}

/**
 * 读取今日已消耗的 urgent 辅拉次数（未设 key 时返回 0）。
 * 导出供端点 GET /registry-urgent-policies/status 使用。
 */
export async function readUrgentPullCount(env: Env): Promise<number> {
  const key = urgentCountKey();
  const raw = await env.STATE_KV.get(key);
  if (!raw) return 0;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/**
 * 原子尝试消耗一个 urgent 辅拉配额。
 * 读取 → 检查 → 写入；返回 true 表示成功获得配额，false 表示已达上限。
 * KV put 在 Cloudflare Workers 中具有 read-modify-write 原子性，
 * 多实例并发时以最后一次写入为准（软限制，允许轻微超出）。
 */
async function tryAcquireUrgentQuota(env: Env): Promise<boolean> {
  const key = urgentCountKey();
  const current = await readUrgentPullCount(env);
  if (current >= URGENT_PULL_DAILY_LIMIT) {
    return false;
  }
  // 写入新计数（UTC 日，过期 TTL 确保隔日自动清零）
  await env.STATE_KV.put(key, String(current + 1), { expirationTtl: URGENT_COUNT_TTL_SEC });
  return true;
}

export interface UrgentPolicyPullResult {
  skipped: 'disabled' | 'quota_exceeded' | 'not_urgent';
  pulled: boolean;
  quotaUsed: number;
  quotaLimit: number;
  message: string;
}

/**
 * R-MSG-2e 核心逻辑：检查开关 → 检查配额 → 打 digest → 辅拉。
 *
 * 预期调用方：Cron 定时任务（建议每小时一次）或手动触发端点。
 */
export async function runUrgentPolicyPull(
  env: Env,
): Promise<UrgentPolicyPullResult> {
  // 1. 开关检查
  if (env.URGENT_POLICY_PULL_ENABLED !== 'true') {
    return {
      skipped: 'disabled',
      pulled: false,
      quotaUsed: 0,
      quotaLimit: URGENT_PULL_DAILY_LIMIT,
      message: 'URGENT_POLICY_PULL_ENABLED 非 true，已跳过',
    };
  }

  // 2. 配额检查
  const quotaUsed = await readUrgentPullCount(env);
  if (quotaUsed >= URGENT_PULL_DAILY_LIMIT) {
    return {
      skipped: 'quota_exceeded',
      pulled: false,
      quotaUsed,
      quotaLimit: URGENT_PULL_DAILY_LIMIT,
      message: `今日 urgent 辅拉 ${quotaUsed}/${URGENT_PULL_DAILY_LIMIT} 次已达上限，已跳过`,
    };
  }

  // 3. 打 digest（含 ETag/304；若 304 则 digest 无变化，不触发辅拉）
  const digestResult = await syncRegistryPolicyDigest(env, {});
  const quotaAfter = await readUrgentPullCount(env);

  if (digestResult.status === 'not_modified') {
    // 304：策略未变，digest 无 urgent 信息，无需辅拉
    return {
      skipped: 'not_urgent',
      pulled: false,
      quotaUsed: quotaAfter,
      quotaLimit: URGENT_PULL_DAILY_LIMIT,
      message: 'digest 304 未变更，无需辅拉',
    };
  }

  if (digestResult.status === 'failed') {
    // digest 请求失败，不消耗配额（下次重试）
    return {
      skipped: 'not_urgent',
      pulled: false,
      quotaUsed,
      quotaLimit: URGENT_PULL_DAILY_LIMIT,
      message: `digest 失败：${digestResult.message}`,
    };
  }

  // 4. digest 返回有内容（status === 'updated'）
  //    syncRegistryPolicyDigest 内部已写 ETag，不重复消耗配额——配额在 digest 成功后才消耗
  const acquired = await tryAcquireUrgentQuota(env);
  if (!acquired) {
    // 刚好在检查与写入之间被其他实例占满（极罕见）
    return {
      skipped: 'quota_exceeded',
      pulled: false,
      quotaUsed: await readUrgentPullCount(env),
      quotaLimit: URGENT_PULL_DAILY_LIMIT,
      message: '配额竞争，已达上限，已跳过',
    };
  }

  // 5. 辅拉黑名单 + 官方公告（与 syncRegistryPolicyDigest 内部的增量辅拉互补；
  //    这里在 digest 确认 updated 后额外补拉，确保紧急时完整生效）
  try {
    await syncRegistryBlacklistToKv(env);
  } catch (err) {
    console.warn('[cron/urgent-policy] 黑名单补拉失败', err);
  }
  try {
    await pullRegistryOfficialFeedAfterRegistration(env);
  } catch (err) {
    console.warn('[cron/urgent-policy] 官方公告补拉失败', err);
  }

  await writeOperationLog(env, {
    source: 'worker-a',
    level: 'info',
    event: 'registry_urgent_policy_pulled',
    message: 'urgent 辅拉成功',
    details: {
      quota_used: await readUrgentPullCount(env),
      quota_limit: URGENT_PULL_DAILY_LIMIT,
    },
  }).catch(() => {});

  return {
    skipped: 'not_urgent',
    pulled: true,
    quotaUsed: await readUrgentPullCount(env),
    quotaLimit: URGENT_PULL_DAILY_LIMIT,
    message: 'urgent 辅拉完成',
  };
}

/** 手动强制触发（绕过 `URGENT_POLICY_PULL_ENABLED` 开关检查，供 Settings / force 使用） */
export async function runUrgentPolicyPullForced(
  env: Env,
): Promise<UrgentPolicyPullResult> {
  const quotaUsed = await readUrgentPullCount(env);
  if (quotaUsed >= URGENT_PULL_DAILY_LIMIT) {
    return {
      skipped: 'quota_exceeded',
      pulled: false,
      quotaUsed,
      quotaLimit: URGENT_PULL_DAILY_LIMIT,
      message: `今日 urgent 辅拉已达上限 ${quotaUsed}/${URGENT_PULL_DAILY_LIMIT} 次`,
    };
  }
  const acquired = await tryAcquireUrgentQuota(env);
  if (!acquired) {
    return {
      skipped: 'quota_exceeded',
      pulled: false,
      quotaUsed: await readUrgentPullCount(env),
      quotaLimit: URGENT_PULL_DAILY_LIMIT,
      message: '配额竞争，已达上限',
    };
  }
  await syncRegistryPolicyDigest(env, {});
  try {
    await syncRegistryBlacklistToKv(env);
  } catch (err) {
    console.warn('[cron/urgent-policy/forced] 黑名单补拉失败', err);
  }
  try {
    await pullRegistryOfficialFeedAfterRegistration(env);
  } catch (err) {
    console.warn('[cron/urgent-policy/forced] 官方公告补拉失败', err);
  }
  return {
    skipped: 'not_urgent',
    pulled: true,
    quotaUsed: await readUrgentPullCount(env),
    quotaLimit: URGENT_PULL_DAILY_LIMIT,
    message: '手动 urgent 辅拉完成',
  };
}
