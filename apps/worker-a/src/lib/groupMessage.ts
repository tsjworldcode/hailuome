// M16-2：群消息权威写入、ingress 校验与成员 outbox 投递。
// NCF-2D2：群主 inbound 判定迁入 services/groups；本文件保留兼容壳与成员发信/relay。

import { verifyGroupMessageEnvelope } from '@hailuo/shared-crypto';
import type { GroupMessageEnvelope, GroupRelayPayload, OwnerReceiptV1 } from '@hailuo/shared-types';
import { redactOutboundUrlHost } from '@hailuo/shared-utils';
import type { Env } from '../env';
import {
  executeAcceptGroupMessage,
  type AcceptGroupMessageResult,
} from '../services/groups';
import { fetchOutboundPeer } from './fetchOutboundPeer';
import { isGroupMessageExpired, parseGroupMessageEnvelope } from './groupEnvelope';
import { loadOwnerMembershipPin } from './groupInvite';
import { normalizeGroupMemberUrl } from './groupMemberUrl';
import { handleLocalGroupRelay, postRelayToPeer, GROUP_RELAY_FETCH_TIMEOUT_MS } from './groupRelay';
import {
  checkOwnerReceiptAgainstEnvelope,
  isGroupRelayReceiptRequired,
} from './groupOwnerReceiptVerify';
import { loadSpeakerPrimaryTargets } from './groupSpeakerPrimary';
import type { GroupRelaySchedule } from './groupRelay';
import { messagingDb } from './messagingDb';
import { resolveGroupMessagesDb } from './messagingShard';
import {
  canSpeakWhenMuted,
  decideMuteRelayChatGate,
  GROUP_MEMBERS_MUTED,
} from './groupModeration';

export type GroupMessageError = {
  ok: false;
  error_code: string;
  message: string;
  status: 400 | 403 | 404 | 409 | 429 | 500 | 502;
};

export type GroupMessageOk = {
  ok: true;
  data: {
    message_id: string;
    duplicate?: boolean;
    /** inbound 成功/幂等补签时可带回（成员主责加速用） */
    owner_receipt?: OwnerReceiptV1;
  };
};

function nowIso(): string {
  return new Date().toISOString();
}

async function getMemberPubkey(
  env: Env,
  groupId: string,
  memberWorkerBUrl: string,
): Promise<string | null> {
  const row = await messagingDb(env)
    .prepare(
      `SELECT member_pubkey, status, key_state FROM group_members
        WHERE group_id = ? AND member_worker_b_url = ? LIMIT 1`,
    )
    .bind(groupId, normalizeGroupMemberUrl(memberWorkerBUrl))
    .first<{ member_pubkey: string; status: string; key_state: string }>();
  if (!row || row.status !== 'active') return null;
  return row.member_pubkey;
}

/** 本机成员表没有发送方时，向其 Worker B 的公开资料取 pubkey 再验签。 */
async function resolveRelaySenderPubkey(
  env: Env,
  envelope: GroupMessageEnvelope,
): Promise<string | null> {
  const known = await getMemberPubkey(env, envelope.group_id, envelope.sender_worker_b_url);
  if (known) return known;

  const senderUrl = normalizeGroupMemberUrl(envelope.sender_worker_b_url);
  const handle = envelope.sender_handle.trim().toLowerCase();
  if (!senderUrl || !handle) return null;

  // SEC-AUDIT-2026-10-1：统一出站（SSRF + redirect:manual + 超时）
  const fetched = await fetchOutboundPeer(
    env,
    `${senderUrl}/users/${encodeURIComponent(handle)}`,
    {
      headers: { Accept: 'application/json' },
      timeoutMs: GROUP_RELAY_FETCH_TIMEOUT_MS,
    },
  );
  if (!fetched.ok) return null;
  try {
    const res = fetched.response;
    if (!res.ok) return null;
    const json = (await res.json()) as {
      ok?: boolean;
      data?: { pubkey?: string; handle?: string };
    };
    if (json.ok !== true || typeof json.data?.pubkey !== 'string') return null;
    const remoteHandle =
      typeof json.data.handle === 'string' ? json.data.handle.trim().toLowerCase() : '';
    if (remoteHandle && remoteHandle !== handle) return null;
    const pubkey = json.data.pubkey.trim();
    return pubkey || null;
  } catch {
    return null;
  }
}

