/**
 * M16-5：群聊 Cron（sync 双档 / outbox 重试 / mirror 重试 / 群主 relay_tree 维护）。
 */
import { resolveIdentityDb } from '../db/bindings';
import { randomDmNonceHex, signGroupSyncRequest } from '@hailuo/shared-crypto';
import type { GroupSyncRequest } from '@hailuo/shared-types';
import type { Env } from '../env';
import { parseGroupMessageEnvelope } from './groupEnvelope';
import { deliverMemberEnvelopeToPrimary } from './groupMessage';
import { mirrorGroupMediaFromSender } from './groupMediaMirror';
import { gcGroupRetention } from './groupGc';
import { scanAndKickEmptyAckMembers } from './groupKick';
import { messagingDb } from './messagingDb';
import { fetchMemberGroupEnvelopeJson } from './messagingShard';
import { normalizeGroupMemberUrl } from './groupMemberUrl';
import { recomputeAndPersistRelayTree, catchupFanoutGroupRelay, GROUP_REBUILD_COOLDOWN_MS } from './groupRelayTree';
import { runGroupSyncWithParent } from './groupSync';

/** m16-group-chat-plan.md §1.2 */
export const GROUP_SYNC_INTERVAL_ACTIVE_MS = 15 * 60 * 1000;
export const GROUP_SYNC_INTERVAL_UNSYNCED_MS = 30 * 60 * 1000;
export const GROUP_TREE_RECOMPUTE_INTERVAL_MS = 15 * 60 * 1000;
export const GROUP_SYNC_CRON_BATCH_DEFAULT = 10;
/** 与 cronBudget 的 group-sync-batch 外部估算(10)对齐；超过 10 会单次超 50 子请求。 */
export const GROUP_SYNC_CRON_BATCH_MAX = 10;
/** 与 cronBudget 的 group-outbox-retry 外部估算(5)对齐：每条 1 次外部投递。 */
export const GROUP_OUTBOX_RETRY_BATCH = 5;
/** 与 cronBudget 的 group-media-mirror-retry 外部估算(4)对齐：每条最多 2 次外部（拉取 + B2/Filebase 写入）。 */
export const GROUP_MIRROR_RETRY_BATCH = 2;
/** 单次 owner-maintenance 最多重建/补发 1 个群；每个群 catchup fanout 最多 8 次外部。 */
export const GROUP_PENDING_REBUILD_BATCH = 1;

const GROUP_SYNC_TTL_MS = 5 * 60 * 1000;
const OUTBOX_BACKOFF_MS = [60_000, 300_000, 900_000, 3_600_000];
const OUTBOX_MAX_RETRIES = 8;
const MIRROR_RETRY_BACKOFF_MS = [60_000, 300_000, 900_000, 3_600_000];

function nowIso(): string {
  return new Date().toISOString();
}

function parseSyncBatch(env: Env): number {
  const raw = env.GROUP_SYNC_CRON_BATCH;
  if (!raw) return GROUP_SYNC_CRON_BATCH_DEFAULT;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0
    ? Math.min(n, GROUP_SYNC_CRON_BATCH_MAX)
    : GROUP_SYNC_CRON_BATCH_DEFAULT;
}

async function getLocalUser(env: Env) {
  return resolveIdentityDb(env).prepare(`SELECT handle, pubkey, worker_b_url FROM users LIMIT 1`).first<{
    handle: string;
    pubkey: string;
    worker_b_url: string;
  }>();
}

async function buildCronSyncRequest(
  env: Env,
  groupId: string,
  localUser: { handle: string; worker_b_url: string },
  ownerWorkerBUrl: string,
  epoch: number,
  cursor: string | null,
): Promise<GroupSyncRequest> {
  const now = nowIso();
  const unsigned = {
    v: 1 as const,
    kind: 'GROUP_SYNC' as const,
    group_id: groupId,
    sender_handle: localUser.handle.trim().toLowerCase(),
    sender_worker_b_url: normalizeGroupMemberUrl(localUser.worker_b_url),
    owner_worker_b_url: normalizeGroupMemberUrl(ownerWorkerBUrl),
    epoch,
    created_at: now,
    expires_at: new Date(Date.now() + GROUP_SYNC_TTL_MS).toISOString(),
    nonce: randomDmNonceHex(16),
    cursor,
    acks: [] as string[],
    heartbeat: true as const,
  };
  const sig = await signGroupSyncRequest(unsigned, env.ED25519_PRIVATE_KEY);
  return { ...unsigned, sig };
}

