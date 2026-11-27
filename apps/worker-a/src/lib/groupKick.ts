/**
 * MOD-1 + REKEY-1：群主/管理员踢人先隔绝；禁止假 wrap / 乱推进 epoch。
 * 真换钥（全员可读 wraps + rekey-commit）留给 REKEY-2。
 * EPOCH v0.3：连续空 ack **不再踢人**，仅 `demoteMemberForEmptyAck` 触发 force 建树（filter 排除 streak≥3）。
 */
import { resolveIdentityDb } from '../db/bindings';
import { randomDmNonceHex, signGroupMessageEnvelope } from '@hailuo/shared-crypto';
import type { GroupMessageEnvelope } from '@hailuo/shared-types';
import type { Env } from '../env';
import { acceptGroupMessageOnOwner } from './groupMessage';
import { messagingDb } from './messagingDb';
import { normalizeGroupMemberUrl } from './groupMemberUrl';
import { assertGroupOwnerOrAdmin } from './groupModeration';
import {
  decideKickRekeyPolicy,
  type RekeyWrapCandidate,
} from './groupRekeyPolicy';
import { recomputeAndPersistRelayTree } from './groupRelayTree';

const GROUP_MESSAGE_TTL_MS = 24 * 60 * 60 * 1000;
const EMPTY_ACK_KICK_THRESHOLD = 3;

function nowIso(): string {
  return new Date().toISOString();
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function newGroupMessageId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `gmsg_${bytesToHex(bytes)}`;
}

/** system 消息：UTF-8 明文 base64（msg_kind=system，客户端可不解密直接展示）。 */
function utf8PlaintextBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

async function getLocalOwner(env: Env): Promise<{
  handle: string;
  worker_b_url: string;
  pubkey: string;
} | null> {
  return resolveIdentityDb(env).prepare(`SELECT handle, worker_b_url, pubkey FROM users LIMIT 1`).first<{
    handle: string;
    worker_b_url: string;
    pubkey: string;
  }>();
}

async function buildKickSystemEnvelope(
  env: Env,
  groupId: string,
  owner: { handle: string; worker_b_url: string },
  ownerWorkerBUrl: string,
  epoch: number,
  reasonText: string,
): Promise<GroupMessageEnvelope> {
  const now = nowIso();
  const ownerUrl = normalizeGroupMemberUrl(ownerWorkerBUrl);
  const unsigned = {
    v: 1 as const,
    kind: 'GROUP_MESSAGE' as const,
    group_id: groupId,
    message_id: newGroupMessageId(),
    epoch,
    sender_handle: owner.handle.trim().toLowerCase(),
    sender_worker_b_url: ownerUrl,
    owner_worker_b_url: ownerUrl,
    created_at: now,
    expires_at: new Date(Date.now() + GROUP_MESSAGE_TTL_MS).toISOString(),
    nonce: randomDmNonceHex(16),
    msg_kind: 'system' as const,
    ciphertext: utf8PlaintextBase64(reasonText),
  };
  const sig = await signGroupMessageEnvelope(unsigned, env.ED25519_PRIVATE_KEY);
  return { ...unsigned, sig };
}

/** @deprecated REKEY-1：踢人路径不再接受 wrap；保留别名仅供旧调用方编译。 */
export type KickWrappedKeyUpload = RekeyWrapCandidate;

async function applyKickBatch(
  env: Env,
  groupId: string,
  memberUrl: string,
  systemText: string,
  options?: {
    expectedEpoch?: number;
  },
  actorWorkerBUrl?: string,
): Promise<
  | { ok: true; new_epoch: number }
  | { ok: false; error_code: 'EPOCH_CONFLICT' | 'KICK_FAILED' | 'TREE_REBUILD_FAILED'; message: string }
