/**
 * NCF-2D3：Messaging Media 发送方 serve 验票核心（窄 deps，无 Env / Hono）。
 * 不解密、不读 blob；只判定是否允许路由 serveMediaObject。
 */
import { isMessagingMediaStorageKey } from '@hailuo/shared-utils';
import type { DmMediaFetchTicket, GroupMediaFetchTicket, GroupMessageEnvelope } from '@hailuo/shared-types';
import { normalizeGroupMemberUrl } from '../../lib/groupMemberUrl';
import type {
  ServeMessagingMediaCommand,
  ServeMessagingMediaDeps,
  ServeMessagingMediaResult,
} from './types';

function normalizeWorkerBUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

function fail(
  status: ServeMessagingMediaResult['status'],
  httpStatus: number,
  error_code: string,
  message: string,
): ServeMessagingMediaResult {
  return { status, httpStatus, error_code, message };
}

async function runServeDmMedia(
  ticket: DmMediaFetchTicket,
  storageKey: string,
  deps: ServeMessagingMediaDeps,
): Promise<ServeMessagingMediaResult> {
  if (ticket.v !== 1) {
    return fail('ticket_invalid', 403, 'DM_MEDIA_TICKET_INVALID', 'ticket 版本无效');
  }
  if (ticket.exp < deps.clock.nowSec()) {
    return fail('ticket_invalid', 403, 'DM_MEDIA_TICKET_INVALID', 'ticket 已过期');
  }
  if (ticket.sender_storage_key !== storageKey) {
    return fail('forbidden', 403, 'DM_MEDIA_FORBIDDEN', 'storage_key 与 ticket 不匹配');
  }
  if (!isMessagingMediaStorageKey(storageKey)) {
    return fail('not_found', 404, 'DM_MEDIA_NOT_FOUND', '媒体不存在');
  }
  if (
    normalizeWorkerBUrl(ticket.sender_worker_b_url) !==
    normalizeWorkerBUrl(await deps.localPublicBase.getNormalizedUrl())
  ) {
    return fail('forbidden', 403, 'DM_MEDIA_FORBIDDEN', 'ticket 目标节点不匹配');
  }

  const envelope = await deps.dm.loadOutboxEnvelope(ticket.message_id);
  if (!envelope?.media) {
    return fail('not_found', 404, 'DM_MEDIA_NOT_FOUND', '消息或媒体不存在');
  }
  if (
    envelope.media.media_id !== ticket.media_id ||
    envelope.media.sender_storage_key !== ticket.sender_storage_key ||
    normalizeWorkerBUrl(envelope.media.sender_worker_b_url) !==
      normalizeWorkerBUrl(ticket.sender_worker_b_url)
  ) {
    return fail('forbidden', 403, 'DM_MEDIA_FORBIDDEN', 'ticket 与消息媒体不一致');
  }

  const peerUrl = await deps.dm.getOutboxPeerWorkerBUrl(ticket.message_id);
  const expectedRequester = normalizeWorkerBUrl(ticket.requester_worker_b_url);
  if (!peerUrl || normalizeWorkerBUrl(peerUrl) !== expectedRequester) {
    return fail('forbidden', 403, 'DM_MEDIA_FORBIDDEN', '请求方节点无权拉取该媒体');
  }

  const requesterPubkey = await deps.requesterPubkey.fetch(
    ticket.requester_worker_b_url,
    envelope.recipient_handle,
  );
  if (!requesterPubkey || !(await deps.dm.verifyTicket(ticket, requesterPubkey))) {
    return fail('ticket_invalid', 403, 'DM_MEDIA_TICKET_INVALID', 'ticket 签名无效');
  }

  try {
    if (!(await deps.registry.hasActiveMessagingObject(storageKey))) {
      return fail('not_found', 404, 'DM_MEDIA_NOT_FOUND', '发送方 blob 未登记');
    }
  } catch (err) {
    deps.logger.error('[messaging-media] dm registry check failed', err);
    return fail('internal_error', 500, 'INTERNAL_ERROR', '发送方 blob 登记校验失败');
  }

  const nonceResult = await deps.dm.consumeNonce(ticket.nonce, deps.clock.nowIso());
  if (nonceResult === 'replay') {
    return fail('ticket_invalid', 403, 'DM_MEDIA_TICKET_INVALID', 'ticket 已使用');
  }
  if (nonceResult === 'error') {
    deps.logger.error('[messaging-media] dm nonce insert failed');
    return fail('internal_error', 500, 'INTERNAL_ERROR', 'ticket 防重放写入失败');
  }

  return { status: 'ok', httpStatus: 200, data: { storage_key: storageKey } };
}