/** NCF-2D2：深模块 result → 既有 GroupMessageOk/Error（persist / kick 复用） */
function acceptGroupMessageResultToLegacy(
  result: AcceptGroupMessageResult,
): GroupMessageOk | GroupMessageError {
  if (result.status === 'ok' && result.data) {
    return { ok: true, data: result.data };
  }
  return {
    ok: false,
    status: (result.httpStatus as GroupMessageError['status']) || 500,
    error_code: result.error_code ?? 'INTERNAL_ERROR',
    message: result.message ?? '群消息接收失败',
  };
}

/** 群主权威 ingress：委托 NCF-2D2 `executeAcceptGroupMessage`。 */
export async function acceptGroupMessageOnOwner(
  env: Env,
  envelope: GroupMessageEnvelope,
  opts?: { schedule?: GroupRelaySchedule },
): Promise<GroupMessageOk | GroupMessageError> {
  const result = await executeAcceptGroupMessage(env, { envelope }, opts);
  return acceptGroupMessageResultToLegacy(result);
}

/** 群主本节点发信：写权威 + 本地副本 + relay。 */
export async function persistOwnerLocalGroupMessage(
  env: Env,
  envelope: GroupMessageEnvelope,
  localOwnerUrl: string,
  opts?: { schedule?: GroupRelaySchedule },
): Promise<GroupMessageOk | GroupMessageError> {
  const ownerUrl = normalizeGroupMemberUrl(localOwnerUrl);
  if (normalizeGroupMemberUrl(envelope.sender_worker_b_url) !== ownerUrl) {
    return { ok: false, status: 403, error_code: 'GROUP_ENVELOPE_INVALID', message: '只能以本节点群主身份发信' };
  }

  const result = await acceptGroupMessageOnOwner(env, envelope, opts);
  if (!result.ok) return result;

  const msgDb = await resolveGroupMessagesDb(env, envelope.group_id);
  // MSG-FIX-5：本机镜像复制**权威行实际分配到的** recv_seq（不复制则本机副本缺 seq，
  // 后续 sync 游标会把它当「无 seq」处理）。用子查询取权威值，避免读到写前快照。
  await msgDb
    .prepare(
      `INSERT OR IGNORE INTO member_group_messages
       (message_id, group_id, epoch, sender_worker_b_url, sender_handle, msg_kind, ciphertext, created_at, envelope_json, recv_seq)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?,
               (SELECT recv_seq FROM group_messages WHERE message_id = ?))`,
    )
    .bind(
      envelope.message_id,
      envelope.group_id,
      envelope.epoch,
      envelope.sender_worker_b_url,
      envelope.sender_handle,
      envelope.msg_kind,
      envelope.ciphertext,
      envelope.created_at,
      JSON.stringify(envelope),
      envelope.message_id,
    )
    .run();

  return result;
}

/** 成员 remote 投递：fetch 群主 Worker B `/groups/inbound`；成功时可带回 owner_receipt。 */
export async function deliverGroupOutboxToOwner(
  env: Env,
  ownerWorkerBUrl: string,
  envelope: GroupMessageEnvelope,
): Promise<
  | { ok: true; owner_receipt?: OwnerReceiptV1 }
  | { ok: false; error_code: string; message: string; status: number }
> {
  const ownerUrl = normalizeGroupMemberUrl(ownerWorkerBUrl);
  const fetched = await fetchOutboundPeer(env, `${ownerUrl}/groups/inbound`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ envelope }),
    timeoutMs: GROUP_RELAY_FETCH_TIMEOUT_MS,
  });
  if (!fetched.ok) {
    return { ok: false, status: 502, error_code: 'GROUP_OWNER_UNREACHABLE', message: '无法连接群主节点' };
  }
  const upstream = fetched.response;

  const parsed = (await upstream.json().catch(() => null)) as {
    ok?: boolean;
    error_code?: string;
    message?: string;
    data?: { owner_receipt?: unknown };
  } | null;

  if (!upstream.ok || !parsed?.ok) {
    return {
      ok: false,
      status: upstream.status >= 400 ? upstream.status : 502,
      error_code: parsed?.error_code ?? 'GROUP_OWNER_REJECTED',
      message: parsed?.message ?? '群主节点拒绝消息',
    };
  }

  // GRP-RELAY-AUTH-4：从 inbound 响应取回执；形状非法则当无回执（只打群主，不直推 peer）
  const receiptRaw = parsed.data?.owner_receipt;
  const owner_receipt =
    receiptRaw !== undefined ? parseOwnerReceipt(receiptRaw) ?? undefined : undefined;
  return owner_receipt ? { ok: true, owner_receipt } : { ok: true };
}

