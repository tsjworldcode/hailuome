/**
 * M6-3：黑名单 D1 → STATE_KV Cron 同步。
 *
 * 调用方：apps/worker-a/src/index.ts scheduled handler 在 `*\/5 * * * *` cron 触发时
 *        通过 `ctx.waitUntil(syncBlacklistToKv(env))` 调用。
 *
 * 设计要点（NCF-AUDIT-OR-6 · 🟠 6 修后口径）：
 *   - 移除 dirty 节流：原本 `system_config.blacklist_dirty` 标志需跨 binding 写
 *     （blacklist 表在 GOVERNANCE_DB，system_config 在 IDENTITY_DB），非事务会留半成功脏数据。
 *     改为每次 cron 都全量 diff（D1 blacklist ⊖ STATE_KV），D1 读 288 次/天 < 100K 限频，
 *     不需要 dirty 标志。immediate sync（M9-13）已接管主路径，本入口纯兜底。
 *   - 全量 diff：每次执行都全表 SELECT D1 blacklist + KV LIST prefix `blacklist:`，
 *     算出"应加""应删"两个集合后分别下发 KV put / KV delete。中间不缓存任何中间态。
 *   - 写完更新 last_sync_at 时间戳（仅身份 DB 单 binding，无跨 binding）。
 *   - fail-soft：KV 批量操作中单条失败只记日志，不中断；下次 Cron 重新 diff（最终一致）。
 *
 * KV 写成本估算（Free Tier 1000 写/天硬约束）：
 *   - 单次 cron tick：1 次 D1 SELECT（blacklist 全表）+ 1 次 KV LIST + |D1 ⊖ KV| 次 KV 写
 *   - 正常使用一般 <10 次/天写；极端 5 分钟一次封禁 ≤ 288 次 cron × ≤少量 keys
 *
 * KV 键值约定：
 *   - 键名：`blacklist:local:<node_url>`（M6-4 起与注册中心 `blacklist:registry:` 分离）
 *   - 值：JSON `{ reason: string, created_at: string }`（Worker B 当前仅看键存在与否，
 *     但保留值以便 M9+ 拓展，例如"封禁原因展示"）
 */

import {
  BLACKLIST_KV_LOCAL_PREFIX,
  blacklistLocalKey,
  isLegacyBlacklistKvKey,
} from '@hailuo/shared-utils';
import type { Env } from '../env';
import { resolveGovernanceDb, resolveIdentityDb } from '../db/bindings';

/** STATE_KV 中本地黑名单键前缀（M6-4 与 registry 键分离）。 */
const KV_PREFIX = BLACKLIST_KV_LOCAL_PREFIX;

/** D1 blacklist 表的扁平行类型。 */
interface BlacklistRow {
  node_url: string;
  reason: string;
  created_at: string;
}

/** STATE_KV 中存储的值结构（JSON 序列化）。 */
interface BlacklistKvValue {
  reason: string;
  created_at: string;
}

/** 当前 UTC ISO 8601 字符串。 */
function isoNow(): string {
  return new Date().toISOString();
}

/**
 * 列出 STATE_KV 中本地黑名单键 + 待清理的遗留键。
 */
async function listLocalBlacklistKvKeys(env: Env): Promise<{ local: Set<string>; legacy: string[] }> {
  const local = new Set<string>();
  const legacy: string[] = [];
  let cursor: string | undefined;
  do {
    const page: KVNamespaceListResult<unknown, string> =
      await env.STATE_KV.list({ prefix: 'blacklist:', cursor });
    for (const k of page.keys) {
      if (k.name.startsWith(KV_PREFIX)) {
        local.add(k.name);
      } else if (isLegacyBlacklistKvKey(k.name)) {
        legacy.push(k.name);
      }
    }
    if (page.list_complete) break;
    cursor = page.cursor;
  } while (cursor);
  return { local, legacy };
}

/**
 * 黑名单 D1 → STATE_KV 同步主入口（NCF-AUDIT-OR-6 · 🟠 6 修后）。
 *
 * fail-soft：任何中途失败都不抛出（不影响其他 Cron 分支），单条 KV 失败时
 * 下次 Cron 重新 diff 直至最终一致。
 */
