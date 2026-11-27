/**
 * NCF-2D1：DM 收件核心（窄 deps，无 Env / Hono / ExecutionContext）。
 * 不解密 ciphertext；只验签 + 门禁 + 落库密文 envelope。
 */
import type { ReceiveDmInboxCommand, ReceiveDmInboxDeps, ReceiveDmInboxResult } from './types';

export async function runReceiveDmInbox(
  command: ReceiveDmInboxCommand,
  deps: ReceiveDmInboxDeps,
): Promise<ReceiveDmInboxResult> {
  const envelope = command.envelope;

  const localHandle = await deps.localUser.getHandle();
  if (!localHandle) {
    return {
      status: 'user_not_registered',
      httpStatus: 409,
      error_code: 'USER_NOT_REGISTERED',
      message: '节点尚未完成注册',
    };
  }

  if (envelope.recipient_handle !== localHandle) {
    return {
      status: 'envelope_invalid',
      httpStatus: 400,
      error_code: 'DM_ENVELOPE_INVALID',
      message: '收件人与本节点不匹配',
    };
  }
  if (envelope.send_ticket.recipient_handle !== localHandle) {
    return {
      status: 'ticket_invalid',
      httpStatus: 403,
      error_code: 'DM_TICKET_INVALID',
      message: '私信 ticket 收件人与本节点不匹配',
    };
  }

  const localPublicBase = await deps.localPublicBase.getNormalizedUrl();
  if (envelope.send_ticket.recipient_worker_b_url !== localPublicBase) {
    return {
      status: 'ticket_invalid',
      httpStatus: 403,
      error_code: 'DM_TICKET_INVALID',
      message: '私信 ticket 目标节点不匹配',
    };
  }
  if (envelope.send_ticket.sender_handle !== envelope.sender_handle) {
    return {
      status: 'ticket_invalid',
      httpStatus: 403,
      error_code: 'DM_TICKET_INVALID',
      message: '私信 ticket 与发送者不匹配',
    };
  }
  if (envelope.sender_worker_b_url === localPublicBase) {
    return {
      status: 'envelope_invalid',
      httpStatus: 400,
      error_code: 'DM_ENVELOPE_INVALID',
      message: '不能向自己投递私信',
    };
  }
  if (envelope.send_ticket.exp < deps.clock.nowSec()) {
    return {
      status: 'ticket_invalid',
      httpStatus: 403,
      error_code: 'DM_TICKET_INVALID',
      message: '私信 ticket 已过期',
    };
  }

  if (await deps.blacklist.isBlacklisted(envelope.sender_worker_b_url)) {
    return {
      status: 'blacklisted',
      httpStatus: 403,
      error_code: 'BLACKLISTED',
      message: '发送方已被拉黑',
    };
  }
  if (!(await deps.follows.isFollowing(envelope.sender_worker_b_url))) {
    return {
      status: 'not_mutual',
      httpStatus: 403,
      error_code: 'DM_NOT_MUTUAL',
      message: '未与对方互粉，无法接收私信',
    };
  }

  // 验签：有本地 Pin 就用 Pin，没有才取档。失败仍用原来的错误码，不告诉对方是钥匙被钉死。
  // 验签通过后才回填空 Pin，也才扣 rate limit（无效 envelope 不消耗配额）。
  const resolved = await deps.senderPubkey.resolve(envelope);
  const senderPubkey = resolved.pubkey;
  if (!senderPubkey) {
    return {
      status: 'pubkey_unavailable',
      httpStatus: 403,
      error_code: 'DM_TICKET_INVALID',
      message: '无法获取发送方公钥',
    };
  }
  if (!envelope.send_ticket.sig || !(await deps.crypto.verifyTicket(envelope.send_ticket, senderPubkey))) {
    return {
      status: 'ticket_invalid',
      httpStatus: 403,
      error_code: 'DM_TICKET_INVALID',
      message: '私信 ticket 签名无效',
    };
  }
  if (!(await deps.crypto.verifyEnvelope(envelope, senderPubkey))) {
    return {
      status: 'envelope_invalid',
      httpStatus: 400,
      error_code: 'DM_ENVELOPE_INVALID',
      message: '私信 envelope 签名无效',
    };
  }
  if (resolved.backfillAfterVerify) {
    try {
      await deps.senderPubkey.backfill(envelope, senderPubkey);
    } catch (err) {
      deps.logger.error('[dm] 空 Pin 回填失败', err instanceof Error ? err.message : 'unknown');
    }
  }

  // 验签通过后才扣 rate limit。
  if (!(await deps.rateLimit.checkAndIncrement(envelope.sender_worker_b_url))) {
    return {
      status: 'rate_limited',
      httpStatus: 429,
      error_code: 'DM_RATE_LIMITED',
      message: '对方节点发信过于频繁，请稍后再试',
    };
  }

  const batchResult = await deps.store.insertMessageBatch(envelope, envelope.send_ticket.nonce);
  if (batchResult === 'replay') {
    return {
      status: 'nonce_replay',
      httpStatus: 409,
      error_code: 'DM_NONCE_REPLAY',
      message: '私信请求已存在（防重放）',
    };
  }
  if (batchResult === 'error') {
    return {
      status: 'internal_error',
      httpStatus: 500,
      error_code: 'INTERNAL_ERROR',
      message: '私信防重放记录写入失败',
    };
  }

  return {
    status: 'ok',
    httpStatus: 200,
    data: { message_id: envelope.message_id },
    flags: { needMediaMirror: Boolean(envelope.media) },
  };
}
