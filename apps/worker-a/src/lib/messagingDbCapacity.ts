/**
 * M16-7d：MESSAGING_DB 容量粗算与 retention 预检（m16-group-chat-plan.md §4bis.0.1 / §4bis.3）。
 * Free Tier 单库 500 MB；350 MB 警告、400 MB 硬限（可调 override）。
 * M16-P4e：tier / retention / P4 触发按 primary 单库估算；另返回 total 供 Settings 展示合计。
 */
import { resolveIdentityDb } from '../db/bindings';
import type { Env } from '../env';
import { messagingDb } from './messagingDb';
import {
  countShardRoutedGroups,
  hasMessagingShard1,
  isGroupRoutedToShard1,
  sumGroupMemberMessageBytesForGroup,
  sumGroupMessageTableBytesAllShards,
  sumGroupMessageTableBytesPrimary,
} from './messagingShard';

/** Cloudflare D1 Free 单库上限 */
export const MESSAGING_DB_LIMIT_BYTES = 500 * 1024 * 1024;
/** Settings 黄色警告线 */
export const MESSAGING_DB_WARN_BYTES = 350 * 1024 * 1024;
/** 拒绝延长 retention / >90 天硬限线 */
export const MESSAGING_DB_HARD_BYTES = 400 * 1024 * 1024;
/** 索引 + WAL 余量（§4bis.3 ×1.25～1.3，取 1.28） */
export const MESSAGING_INDEX_OVERHEAD = 1.28;
/** wrapped_keys + nonces 等稳态固定开销（§4bis.3 ~20 MB） */
export const MESSAGING_FIXED_OVERHEAD_BYTES = 20 * 1024 * 1024;
/**
 * CRON-OBSERVABILITY 2026-11-26：`messaging_media_local` 只存元数据（blob 在 KV/R2/B2，不在 D1），
 * 表里也从来没有 `size_bytes` 列 —— 旧实现 `SUM(size_bytes)` 每次 tick 都报 no such column，
 * 自动分片容量估算长期失败。这里改为按行近似 D1 占用（含主键/索引摊销）。
 */
export const MESSAGING_MEDIA_ROW_ESTIMATE_BYTES = 256;

export type MessagingDbCapacityTier = 'normal' | 'warn' | 'hard';

export interface MessagingDbCapacityBreakdown {
  dm_message_bytes: number;
  /** 跨 primary+shard 合计（展示用） */
  group_member_message_bytes: number;
  group_owner_message_bytes: number;
  /** 仅 MESSAGING_DB primary 上的群消息字节 */
  group_member_message_bytes_primary: number;
  group_owner_message_bytes_primary: number;
  media_local_bytes: number;
  fixed_overhead_bytes: number;
  index_overhead_factor: number;
}

export interface MessagingDbCapacitySnapshot {
  /** primary（MESSAGING_DB）估算 — tier / retention / P4 触发依据 */
  estimated_bytes: number;
  estimated_mb: number;
  tier: MessagingDbCapacityTier;
  /** primary + shard 群消息表合计（站主总占用参考） */
  total_estimated_bytes: number;
  total_estimated_mb: number;
  total_tier: MessagingDbCapacityTier;
  warn_threshold_mb: number;
  hard_threshold_mb: number;
  limit_mb: number;
  /** M16-P：运维是否已绑定 MESSAGING_SHARD_1 */
  shard_available: boolean;
  /** M16-P：已路由到 shard_1 的群数量 */
  shard_routed_groups: number;
  breakdown: MessagingDbCapacityBreakdown;
}

export interface MessagingDbCapacityProjectionOptions {
  groupId: string;
  proposedRetentionDays: number;
  currentRetentionDays: number;
}

function bytesToMb(bytes: number): number {
  return Math.round((bytes / (1024 * 1024)) * 10) / 10;
}

export function resolveMessagingDbCapacityTier(estimatedBytes: number): MessagingDbCapacityTier {
  if (estimatedBytes >= MESSAGING_DB_HARD_BYTES) return 'hard';
  if (estimatedBytes >= MESSAGING_DB_WARN_BYTES) return 'warn';
  return 'normal';
}

async function sumDmMessageBytes(env: Env): Promise<number> {
  const db = messagingDb(env);
  // dm_messages 只有 envelope_json（无 ciphertext 列）—— 与 messaging_media_local 同类漂移
  const row = await db
    .prepare(
      `SELECT COALESCE(SUM(LENGTH(envelope_json)), 0) AS total
         FROM dm_messages`,
    )
    .first<{ total: number }>();
  return Number(row?.total ?? 0);
}