export async function syncBlacklistToKv(env: Env): Promise<void> {
  // 1. 同时取 D1 全量与 KV 全量，做集合 diff（NCF-AUDIT-OR-6 · 移除 dirty 节流，
  //    改为每次 cron 全量 diff，消除 blacklist（GOVERNANCE）→ system_config（IDENTITY）
  //    跨 binding 非事务半成功留脏数据风险）。
  const governanceDb = resolveGovernanceDb(env);
  const identityDb = resolveIdentityDb(env);
  let d1Rows: BlacklistRow[];
  let kvKeys: Set<string>;
  let legacyKeys: string[];
  try {
    const [d1Result, kvListed] = await Promise.all([
      governanceDb
        .prepare(`SELECT node_url, reason, created_at FROM blacklist`)
        .all<BlacklistRow>(),
      listLocalBlacklistKvKeys(env),
    ]);
    d1Rows = d1Result.results ?? [];
    kvKeys = kvListed.local;
    legacyKeys = kvListed.legacy;
  } catch (err) {
    console.error('[cron/blacklist-sync] D1 SELECT 或 KV LIST 失败', err);
    return; // 下次 cron 重试
  }

  // 3. 计算 diff：
  //    toPut    = D1 中存在但 KV 中没有 → 新加黑、KV 未跟上
  //    toDelete = KV 中存在但 D1 中没有 → 已解封，需删 KV 键
  //    (KV 已存在的 keys 与 D1 一致部分不重写，KV 写次数最小化)
  const d1KeySet = new Set<string>();
  const toPut: BlacklistRow[] = [];
  for (const row of d1Rows) {
    const fullKey = blacklistLocalKey(row.node_url);
    d1KeySet.add(fullKey);
    if (!kvKeys.has(fullKey)) {
      toPut.push(row);
    }
  }
  const toDelete: string[] = [];
  for (const kvKey of kvKeys) {
    if (!d1KeySet.has(kvKey)) {
      toDelete.push(kvKey);
    }
  }
  // 升级清理：遗留 blacklist:https:// 键一律删除（D1 已在上面 toPut 重建 local 键）
  for (const legacyKey of legacyKeys) {
    toDelete.push(legacyKey);
  }

  // 4. KV 批量写（fail-soft：单条失败不中断，但记录失败次数）
  //    Promise.allSettled 而非 Promise.all——避免某一条 KV 异常拖垮整批。
  let failures = 0;
  if (toPut.length > 0) {
    const results = await Promise.allSettled(
      toPut.map((row) => {
        const value: BlacklistKvValue = { reason: row.reason, created_at: row.created_at };
        return env.STATE_KV.put(blacklistLocalKey(row.node_url), JSON.stringify(value));
      }),
    );
    for (const r of results) {
      if (r.status === 'rejected') {
        failures++;
        console.error('[cron/blacklist-sync] KV put 失败', r.reason);
      }
    }
  }
  if (toDelete.length > 0) {
    const results = await Promise.allSettled(
      toDelete.map((key) => env.STATE_KV.delete(key)),
    );
    for (const r of results) {
      if (r.status === 'rejected') {
        failures++;
        console.error('[cron/blacklist-sync] KV delete 失败', r.reason);
      }
    }
  }

  // 5. 整批成功才更新 last_sync_at 时间戳（IDENTITY_DB 单 binding，无跨 binding 风险）。
  //    保留时间戳仅作监控/排障：值格式 ISO 8601，与原 last_sync_at 一致。
  //    即使写失败，下次 cron 仍会重新 diff（KV 已是最新状态，diff 集合会为空），
  //    不会重复写 KV；与"dirty 失败保持 true 等价幂等回滚"语义一致。
  if (failures > 0) {
    console.warn(
      `[cron/blacklist-sync] 部分 KV 操作失败 (${failures})，last_sync_at 不更新，等待下次重试`,
    );
    return;
  }

  const now = isoNow();
  try {
    await identityDb
      .prepare(
        `UPDATE system_config SET value = ?, updated_at = ?
          WHERE key = 'blacklist_last_sync_at'`,
      )
      .bind(now, now)
      .run();
  } catch (err) {
    console.warn('[cron/blacklist-sync] 更新 last_sync_at 失败（不影响下次 cron 重试）', err);
    return;
  }

  console.log(
    `[cron/blacklist-sync] 同步完成：put=${toPut.length} delete=${toDelete.length} d1=${d1Rows.length} kv_before=${kvKeys.size}`,
  );
}
