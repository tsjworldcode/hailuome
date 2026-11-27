/**
 * M16-P：群消息 overflow 分片路由（§4bis.0.1）。
 * 仅 group_messages / member_group_messages 按 group_id 路由；metadata + dm_* 留 MESSAGING_DB。
 */
import type { Env } from '../env';
import { messagingDb } from './messagingDb';

export type GroupMessageShardId = 'primary' | 'shard_1';

/** 运维显式创建第二 D1 后 wrangler 绑定 MESSAGING_SHARD_1。 */
export function hasMessagingShard1(env: Env): boolean {
  return env.MESSAGING_SHARD_1 != null;
}

function shardDb(env: Env): D1Database {
  if (!env.MESSAGING_SHARD_1) {
    throw new Error('MESSAGING_SHARD_1 binding 未配置');
  }
  return env.MESSAGING_SHARD_1;
}

/**
 * MSG-FIX-6：解析 group_id 当前所在的群消息分片（'primary' | 'shard_1'）。
 *
 * 用途：调用方需要判断「群消息表」与「群元数据表（group_nonces 等）」是否同一个物理库——
 * 同库可单 batch 保原子；异库**必须**拆两步串行（跨库单 batch 会静默写错库，见
 * `isSameD1Database` 注释）。
 */
export async function resolveGroupMessageShardId(
  env: Env,
  groupId: string,
): Promise<GroupMessageShardId> {
  const row = await messagingDb(env)
    .prepare(`SELECT shard_id FROM group_message_shard_routes WHERE group_id = ? LIMIT 1`)
    .bind(groupId)
    .first<{ shard_id: string }>();
  return row?.shard_id === 'shard_1' ? 'shard_1' : 'primary';
}

/**
 * MSG-FIX-6：判断两个 D1 binding 是否**同一个物理库**。
 *
 * 背景：D1 的 `db.batch([...])` 是**绑定在某个 database_id 上的端点**——statement 载荷里
 * 只有 SQL + params，**不带各自的 binding id**。实测（miniflare，`scripts/probe-d1-cross-db-batch.mjs`）：
 * `dbA.batch([dbB.prepare(...)])` **不会抛错**，而是把该 statement **静默执行到 dbA**。
 * 于是「跨库单 batch」不是报错，而是**静默写错库**（split-brain）——比抛错更难发现。
 *
 * 判据：D1Database 实例无公开的 database id，故用「同一 binding 取出的实例」做引用比较：
 * 同库恒为同一引用（`env.MESSAGING_DB`），异库恒为不同引用（`env.MESSAGING_SHARD_1`）。
 */
export function isSameD1Database(a: D1Database, b: D1Database): boolean {
  return a === b;
}

/**
 * MSG-FIX-6：解析群消息表所在的 D1 **及其分片号**（一次查询，供调用方判定是否跨库）。
 *
 * 为什么不用引用比较做主判据：群消息表在 primary 时返回 `messagingDb(env)`（= `env.MESSAGING_DB`），
 * 在 shard_1 时返回 `env.MESSAGING_SHARD_1`——两者必然是**不同 binding**，
 * 故「分片号 === 'primary'」即等价于「与 group_nonces 同库」。该判据不依赖对象引用，
 * 比 `isSameD1Database` 更稳（后者保留作双保险）。
 */
export async function resolveGroupMessagesDbAndShard(
  env: Env,
  groupId: string,
): Promise<{ db: D1Database; shardId: GroupMessageShardId }> {
  const shardId = await resolveGroupMessageShardId(env, groupId);
  if (shardId === 'shard_1') {
    // R-AUDIT-2：缺 binding 禁止回落 primary（避免 split-brain 静默写错库）
    if (!hasMessagingShard1(env)) {
      throw new Error('MESSAGING_SHARD_1_BINDING_MISSING');
    }
    return { db: shardDb(env), shardId };
  }
  return { db: messagingDb(env), shardId };
}

/** 读取 group_id 对应群消息表所在 D1（默认 primary）。 */
export async function resolveGroupMessagesDb(env: Env, groupId: string): Promise<D1Database> {
  const shardId = await resolveGroupMessageShardId(env, groupId);
  if (shardId === 'shard_1') {
    // R-AUDIT-2：缺 binding 禁止回落 primary（避免 split-brain 静默写错库）
    if (!hasMessagingShard1(env)) {
      throw new Error('MESSAGING_SHARD_1_BINDING_MISSING');
    }
    return shardDb(env);
  }
  return messagingDb(env);
}

/** 登记群消息分片路由（迁移脚本 / 运维显式调用）。 */
export async function registerGroupMessageShardRoute(
  env: Env,
  groupId: string,
  shardId: GroupMessageShardId,
): Promise<void> {
  const now = new Date().toISOString();
  await messagingDb(env)
    .prepare(
      `INSERT INTO group_message_shard_routes (group_id, shard_id, routed_at, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(group_id) DO UPDATE SET
         shard_id = excluded.shard_id,
         updated_at = excluded.updated_at`,
    )
    .bind(groupId, shardId, now, now)
    .run();
}

