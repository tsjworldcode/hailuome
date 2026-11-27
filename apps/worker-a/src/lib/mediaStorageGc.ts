/**
 * M8-14-8：R2 高水位 GC（90% → 清到 70%）。
 *
 * 触发：当 R2 用量 ≥ 高水位（默认 0.90，10 GiB 上限）时，自动回收可清理对象，
 *       直到用量 ≤ 目标水位（默认 0.70，腾约 30% 空间）。
 *
 * 两段回收（防裂图）：
 *   Tier 1：released_at IS NOT NULL / storage_state='abandoned' / retain_until 已过期
 *           — 已是逻辑释放状态，直接删 R2 bytes + 减计数（修复/重试失败的孤儿）。
 *   Tier 2：storage_state='active' 按 created_at 升序（最早先考虑删）
 *           — 但每条必须跨 CONTENT_DB 校验「posts.deleted_at IS NULL 且 image_keys 含此 key」
 *           — 仍被引用则跳过，**禁止直接删未删帖的图**（避免图裂）。
 *
 * 挂点：handlers/cronBudget.ts 的 isGroupExternalSlotMinute 槽（5/15/25/35/45）
 *      — 与 messaging-media-gc 同槽同优先级串行，**不增新 Cron Trigger**。
 *
 * 失败策略：fail-soft；任何步骤级错误写到 result.errors，cron 任务不应被 GC 失败拖垮。
 *
 * SSOT：docs/m8-14-optional-r2-bootstrap-plan.md §5.2
 */
import type { Env } from '../env';
import { resolveContentDb, resolveIdentityDb } from '../db/bindings';
import { isMessagingMediaStorageKey } from '@hailuo/shared-utils';
import { deleteMediaObjectFromStorage } from './mediaObjectRegistry';
import {
  calibrateKvUsage,
  decrementUsage,
  readR2HighWatermark,
  readR2TargetWatermark,
  readUsageRow,
} from './mediaStorageUsage';

/** 单批扫描行数；防止一次扫太多阻塞 cron。 */
const GC_BATCH_LIMIT = 50;

/** Tier 2 安全 break 上限：避免极端情况下无限循环（每批 50 行 × 20 批 = 1000 行）。 */
const GC_MAX_BATCHES = 20;

interface TierCandidate {
  object_key: string;
  size_bytes: number;
  created_at: string;
}

export interface GcR2Result {
  skipped: boolean;
  reason?: string;
  tier1Deleted: number;
  tier2Deleted: number;
  tier2SkippedReferenced: number;
  bytesReclaimed: number;
  errors: string[];
}

function nowIso(): string {
  return new Date().toISOString();
}

/** Tier 1：已逻辑释放 / 已废弃 / 已过期的 R2 对象 — 安全回收。 */
async function queryTier1R2Candidates(env: Env, limit: number): Promise<TierCandidate[]> {
  const db = resolveIdentityDb(env);
  const now = nowIso();
  try {
    const rows = await db
      .prepare(
        `SELECT object_key, size_bytes, created_at
           FROM media_object_registry
          WHERE backend = 'r2'
            AND (
              released_at IS NOT NULL
              OR storage_state = 'abandoned'
              OR (retain_until IS NOT NULL AND retain_until < ?)
            )
          ORDER BY created_at ASC
          LIMIT ?`,
      )
      .bind(now, limit)
      .all<TierCandidate>();
    return rows.results ?? [];
  } catch (err) {
    console.error('[mediaStorageGc] queryTier1R2Candidates 失败', err);
    return [];
  }
}