/**
 * 成员第一跳主责加速：
 * 1) 必先打群主 inbound（权威落库）；失败则整次失败。
 * 2) GRP-RELAY-AUTH-4：无 owner_receipt 不得直推 peer（只等群主树扇出 / 只打群主）。
 * 3) 有回执后才对主责名单中的 peer 走 relay，并携带 receipt。
 * peer 失败只记日志，不挡住这次发信。
 */
export async function deliverMemberEnvelopeToPrimary(
  env: Env,
  envelope: GroupMessageEnvelope,
  ownerWorkerBUrl: string,
): Promise<{ ok: true } | { ok: false; error_code: string; message: string; status: number }> {
  const ownerUrl = normalizeGroupMemberUrl(ownerWorkerBUrl);

  // 先打群主：无受理回执前禁止与 peer 并行直推（堵「绕过起播」口子）
  const ownerResult = await deliverGroupOutboxToOwner(env, ownerUrl, envelope);
  if (!ownerResult.ok) return ownerResult;

  const receipt = ownerResult.owner_receipt;
  if (!receipt) {
    // 群主已受理但未回传 receipt（缺钥 fail-soft 等）→ 仅依赖群主侧 fanout
    return { ok: true };
  }

  const targets = await loadSpeakerPrimaryTargets(
    env,
    envelope.group_id,
    envelope.sender_worker_b_url,
    ownerUrl,
  );
  const peers = targets
    .map((url) => normalizeGroupMemberUrl(url))
    .filter((url) => url && url !== ownerUrl)
    .slice(0, 7);

  await Promise.all(
    peers.map(async (target) => {
      const status = await postRelayToPeer(env, target, {
        envelope,
        hop_count: 0,
        owner_receipt: receipt,
      });
      if (status !== 'ok') {
        // 12 反追查：日志只打脱敏 host，不落完整对端 URL
        console.warn('[group/primary] relay 失败', redactOutboundUrlHost(target));
      }
    }),
  );

  return { ok: true };
}

const OUTBOX_BACKOFF_MS = [60_000, 300_000, 900_000, 3_600_000];

/** 成员发信：写本地 + outbox + 推主责名单（含群主）。 */
export async function sendMemberGroupMessage(
  env: Env,
  envelope: GroupMessageEnvelope,
  localMember: { worker_b_url: string; handle: string; pubkey: string },
): Promise<
  | { ok: true; data: { message_id: string; outbox_state: 'sent' | 'failed' } }
  | GroupMessageError
