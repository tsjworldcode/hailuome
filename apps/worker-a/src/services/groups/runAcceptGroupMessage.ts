/**
 * NCF-2D2：群主 inbound 核心（窄 deps，无 Env / Hono / ExecutionContext）。
 * 不解密 ciphertext；只验签 + membership + 落库密文 envelope + 触发 relay seed。
 */
import { isGroupMessageExpired } from '../../lib/groupEnvelope';
import { normalizeGroupMemberUrl } from '../../lib/groupMemberUrl';
import { canSpeakWhenMuted, GROUP_MEMBERS_MUTED } from '../../lib/groupModeration';
import type {
  AcceptGroupMessageCommand,
  AcceptGroupMessageDeps,
  AcceptGroupMessageResult,
} from './types';

export async function runAcceptGroupMessage(
  command: AcceptGroupMessageCommand,
  deps: AcceptGroupMessageDeps,
): Promise<AcceptGroupMessageResult> {
  const envelope = command.envelope;

  if (isGroupMessageExpired(envelope)) {
    return {
      status: 'message_expired',
      httpStatus: 400,
      error_code: 'GROUP_MESSAGE_EXPIRED',
      message: '消息 envelope 已过期',
    };
  }

  const group = await deps.groups.get(envelope.group_id);
  if (!group || group.dissolved_at) {
    return {
      status: 'group_not_found',
      httpStatus: 404,
      error_code: 'GROUP_NOT_FOUND',
      message: '群不存在或已解散',
    };
  }

  if (
    normalizeGroupMemberUrl(envelope.owner_worker_b_url) !==
    normalizeGroupMemberUrl(group.owner_worker_b_url)
  ) {
    return {
      status: 'envelope_invalid',
      httpStatus: 400,
      error_code: 'GROUP_ENVELOPE_INVALID',
      message: 'owner_worker_b_url 与群不匹配',
    };
  }

  if (envelope.epoch !== group.epoch) {
    return {
      status: 'epoch_stale',
      httpStatus: 409,
      error_code: 'GROUP_EPOCH_STALE',
      message: '群 epoch 已过期，请拉取最新密钥',
    };
  }

  const senderUrl = normalizeGroupMemberUrl(envelope.sender_worker_b_url);
  const member = await deps.members.get(envelope.group_id, senderUrl);

  if (!member || member.status !== 'active') {
    return {
      status: 'not_member',
      httpStatus: 403,
      error_code: 'GROUP_NOT_MEMBER',
      message: '发送方非在册成员',
    };
  }

  if (member.key_state !== 'active') {
    return {
      status: 'key_pending',
      httpStatus: 403,
      error_code: 'GROUP_KEY_PENDING',
      message: '群密钥尚未就绪，暂不可发信',
    };
  }

  // M16-GROUP-MOD：全员禁言时仅群主/管理员可发聊天消息；system 不受限
  if (
    envelope.msg_kind === 'chat' &&
    !canSpeakWhenMuted(group.members_muted ?? 0, {
      role: member.role ?? 'member',
      is_admin: member.is_admin ?? 0,
      status: member.status,
    })
  ) {
    return {
      status: 'members_muted',
      httpStatus: 403,
      error_code: GROUP_MEMBERS_MUTED,
      message: '本群已开启仅群主与管理员可发言',
    };
  }

  if (member.member_handle !== envelope.sender_handle) {
    return {
      status: 'envelope_invalid',
      httpStatus: 400,
      error_code: 'GROUP_ENVELOPE_INVALID',
      message: 'sender_handle 与 membership 不一致',
    };
  }

  if (await deps.blacklist.isBlacklisted(senderUrl)) {
    return {
      status: 'blacklisted',
      httpStatus: 403,
      error_code: 'BLACKLISTED',
      message: '发送方已被拉黑',
    };
  }

  // 验签：成员公钥已在 membership 查询中，直接验 envelope；通过后才扣 rate limit（无效 envelope 不消耗对方配额）。
  if (!(await deps.crypto.verifyEnvelope(envelope, member.member_pubkey))) {
    return {
      status: 'envelope_invalid',
      httpStatus: 400,
      error_code: 'GROUP_ENVELOPE_INVALID',
      message: '消息 envelope 签名无效',
    };
  }

  if (!(await deps.rateLimit.checkAndIncrement(envelope.group_id, senderUrl))) {
    return {
      status: 'rate_limited',
      httpStatus: 429,
      error_code: 'GROUP_RATE_LIMITED',
      message: '发信过于频繁，请稍后再试',
    };
  }

  if (await deps.store.messageExists(envelope.message_id, envelope.group_id)) {
    // GRP-RELAY-AUTH-DUP-1：幂等命中仍补签回执（不 fanout / 不 mirror）。
    // 弱网超时后 Outbox 重试常走 duplicate；无 receipt 则 AUTH-4 无法主责直推 peer。
    // MSG-FIX-5：duplicate 路径回读既有权威行的 recv_seq 后补签（保证与首次一致）。
    const dupReceipt = await deps.crypto.issueOwnerReceipt(
      envelope,
      group.owner_worker_b_url,
      await deps.store.readAuthoritativeRecvSeq?.(envelope.message_id, envelope.group_id) ?? null,
    );
    return {
      status: 'ok',
      httpStatus: 200,
      data: {
        message_id: envelope.message_id,
        duplicate: true,
        ...(dupReceipt ? { owner_receipt: dupReceipt } : {}),
      },
      flags: { needMediaMirror: false },
    };
  }

  const batchResult = await deps.store.insertMessageBatch(envelope, senderUrl);
  if (batchResult.status === 'replay') {
    return {
      status: 'nonce_replay',
      httpStatus: 409,
      error_code: 'GROUP_NONCE_REPLAY',
      message: 'nonce 重复（防重放）',
    };
  }
  if (batchResult.status === 'error') {
    deps.logger.error('[groups] batch insert failed');
    return {
      status: 'internal_error',
      httpStatus: 500,
      error_code: 'INTERNAL_ERROR',
      message: '群消息防重放记录写入失败',
    };
  }
  // GRP-RELAY-AUTH-2：落库成功后签发 owner_receipt，再随 fanout 携带（强制校验见 AUTH-3）
  // MSG-FIX-5：把实际分配的 recv_seq 签进回执 → 中继只透传、不可伪造序号。
  const ownerReceipt = await deps.crypto.issueOwnerReceipt(
    envelope,
    group.owner_worker_b_url,
    batchResult.recv_seq,
  );

  await deps.relay.fanoutFromOwner(
    envelope.group_id,
    group.owner_worker_b_url,
    group.tree_id,
    envelope,
    ownerReceipt,
  );

  return {
    status: 'ok',
    httpStatus: 200,
    data: {
      message_id: envelope.message_id,
      ...(ownerReceipt ? { owner_receipt: ownerReceipt } : {}),
    },
    flags: { needMediaMirror: Boolean(envelope.media) },
  };
}
