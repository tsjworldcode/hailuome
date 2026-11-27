/**
 * M16-GROUP-GOV-5 / GOV-8 / LIFECYCLE-V2-13：群主侧群号活名单 + 近窗解散，供 daily-sync `group_lifecycle`。
 *
 * - created：admin 为群主且未解散；有锚点时 `created_at >= last_daily_sync_reported_at`（增量）；无锚点 fail-open 全量
 * - dissolved：近 30 天解散的群（中心据此删 created 行）
 * 防身份关联：只报 group_id + 事件时间；不报群名/成员/内容。
 * fail-soft：MESSAGING_DB 不可用或聚合失败 → 返回 null，不阻断 daily-sync。
 *
 * R-MSG-4b：GroupLifecycleItem / GroupLifecycleSummary 接口已迁入 @hailuo/registry-protocol；
 * build / truncate 函数保留本地。
 */
import type { Env } from '../env';
import { normalizeGroupMemberUrl } from './groupMemberUrl';
import { resolveLocalPublicBaseUrl } from './localPublicBaseUrl';
import { messagingDb } from './messagingDb';
import { getLastDailySyncReportedAt } from './nodeSyncState';
import type {
  GroupLifecycleItem,
  GroupLifecycleSummary,
} from '@hailuo/registry-protocol';

export const GROUP_LIFECYCLE_PERIOD_DAYS = 30;
export const GROUP_LIFECYCLE_MAX_ITEMS = 100;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * 截断最旧，保留最新 maxN 条（按 at 时间升序后取尾部）。
 * V2-20：用 `Date.parse` 排序，避免 ISO 形态不一致（`…Z` / `…000Z` / `…+00:00`）导致字典序错位；
 * 与中心 `groupLifecycleParse.ts:160` 对齐。
 */
export function truncateNewestGroupLifecycleItems(
  items: GroupLifecycleItem[],
  maxN: number = GROUP_LIFECYCLE_MAX_ITEMS,
): GroupLifecycleItem[] {
  if (items.length <= maxN) return items;
  const sorted = [...items].sort((a, b) => {
    const am = Date.parse(a.at);
    const bm = Date.parse(b.at);
    if (Number.isFinite(am) && Number.isFinite(bm)) return am - bm;
    // 任一非法：兜底字典序（与 v0.6 行为一致）
    return a.at.localeCompare(b.at);
  });
  return sorted.slice(sorted.length - maxN);
}

function isoNow(): string {
  return new Date().toISOString();
}

function sinceIso(days: number): string {
  return new Date(Date.now() - days * MS_PER_DAY).toISOString();
}

/**
 * 从本地 MESSAGING_DB 聚合群号活名单 + 近窗解散。
 * V2-13：`userId` 用于读 IDENTITY `node_sync_state` 增量锚点；MESSAGING_DB 不可用 → null。
 */
export async function buildGroupLifecycleSummary(
  env: Env,
  userId: string,
): Promise<GroupLifecycleSummary | null> {
  // fail-soft：未绑 MESSAGING_DB 时不抛，跳过整块
  if (!env.MESSAGING_DB) return null;

  try {
    const db = messagingDb(env);
    const since = sinceIso(GROUP_LIFECYCLE_PERIOD_DAYS);
    const ownerUrl = resolveLocalPublicBaseUrl(env);
    // V2-13：增量锚点；无锚点 → 全量活名单（中心窗兜底）
    const anchor = await getLastDailySyncReportedAt(env, userId);

    const createdRows = anchor
      ? await db
          .prepare(
            `SELECT group_id, created_at AS at
             FROM groups
             WHERE owner_worker_b_url = ?1
               AND dissolved_at IS NULL
               AND created_at >= ?2
             ORDER BY created_at DESC
             LIMIT ?3`,
          )
          .bind(ownerUrl, anchor, GROUP_LIFECYCLE_MAX_ITEMS)
          .all<{ group_id: string; at: string }>()
      : await db
          .prepare(
            `SELECT group_id, created_at AS at
             FROM groups
             WHERE owner_worker_b_url = ?1
               AND dissolved_at IS NULL
             ORDER BY created_at DESC
             LIMIT ?2`,
          )
          .bind(ownerUrl, GROUP_LIFECYCLE_MAX_ITEMS)
          .all<{ group_id: string; at: string }>();

    const created = (createdRows.results ?? [])
      .map((r) => ({ group_id: r.group_id, at: r.at }))
      .filter((r) => normalizeGroupMemberUrl(r.group_id) !== null);

    const dissolvedRows = await db
      .prepare(
        `SELECT group_id, dissolved_at AS at
         FROM groups
         WHERE owner_worker_b_url = ?1
           AND dissolved_at IS NOT NULL
           AND dissolved_at >= ?2
         ORDER BY dissolved_at DESC`,
      )
      .bind(ownerUrl, since)
      .all<{ group_id: string; at: string }>();

    const dissolved = (dissolvedRows.results ?? [])
      .map((r) => ({ group_id: r.group_id, at: r.at }))
      .filter((r) => normalizeGroupMemberUrl(r.group_id) !== null);

    const summary: GroupLifecycleSummary = {
      period_days: GROUP_LIFECYCLE_PERIOD_DAYS,
      computed_at: isoNow(),
      created: truncateNewestGroupLifecycleItems(created),
      dissolved,
    };

    return summary;
  } catch (err) {
    console.warn('[group-lifecycle-summary] 聚合失败，跳过该块', err);
    return null;
  }
}