/** Tier 2：仍 active 的最早 R2 对象 — 每条需跨库校验无未删帖引用。 */
async function queryTier2R2Candidates(
  env: Env,
  limit: number,
  offsetCreatedAt: string | null,
): Promise<TierCandidate[]> {
  const db = resolveIdentityDb(env);
  try {
    const rows = offsetCreatedAt
      ? await db
          .prepare(
            `SELECT object_key, size_bytes, created_at
               FROM media_object_registry
              WHERE backend = 'r2'
                AND storage_state = 'active'
                AND released_at IS NULL
                AND created_at > ?
              ORDER BY created_at ASC
              LIMIT ?`,
          )
          .bind(offsetCreatedAt, limit)
          .all<TierCandidate>()
      : await db
          .prepare(
            `SELECT object_key, size_bytes, created_at
               FROM media_object_registry
              WHERE backend = 'r2'
                AND storage_state = 'active'
                AND released_at IS NULL
              ORDER BY created_at ASC
              LIMIT ?`,
          )
          .bind(limit)
          .all<TierCandidate>();
    return rows.results ?? [];
  } catch (err) {
    console.error('[mediaStorageGc] queryTier2R2Candidates 失败', err);
    return [];
  }
}

/**
 * 跨 CONTENT_DB 校验：object_key 是否仍被任何未删帖引用。
 * 用 SQLite `json_each` 展开 posts.image_keys JSON 数组，等值匹配 —
 * 较旧 LIKE '%"key"%' 实现更稳：
 *   1. 不依赖 key 前后必须有双引号的假设（schema 演进 / JSON 转义都安全）
 *   2. 子串误匹配风险为零（json_each.value 是数组元素本体）
 *   3. 借 SQLite 优化器命中 image_keys 长度过滤；LIKE 全表扫描成本随帖子数线性增长
 * 失败仍 fail-soft 返 true（保守不删）。
 */
async function isR2ObjectReferencedByActivePost(env: Env, objectKey: string): Promise<boolean> {
  const db = resolveContentDb(env);
  try {
    const row = await db
      .prepare(
        `SELECT 1
           FROM posts, json_each(posts.image_keys) AS je
          WHERE posts.deleted_at IS NULL
            AND je.value = ?
          LIMIT 1`,
      )
      .bind(objectKey)
      .first();
    return row != null;
  } catch (err) {
    console.warn('[mediaStorageGc] isR2ObjectReferencedByActivePost 查询失败', objectKey, err);
    // 失败时保守认为仍被引用，跳过该条 — 不冒险删
    return true;
  }
}

/** 删除 R2 对象 + 减计数 + 标记释放（idempotent）。 */
async function deleteR2ObjectAndDecrement(env: Env, candidate: TierCandidate): Promise<void> {
  await deleteMediaObjectFromStorage(env, candidate.object_key, 'r2');
  if (candidate.size_bytes > 0) {
    await decrementUsage(env, 'r2', candidate.size_bytes);
  }
  const db = resolveIdentityDb(env);
  await db
    .prepare(
      `UPDATE media_object_registry
          SET released_at = ?
        WHERE object_key = ?
          AND released_at IS NULL`,
    )
    .bind(nowIso(), candidate.object_key)
    .run();
}

/**
 * M8-14-8 主入口：水位 ≥ high 时回收可清理对象，直到 ≤ target。
 *
 * 跳过条件（fail-soft，不抛）：
 *   - R2 用量行未初始化或无 bytes_limit
 *   - 当前用量 < 高水位阈值
 *   - 当前用量 ≤ 目标水位阈值（无需清理）
 *
 * 行为：
 *   1. 先扫 Tier 1（已释放/废弃/过期）；无门槛，按批循环
 *   2. 若仍未到目标水位，扫 Tier 2（active + 最早 + 跨库校验）
 *   3. 删够即停；删不够就停（无可回收对象）
 *   4. 不静默删被引用的对象（Tier 2 跨库校验保护）
 */
