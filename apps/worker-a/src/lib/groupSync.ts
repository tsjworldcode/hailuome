// M16-3：反向 sync-with-parent（ack↑ + 消息/树/密钥↓）。

import { verifyGroupSyncRequest } from '@hailuo/shared-crypto';
import type { GroupRelayTreeDown, GroupSyncDown, GroupSyncMessage, GroupSyncRequest } from '@hailuo/shared-types';
import type { Env } from '../env';
import { fetchOutboundPeer } from './fetchOutboundPeer';
import {
  loadOwnerMembershipPin,
  upsertLocalOwnerMembershipPin,
} from './groupInvite';
import { isGroupSyncExpired, parseGroupSyncRequest } from './groupSyncEnvelope';
import { normalizeGroupMemberUrl } from './groupMemberUrl';
import { checkAndIncrementGroupSyncRate } from './groupRateLimit';
import { processEmptyAckKickIfNeeded } from './groupKick';
import { messagingDb } from './messagingDb';
import { resolveGroupMessagesDb } from './messagingShard';

/** GRP-RELAY-AUTH-PIN-1：把本机群主 pin 拼进 sync 下行（无 pin 则省略）。 */
export function ownerPinFieldsForSyncDown(
  pin: { owner_handle: string; owner_pubkey: string } | null,
): Pick<GroupSyncDown, 'owner_handle' | 'owner_pubkey'> {
  if (!pin?.owner_pubkey) return {};
  return {
    owner_handle: pin.owner_handle,
    owner_pubkey: pin.owner_pubkey,
  };
}

/** 单次 sync 下行消息条数上限。 */
export const GROUP_SYNC_MESSAGE_BATCH = 50;
/** E-4：父节点连续 sync 失败达到此值 → unsynced 直连群主。 */
export const GROUP_PARENT_SYNC_FAIL_THRESHOLD = 2;

export type GroupSyncError = {
  ok: false;
  error_code: string;
  message: string;
  status: 400 | 403 | 404 | 409 | 429 | 500 | 502;
};

export type GroupSyncOk = { ok: true; data: GroupSyncDown };

function nowIso(): string {
  return new Date().toISOString();
}

/** unsynced 或 E-4 降级后：直连群主；active 在树时问 relay parent。 */
function resolveSyncParentUrl(
  syncState: { parent_worker_b_url: string; sync_tier: string } | null,
  ownerUrl: string,
): string {
  const owner = normalizeGroupMemberUrl(ownerUrl);
  if (!syncState || syncState.sync_tier === 'unsynced') {
    return owner;
  }
  return normalizeGroupMemberUrl(syncState.parent_worker_b_url);
}

type GroupSyncStateRow = {
  parent_worker_b_url: string;
  cursor: string | null;
  sync_tier: string;
  local_retention_days: number;
  parent_sync_fail_streak: number;
};

async function loadGroupSyncState(db: D1Database, groupId: string): Promise<GroupSyncStateRow | null> {
  return db
    .prepare(
      `SELECT parent_worker_b_url, cursor, sync_tier, local_retention_days, parent_sync_fail_streak
         FROM group_sync_state WHERE group_id = ? LIMIT 1`,
    )
    .bind(groupId)
    .first<GroupSyncStateRow>();
}