function isSyncDue(
  lastSyncAt: string | null,
  syncTier: string,
  nowMs: number,
): boolean {
  const interval =
    syncTier === 'unsynced' ? GROUP_SYNC_INTERVAL_UNSYNCED_MS : GROUP_SYNC_INTERVAL_ACTIVE_MS;
  if (!lastSyncAt) return true;
  const last = new Date(lastSyncAt).getTime();
  return !Number.isFinite(last) || nowMs - last >= interval;
}

/**
 * 成员节点：Cron 反向 sync-with-parent（每 tick 最多 N 群，hash jitter 错峰）。
 */
export async function runGroupSyncCronBatch(env: Env, minute: number): Promise<number> {
  const localUser = await getLocalUser(env);
  if (!localUser?.worker_b_url) return 0;

  const localUrl = normalizeGroupMemberUrl(localUser.worker_b_url);
  const batchLimit = parseSyncBatch(env);
  const nowMs = Date.now();
  const db = messagingDb(env);

  const { results: rows } = await db
    .prepare(
      `SELECT g.group_id, g.owner_worker_b_url, g.epoch, g.dissolved_at,
              s.parent_worker_b_url, s.cursor, s.sync_tier, s.last_sync_at
         FROM groups g
         INNER JOIN group_members gm
           ON gm.group_id = g.group_id AND gm.member_worker_b_url = ?
         LEFT JOIN group_sync_state s ON s.group_id = g.group_id
        WHERE gm.status = 'active'
          AND gm.role != 'owner'
          AND g.dissolved_at IS NULL
          AND g.owner_worker_b_url != ?`,
    )
    .bind(localUrl, localUrl)
    .all<{
      group_id: string;
      owner_worker_b_url: string;
      epoch: number;
      parent_worker_b_url: string | null;
      cursor: string | null;
      sync_tier: string | null;
      last_sync_at: string | null;
    }>();

  // M13-12 之后 group-sync-batch 只挂 5/15/25/35/45（minute % 5 === 0）；
  // 旧的 `hash % 5 === minute % 5` 错峰会让 minute % 5 恒为 0 → 只有 hash%5==0 的群能同步，
  // 其余 4/5 的群永远 unsynced、收不到消息。改为：全部到期群按 last_sync_at 轮转 + batchLimit 限流。
  const due = (rows ?? [])
    .filter((row) => isSyncDue(row.last_sync_at, row.sync_tier ?? 'unsynced', nowMs))
    .sort((a, b) => {
      const ta = a.last_sync_at ? new Date(a.last_sync_at).getTime() : 0;
      const tb = b.last_sync_at ? new Date(b.last_sync_at).getTime() : 0;
      return ta - tb;
    })
    .slice(0, batchLimit);

  let synced = 0;
  for (const row of due) {
    const signed = await buildCronSyncRequest(
      env,
      row.group_id,
      localUser,
      row.owner_worker_b_url,
      row.epoch,
      row.cursor,
    );
    const result = await runGroupSyncWithParent(env, row.group_id, localUser, signed);
    if (result.ok) synced += 1;
    else console.warn('[group/cron] sync 失败', row.group_id, result.error_code);
  }

  if (synced > 0) {
    console.log('[group/cron] sync batch', JSON.stringify({ synced, attempted: due.length, minute }));
  }
  return synced;
}