> {
  const db = messagingDb(env);
  const localOwner = await getLocalOwner(env);
  if (!localOwner?.worker_b_url) {
    return { ok: false, error_code: 'KICK_FAILED', message: '节点未注册' };
  }

  const localUrl = normalizeGroupMemberUrl(localOwner.worker_b_url);
  const group = await db
    .prepare(
      `SELECT group_id, owner_worker_b_url, epoch, dissolved_at FROM groups WHERE group_id = ? LIMIT 1`,
    )
    .bind(groupId)
    .first<{ group_id: string; owner_worker_b_url: string; epoch: number; dissolved_at: string | null }>();

  if (!group || group.dissolved_at) {
    return { ok: false, error_code: 'KICK_FAILED', message: '群不存在' };
  }
  if (normalizeGroupMemberUrl(group.owner_worker_b_url) !== localUrl) {
    return { ok: false, error_code: 'KICK_FAILED', message: '本节点非群主权威' };
  }

  if (
    typeof options?.expectedEpoch === 'number' &&
    Number.isInteger(options.expectedEpoch) &&
    options.expectedEpoch !== group.epoch
  ) {
    return {
      ok: false,
      error_code: 'EPOCH_CONFLICT',
      message: `epoch 冲突：期望 ${options.expectedEpoch}，当前 ${group.epoch}`,
    };
  }

  const envelope = await buildKickSystemEnvelope(
    env,
    groupId,
    localOwner,
    group.owner_worker_b_url,
    group.epoch,
    systemText,
  );

  const now = nowIso();
  const expected = group.epoch;
  const actor = normalizeGroupMemberUrl(actorWorkerBUrl ?? localUrl);
  // 同一事务内重查权限与目标，封住验签后撤权/目标升管理员的并发窗口。
  // 目标更新最后执行，前面各句共享同一个 active 判据，失败时整批零副作用。
  const guard = `EXISTS (
    SELECT 1 FROM groups g JOIN group_members t ON t.group_id = g.group_id
    WHERE g.group_id = ? AND g.epoch = ? AND g.dissolved_at IS NULL
      AND g.owner_worker_b_url = ? AND t.member_worker_b_url = ?
      AND t.status = 'active' AND t.role != 'owner' AND t.member_worker_b_url != ?
      AND (? = g.owner_worker_b_url OR (COALESCE(t.is_admin, 0) != 1 AND EXISTS (
        SELECT 1 FROM group_members a WHERE a.group_id = g.group_id
          AND a.member_worker_b_url = ? AND a.status = 'active' AND a.is_admin = 1))))`;
  const guardArgs = [groupId, expected, group.owner_worker_b_url, memberUrl, actor, actor, actor];
  const applied = await db.batch([
    db.prepare(`UPDATE groups SET updated_at = ?, rekey_scheduled = 1 WHERE group_id = ? AND ${guard}`)
      .bind(now, groupId, ...guardArgs),
    db.prepare(`DELETE FROM group_wrapped_keys WHERE group_id = ? AND member_worker_b_url = ? AND ${guard}`)
      .bind(groupId, memberUrl, ...guardArgs),
    db.prepare(`DELETE FROM group_pending_members WHERE group_id = ? AND member_worker_b_url = ? AND ${guard}`)
      .bind(groupId, memberUrl, ...guardArgs),
    db.prepare(`DELETE FROM group_relay_edges WHERE group_id = ?
      AND (parent_worker_b_url = ? OR child_worker_b_url = ?) AND ${guard}`)
      .bind(groupId, memberUrl, memberUrl, ...guardArgs),
    db.prepare(`UPDATE group_members
      SET status = 'kicked', empty_ack_streak = 0, key_state = 'epoch_rotation_pending', is_admin = 0
      WHERE group_id = ? AND member_worker_b_url = ? AND ${guard}`)
      .bind(groupId, memberUrl, ...guardArgs),
  ]);
  if (!(applied[4]?.meta?.changes ?? 0)) {
    return {
      ok: false,
      error_code: 'EPOCH_CONFLICT',
      message: '群状态或管理权限已变化，请刷新后重试',
    };
  }

  // REKEY-1：仅隔绝；旧钥继续服务留下成员，绝不在此 CAS epoch++ / 写入 wrap。
  const newEpoch = expected;
  // 目标边已在事务内摘掉；整树 force 重建失败时须让调用方换 nonce 走幂等收尾。
  try {
    await recomputeAndPersistRelayTree(env, groupId, { force: true });
  } catch (err) {
    console.warn('[group/kick] force 建树失败', groupId, err instanceof Error ? err.message : String(err));
    return {
      ok: false,
      error_code: 'TREE_REBUILD_FAILED',
      message: '成员已隔绝，群树重建失败，请重试',
    };
  }
  // 先摘边再广播；公告失败不能回滚已经生效的隔绝。
  try {
    const posted = await acceptGroupMessageOnOwner(env, envelope);
    if (!posted.ok) console.warn('[group/kick] system 消息失败', posted.error_code);
  } catch {
    console.warn('[group/kick] system 消息暂不可用');
  }
  return { ok: true, new_epoch: newEpoch };
}