> {
  if (isGroupMessageExpired(envelope)) {
    return { ok: false, status: 400, error_code: 'GROUP_MESSAGE_EXPIRED', message: '消息 envelope 已过期' };
  }

  const memberUrl = normalizeGroupMemberUrl(localMember.worker_b_url);
  if (normalizeGroupMemberUrl(envelope.sender_worker_b_url) !== memberUrl) {
    return { ok: false, status: 403, error_code: 'GROUP_ENVELOPE_INVALID', message: '发信 envelope 必须属于本节点' };
  }
  if (envelope.sender_handle !== localMember.handle.trim().toLowerCase()) {
    return { ok: false, status: 403, error_code: 'GROUP_ENVELOPE_INVALID', message: 'sender_handle 与本节点不匹配' };
  }

  const metaDb = messagingDb(env);
  const membership = await metaDb
    .prepare(
      `SELECT gm.status, gm.key_state, gm.role, gm.is_admin,
              g.owner_worker_b_url, g.epoch, g.dissolved_at, g.members_muted
         FROM group_members gm
         JOIN groups g ON g.group_id = gm.group_id
        WHERE gm.group_id = ? AND gm.member_worker_b_url = ? LIMIT 1`,
    )
    .bind(envelope.group_id, memberUrl)
    .first<{
      status: string;
      key_state: string;
      role: string;
      is_admin: number | null;
      owner_worker_b_url: string;
      epoch: number;
      dissolved_at: string | null;
      members_muted: number | null;
    }>();

  if (!membership || membership.dissolved_at) {
    return { ok: false, status: 404, error_code: 'GROUP_NOT_FOUND', message: '群不存在或未加入' };
  }
  if (membership.status !== 'active') {
    return { ok: false, status: 403, error_code: 'GROUP_NOT_MEMBER', message: '非在册成员，无法发信' };
  }
  if (membership.key_state !== 'active') {
    return { ok: false, status: 403, error_code: 'GROUP_KEY_PENDING', message: '群密钥尚未就绪，暂不可发信' };
  }
  if (
    envelope.msg_kind === 'chat' &&
    !canSpeakWhenMuted(membership.members_muted ?? 0, {
      role: membership.role,
      is_admin: membership.is_admin ?? 0,
      status: membership.status,
    })
  ) {
    return {
      ok: false,
      status: 403,
      error_code: GROUP_MEMBERS_MUTED,
      message: '本群已开启仅群主与管理员可发言',
    };
  }
  if (envelope.epoch !== membership.epoch) {
    return { ok: false, status: 409, error_code: 'GROUP_EPOCH_STALE', message: '群 epoch 已过期' };
  }
  if (
    normalizeGroupMemberUrl(envelope.owner_worker_b_url) !==
    normalizeGroupMemberUrl(membership.owner_worker_b_url)
  ) {
    return { ok: false, status: 400, error_code: 'GROUP_ENVELOPE_INVALID', message: 'owner_worker_b_url 不匹配' };
  }

  if (!(await verifyGroupMessageEnvelope(envelope, localMember.pubkey))) {
    return { ok: false, status: 400, error_code: 'GROUP_ENVELOPE_INVALID', message: '消息 envelope 签名无效' };
  }

  const now = nowIso();
  const msgDb = await resolveGroupMessagesDb(env, envelope.group_id);
  // MSG-FIX-5：本机副本的 recv_seq **只**来自权威源（群主权威行 / relay 回执 / sync 下行）。
  // 成员自己发信时还没拿到序号 → 写 NULL；若此前已通过 sync 补到序号，
  // 用子查询保留旧值（INSERT OR REPLACE 会整行替换，不能让它把序号抹掉）。
  await msgDb
    .prepare(
      `INSERT OR REPLACE INTO member_group_messages
       (message_id, group_id, epoch, sender_worker_b_url, sender_handle, msg_kind, ciphertext, created_at, envelope_json, recv_seq)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?,
               (SELECT recv_seq FROM member_group_messages WHERE message_id = ?))`,
    )
    .bind(
      envelope.message_id,
      envelope.group_id,
      envelope.epoch,
      envelope.sender_worker_b_url,
      envelope.sender_handle,
      envelope.msg_kind,
      envelope.ciphertext,
      envelope.created_at,
      JSON.stringify(envelope),
      envelope.message_id,
    )
    .run();
  await metaDb
    .prepare(
      `INSERT OR REPLACE INTO group_outbox
       (message_id, group_id, owner_worker_b_url, state, retry_count, next_retry_at, last_error,
        ciphertext, envelope_json, created_at, updated_at)
       VALUES (?, ?, ?, 'pending', 0, ?, NULL, ?, ?, ?, ?)`,
    )
    .bind(
      envelope.message_id,
      envelope.group_id,
      normalizeGroupMemberUrl(membership.owner_worker_b_url),
      now,
      envelope.ciphertext,
      JSON.stringify(envelope),
      now,
      now,
    )
    .run();

  const delivery = await deliverMemberEnvelopeToPrimary(env, envelope, membership.owner_worker_b_url);
  const outboxState = delivery.ok ? 'sent' : 'failed';
  const nextRetry = delivery.ok
    ? now
    : new Date(Date.now() + OUTBOX_BACKOFF_MS[0]).toISOString();

  await metaDb
    .prepare(
      `UPDATE group_outbox
       SET state = ?, retry_count = ?, next_retry_at = ?, last_error = ?, updated_at = ?
       WHERE message_id = ?`,
    )
    .bind(
      outboxState,
      delivery.ok ? 0 : 1,
      nextRetry,
      delivery.ok ? null : delivery.message,
      nowIso(),
      envelope.message_id,
    )
    .run();

  if (!delivery.ok) {
    return {
      ok: false,
      status: (delivery.status >= 400 && delivery.status < 600 ? delivery.status : 502) as GroupMessageError['status'],
      error_code: delivery.error_code,
      message: delivery.message,
    };
  }

  return { ok: true, data: { message_id: envelope.message_id, outbox_state: 'sent' } };
}