/** 成员 outbox 重试（纯 D1 + 1 外部 fetch/条）。 */
export async function retryGroupOutboxBatch(env: Env): Promise<number> {
  const now = nowIso();
  const db = messagingDb(env);
  const { results } = await db
    .prepare(
      `SELECT message_id, group_id, owner_worker_b_url, envelope_json, retry_count
         FROM group_outbox
        WHERE state IN ('pending', 'failed')
          AND next_retry_at <= ?
          AND retry_count < ?
        ORDER BY next_retry_at ASC
        LIMIT ?`,
    )
    .bind(now, OUTBOX_MAX_RETRIES, GROUP_OUTBOX_RETRY_BATCH)
    .all<{
      message_id: string;
      group_id: string;
      owner_worker_b_url: string;
      envelope_json: string;
      retry_count: number;
    }>();

  let retried = 0;
  for (const row of results ?? []) {
    const envelope = parseGroupMessageEnvelope(JSON.parse(row.envelope_json));
    if (!envelope) continue;

    const delivery = await deliverMemberEnvelopeToPrimary(env, envelope, row.owner_worker_b_url);
    const nextCount = row.retry_count + (delivery.ok ? 0 : 1);
    const state = delivery.ok ? 'sent' : nextCount >= OUTBOX_MAX_RETRIES ? 'dead' : 'failed';
    const backoff = OUTBOX_BACKOFF_MS[Math.min(nextCount, OUTBOX_BACKOFF_MS.length - 1)]!;
    const nextRetry = delivery.ok ? now : new Date(Date.now() + backoff).toISOString();

    await db
      .prepare(
        `UPDATE group_outbox
            SET state = ?, retry_count = ?, next_retry_at = ?, last_error = ?, updated_at = ?
          WHERE message_id = ?`,
      )
      .bind(
        state,
        delivery.ok ? row.retry_count : nextCount,
        nextRetry,
        delivery.ok ? null : delivery.message,
        nowIso(),
        row.message_id,
      )
      .run();
    retried += 1;
  }
  return retried;
}

/** messaging_media_local mirror_pending 重试（fail-soft）。 */
export async function retryGroupMediaMirrorBatch(env: Env): Promise<number> {
  const now = nowIso();
  const db = messagingDb(env);
  const { results } = await db
    .prepare(
      `SELECT message_id, media_id, group_id
         FROM messaging_media_local
        WHERE storage_state = 'mirror_pending'
          AND group_id IS NOT NULL
          AND (retry_at IS NULL OR retry_at <= ?)
        LIMIT ?`,
    )
    .bind(now, GROUP_MIRROR_RETRY_BATCH)
    .all<{ message_id: string; media_id: string; group_id: string }>();

  let retried = 0;
  for (const row of results ?? []) {
    const envelopeJson = await fetchMemberGroupEnvelopeJson(env, row.group_id, row.message_id);
    if (!envelopeJson) continue;
    const envelope = parseGroupMessageEnvelope(JSON.parse(envelopeJson));
    if (!envelope?.media) continue;

    const prevRetry = await db
      .prepare(`SELECT retry_at FROM messaging_media_local WHERE message_id = ? AND media_id = ?`)
      .bind(row.message_id, row.media_id)
      .first<{ retry_at: string | null }>();

    try {
      await mirrorGroupMediaFromSender(env, envelope);
    } catch (err) {
      console.warn('[group/cron] mirror 重试异常', row.message_id, err);
    }

    const stillPending = await db
      .prepare(
        `SELECT storage_state FROM messaging_media_local WHERE message_id = ? AND media_id = ?`,
      )
      .bind(row.message_id, row.media_id)
      .first<{ storage_state: string }>();

    if (stillPending?.storage_state === 'mirror_pending') {
      const attempt = prevRetry?.retry_at ? 2 : 1;
      const backoff = MIRROR_RETRY_BACKOFF_MS[Math.min(attempt, MIRROR_RETRY_BACKOFF_MS.length - 1)]!;
      await db
        .prepare(
          `UPDATE messaging_media_local SET retry_at = ?, updated_at = ? WHERE message_id = ? AND media_id = ?`,
        )
        .bind(new Date(Date.now() + backoff).toISOString(), nowIso(), row.message_id, row.media_id)
        .run();
    }
    retried += 1;
  }
  return retried;
}