async function sumMediaLocalBytes(db: D1Database): Promise<number> {
  // 只统计有本地对象的行；每行按固定元数据开销估算（表里没有 size_bytes 列）
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM messaging_media_local WHERE local_storage_key IS NOT NULL`,
    )
    .first<{ n: number }>();
  return Number(row?.n ?? 0) * MESSAGING_MEDIA_ROW_ESTIMATE_BYTES;
}

function applyIndexOverhead(rawRowBytes: number): number {
  const withFixed = rawRowBytes + MESSAGING_FIXED_OVERHEAD_BYTES;
  return Math.ceil(withFixed * MESSAGING_INDEX_OVERHEAD);
}

/** retention 延长投影：primary 口径跳过已路由 shard 的群。 */
async function applyMemberRetentionProjection(
  env: Env,
  baseMemberBytes: number,
  projection: MessagingDbCapacityProjectionOptions,
  scope: 'primary' | 'total',
): Promise<number> {
  if (scope === 'primary' && (await isGroupRoutedToShard1(env, projection.groupId))) {
    return baseMemberBytes;
  }
  const groupBytes = await sumGroupMemberMessageBytesForGroup(env, projection.groupId);
  const currentDays = Math.max(1, projection.currentRetentionDays);
  const proposedDays = Math.max(1, projection.proposedRetentionDays);
  const ratio = proposedDays / currentDays;
  return baseMemberBytes - groupBytes + Math.ceil(groupBytes * ratio);
}

/** 粗算 MESSAGING_DB 当前体积；tier 按 primary 单库，另返回 total 合计。 */
export async function estimateMessagingDbCapacity(
  env: Env,
  projection?: MessagingDbCapacityProjectionOptions,
): Promise<MessagingDbCapacitySnapshot> {
  const db = messagingDb(env);
  const [
    dmBytes,
    memberPrimary,
    ownerPrimary,
    memberTotal,
    ownerTotal,
    mediaBytes,
  ] = await Promise.all([
    sumDmMessageBytes(env),
    sumGroupMessageTableBytesPrimary(env, 'member_group_messages'),
    sumGroupMessageTableBytesPrimary(env, 'group_messages'),
    sumGroupMessageTableBytesAllShards(env, 'member_group_messages'),
    sumGroupMessageTableBytesAllShards(env, 'group_messages'),
    sumMediaLocalBytes(db),
  ]);

  let adjustedMemberPrimary = memberPrimary;
  let adjustedMemberTotal = memberTotal;
  if (projection) {
    adjustedMemberPrimary = await applyMemberRetentionProjection(
      env,
      memberPrimary,
      projection,
      'primary',
    );
    adjustedMemberTotal = await applyMemberRetentionProjection(
      env,
      memberTotal,
      projection,
      'total',
    );
  }

  const primaryRaw = dmBytes + adjustedMemberPrimary + ownerPrimary + mediaBytes;
  const totalRaw = dmBytes + adjustedMemberTotal + ownerTotal + mediaBytes;
  const estimatedBytes = applyIndexOverhead(primaryRaw);
  const totalEstimatedBytes = applyIndexOverhead(totalRaw);
  const tier = resolveMessagingDbCapacityTier(estimatedBytes);
  const totalTier = resolveMessagingDbCapacityTier(totalEstimatedBytes);
  const shardRoutedGroups = await countShardRoutedGroups(env);

  return {
    estimated_bytes: estimatedBytes,
    estimated_mb: bytesToMb(estimatedBytes),
    tier,
    total_estimated_bytes: totalEstimatedBytes,
    total_estimated_mb: bytesToMb(totalEstimatedBytes),
    total_tier: totalTier,
    warn_threshold_mb: bytesToMb(MESSAGING_DB_WARN_BYTES),
    hard_threshold_mb: bytesToMb(MESSAGING_DB_HARD_BYTES),
    limit_mb: bytesToMb(MESSAGING_DB_LIMIT_BYTES),
    shard_available: hasMessagingShard1(env),
    shard_routed_groups: shardRoutedGroups,
    breakdown: {
      dm_message_bytes: dmBytes,
      group_member_message_bytes: adjustedMemberTotal,
      group_owner_message_bytes: ownerTotal,
      group_member_message_bytes_primary: adjustedMemberPrimary,
      group_owner_message_bytes_primary: ownerPrimary,
      media_local_bytes: mediaBytes,
      fixed_overhead_bytes: MESSAGING_FIXED_OVERHEAD_BYTES,
      index_overhead_factor: MESSAGING_INDEX_OVERHEAD,
    },
  };
}

export function isMessagingCapacityOverrideEnabled(env: Env): boolean {
  return env.MESSAGING_CAPACITY_OVERRIDE === 'true';
}

/** PUT settings 前：延长 retention 须通过容量预检（按 primary 单库）。 */
export async function assertGroupRetentionCapacityAllowed(
  env: Env,
  input: { groupId: string; proposedDays: number; currentDays: number },
): Promise<{ ok: true } | { ok: false; status: 409; error_code: string; message: string }> {
  if (isMessagingCapacityOverrideEnabled(env)) {
    return { ok: true };
  }

  const currentDays = Math.max(1, input.currentDays);
  const { proposedDays, groupId } = input;

  // 缩短或不变：不增加占用，始终允许
  if (proposedDays <= currentDays) {
    return { ok: true };
  }

  const current = await estimateMessagingDbCapacity(env);
  const projected = await estimateMessagingDbCapacity(env, {
    groupId,
    proposedRetentionDays: proposedDays,
    currentRetentionDays: currentDays,
  });

  const atHard =
    current.estimated_bytes >= MESSAGING_DB_HARD_BYTES ||
    projected.estimated_bytes >= MESSAGING_DB_HARD_BYTES;

  if (atHard) {
    if (proposedDays > 90) {
      return {
        ok: false,
        status: 409,
        error_code: 'MESSAGING_DB_CAPACITY_HARD',
        message:
          '主会话库已接近 Free Tier 上限（预估 ≥400 MB），无法将群消息保留天数设为超过 90 天；请缩短保留期、清理历史或联系运维启用扩容方案（M16-P）。',
      };
    }
    return {
      ok: false,
      status: 409,
      error_code: 'MESSAGING_DB_CAPACITY_HARD',
      message:
        '主会话库已接近 Free Tier 上限（预估 ≥400 MB），无法继续延长群消息保留天数；请缩短保留期、清理历史后再试。',
    };
  }

  if (projected.estimated_bytes >= MESSAGING_DB_WARN_BYTES) {
    return {
      ok: false,
      status: 409,
      error_code: 'MESSAGING_DB_CAPACITY_WARN',
      message: `按当前活跃度估算，保留 ${proposedDays} 天将使主会话库达到约 ${projected.estimated_mb} MB（≥350 MB 警告线）；请缩短保留天数或清理历史后再试。`,
    };
  }

  return { ok: true };
}

async function readSystemConfig(db: D1Database, key: string): Promise<string | null> {
  const row = await db.prepare('SELECT value FROM system_config WHERE key = ? LIMIT 1').bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

async function writeSystemConfig(db: D1Database, key: string, value: string): Promise<void> {
  const now = new Date().toISOString();
  await db.prepare('INSERT OR REPLACE INTO system_config (key, value, updated_at) VALUES (?, ?, ?)').bind(key, value, now).run();
}

const WATERMARK_LOG_KEY = 'messaging_db_watermark_last_log';
const WATERMARK_LOG_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Cron GC 后：primary ≥350 MB 时打 `[messaging/watermark]`（24h 同 tier 去重）。 */
export async function maybeLogMessagingDbWatermark(env: Env): Promise<void> {
  const snap = await estimateMessagingDbCapacity(env);
  if (snap.tier === 'normal') return;

  const now = Date.now();
  const lastRaw = await readSystemConfig(resolveIdentityDb(env), WATERMARK_LOG_KEY);
  if (lastRaw) {
    try {
      const prev = JSON.parse(lastRaw) as { tier: string; at: number };
      if (prev.tier === snap.tier && now - prev.at < WATERMARK_LOG_INTERVAL_MS) {
        return;
      }
    } catch {
      // 损坏配置：继续写新日志
    }
  }

  console.log(
    '[messaging/watermark]',
    JSON.stringify({
      tier: snap.tier,
      estimated_mb: snap.estimated_mb,
      estimated_bytes: snap.estimated_bytes,
      total_estimated_mb: snap.total_estimated_mb,
      at: new Date().toISOString(),
    }),
  );

  await writeSystemConfig(resolveIdentityDb(env), WATERMARK_LOG_KEY, JSON.stringify({ tier: snap.tier, at: now }));
}