/**
 * @deprecated EPOCH v0.3：空 ack 不再踢人；请用 demoteMemberForEmptyAck。
 * 保留导出名以免旧调用方编译断，内部改走降级。
 */
export async function kickMemberForEmptyAck(
  env: Env,
  groupId: string,
  memberWorkerBUrl: string,
): Promise<boolean> {
  return demoteMemberForEmptyAck(env, groupId, memberWorkerBUrl);
}

/**
 * 群主节点：empty_ack_streak ≥ 3 时仅路由降级（不改 status、不 epoch++）。
 * 建树侧 `filterActiveMembers` 排除 streak≥3；下次有效 sync 清零 streak 后可再入树。
 */
export async function demoteMemberForEmptyAck(
  env: Env,
  groupId: string,
  memberWorkerBUrl: string,
): Promise<boolean> {
  const db = messagingDb(env);
  const localOwner = await getLocalOwner(env);
  if (!localOwner?.worker_b_url) return false;

  const localUrl = normalizeGroupMemberUrl(localOwner.worker_b_url);
  const memberUrl = normalizeGroupMemberUrl(memberWorkerBUrl);

  const group = await db
    .prepare(
      `SELECT group_id, owner_worker_b_url, dissolved_at FROM groups WHERE group_id = ? LIMIT 1`,
    )
    .bind(groupId)
    .first<{ group_id: string; owner_worker_b_url: string; dissolved_at: string | null }>();

  if (!group || group.dissolved_at) return false;
  if (normalizeGroupMemberUrl(group.owner_worker_b_url) !== localUrl) return false;

  const member = await db
    .prepare(
      `SELECT member_handle, status, role, empty_ack_streak FROM group_members
        WHERE group_id = ? AND member_worker_b_url = ? LIMIT 1`,
    )
    .bind(groupId, memberUrl)
    .first<{ member_handle: string; status: string; role: string; empty_ack_streak: number }>();

  if (!member || member.status !== 'active' || member.role === 'owner') return false;
  if (member.empty_ack_streak < EMPTY_ACK_KICK_THRESHOLD) return false;

  // 不改 status / 不 epoch++；force 重建使 filterActiveMembers 立刻摘边
  const result = await recomputeAndPersistRelayTree(env, groupId, { force: true });
  if (result?.rebuilt) {
    console.log(
      '[group/kick] empty_ack 路由降级',
      JSON.stringify({ groupId, memberUrl, handle: member.member_handle, streak: member.empty_ack_streak }),
    );
  }
  return Boolean(result);
}

/**
 * M16-GROUP-MOD-4 + REKEY-1：群主或管理员手动踢人（仅隔绝）。
 * - 管理员不可踢群主或其他管理员
 * - 群主可踢普通成员与管理员
 * - 附带 wrappedKeys 一律拒绝（禁止假 wrap 冒充换钥）
 */