/** 统计已路由到 shard_1 的群数量（Settings / 运维提示）。 */
export async function countShardRoutedGroups(env: Env): Promise<number> {
  const row = await messagingDb(env)
    .prepare(`SELECT COUNT(*) AS cnt FROM group_message_shard_routes WHERE shard_id = 'shard_1'`)
    .first<{ cnt: number }>();
  return Number(row?.cnt ?? 0);
}

/** 群消息是否已登记 shard_1 路由。 */
export async function isGroupRoutedToShard1(env: Env, groupId: string): Promise<boolean> {
  const row = await messagingDb(env)
    .prepare(`SELECT shard_id FROM group_message_shard_routes WHERE group_id = ? LIMIT 1`)
    .bind(groupId)
    .first<{ shard_id: string }>();
  return row?.shard_id === 'shard_1';
}

/** 容量粗算：仅 MESSAGING_DB（primary）上的群消息表字节。 */
export async function sumGroupMessageTableBytesPrimary(
  env: Env,
  table: 'group_messages' | 'member_group_messages',
): Promise<number> {
  const row = await messagingDb(env)
    .prepare(
      `SELECT COALESCE(SUM(LENGTH(ciphertext) + LENGTH(COALESCE(envelope_json, ''))), 0) AS total
         FROM ${table}`,
    )
    .first<{ total: number }>();
  return Number(row?.total ?? 0);
}

/** 跨库场景：按 group_id 读 member_group_messages.envelope_json。 */
export async function fetchMemberGroupEnvelopeJson(
  env: Env,
  groupId: string,
  messageId: string,
): Promise<string | null> {
  const msgDb = await resolveGroupMessagesDb(env, groupId);
  const row = await msgDb
    .prepare(
      `SELECT envelope_json FROM member_group_messages
        WHERE group_id = ? AND message_id = ? LIMIT 1`,
    )
    .bind(groupId, messageId)
    .first<{ envelope_json: string | null }>();
  return row?.envelope_json ?? null;
}

/** 群主侧 group_messages.envelope_json（ticket 校验）。 */
export async function fetchOwnerGroupEnvelopeJson(
  env: Env,
  groupId: string,
  messageId: string,
): Promise<string | null> {
  const msgDb = await resolveGroupMessagesDb(env, groupId);
  const row = await msgDb
    .prepare(
      `SELECT envelope_json FROM group_messages
        WHERE group_id = ? AND message_id = ? LIMIT 1`,
    )
    .bind(groupId, messageId)
    .first<{ envelope_json: string | null }>();
  return row?.envelope_json ?? null;
}

/** 容量粗算：primary + 可选 shard 两库 group/member 表字节合计。 */
export async function sumGroupMessageTableBytesAllShards(
  env: Env,
  table: 'group_messages' | 'member_group_messages',
): Promise<number> {
  const sumOne = async (db: D1Database): Promise<number> => {
    const row = await db
      .prepare(
        `SELECT COALESCE(SUM(LENGTH(ciphertext) + LENGTH(COALESCE(envelope_json, ''))), 0) AS total
           FROM ${table}`,
      )
      .first<{ total: number }>();
    return Number(row?.total ?? 0);
  };

  let total = await sumOne(messagingDb(env));
  if (hasMessagingShard1(env)) {
    total += await sumOne(shardDb(env));
  }
  return total;
}

/** 单群 member 消息字节（含分片路由）。 */
export async function sumGroupMemberMessageBytesForGroup(
  env: Env,
  groupId: string,
): Promise<number> {
  const msgDb = await resolveGroupMessagesDb(env, groupId);
  const row = await msgDb
    .prepare(
      `SELECT COALESCE(SUM(LENGTH(ciphertext) + LENGTH(COALESCE(envelope_json, ''))), 0) AS total
         FROM member_group_messages WHERE group_id = ?`,
    )
    .bind(groupId)
    .first<{ total: number }>();
  return Number(row?.total ?? 0);
}

/**
 * SPILL-2-4：群消息跨片迁移后跨实例 cache 失效。
 *
 * 群消息从 primary 搬到 MESSAGING_SHARD_1 且路由表改写后，若 STATE_KV 上
 * 仍有以 group_id 为粒度的缓存，读路径可能按旧 primary 快照渲染。
 * 登记路由后立即逐 key 删除；fail-soft，单 key 失败仅记日志。
 *
 * 当前生产写路径未必已写入下列 key（预留 / 防御性清单）；delete 幂等。
 * 新前缀加入时同步更新此处与契约测。
 *
 * @returns 删除成功的 key 数（含「键本就不存在」的成功 delete）
 */
export async function invalidateGroupCacheAcrossShards(
  env: Env,
  groupId: string,
): Promise<number> {
  if (!env.STATE_KV) return 0;
  // 已知与群粒度相关的 cache key 前缀；新前缀加入时同步更新此处
  const keys = [
    `group_feed_latest:${groupId}`,
    `group_feed_latest_meta:${groupId}`,
    `group_members_cache:${groupId}`,
    `group_member_envelopes:${groupId}`,
  ];
  let deleted = 0;
  for (const key of keys) {
    try {
      await env.STATE_KV.delete(key);
      deleted += 1;
    } catch (err) {
      console.warn(
        `[messagingShard] invalidateGroupCacheAcrossShards KV.delete 失败（key=${key}）`,
        err,
      );
      // 继续后续 key — 单条失败不影响其它
    }
  }
  return deleted;
}