/** M16-SLA-3：冷却期满且有待上树成员时立即触发重建（不等下次 cron 间隔）。 */
export async function triggerPendingRebuilds(env: Env): Promise<number> {
  const localUser = await getLocalUser(env);
  if (!localUser?.worker_b_url) return 0;

  const localUrl = normalizeGroupMemberUrl(localUser.worker_b_url);
  const db = messagingDb(env);
  const nowMs = Date.now();

  const { results: pendingGroups } = await db
    .prepare(
      `SELECT DISTINCT g.group_id, g.last_rebuilt_at
         FROM groups g
         INNER JOIN group_pending_members pm ON pm.group_id = g.group_id
        WHERE g.owner_worker_b_url = ? AND g.dissolved_at IS NULL
        ORDER BY g.last_rebuilt_at ASC
        LIMIT ?`,
    )
    .bind(localUrl, GROUP_PENDING_REBUILD_BATCH)
    .all<{ group_id: string; last_rebuilt_at: string | null }>();

  let triggered = 0;
  for (const row of pendingGroups ?? []) {
    const lastBuiltAt = row.last_rebuilt_at ? new Date(row.last_rebuilt_at).getTime() : 0;
    if (nowMs - lastBuiltAt < GROUP_REBUILD_COOLDOWN_MS) continue;
    try {
      const result = await recomputeAndPersistRelayTree(env, row.group_id);
      if (result?.rebuilt) {
        triggered++;
        console.log('[group/cron] pending rebuild 触发', row.group_id, `pending_merged=${result.pending_merged}`);
        // M16-SLA-5：重建完成后由群主沿新树补发 [gap_start, gap_end] 内历史消息到新成员。
        // 默认 limit=1（单 invocation 一条 envelope 一次 fanoutGroupRelay）；多 invocation 续发由下次 cron tick 接力。
        try {
          const catchup = await catchupFanoutGroupRelay(env, row.group_id, localUrl, result.tree_id);
          if (!catchup.skipped) {
            console.log(
              '[group/cron] catchup fanout',
              row.group_id,
              `treeId=${result.tree_id}`,
              `gap=[${catchup.gapStart}, ${catchup.gapEnd}]`,
              `msgs=${catchup.messageCount}`,
              `success=${catchup.success}/${catchup.messageCount}`,
              `failed=${catchup.failed}`,
            );
          } else {
            console.log(
              '[group/cron] catchup fanout skipped',
              row.group_id,
              `reason=${catchup.reason}`,
              `treeId=${result.tree_id}`,
            );
          }
        } catch (catchupErr) {
          // M16-SLA-5：补发失败不阻断后续 cron；下次 cron 接力。
          console.warn('[group/cron] catchup fanout 失败', row.group_id, catchupErr);
        }
      }
    } catch (err) {
      console.warn('[group/cron] pending rebuild 失败', row.group_id, err);
    }
  }
  return triggered;
}

/** 群主节点：relay_tree 定时重算兜底（≥15min）+ pending 冷却期满即时触发 + 空 ack 踢人。 */
export async function runOwnerGroupMaintenanceCron(env: Env): Promise<void> {
  const pendingTriggered = await triggerPendingRebuilds(env);

  const localUser = await getLocalUser(env);
  if (!localUser?.worker_b_url) return;

  const localUrl = normalizeGroupMemberUrl(localUser.worker_b_url);
  const db = messagingDb(env);
  const cutoff = new Date(Date.now() - GROUP_TREE_RECOMPUTE_INTERVAL_MS).toISOString();

  const { results: owned } = await db
    .prepare(
      `SELECT group_id FROM groups
        WHERE owner_worker_b_url = ? AND dissolved_at IS NULL AND updated_at <= ?`,
    )
    .bind(localUrl, cutoff)
    .all<{ group_id: string }>();

  for (const row of owned ?? []) {
    try {
      await recomputeAndPersistRelayTree(env, row.group_id);
    } catch (err) {
      console.warn('[group/cron] relay_tree 重算失败', row.group_id, err);
    }
  }

  const kicked = await scanAndKickEmptyAckMembers(env);
  if (kicked > 0) {
    console.log('[group/cron] empty_ack 路由降级兜底', kicked);
  }
}

export { gcGroupRetention };