/** E-4：父节点 unreachable/reject 时累加；达阈值改 unsynced + parent=owner。 */
async function recordParentSyncFailure(
  env: Env,
  groupId: string,
  ownerUrl: string,
  attemptedParentUrl: string,
  syncState: GroupSyncStateRow | null,
): Promise<void> {
  const owner = normalizeGroupMemberUrl(ownerUrl);
  const attempted = normalizeGroupMemberUrl(attemptedParentUrl);
  if (attempted === owner) return;

  const now = nowIso();
  const db = messagingDb(env);
  const streak = (syncState?.parent_sync_fail_streak ?? 0) + 1;

  if (streak >= GROUP_PARENT_SYNC_FAIL_THRESHOLD) {
    console.warn(
      '[group/sync] E-4 父节点连续失败，降级 unsynced 直连群主',
      JSON.stringify({ group_id: groupId, streak, attempted_parent: attempted }),
    );
    const retention = syncState?.local_retention_days ?? 90;
    const cursor = syncState?.cursor ?? null;
    await db
      .prepare(
        `INSERT INTO group_sync_state
           (group_id, parent_worker_b_url, cursor, sync_tier, local_retention_days,
            parent_sync_fail_streak, last_sync_at, updated_at)
         VALUES (?, ?, ?, 'unsynced', ?, 0, NULL, ?)
         ON CONFLICT(group_id) DO UPDATE SET
           parent_worker_b_url = excluded.parent_worker_b_url,
           sync_tier = 'unsynced',
           parent_sync_fail_streak = 0,
           updated_at = excluded.updated_at`,
      )
      .bind(groupId, owner, cursor, retention, now)
      .run();
    return;
  }

  await db
    .prepare(
      `INSERT INTO group_sync_state
         (group_id, parent_worker_b_url, cursor, sync_tier, local_retention_days,
          parent_sync_fail_streak, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(group_id) DO UPDATE SET
         parent_sync_fail_streak = excluded.parent_sync_fail_streak,
         updated_at = excluded.updated_at`,
    )
    .bind(
      groupId,
      syncState?.parent_worker_b_url ?? attempted,
      syncState?.cursor ?? null,
      syncState?.sync_tier ?? 'active',
      syncState?.local_retention_days ?? 90,
      streak,
      now,
    )
    .run();
}

async function resetParentSyncFailStreak(env: Env, groupId: string): Promise<void> {
  await messagingDb(env)
    .prepare(`UPDATE group_sync_state SET parent_sync_fail_streak = 0 WHERE group_id = ?`)
    .bind(groupId)
    .run();
}

async function consumeGroupSyncNonce(
  env: Env,
  groupId: string,
  nonce: string,
  createdAt: string,
): Promise<boolean> {
  try {
    await messagingDb(env)
      .prepare(`INSERT INTO group_nonces (group_id, nonce, created_at) VALUES (?, ?, ?)`)
      .bind(groupId, nonce, createdAt)
      .run();
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('UNIQUE') || message.includes('constraint')) {
      return false;
    }
    throw err;
  }
}

async function getMemberRow(
  env: Env,
  groupId: string,
  memberUrl: string,
): Promise<{
  member_pubkey: string;
  member_handle: string;
  status: string;
  key_state: string;
  role: string;
  empty_ack_streak: number;
} | null> {
  return messagingDb(env)
    .prepare(
      `SELECT member_pubkey, member_handle, status, key_state, role, empty_ack_streak
         FROM group_members WHERE group_id = ? AND member_worker_b_url = ? LIMIT 1`,
    )
    .bind(groupId, normalizeGroupMemberUrl(memberUrl))
    .first();
}

function hasEffectiveAck(request: GroupSyncRequest): boolean {
  if (request.acks.length > 0) return true;
  return request.heartbeat === true;
}