/** 树内 relay ingress：验签 + seen 去重 + 本地副本 + 向下 fanout。 */
export async function acceptGroupRelayLocally(
  env: Env,
  payload: GroupRelayPayload,
  localWorkerBUrl: string,
  opts?: { schedule?: GroupRelaySchedule },
): Promise<GroupMessageOk | GroupMessageError> {
  const envelope = parseGroupMessageEnvelope(payload.envelope);
  if (!envelope) {
    return { ok: false, status: 400, error_code: 'GROUP_ENVELOPE_INVALID', message: 'relay envelope 无效' };
  }
  if (payload.hop_count < 0 || payload.hop_count > 10) {
    return { ok: false, status: 400, error_code: 'GROUP_ENVELOPE_INVALID', message: 'hop_count 无效' };
  }
  if (isGroupMessageExpired(envelope)) {
    return { ok: false, status: 400, error_code: 'GROUP_MESSAGE_EXPIRED', message: '消息 envelope 已过期' };
  }

  const metaDb = messagingDb(env);
  // 一次读齐 relay 闸所需群行字段（含禁言），避免同表重复 SELECT
  const knownGroup = await metaDb
    .prepare(
      `SELECT owner_worker_b_url, epoch, members_muted FROM groups
        WHERE group_id = ? AND dissolved_at IS NULL LIMIT 1`,
    )
    .bind(envelope.group_id)
    .first<{ owner_worker_b_url: string; epoch: number; members_muted: number | null }>();
  if (!knownGroup) {
    return { ok: false, status: 404, error_code: 'GROUP_NOT_FOUND', message: '本节点无该群副本' };
  }

  // GRP-RELAY-AUTH-3：先验群主 owner_receipt，再验发送者成员签（§3.3）。
  // 恒强制（程序内常量 GROUP_RELAY_RECEIPT_REQUIRED=true）：缺回执 / 无 pin / 错签一律 403。
  const receiptRequired = isGroupRelayReceiptRequired();
  const ownerPin = await loadOwnerMembershipPin(metaDb, envelope.group_id, knownGroup.owner_worker_b_url);
  const receiptCheck = await checkOwnerReceiptAgainstEnvelope(
    payload.owner_receipt,
    envelope,
    {
      owner_worker_b_url: knownGroup.owner_worker_b_url,
      epoch: knownGroup.epoch,
    },
    ownerPin?.owner_pubkey ?? null,
    { required: receiptRequired },
  );
  if (!receiptCheck.ok) {
    return {
      ok: false,
      status: 403,
      error_code: receiptCheck.error_code,
      message: receiptCheck.message,
    };
  }
  if (receiptCheck.epochLocalMismatch) {
    console.warn(
      '[group/relay] owner_receipt epoch 与本机 groups.epoch 不一致（已放行；解密交给客户端）',
      envelope.message_id,
    );
  }

  const pubkey = await resolveRelaySenderPubkey(env, envelope);
  if (!pubkey) {
    return { ok: false, status: 403, error_code: 'GROUP_NOT_MEMBER', message: '发送方非本节点已知成员' };
  }
  if (!(await verifyGroupMessageEnvelope(envelope, pubkey))) {
    return { ok: false, status: 400, error_code: 'GROUP_ENVELOPE_INVALID', message: 'relay envelope 签名无效' };
  }

  // MUTE-RELAY-1：成员 relay 收包对齐全员禁言（验签通过后、seen/落库/fanout 之前）。
  // 只拦 chat；system 不受禁言限制；仅 members_muted=1 时查成员行（未禁言不因中继成员表滞后误杀）。
  if (envelope.msg_kind === 'chat') {
    let senderMember: { status: string; role: string; is_admin: number | null } | null = null;
    // 仅禁言开启时读成员行（fail-closed：未知发送者不可绕过禁言）
    if (Number(knownGroup.members_muted) === 1) {
      const senderUrl = normalizeGroupMemberUrl(envelope.sender_worker_b_url);
      senderMember = await metaDb
        .prepare(
          `SELECT status, role, is_admin FROM group_members
            WHERE group_id = ? AND member_worker_b_url = ? LIMIT 1`,
        )
        .bind(envelope.group_id, senderUrl)
        .first<{ status: string; role: string; is_admin: number | null }>();
    }
    const gate = decideMuteRelayChatGate(
      knownGroup.members_muted,
      senderMember
        ? {
            status: senderMember.status,
            role: senderMember.role,
            is_admin: senderMember.is_admin ?? 0,
          }
        : null,
    );
    if (gate.action === 'reject') {
      return { ok: false, status: 403, error_code: gate.error_code, message: gate.message };
    }
  }

  try {
    // 透传完整 payload（piggyback + owner_receipt），禁止再剥壳只留 envelope/hop
    const outcome = await handleLocalGroupRelay(env, payload, localWorkerBUrl, opts);
    return {
      ok: true,
      data: { message_id: envelope.message_id, duplicate: outcome === 'duplicate' },
    };
  } catch {
    return { ok: false, status: 404, error_code: 'GROUP_NOT_FOUND', message: '本节点无该群副本' };
  }
}