async function verifyGroupEnvelopeAgainstTicket(
  ticket: GroupMediaFetchTicket,
  envelope: GroupMessageEnvelope,
  storageKey: string,
  deps: ServeMessagingMediaDeps,
): Promise<ServeMessagingMediaResult> {
  if (envelope.group_id !== ticket.group_id) {
    return fail('forbidden', 403, 'GROUP_MEDIA_FORBIDDEN', '群 id 不匹配');
  }
  if (!envelope.media) {
    return fail('not_found', 404, 'GROUP_MEDIA_NOT_FOUND', '消息不含媒体');
  }
  if (
    envelope.media.media_id !== ticket.media_id ||
    envelope.media.sender_storage_key !== ticket.sender_storage_key ||
    normalizeWorkerBUrl(envelope.media.sender_worker_b_url) !==
      normalizeWorkerBUrl(ticket.sender_worker_b_url)
  ) {
    return fail('forbidden', 403, 'GROUP_MEDIA_FORBIDDEN', 'ticket 与消息媒体不一致');
  }

  const senderUrl = normalizeGroupMemberUrl(envelope.sender_worker_b_url);
  const senderHandle = await deps.group.getActiveMemberHandle(envelope.group_id, senderUrl);
  if (!senderHandle) {
    return fail('forbidden', 403, 'GROUP_MEDIA_FORBIDDEN', '发送方非在册成员');
  }

  const requesterUrl = normalizeGroupMemberUrl(ticket.requester_worker_b_url);
  const requesterHandle = await deps.group.getActiveMemberHandle(envelope.group_id, requesterUrl);
  if (!requesterHandle) {
    return fail('forbidden', 403, 'GROUP_MEDIA_FORBIDDEN', '请求方非群成员');
  }

  const requesterPubkey = await deps.requesterPubkey.fetch(
    ticket.requester_worker_b_url,
    requesterHandle,
  );
  if (!requesterPubkey || !(await deps.group.verifyTicket(ticket, requesterPubkey))) {
    return fail('ticket_invalid', 403, 'GROUP_MEDIA_TICKET_INVALID', 'ticket 签名无效');
  }

  try {
    if (!(await deps.registry.hasActiveMessagingObject(storageKey))) {
      return fail('not_found', 404, 'GROUP_MEDIA_NOT_FOUND', '发送方 blob 未登记');
    }
  } catch (err) {
    deps.logger.error('[messaging-media] group registry check failed', err);
    return fail('internal_error', 500, 'INTERNAL_ERROR', '发送方 blob 登记校验失败');
  }

  const nonceResult = await deps.group.consumeNonce(
    ticket.group_id,
    ticket.nonce,
    deps.clock.nowIso(),
  );
  if (nonceResult === 'replay') {
    return fail('ticket_invalid', 403, 'GROUP_MEDIA_TICKET_INVALID', 'ticket 已使用');
  }
  if (nonceResult === 'error') {
    deps.logger.error('[messaging-media] group nonce insert failed');
    return fail('internal_error', 500, 'INTERNAL_ERROR', 'ticket 防重放写入失败');
  }

  return { status: 'ok', httpStatus: 200, data: { storage_key: storageKey } };
}

async function runServeGroupMedia(
  ticket: GroupMediaFetchTicket,
  storageKey: string,
  deps: ServeMessagingMediaDeps,
): Promise<ServeMessagingMediaResult> {
  if (ticket.v !== 1) {
    return fail('ticket_invalid', 403, 'GROUP_MEDIA_TICKET_INVALID', 'ticket 版本无效');
  }
  if (ticket.exp < deps.clock.nowSec()) {
    return fail('ticket_invalid', 403, 'GROUP_MEDIA_TICKET_INVALID', 'ticket 已过期');
  }
  if (ticket.sender_storage_key !== storageKey) {
    return fail('forbidden', 403, 'GROUP_MEDIA_FORBIDDEN', 'storage_key 与 ticket 不匹配');
  }
  if (!isMessagingMediaStorageKey(storageKey)) {
    return fail('not_found', 404, 'GROUP_MEDIA_NOT_FOUND', '媒体不存在');
  }
  if (
    normalizeWorkerBUrl(ticket.sender_worker_b_url) !==
    normalizeWorkerBUrl(await deps.localPublicBase.getNormalizedUrl())
  ) {
    return fail('forbidden', 403, 'GROUP_MEDIA_FORBIDDEN', 'ticket 目标节点不匹配');
  }

  const envelope = await deps.group.loadEnvelope(ticket.group_id, ticket.message_id);
  if (!envelope?.media) {
    const ownerEnvelope = await deps.group.loadOwnerEnvelope(ticket.group_id, ticket.message_id);
    if (ownerEnvelope) {
      return verifyGroupEnvelopeAgainstTicket(ticket, ownerEnvelope, storageKey, deps);
    }
    return fail('not_found', 404, 'GROUP_MEDIA_NOT_FOUND', '消息或媒体不存在');
  }

  return verifyGroupEnvelopeAgainstTicket(ticket, envelope, storageKey, deps);
}

export async function runServeMessagingMedia(
  command: ServeMessagingMediaCommand,
  deps: ServeMessagingMediaDeps,
): Promise<ServeMessagingMediaResult> {
  if (command.kind === 'dm') {
    return runServeDmMedia(command.ticket, command.storageKey, deps);
  }
  return runServeGroupMedia(command.ticket, command.storageKey, deps);
}