export async function gcR2ToTargetWatermark(env: Env): Promise<GcR2Result> {
  const result: GcR2Result = {
    skipped: false,
    tier1Deleted: 0,
    tier2Deleted: 0,
    tier2SkippedReferenced: 0,
    bytesReclaimed: 0,
    errors: [],
  };

  // ── 跳过条件 1：R2 用量行未就绪 ───────────────────────────────────
  const r2Row = await readUsageRow(env, 'r2');
  if (!r2Row || r2Row.bytes_limit == null) {
    result.skipped = true;
    result.reason = 'no_r2_row_or_no_limit';
    return result;
  }

  // ── 跳过条件 2：未达高水位 ─────────────────────────────────────────
  const [highWatermark, targetWatermark] = await Promise.all([
    readR2HighWatermark(env),
    readR2TargetWatermark(env),
  ]);
  const highThreshold = r2Row.bytes_limit * highWatermark;
  if (r2Row.bytes_used < highThreshold) {
    result.skipped = true;
    result.reason = 'below_high_watermark';
    return result;
  }

  // ── 跳过条件 3：已低于目标水位 ─────────────────────────────────────
  const targetThreshold = r2Row.bytes_limit * targetWatermark;
  const bytesToFree = r2Row.bytes_used - targetThreshold;
  if (bytesToFree <= 0) {
    result.skipped = true;
    result.reason = 'already_below_target';
    return result;
  }

  let freed = 0;

  // ── Tier 1：已释放 / 已废弃 / 已过期 — 直接回收 ─────────────────────
  let tier1Batches = 0;
  while (freed < bytesToFree && tier1Batches < GC_MAX_BATCHES) {
    tier1Batches += 1;
    const candidates = await queryTier1R2Candidates(env, GC_BATCH_LIMIT);
    if (candidates.length === 0) break;
    for (const c of candidates) {
      try {
        await deleteR2ObjectAndDecrement(env, c);
        result.tier1Deleted += 1;
        result.bytesReclaimed += c.size_bytes;
        freed += c.size_bytes;
        if (freed >= bytesToFree) break;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        result.errors.push(`tier1:${c.object_key}: ${msg}`);
      }
    }
    if (candidates.length < GC_BATCH_LIMIT) break;
  }

  // ── Tier 2：active + 最早 + 跨库校验 ─────────────────────────────
  if (freed < bytesToFree) {
    let offsetCreatedAt: string | null = null;
    let tier2Batches = 0;
    while (freed < bytesToFree && tier2Batches < GC_MAX_BATCHES) {
      tier2Batches += 1;
      const candidates = await queryTier2R2Candidates(env, GC_BATCH_LIMIT, offsetCreatedAt);
      if (candidates.length === 0) break;
      let anyDeletedInBatch = false;
      for (const c of candidates) {
        try {
          const stillReferenced = await isR2ObjectReferencedByActivePost(env, c.object_key);
          if (stillReferenced) {
            // 仍被未删帖引用 — 跳过（防图裂）
            result.tier2SkippedReferenced += 1;
            continue;
          }
          await deleteR2ObjectAndDecrement(env, c);
          result.tier2Deleted += 1;
          result.bytesReclaimed += c.size_bytes;
          freed += c.size_bytes;
          anyDeletedInBatch = true;
          if (freed >= bytesToFree) break;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          result.errors.push(`tier2:${c.object_key}: ${msg}`);
        }
      }
      if (!anyDeletedInBatch) {
        // 本批全是被引用的活跃对象 — 继续往后扫（更晚的更不急着删）
        // 但 offset 仍要推进，否则会死循环
      }
      if (candidates.length < GC_BATCH_LIMIT) break;
      offsetCreatedAt = candidates[candidates.length - 1].created_at;
    }
  }

  // ── 摘要日志（fail-soft 不抛） ─────────────────────────────────────
  if (result.tier1Deleted + result.tier2Deleted > 0 || result.errors.length > 0) {
    console.log(
      `[mediaStorageGc] gcR2ToTargetWatermark tier1=${result.tier1Deleted} tier2=${result.tier2Deleted} skipped_ref=${result.tier2SkippedReferenced} bytes=${result.bytesReclaimed} errors=${result.errors.length}`,
    );
  }

  return result;
}