export async function kickGroupMemberByModerator(
  env: Env,
  groupId: string,
  actorWorkerBUrl: string,
  targetWorkerBUrl: string,
  options?: {
    expectedEpoch?: number;
    /** @deprecated REKEY-1：非空即 400 GROUP_REKEY_NOT_READY */
    wrappedKeys?: KickWrappedKeyUpload[];
  },
): Promise<
  | {
      ok: true;
      data: {
        group_id: string;
        member_worker_b_url: string;
        status: 'kicked';
        new_epoch: number;
        rekey_scheduled: true;
      };
    }
  | { ok: false; status: 400 | 403 | 404 | 409 | 503; error_code: string; message: string }
> {
  // 先挡假 wrap，再走权限/目标校验，避免用无效换钥请求探测成员态。
  const rekeyGate = decideKickRekeyPolicy({ wrappedKeys: options?.wrappedKeys });
  if (!rekeyGate.ok) {
    return {
      ok: false,
      status: 400,
      error_code: rekeyGate.error_code,
      message: rekeyGate.message,
    };
  }

  const gate = await assertGroupOwnerOrAdmin(env, groupId, actorWorkerBUrl);
  if (!gate.ok) return gate;

  const targetUrl = normalizeGroupMemberUrl(targetWorkerBUrl);
  if (!targetUrl) {
    return { ok: false, status: 400, error_code: 'GROUP_ENVELOPE_INVALID', message: 'member_worker_b_url 无效' };
  }
  if (normalizeGroupMemberUrl(actorWorkerBUrl) === targetUrl) {
    return { ok: false, status: 400, error_code: 'GROUP_ENVELOPE_INVALID', message: '不能踢出自己' };
  }

  const db = messagingDb(env);
  const target = await db
    .prepare(
      `SELECT member_handle, status, role, is_admin FROM group_members
        WHERE group_id = ? AND member_worker_b_url = ? LIMIT 1`,
    )
    .bind(groupId, targetUrl)
    .first<{ member_handle: string; status: string; role: string; is_admin: number }>();

  // 半失败恢复：成员已 kicked 但 force 建树/公告未完成时，换新 nonce 只做收尾。
  if (target?.status === 'kicked') {
    const group = await db
      .prepare(
        `SELECT epoch, rekey_scheduled, owner_worker_b_url FROM groups WHERE group_id = ? LIMIT 1`,
      )
      .bind(groupId)
      .first<{ epoch: number; rekey_scheduled: number; owner_worker_b_url: string }>();
    if (
      typeof options?.expectedEpoch === 'number' &&
      Number.isInteger(options.expectedEpoch) &&
      group &&
      options.expectedEpoch !== group.epoch
    ) {
      return {
        ok: false,
        status: 409,
        error_code: 'EPOCH_CONFLICT',
        message: `epoch 冲突：期望 ${options.expectedEpoch}，当前 ${group.epoch}`,
      };
    }
    try {
      await recomputeAndPersistRelayTree(env, groupId, { force: true });
    } catch (err) {
      console.warn('[group/kick] 幂等建树失败', groupId, err instanceof Error ? err.message : String(err));
      return {
        ok: false,
        status: 503,
        error_code: 'GROUP_MODERATION_UNAVAILABLE',
        message: '群管理服务暂不可用',
      };
    }
    // 建树曾失败时 system 公告可能未发出；补发失败不能否定已生效的隔绝。
    try {
      const hasSystem = await db
        .prepare(
          `SELECT 1 AS ok FROM group_messages WHERE group_id = ? AND msg_kind = 'system' LIMIT 1`,
        )
        .bind(groupId)
        .first<{ ok: number }>();
      if (!hasSystem && group) {
        const localOwner = await getLocalOwner(env);
        if (localOwner?.worker_b_url) {
          const envelope = await buildKickSystemEnvelope(
            env,
            groupId,
            localOwner,
            group.owner_worker_b_url,
            group.epoch,
            `@${target.member_handle} 已被移出群聊`,
          );
          const posted = await acceptGroupMessageOnOwner(env, envelope);
          if (!posted.ok) console.warn('[group/kick] 幂等 system 消息失败', posted.error_code);
        }
      }
    } catch {
      console.warn('[group/kick] 幂等 system 消息暂不可用');
    }
    return {
      ok: true,
      data: {
        group_id: groupId,
        member_worker_b_url: targetUrl,
        status: 'kicked',
        new_epoch: group?.epoch ?? options?.expectedEpoch ?? 0,
        rekey_scheduled: true,
      },
    };
  }

  if (!target || target.status !== 'active') {
    return { ok: false, status: 404, error_code: 'GROUP_NOT_MEMBER', message: '目标成员不存在或不在册' };
  }
  if (target.role === 'owner') {
    return { ok: false, status: 403, error_code: 'GROUP_NOT_MEMBER', message: '不能踢出群主' };
  }
  if (!gate.isOwner && Number(target.is_admin) === 1) {
    return { ok: false, status: 403, error_code: 'GROUP_NOT_MEMBER', message: '管理员不能踢出其他管理员' };
  }

  const applied = await applyKickBatch(
    env,
    groupId,
    targetUrl,
    `@${target.member_handle} 已被移出群聊`,
    options,
    actorWorkerBUrl,
  );
  if (!applied.ok) {
    if (applied.error_code === 'TREE_REBUILD_FAILED') {
      return {
        ok: false,
        status: 503,
        error_code: 'GROUP_MODERATION_UNAVAILABLE',
        message: '群管理服务暂不可用',
      };
    }
    return {
      ok: false,
      status: 409,
      error_code: applied.error_code,
      message: applied.message,
    };
  }
  return {
    ok: true,
    data: {
      group_id: groupId,
      member_worker_b_url: targetUrl,
      status: 'kicked',
      new_epoch: applied.new_epoch,
      rekey_scheduled: true,
    },
  };
}