/** GRP-RELAY-AUTH-2：宽松解析 owner_receipt 形状；验签留给 AUTH-3 */
export function parseOwnerReceipt(raw: unknown): OwnerReceiptV1 | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (o.v !== 1) return null;
  const str = (k: string) => (typeof o[k] === 'string' ? (o[k] as string) : null);
  const group_id = str('group_id');
  const message_id = str('message_id');
  const sender_worker_b_url = str('sender_worker_b_url');
  const sender_handle = str('sender_handle');
  const ciphertext_sha256 = str('ciphertext_sha256');
  const owner_worker_b_url = str('owner_worker_b_url');
  const issued_at = str('issued_at');
  const exp = str('exp');
  const sig = str('sig');
  if (
    !group_id ||
    !message_id ||
    !sender_worker_b_url ||
    !sender_handle ||
    !ciphertext_sha256 ||
    !owner_worker_b_url ||
    !issued_at ||
    !exp ||
    !sig
  ) {
    return null;
  }
  if (typeof o.epoch !== 'number' || !Number.isInteger(o.epoch) || o.epoch < 0) return null;
  // MSG-FIX-5：recv_seq 可选（老回执无此字段）；出现则必须是 ≥1 的整数
  const recvSeqRaw = o.recv_seq;
  if (
    recvSeqRaw !== undefined &&
    (typeof recvSeqRaw !== 'number' || !Number.isInteger(recvSeqRaw) || recvSeqRaw < 1)
  ) {
    return null;
  }
  return {
    v: 1,
    group_id,
    message_id,
    epoch: o.epoch,
    sender_worker_b_url,
    sender_handle,
    ciphertext_sha256,
    owner_worker_b_url,
    issued_at,
    exp,
    ...(typeof recvSeqRaw === 'number' ? { recv_seq: recvSeqRaw } : {}),
    sig,
  };
}

export function parseGroupRelayPayload(raw: unknown): GroupRelayPayload | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const envelope = parseGroupMessageEnvelope(obj.envelope);
  if (!envelope) return null;
  const hopCount = obj.hop_count === undefined ? 0 : obj.hop_count;
  if (typeof hopCount !== 'number' || !Number.isInteger(hopCount) || hopCount < 0 || hopCount > 10) {
    return null;
  }

  const result: GroupRelayPayload = { envelope, hop_count: hopCount };

  if (obj.tree_id !== undefined) {
    if (typeof obj.tree_id !== 'number' || !Number.isInteger(obj.tree_id)) return null;
    result.tree_id = obj.tree_id;
  }

  if (obj.next_hops !== undefined) {
    if (!Array.isArray(obj.next_hops) || !obj.next_hops.every((u) => typeof u === 'string')) {
      return null;
    }
    result.next_hops = obj.next_hops as string[];
  }

  if (obj.route_slice !== undefined) {
    if (!Array.isArray(obj.route_slice)) return null;
    const slice: Array<{ parent_worker_b_url: string; child_worker_b_url: string }> = [];
    for (const edge of obj.route_slice) {
      if (!edge || typeof edge !== 'object') return null;
      const e = edge as Record<string, unknown>;
      if (typeof e.parent_worker_b_url !== 'string' || typeof e.child_worker_b_url !== 'string') {
        return null;
      }
      slice.push({
        parent_worker_b_url: e.parent_worker_b_url,
        child_worker_b_url: e.child_worker_b_url,
      });
    }
    result.route_slice = slice;
  }

  // AUTH-2：可选携带；形状非法则整包拒（避免半残 receipt）；缺字段则影子无 receipt
  if (obj.owner_receipt !== undefined) {
    const receipt = parseOwnerReceipt(obj.owner_receipt);
    if (!receipt) return null;
    result.owner_receipt = receipt;
  }

  return result;
}