async function recordMemberAcks(
  env: Env,
  groupId: string,
  memberUrl: string,
  acks: string[],
  cursor: string | null,
): Promise<void> {
  if (acks.length === 0 && !cursor) return;
  const now = nowIso();
  await messagingDb(env)
    .prepare(
      `INSERT INTO group_message_acks
       (group_id, member_worker_b_url, cursor, acks_json, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(groupId, normalizeGroupMemberUrl(memberUrl), cursor, JSON.stringify(acks), now)
    .run();
}

async function updateMemberAckState(
  env: Env,
  groupId: string,
  memberUrl: string,
  effective: boolean,
  hasDownstreamDelta: boolean,
): Promise<void> {
  const now = nowIso();
  if (effective || hasDownstreamDelta) {
    await messagingDb(env)
      .prepare(
        `UPDATE group_members
         SET last_ack_at = ?, empty_ack_streak = 0
         WHERE group_id = ? AND member_worker_b_url = ?`,
      )
      .bind(now, groupId, normalizeGroupMemberUrl(memberUrl))
      .run();
    return;
  }

  await messagingDb(env)
    .prepare(
      `UPDATE group_members
       SET empty_ack_streak = empty_ack_streak + 1
       WHERE group_id = ? AND member_worker_b_url = ?`,
    )
    .bind(groupId, normalizeGroupMemberUrl(memberUrl))
    .run();
}

async function fetchMessagesSinceCursor(
  env: Env,
  table: 'group_messages' | 'member_group_messages',
  groupId: string,
  cursor: string | null,
): Promise<GroupSyncMessage[]> {
  const db = await resolveGroupMessagesDb(env, groupId);
  // MSG-FIX-4：对外 cursor 仍是 message_id；服务端翻译为 after_seq，杜绝客户端时钟空洞
  let afterSeq = 0;
  if (cursor) {
    const cursorRow = await db
      .prepare(`SELECT recv_seq FROM ${table} WHERE message_id = ? AND group_id = ? LIMIT 1`)
      .bind(cursor, groupId)
      .first<{ recv_seq: number | null }>();
    if (cursorRow?.recv_seq != null && Number.isFinite(Number(cursorRow.recv_seq))) {
      afterSeq = Number(cursorRow.recv_seq);
    } else {
      // 缺 seq（不应发生若回填完整）→ fail-soft 从 0 重拉一页
      console.warn('[group/sync] cursor 行缺 recv_seq，fail-soft 从 0 拉');
      afterSeq = 0;
    }
  }

  const { results } = await db
    .prepare(
      `SELECT message_id, group_id, epoch, sender_worker_b_url, sender_handle, msg_kind, ciphertext, created_at, envelope_json, recv_seq
         FROM ${table}
        WHERE group_id = ? AND recv_seq IS NOT NULL AND recv_seq > ?
        ORDER BY recv_seq ASC
        LIMIT ?`,
    )
    .bind(groupId, afterSeq, GROUP_SYNC_MESSAGE_BATCH)
    .all<{
      message_id: string;
      group_id: string;
      epoch: number;
      sender_worker_b_url: string;
      sender_handle: string;
      msg_kind: 'chat' | 'system';
      ciphertext: string;
      created_at: string;
      envelope_json: string | null;
      recv_seq: number | null;
    }>();

  return (results ?? []).map((row) => ({
    message_id: row.message_id,
    group_id: row.group_id,
    epoch: row.epoch,
    sender_worker_b_url: row.sender_worker_b_url,
    sender_handle: row.sender_handle,
    msg_kind: row.msg_kind,
    ciphertext: row.ciphertext,
    created_at: row.created_at,
    ...(row.recv_seq != null ? { recv_seq: Number(row.recv_seq) } : {}),
    ...(row.envelope_json ? { envelope_json: row.envelope_json } : {}),
  }));
}

async function buildRelayTreeDown(env: Env, groupId: string, treeId: number): Promise<GroupRelayTreeDown | null> {
  const db = messagingDb(env);
  const { results: edgeRows } = await db
    .prepare(
      `SELECT parent_worker_b_url, child_worker_b_url FROM group_relay_edges
        WHERE group_id = ? AND tree_id = ?`,
    )
    .bind(groupId, treeId)
    .all<{ parent_worker_b_url: string; child_worker_b_url: string }>();

  if (!edgeRows?.length) return null;

  const { results: seedRows } = await db
    .prepare(
      `SELECT member_worker_b_url FROM group_members
        WHERE group_id = ? AND role = 'seed' AND status = 'active'`,
    )
    .bind(groupId)
    .all<{ member_worker_b_url: string }>();

  return {
    tree_id: treeId,
    seeds: (seedRows ?? []).map((r) => normalizeGroupMemberUrl(r.member_worker_b_url)),
    edges: edgeRows.map((e) => ({
      parent_worker_b_url: normalizeGroupMemberUrl(e.parent_worker_b_url),
      child_worker_b_url: normalizeGroupMemberUrl(e.child_worker_b_url),
    })),
  };
}

async function validateSyncRequestBase(
  env: Env,
  request: GroupSyncRequest,
): Promise<
  | { ok: true; member: NonNullable<Awaited<ReturnType<typeof getMemberRow>>>; senderUrl: string }
  | GroupSyncError
> {
  if (isGroupSyncExpired(request)) {
    return { ok: false, status: 400, error_code: 'GROUP_MESSAGE_EXPIRED', message: 'sync 请求已过期' };
  }

  const senderUrl = normalizeGroupMemberUrl(request.sender_worker_b_url);
  if (senderUrl !== normalizeGroupMemberUrl(request.sender_worker_b_url)) {
    return { ok: false, status: 400, error_code: 'GROUP_ENVELOPE_INVALID', message: 'sender_worker_b_url 无效' };
  }

  const member = await getMemberRow(env, request.group_id, senderUrl);
  if (!member || member.status !== 'active') {
    return { ok: false, status: 403, error_code: 'GROUP_NOT_MEMBER', message: '同步方非在册成员' };
  }
  if (member.member_handle !== request.sender_handle) {
    return { ok: false, status: 400, error_code: 'GROUP_ENVELOPE_INVALID', message: 'sender_handle 与 membership 不一致' };
  }

  if (!(await checkAndIncrementGroupSyncRate(env, request.group_id, senderUrl))) {
    return { ok: false, status: 429, error_code: 'GROUP_RATE_LIMITED', message: 'sync 过于频繁，请稍后再试' };
  }

  if (!(await verifyGroupSyncRequest(request, member.member_pubkey))) {
    return { ok: false, status: 400, error_code: 'GROUP_ENVELOPE_INVALID', message: 'sync 签名无效' };
  }

  if (!(await consumeGroupSyncNonce(env, request.group_id, request.nonce, request.created_at))) {
    return { ok: false, status: 409, error_code: 'GROUP_NONCE_REPLAY', message: 'nonce 重复（防重放）' };
  }

  return { ok: true, member, senderUrl };
}

/** 群主权威：seed/未同步成员 sync-with-parent 对端。 */
export async function handleOwnerSyncWithParent(
  env: Env,
  request: GroupSyncRequest,
  localOwnerUrl: string,
): Promise<GroupSyncOk | GroupSyncError> {
  const ownerUrl = normalizeGroupMemberUrl(localOwnerUrl);
  if (normalizeGroupMemberUrl(request.owner_worker_b_url) !== ownerUrl) {
    return { ok: false, status: 400, error_code: 'GROUP_ENVELOPE_INVALID', message: 'owner_worker_b_url 不匹配' };
  }

  const db = messagingDb(env);
  const group = await db
    .prepare(
      `SELECT group_id, epoch, tree_id, dissolved_at FROM groups WHERE group_id = ? LIMIT 1`,
    )
    .bind(request.group_id)
    .first<{ group_id: string; epoch: number; tree_id: number; dissolved_at: string | null }>();

  if (!group) {
    return { ok: false, status: 404, error_code: 'GROUP_NOT_FOUND', message: '群不存在' };
  }

  const base = await validateSyncRequestBase(env, request);
  if (!base.ok) return base;

  // 已解散：仍允许 sync 以传播 dissolved_at（成员 48h 只读窗口）
  if (group.dissolved_at) {
    await recordMemberAcks(env, request.group_id, base.senderUrl, request.acks, request.cursor);
    const dissolvedPin = await loadOwnerMembershipPin(db, request.group_id, ownerUrl);
    return {
      ok: true,
      data: {
        group_id: request.group_id,
        epoch: group.epoch,
        tree_id: group.tree_id,
        cursor: request.cursor,
        messages: [],
        dissolved_at: group.dissolved_at,
        ...ownerPinFieldsForSyncDown(dissolvedPin),
      },
    };
  }

  if (request.epoch !== group.epoch) {
    return { ok: false, status: 409, error_code: 'GROUP_EPOCH_STALE', message: '群 epoch 已过期' };
  }

  const messages = await fetchMessagesSinceCursor(env, 'group_messages', request.group_id, request.cursor);
  const relayTree = await buildRelayTreeDown(env, request.group_id, group.tree_id);
  // PIN-1：权威侧每次 sync 带群主 pin（不计入 hasDelta，避免削弱 empty-ack 踢人）
  const ownerPin = await loadOwnerMembershipPin(db, request.group_id, ownerUrl);

  let wrappedKey: GroupSyncDown['wrapped_key'];
  if (base.member.key_state === 'pending_key' || base.member.key_state === 'epoch_rotation_pending') {
    const wk = await db
      .prepare(
        `SELECT wrapped_key_json FROM group_wrapped_keys
          WHERE group_id = ? AND epoch = ? AND member_worker_b_url = ? LIMIT 1`,
      )
      .bind(request.group_id, group.epoch, base.senderUrl)
      .first<{ wrapped_key_json: string }>();
    if (wk?.wrapped_key_json) {
      wrappedKey = { epoch: group.epoch, wrapped_key_json: wk.wrapped_key_json };
    }
  }

  await recordMemberAcks(env, request.group_id, base.senderUrl, request.acks, request.cursor);
  const effective = hasEffectiveAck(request);
  const hasDelta = messages.length > 0 || !!relayTree || !!wrappedKey;
  await updateMemberAckState(env, request.group_id, base.senderUrl, effective, hasDelta);
  await processEmptyAckKickIfNeeded(env, request.group_id, base.senderUrl);

  const latestCursor =
    messages.length > 0 ? messages[messages.length - 1]!.message_id : request.cursor;

  return {
    ok: true,
    data: {
      group_id: request.group_id,
      epoch: group.epoch,
      tree_id: group.tree_id,
      cursor: latestCursor,
      messages,
      ...(relayTree ? { relay_tree: relayTree } : {}),
      ...(wrappedKey ? { wrapped_key: wrappedKey } : {}),
      ...ownerPinFieldsForSyncDown(ownerPin),
    },
  };
}

/** 中间父节点：直接子节点 sync 对端（本地 member_group_messages + relay_tree）。 */
export async function handleIntermediateSyncWithParent(
  env: Env,
  request: GroupSyncRequest,
  localWorkerBUrl: string,
): Promise<GroupSyncOk | GroupSyncError> {
  const localUrl = normalizeGroupMemberUrl(localWorkerBUrl);

  const db = messagingDb(env);
  const group = await db
    .prepare(`SELECT group_id, epoch, tree_id, owner_worker_b_url, dissolved_at FROM groups WHERE group_id = ? LIMIT 1`)
    .bind(request.group_id)
    .first<{
      group_id: string;
      epoch: number;
      tree_id: number;
      owner_worker_b_url: string;
      dissolved_at: string | null;
    }>();

  if (!group || group.dissolved_at) {
    return { ok: false, status: 404, error_code: 'GROUP_NOT_FOUND', message: '本节点无该群副本' };
  }
  if (normalizeGroupMemberUrl(request.owner_worker_b_url) !== normalizeGroupMemberUrl(group.owner_worker_b_url)) {
    return { ok: false, status: 400, error_code: 'GROUP_ENVELOPE_INVALID', message: 'owner_worker_b_url 不匹配' };
  }
  if (request.epoch !== group.epoch) {
    return { ok: false, status: 409, error_code: 'GROUP_EPOCH_STALE', message: '群 epoch 已过期' };
  }

  const base = await validateSyncRequestBase(env, request);
  if (!base.ok) return base;

  const childEdge = await db
    .prepare(
      `SELECT 1 AS ok FROM group_relay_edges
        WHERE group_id = ? AND tree_id = ? AND parent_worker_b_url = ? AND child_worker_b_url = ? LIMIT 1`,
    )
    .bind(request.group_id, group.tree_id, localUrl, base.senderUrl)
    .first<{ ok: number }>();

  if (!childEdge) {
    return { ok: false, status: 403, error_code: 'GROUP_NOT_MEMBER', message: '非本节点直接子成员，拒绝 sync' };
  }

  const messages = await fetchMessagesSinceCursor(env, 'member_group_messages', request.group_id, request.cursor);
  const relayTree = await buildRelayTreeDown(env, request.group_id, group.tree_id);
  // PIN-1：中间父若本机已有群主 pin 则下传（否则省略，子节点可经 E-4 直连群主补）
  const ownerPin = await loadOwnerMembershipPin(db, request.group_id, group.owner_worker_b_url);

  await recordMemberAcks(env, request.group_id, base.senderUrl, request.acks, request.cursor);

  const latestCursor =
    messages.length > 0 ? messages[messages.length - 1]!.message_id : request.cursor;

  return {
    ok: true,
    data: {
      group_id: request.group_id,
      epoch: group.epoch,
      tree_id: group.tree_id,
      cursor: latestCursor,
      messages,
      ...(relayTree ? { relay_tree: relayTree } : {}),
      ...ownerPinFieldsForSyncDown(ownerPin),
    },
  };
}

/** 路由：本节点作为 sync 父节点处理请求。 */
export async function handleSyncWithParentAsParent(
  env: Env,
  request: GroupSyncRequest,
  localWorkerBUrl: string,
): Promise<GroupSyncOk | GroupSyncError> {
  const localUrl = normalizeGroupMemberUrl(localWorkerBUrl);
  const ownerUrl = normalizeGroupMemberUrl(request.owner_worker_b_url);

  if (localUrl === ownerUrl) {
    return handleOwnerSyncWithParent(env, request, localWorkerBUrl);
  }

  return handleIntermediateSyncWithParent(env, request, localWorkerBUrl);
}

/** 持久化下行 relay_tree 到本节点 MESSAGING_DB。 */
export async function persistRelayTreeLocally(
  env: Env,
  groupId: string,
  relayTree: GroupRelayTreeDown,
): Promise<void> {
  const db = messagingDb(env);
  await db
    .prepare(`UPDATE groups SET tree_id = ?, updated_at = ? WHERE group_id = ?`)
    .bind(relayTree.tree_id, nowIso(), groupId)
    .run();
  await db.prepare(`DELETE FROM group_relay_edges WHERE group_id = ?`).bind(groupId).run();

  if (relayTree.edges.length > 0) {
    const stmts = relayTree.edges.map((edge) =>
      db
        .prepare(
          `INSERT INTO group_relay_edges
           (group_id, tree_id, parent_worker_b_url, child_worker_b_url)
           VALUES (?, ?, ?, ?)`,
        )
        .bind(
          groupId,
          relayTree.tree_id,
          normalizeGroupMemberUrl(edge.parent_worker_b_url),
          normalizeGroupMemberUrl(edge.child_worker_b_url),
        ),
    );
    await db.batch(stmts);
  }

  const seedSet = new Set(relayTree.seeds.map((s) => normalizeGroupMemberUrl(s)));
  const { results: members } = await db
    .prepare(`SELECT member_worker_b_url, role, status FROM group_members WHERE group_id = ?`)
    .bind(groupId)
    .all<{ member_worker_b_url: string; role: string; status: string }>();

  for (const row of members ?? []) {
    if (row.status !== 'active' || row.role === 'owner') continue;
    const url = normalizeGroupMemberUrl(row.member_worker_b_url);
    const nextRole = seedSet.has(url) ? 'seed' : 'member';
    if (row.role === nextRole) continue;
    await db
      .prepare(`UPDATE group_members SET role = ? WHERE group_id = ? AND member_worker_b_url = ?`)
      .bind(nextRole, groupId, url)
      .run();
  }
}

/** 应用 sync 下行：写本地消息、树、wrapped_key、更新 cursor/sync_state。 */
export async function applyGroupSyncDown(
  env: Env,
  groupId: string,
  localMemberUrl: string,
  down: GroupSyncDown,
): Promise<void> {
  const db = messagingDb(env);
  const now = nowIso();
  const memberUrl = normalizeGroupMemberUrl(localMemberUrl);

  if (down.dissolved_at) {
    await db
      .prepare(
        `UPDATE groups SET dissolved_at = COALESCE(dissolved_at, ?), updated_at = ? WHERE group_id = ?`,
      )
      .bind(down.dissolved_at, now, groupId)
      .run();
  }

  if (down.messages.length > 0) {
    const msgDb = await resolveGroupMessagesDb(env, groupId);
    // MSG-FIX-4：镜像复制群主下发的 recv_seq；已有 relay 行则补写 seq（不自造乱序）
    const stmts = down.messages.map((msg) =>
      msgDb
        .prepare(
          `INSERT INTO member_group_messages
           (message_id, group_id, epoch, sender_worker_b_url, sender_handle, msg_kind, ciphertext, created_at, envelope_json, recv_seq)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(message_id) DO UPDATE SET
             envelope_json = COALESCE(member_group_messages.envelope_json, excluded.envelope_json),
             recv_seq = COALESCE(excluded.recv_seq, member_group_messages.recv_seq)`,
        )
        .bind(
          msg.message_id,
          msg.group_id,
          msg.epoch,
          msg.sender_worker_b_url,
          msg.sender_handle,
          msg.msg_kind,
          msg.ciphertext,
          msg.created_at,
          msg.envelope_json ?? null,
          typeof msg.recv_seq === 'number' ? msg.recv_seq : null,
        ),
    );
    // 分片时 stmts 绑在 msgDb 上，必须用 msgDb.batch（勿误用 metadata 库）
    await msgDb.batch(stmts);
    for (const msg of down.messages) {
      if (msg.msg_kind !== 'system') continue;
      try {
        const { maybeApplyGroupUrlChangeFromSystemCiphertext } = await import(
          './groupUrlChangeAnnounce'
        );
        await maybeApplyGroupUrlChangeFromSystemCiphertext(env, msg.msg_kind, msg.ciphertext);
      } catch (err) {
        console.warn('[group/sync] groupUrlChange apply 失败', err);
      }
    }
  }

  if (down.relay_tree) {
    await persistRelayTreeLocally(env, groupId, down.relay_tree);
  }

  if (down.wrapped_key?.wrapped_key_json) {
    await db
      .prepare(
        `INSERT OR REPLACE INTO group_wrapped_keys
         (group_id, epoch, member_worker_b_url, wrapped_key_json, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(groupId, down.wrapped_key.epoch, memberUrl, down.wrapped_key.wrapped_key_json, now)
      .run();
    await db
      .prepare(
        `UPDATE group_members SET key_state = 'active' WHERE group_id = ? AND member_worker_b_url = ?`,
      )
      .bind(groupId, memberUrl)
      .run();
  }

  const group = await db
    .prepare(`SELECT owner_worker_b_url FROM groups WHERE group_id = ? LIMIT 1`)
    .bind(groupId)
    .first<{ owner_worker_b_url: string }>();

  // GRP-RELAY-AUTH-PIN-1：存量群主 pin 经 sync 下行回填（与入群 mirror 同源 upsert）
  if (typeof down.owner_pubkey === 'string' && group?.owner_worker_b_url) {
    await upsertLocalOwnerMembershipPin(db, {
      groupId,
      ownerWorkerBUrl: group.owner_worker_b_url,
      ownerHandle: down.owner_handle,
      ownerPubkey: down.owner_pubkey,
      nowIso: now,
    });
  }

  let parentUrl = normalizeGroupMemberUrl(group?.owner_worker_b_url ?? '');

  if (down.relay_tree) {
    const parentEdge = down.relay_tree.edges.find(
      (e) => normalizeGroupMemberUrl(e.child_worker_b_url) === memberUrl,
    );
    if (parentEdge) {
      parentUrl = normalizeGroupMemberUrl(parentEdge.parent_worker_b_url);
    }
  }

  const inTree =
    down.relay_tree != null &&
    (down.relay_tree.seeds.some((s) => normalizeGroupMemberUrl(s) === memberUrl) ||
      down.relay_tree.edges.some(
        (e) =>
          normalizeGroupMemberUrl(e.child_worker_b_url) === memberUrl ||
          normalizeGroupMemberUrl(e.parent_worker_b_url) === memberUrl,
      ));

  const existingState = await db
    .prepare(`SELECT sync_tier, local_retention_days FROM group_sync_state WHERE group_id = ? LIMIT 1`)
    .bind(groupId)
    .first<{ sync_tier: string; local_retention_days: number }>();

  const syncTier = inTree ? 'active' : (existingState?.sync_tier ?? 'unsynced');
  const retentionDays = existingState?.local_retention_days ?? 90;

  await db
    .prepare(
      `INSERT OR REPLACE INTO group_sync_state
       (group_id, parent_worker_b_url, cursor, sync_tier, local_retention_days,
        parent_sync_fail_streak, last_sync_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
    )
    .bind(groupId, parentUrl, down.cursor, syncTier, retentionDays, now, now)
    .run();

  await db
    .prepare(
      `UPDATE group_members SET last_ack_at = ?, empty_ack_streak = 0
       WHERE group_id = ? AND member_worker_b_url = ?`,
    )
    .bind(now, groupId, memberUrl)
    .run();
}

/** 本节点发起 sync-with-parent（Cron/手动入口）。 */
export async function runGroupSyncWithParent(
  env: Env,
  groupId: string,
  localUser: { handle: string; worker_b_url: string; pubkey: string },
  request: GroupSyncRequest,
): Promise<GroupSyncOk | GroupSyncError> {
  const parsed = parseGroupSyncRequest(request);
  if (!parsed) {
    return { ok: false, status: 400, error_code: 'GROUP_ENVELOPE_INVALID', message: 'sync 请求无效' };
  }
  if (parsed.group_id !== groupId) {
    return { ok: false, status: 400, error_code: 'GROUP_ENVELOPE_INVALID', message: 'group_id 不一致' };
  }

  const memberUrl = normalizeGroupMemberUrl(localUser.worker_b_url);
  if (normalizeGroupMemberUrl(parsed.sender_worker_b_url) !== memberUrl) {
    return { ok: false, status: 403, error_code: 'GROUP_ENVELOPE_INVALID', message: '只能以本节点身份 sync' };
  }

  const db = messagingDb(env);
  const syncState = await loadGroupSyncState(db, groupId);

  const group = await db
    .prepare(`SELECT owner_worker_b_url FROM groups WHERE group_id = ? LIMIT 1`)
    .bind(groupId)
    .first<{ owner_worker_b_url: string }>();

  if (!group) {
    return { ok: false, status: 404, error_code: 'GROUP_NOT_FOUND', message: '群不存在' };
  }

  const ownerUrl = normalizeGroupMemberUrl(group.owner_worker_b_url);
  const parentUrl = resolveSyncParentUrl(syncState, ownerUrl);

  // SEC-AUDIT-2026-10-1：统一出站（SSRF + redirect:manual）
  const fetched = await fetchOutboundPeer(env, `${parentUrl}/groups/sync-with-parent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(parsed),
    timeoutMs: 10_000,
  });
  if (!fetched.ok) {
    await recordParentSyncFailure(env, groupId, ownerUrl, parentUrl, syncState);
    return { ok: false, status: 502, error_code: 'GROUP_PARENT_UNREACHABLE', message: '无法连接父节点' };
  }
  const upstream = fetched.response;

  const body = (await upstream.json().catch(() => null)) as {
    ok?: boolean;
    data?: GroupSyncDown;
    error_code?: string;
    message?: string;
  } | null;

  if (!upstream.ok || !body?.ok || !body.data) {
    await recordParentSyncFailure(env, groupId, ownerUrl, parentUrl, syncState);
    return {
      ok: false,
      status: (upstream.status >= 400 && upstream.status < 600 ? upstream.status : 502) as GroupSyncError['status'],
      error_code: body?.error_code ?? 'GROUP_SYNC_REJECTED',
      message: body?.message ?? '父节点拒绝 sync',
    };
  }

  await resetParentSyncFailStreak(env, groupId);
  await applyGroupSyncDown(env, groupId, localUser.worker_b_url, body.data);

  return { ok: true, data: body.data };
}

export { parseGroupSyncRequest };