/** 群主 Cron 兜底：扫描 streak ≥ 3 → 路由降级（force 建树）。 */
export async function scanAndKickEmptyAckMembers(env: Env): Promise<number> {
  return scanAndDemoteEmptyAckMembers(env);
}

export async function scanAndDemoteEmptyAckMembers(env: Env): Promise<number> {
  const localOwner = await getLocalOwner(env);
  if (!localOwner?.worker_b_url) return 0;

  const localUrl = normalizeGroupMemberUrl(localOwner.worker_b_url);
  const db = messagingDb(env);
  // 按群去重：同一群多个 demote 成员只 force 重建一次
  const { results } = await db
    .prepare(
      `SELECT DISTINCT gm.group_id
         FROM group_members gm
         INNER JOIN groups g ON g.group_id = gm.group_id
        WHERE g.owner_worker_b_url = ?
          AND g.dissolved_at IS NULL
          AND gm.status = 'active'
          AND gm.role != 'owner'
          AND gm.empty_ack_streak >= ?
        LIMIT 10`,
    )
    .bind(localUrl, EMPTY_ACK_KICK_THRESHOLD)
    .all<{ group_id: string }>();

  let demotedGroups = 0;
  for (const row of results ?? []) {
    const result = await recomputeAndPersistRelayTree(env, row.group_id, { force: true });
    if (result?.rebuilt) demotedGroups += 1;
  }
  return demotedGroups;
}

/** sync 完成后：streak≥3 则 force 建树降级（仅群主节点）。 */
export async function processEmptyAckKickIfNeeded(
  env: Env,
  groupId: string,
  memberWorkerBUrl: string,
): Promise<void> {
  try {
    await demoteMemberForEmptyAck(env, groupId, memberWorkerBUrl);
  } catch (err) {
    console.error('[group/kick] processEmptyAckKickIfNeeded 失败', groupId, err);
  }
}