/** M8-14-10c：清理 IMAGE_KV 中 `kv:` 前缀且无未删帖引用的孤儿公开图。 */
export interface GcOrphanKvResult {
  scanned: number;
  deleted: number;
  skippedReferenced: number;
  bytesReclaimed: number;
  errors: string[];
}

/**
 * 列举 IMAGE_KV `kv:` keys；跳过仍被 posts.image_keys / users.avatar_key 引用的；
 * 其余删存储 + 登记释放 + 减计数，最后 calibrateKvUsage 以 list 为真值收口。
 * 记录附件用 `private-notes:` 前缀，不在本扫描范围内。
 */
export async function gcOrphanKvImages(
  env: Env,
  opts?: { maxKeys?: number },
): Promise<GcOrphanKvResult> {
  const result: GcOrphanKvResult = {
    scanned: 0,
    deleted: 0,
    skippedReferenced: 0,
    bytesReclaimed: 0,
    errors: [],
  };
  if (!env.IMAGE_KV) {
    result.errors.push('IMAGE_KV missing');
    return result;
  }

  // M8-14-10d 默认 5000：生产大桶（IMAGE_KV 软上限约 1 GiB · 单图可达数 MB）
  // 站主偶尔发完大图、KV 累积数 GB 时，500 默认值永远扫不完；5000 一次能覆盖到
  // 大约 25000 张贴图 / 约 1 GiB 上限，足够追上正常增长。
  // 路由 `gc_orphan_kv` PATCH 与 cron 任务都通过 opts?.maxKeys ?? maxKeys 走这一默认值。
  // 路由 / cron 调用方不传 maxKeys 时，自动用 5000。
  const maxKeys = opts?.maxKeys ?? 5000;
  const identityDb = resolveIdentityDb(env);
  let cursor: string | undefined;
  const toDelete: { name: string; size: number }[] = [];

  try {
    while (result.scanned < maxKeys) {
      const listed = await env.IMAGE_KV.list({
        prefix: 'kv:',
        limit: Math.min(1000, maxKeys - result.scanned),
        ...(cursor ? { cursor } : {}),
      });
      for (const key of listed.keys) {
        result.scanned += 1;
        const meta = key.metadata as { size?: unknown } | undefined;
        const size =
          typeof meta?.size === 'number' && Number.isFinite(meta.size) && meta.size >= 0
            ? Math.floor(meta.size)
            : 0;
        const referenced = await isKvObjectReferenced(env, key.name);
        if (referenced) {
          result.skippedReferenced += 1;
          continue;
        }
        toDelete.push({ name: key.name, size });
      }
      if (listed.list_complete || !listed.cursor) break;
      cursor = listed.cursor;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    result.errors.push(`list: ${msg}`);
    console.error('[mediaStorageGc] gcOrphanKvImages list 失败', err);
    return result;
  }

  const iso = new Date().toISOString();
  for (const item of toDelete) {
    try {
      await deleteMediaObjectFromStorage(env, item.name, 'kv');
      // 有登记则减计数并标释放；无登记则仅删 bytes（末尾 calibrate 收口）
      const row = await identityDb
        .prepare(
          `SELECT size_bytes FROM media_object_registry
            WHERE object_key = ? AND released_at IS NULL LIMIT 1`,
        )
        .bind(item.name)
        .first<{ size_bytes: number }>();
      if (row) {
        const delta = row.size_bytes > 0 ? row.size_bytes : item.size;
        if (delta > 0) await decrementUsage(env, 'kv', delta);
        await identityDb
          .prepare(
            `UPDATE media_object_registry SET released_at = ? WHERE object_key = ? AND released_at IS NULL`,
          )
          .bind(iso, item.name)
          .run();
        result.bytesReclaimed += delta;
      } else {
        result.bytesReclaimed += item.size;
      }
      result.deleted += 1;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(`${item.name}: ${msg}`);
      console.warn('[mediaStorageGc] gcOrphanKvImages 删除失败', item.name, err);
    }
  }

  // 以 list 真值重写 kv 用量（防止减计数与孤儿未登记不一致）
  try {
    await calibrateKvUsage(env);
  } catch (err) {
    console.warn('[mediaStorageGc] gcOrphanKvImages 末尾校准失败', err);
  }

  console.log(
    `[mediaStorageGc] gcOrphanKvImages scanned=${result.scanned} deleted=${result.deleted} skipped_ref=${result.skippedReferenced} bytes=${result.bytesReclaimed} errors=${result.errors.length}`,
  );
  return result;
}

/**
 * 未删帖 image_keys / 站主 avatar_key / messaging_media_local 任一仍引用则 true。
 *
 * 公开帖路径（CONTENT_DB posts + IDENTITY_DB users.avatar_key）：SPILL-2-1 用
 *   `json_each` 等值匹配 `posts.image_keys`，子串误匹配风险为零。
 *
 * Messaging 媒体路径（M8-14-10f）：messaging 媒体 storage_key 前缀为 `kv:msg_`/
 *   `r2:msg_`/`b2:msg_`/`filebase:msg_`（与公开帖 `img_` 完全互斥），不会被
 *   `posts.image_keys` 或 `users.avatar_key` 命中。按 `isMessagingMediaStorageKey`
 *   分流后跨 binding 查 MESSAGING_DB `messaging_media_local.local_storage_key`
 *   或 `mirror_of_key`（DM 双方各存一份 / 群成员镜像表）。
 *
 * 失败 fail-soft：异常一律保守返回 true（不删）。
 */
async function isKvObjectReferenced(env: Env, objectKey: string): Promise<boolean> {
  // M8-14-10f：messaging 媒体（msg_ 前缀）分流到 MESSAGING_DB 跨 binding 查引用
  if (isMessagingMediaStorageKey(objectKey)) {
    if (!env.MESSAGING_DB) {
      // 未配置 MESSAGING_DB — 保守认为仍被引用（孤儿 GC 不冒险删 messaging 媒体）
      return true;
    }
    try {
      const row = await env.MESSAGING_DB
        .prepare(
          `SELECT 1 FROM messaging_media_local
            WHERE (local_storage_key = ? OR mirror_of_key = ?)
              AND storage_state NOT IN ('released', 'release_pending', 'missing')
            LIMIT 1`,
        )
        .bind(objectKey, objectKey)
        .first();
      if (row) return true;
      return false;
    } catch (err) {
      console.warn('[mediaStorageGc] isKvObjectReferenced messaging 查询失败', objectKey, err);
      return true;
    }
  }

  try {
    const contentDb = resolveContentDb(env);
    // SPILL-2-1：改用 json_each 等值匹配；旧 LIKE '%"key"%' 在 schema 转义/特殊字符下漏匹配
    const postHit = await contentDb
      .prepare(
        `SELECT 1
           FROM posts, json_each(posts.image_keys) AS je
          WHERE posts.deleted_at IS NULL
            AND je.value = ?
          LIMIT 1`,
      )
      .bind(objectKey)
      .first();
    if (postHit) return true;
  } catch (err) {
    console.warn('[mediaStorageGc] isKvObjectReferenced posts 查询失败', objectKey, err);
    return true;
  }

  try {
    const identityDb = resolveIdentityDb(env);
    const avatarHit = await identityDb
      .prepare(`SELECT 1 FROM users WHERE avatar_key = ? LIMIT 1`)
      .bind(objectKey)
      .first();
    if (avatarHit) return true;
  } catch (err) {
    console.warn('[mediaStorageGc] isKvObjectReferenced avatar 查询失败', objectKey, err);
    return true;
  }

  return false;
}
