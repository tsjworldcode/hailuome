/**
 * NCF-AUDIT-Y-15-1：群内部 HMAC ingress（Worker B → A）。
 * 从 routes/groups.ts 原样抽出；契约不变。
 */
import { Hono } from 'hono';
import { verifyRequest } from '@hailuo/shared-crypto';
import {
  acceptGroupInviteOnOwner,
} from '../../lib/groupInvite';
import {
  joinGroupByIdOnOwner,
  type JoinGroupByIdInput,
} from '../../lib/groupJoinPolicy';
import { parseGroupMessageEnvelope } from '../../lib/groupEnvelope';
import {
  acceptGroupRelayLocally,
  parseGroupRelayPayload,
} from '../../lib/groupMessage';
import {
  executeAcceptGroupMessage,
  type AcceptGroupMessageResult,
} from '../../services/groups';
import {
  handleSyncWithParentAsParent,
  parseGroupSyncRequest,
} from '../../lib/groupSync';
import { decodeGroupMediaFetchTicketParam } from '../../lib/groupMediaFetchTicket';
import { mirrorGroupMediaFromSender } from '../../lib/groupMediaMirror';
import { serveWrappedKeyOnOwner } from '../../lib/groupKeyFastPull';
import { moderateGroupKickOnOwner } from '../../lib/groupModerationKick';
import { resolveLocalPublicBaseUrl } from '../../lib/localPublicBaseUrl';
import { serveMediaObject } from '../../lib/mediaServe';
import {
  executeServeMessagingMedia,
  type ServeMessagingMediaResult,
} from '../../services/messaging-media';
import type { Env, AppVariables } from '../../env';
import {
  type GroupContext,
  GROUP_ID_RE,
  errorJson,
  parseAcceptInviteBody,
} from './shared';

type AppEnv = { Bindings: Env; Variables: AppVariables };

export const groupsInternalApp = new Hono<AppEnv>();

groupsInternalApp.use('/moderation', async (c, next) => {
  await next();
  c.header('Cache-Control', 'private, no-store');
});
groupsInternalApp.post('/moderation', requireInternalForward, async (c) => {
  let body: unknown;
  try { body = JSON.parse(c.get('internalForwardBody') ?? '{}'); }
  catch { return errorJson(c, 400, 'INVALID_BODY', '请求体必须为 JSON'); }
  const result = await moderateGroupKickOnOwner(c.env, body);
  if (!result.ok) return errorJson(c, result.status, result.error_code, result.message);
  return c.json({ ok: true, data: result.data });
});

async function requireInternalForward(c: GroupContext, next: () => Promise<void>): Promise<Response | void> {
  const configured = c.env.INTERNAL_FORWARD_SECRET;
  const marker = c.req.header('X-Internal-Forward') ?? '';
  const timestamp = c.req.header('X-Timestamp') ?? '';
  const nonce = c.req.header('X-Nonce') ?? '';
  const signature = c.req.header('X-Signature') ?? '';
  if (!configured || marker !== 'hmac-v2' || !timestamp || !nonce || !signature) {
    return errorJson(c, 403, 'INTERNAL_FORWARD_REJECTED', '内部转发头验证失败');
  }

  const rawBody = await c.req.text();
  const url = new URL(c.req.url);
  const ok = await verifyRequest(
    { method: c.req.method.toUpperCase(), path: `${url.pathname}${url.search}` },
    rawBody,
    { timestamp, nonce, signature },
    configured,
  );
  if (!ok) {
    return errorJson(c, 403, 'INTERNAL_FORWARD_REJECTED', '内部转发头验证失败');
  }
  c.set('internalForwardBody', rawBody);
  await next();
}

async function handleInternalInviteAccept(c: GroupContext): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(c.get('internalForwardBody') ?? '{}') as Record<string, unknown>;
  } catch {
    return errorJson(c, 400, 'INVALID_BODY', '请求体必须为 JSON');
  }
  const input = parseAcceptInviteBody(body);
  if (!input) {
    return errorJson(c, 400, 'GROUP_ENVELOPE_INVALID', '入群字段无效');
  }

  const result = await acceptGroupInviteOnOwner(c.env, input);
  if (!result.ok) {
    return errorJson(c, result.status, result.error_code, result.message);
  }
  return c.json({ ok: true, data: result.data });
}

function parseJoinByIdBody(body: Record<string, unknown>): JoinGroupByIdInput | null {
  const groupId = typeof body.group_id === 'string' ? body.group_id.trim() : '';
  const memberUrl =
    typeof body.member_worker_b_url === 'string' ? body.member_worker_b_url.trim() : '';
  const memberHandle = typeof body.member_handle === 'string' ? body.member_handle.trim() : '';
  const memberPubkey = typeof body.member_pubkey === 'string' ? body.member_pubkey.trim() : '';
  const memberDhPubkey =
    typeof body.member_dh_pubkey === 'string' ? body.member_dh_pubkey.trim() : '';
  const wrappedKeyJson =
    typeof body.wrapped_key_json === 'string' ? body.wrapped_key_json : null;
  // SEC-AUDIT-2026-10-15：member_dh_pubkey 必填
  if (!GROUP_ID_RE.test(groupId) || !memberUrl || !memberHandle || !memberPubkey || !memberDhPubkey) {
    return null;
  }
  return {
    group_id: groupId,
    member_worker_b_url: memberUrl,
    member_handle: memberHandle,
    member_pubkey: memberPubkey,
    member_dh_pubkey: memberDhPubkey,
    wrapped_key_json: wrappedKeyJson,
  };
}

async function handleInternalGroupJoin(c: GroupContext): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(c.get('internalForwardBody') ?? '{}') as Record<string, unknown>;
  } catch {
    return errorJson(c, 400, 'INVALID_BODY', '请求体必须为 JSON');
  }
  const input = parseJoinByIdBody(body);
  if (!input) {
    return errorJson(c, 400, 'GROUP_ENVELOPE_INVALID', '按群号入群字段无效');
  }
  const result = await joinGroupByIdOnOwner(c.env, input);
  if (!result.ok) {
    return errorJson(c, result.status, result.error_code, result.message);
  }
  return c.json({ ok: true, data: result.data });
}

/** NCF-2D2：result → 既有 HTTP JSON */
function acceptGroupMessageResultToResponse(
  c: GroupContext,
  result: AcceptGroupMessageResult,
): Response {
  if (result.status === 'ok' && result.data) {
    return c.json({ ok: true, data: result.data });
  }
  return errorJson(
    c,
    (result.httpStatus as 400 | 403 | 404 | 409 | 429 | 500 | 503),
    result.error_code ?? 'INTERNAL_ERROR',
    result.message ?? '群消息接收失败',
  );
}

async function handleInternalGroupInbound(c: GroupContext): Promise<Response> {
  // NCF-2D2：HTTP/HMAC 在中间件；编排进 services/groups
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(c.get('internalForwardBody') ?? '{}') as Record<string, unknown>;
  } catch {
    return errorJson(c, 400, 'INVALID_BODY', '请求体必须为 JSON');
  }
  const envelope = parseGroupMessageEnvelope(body.envelope);
  if (!envelope) {
    return errorJson(c, 400, 'GROUP_ENVELOPE_INVALID', '群消息 envelope 无效');
  }

  const result = await executeAcceptGroupMessage(c.env, { envelope }, {
    schedule: (p) => c.executionCtx.waitUntil(p),
  });

  if (result.status === 'ok' && result.flags?.needMediaMirror) {
    c.executionCtx.waitUntil(mirrorGroupMediaFromSender(c.env, envelope));
  }

  return acceptGroupMessageResultToResponse(c, result);
}

async function handleInternalGroupRelay(c: GroupContext): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(c.get('internalForwardBody') ?? '{}') as Record<string, unknown>;
  } catch {
    return errorJson(c, 400, 'INVALID_BODY', '请求体必须为 JSON');
  }
  const payload = parseGroupRelayPayload(body);
  if (!payload) {
    return errorJson(c, 400, 'GROUP_ENVELOPE_INVALID', 'relay 载荷无效');
  }

  const localWorkerBUrl = (await resolveLocalPublicBaseUrl(c.env)) || '';
  if (!localWorkerBUrl) {
    return errorJson(c, 409, 'USER_NOT_REGISTERED', '节点尚未完成注册');
  }

  const result = await acceptGroupRelayLocally(c.env, payload, localWorkerBUrl, {
    schedule: (p) => c.executionCtx.waitUntil(p),
  });
  if (!result.ok) {
    return errorJson(c, result.status, result.error_code, result.message);
  }
  if (payload.envelope.media && result.data.duplicate !== true) {
    c.executionCtx.waitUntil(mirrorGroupMediaFromSender(c.env, payload.envelope));
  }
  return c.json({ ok: true, data: result.data });
}

async function handleInternalGroupSync(c: GroupContext): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(c.get('internalForwardBody') ?? '{}') as Record<string, unknown>;
  } catch {
    return errorJson(c, 400, 'INVALID_BODY', '请求体必须为 JSON');
  }
  const request = parseGroupSyncRequest(body);
  if (!request) {
    return errorJson(c, 400, 'GROUP_ENVELOPE_INVALID', 'sync 请求无效');
  }

  const localWorkerBUrl = (await resolveLocalPublicBaseUrl(c.env)) || '';
  if (!localWorkerBUrl) {
    return errorJson(c, 409, 'USER_NOT_REGISTERED', '节点尚未完成注册');
  }

  const result = await handleSyncWithParentAsParent(c.env, request, localWorkerBUrl);
  if (!result.ok) {
    return errorJson(c, result.status, result.error_code, result.message);
  }
  return c.json({ ok: true, data: result.data });
}

// SEC-5：连 HMAC 拒绝响应也不得缓存，不影响其余群 ingress 的响应策略。
groupsInternalApp.use('/fetch-wrapped-key', async (c, next) => {
  await next();
  c.header('Cache-Control', 'private, no-store');
});
groupsInternalApp.use('*', requireInternalForward);
groupsInternalApp.post('/invite-accept', handleInternalInviteAccept);
groupsInternalApp.post('/join', handleInternalGroupJoin);
groupsInternalApp.post('/fetch-wrapped-key', async (c) => {
  let body: unknown;
  try {
    body = JSON.parse(c.get('internalForwardBody') ?? '{}');
  } catch {
    return errorJson(c, 400, 'INVALID_BODY', '请求体必须为 JSON');
  }
  const result = await serveWrappedKeyOnOwner(c.env, body);
  if (!result.ok) {
    return errorJson(c, result.status, result.error_code, result.message);
  }
  return c.json({ ok: true, data: result.data });
});
groupsInternalApp.post('/member-left', async (c) => {
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(c.get('internalForwardBody') ?? '{}') as Record<string, unknown>;
  } catch {
    return errorJson(c, 400, 'INVALID_BODY', '请求体必须为 JSON');
  }
  // EPOCH SEC-1：须带 timestamp / nonce / sig（GROUP_MEMBER_LEFT_V1）
  const groupId = typeof body.group_id === 'string' ? body.group_id.trim() : '';
  const memberUrl =
    typeof body.member_worker_b_url === 'string' ? body.member_worker_b_url.trim() : '';
  const memberHandle =
    typeof body.member_handle === 'string' ? body.member_handle.trim() : 'member';
  const timestamp = typeof body.timestamp === 'string' ? body.timestamp.trim() : '';
  const nonce = typeof body.nonce === 'string' ? body.nonce.trim() : '';
  const sig = typeof body.sig === 'string' ? body.sig.trim() : '';
  if (!GROUP_ID_RE.test(groupId) || !memberUrl || !timestamp || !nonce || !sig) {
    return errorJson(c, 400, 'GROUP_ENVELOPE_INVALID', 'member-left 字段无效');
  }
  const { applyMemberLeftOnOwner } = await import('../../lib/groupLeave');
  const result = await applyMemberLeftOnOwner(c.env, {
    group_id: groupId,
    member_worker_b_url: memberUrl,
    member_handle: memberHandle,
    timestamp,
    nonce,
    sig,
  });
  if (!result.ok) {
    const status = (result.status ?? 409) as 400 | 403 | 404 | 409;
    return errorJson(c, status, result.error_code, result.message);
  }
  return c.json({ ok: true, data: { group_id: groupId, status: 'left' } });
});
groupsInternalApp.post('/member-url-changed', async (c) => {
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(c.get('internalForwardBody') ?? '{}') as Record<string, unknown>;
  } catch {
    return errorJson(c, 400, 'INVALID_BODY', '请求体必须为 JSON');
  }
  const groupId = typeof body.group_id === 'string' ? body.group_id.trim() : '';
  if (!GROUP_ID_RE.test(groupId)) {
    return errorJson(c, 400, 'GROUP_ENVELOPE_INVALID', 'group_id 无效');
  }
  const eventRaw = body.event;
  if (!eventRaw || typeof eventRaw !== 'object') {
    return errorJson(c, 400, 'GROUP_ENVELOPE_INVALID', 'event 必填');
  }
  const { handleMemberUrlChangedOnOwner } = await import('../../lib/groupUrlChangeAnnounce');
  const result = await handleMemberUrlChangedOnOwner(
    c.env,
    groupId,
    eventRaw as import('@hailuo/shared-types').NodeUrlChangedEvent,
  );
  if (!result.ok) {
    return errorJson(c, result.status, result.error_code, result.message);
  }
  return c.json({ ok: true, data: result.data });
});
groupsInternalApp.post('/inbound', handleInternalGroupInbound);
groupsInternalApp.post('/relay', handleInternalGroupRelay);
groupsInternalApp.post('/sync-with-parent', handleInternalGroupSync);

/**
 * REL-FIX-6：跨节点管理员代理拉取 / 审批群主待审批入群申请。
 * 群主权威侧校验：请求方必须是群主库在册 admin/owner（不采信自证）+ 验签 + 时间窗 + nonce + 限频。
 */
groupsInternalApp.post('/admin-join-requests', async (c) => {
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(c.get('internalForwardBody') ?? '{}') as Record<string, unknown>;
  } catch {
    return errorJson(c, 400, 'INVALID_BODY', '请求体必须为 JSON');
  }
  const groupId = typeof body.group_id === 'string' ? body.group_id.trim() : '';
  const requesterUrl =
    typeof body.requester_worker_b_url === 'string' ? body.requester_worker_b_url.trim() : '';
  const requesterHandle =
    typeof body.requester_handle === 'string' ? body.requester_handle.trim() : '';
  const targetUrl =
    typeof body.target_member_worker_b_url === 'string'
      ? body.target_member_worker_b_url.trim()
      : '';
  const timestamp = typeof body.timestamp === 'string' ? body.timestamp.trim() : '';
  const nonce = typeof body.nonce === 'string' ? body.nonce.trim() : '';
  const sig = typeof body.sig === 'string' ? body.sig.trim() : '';
  const actionRaw = typeof body.action === 'string' ? body.action.trim() : 'list';
  if (!GROUP_ID_RE.test(groupId)) {
    return errorJson(c, 400, 'GROUP_ENVELOPE_INVALID', 'group_id 无效');
  }
  if (actionRaw !== 'list' && actionRaw !== 'approve' && actionRaw !== 'reject') {
    return errorJson(c, 400, 'GROUP_ENVELOPE_INVALID', 'action 无效');
  }
  if (!requesterUrl || !requesterHandle || !timestamp || !nonce || !sig) {
    return errorJson(c, 400, 'GROUP_ENVELOPE_INVALID', '管理员代理请求字段无效');
  }

  const { serveAdminJoinRequestActionOnOwner, serveAdminJoinRequestListOnOwner } =
    await import('../../lib/groupAdminJoinRequest');

  if (actionRaw === 'list') {
    const result = await serveAdminJoinRequestListOnOwner(c.env, {
      group_id: groupId,
      requester_worker_b_url: requesterUrl,
      requester_handle: requesterHandle,
      timestamp,
      nonce,
      sig,
    });
    if (!result.ok) {
      return errorJson(c, result.status, result.error_code, result.message);
    }
    return c.json({ ok: true, data: { items: result.items } });
  }

  if (!targetUrl) {
    return errorJson(c, 400, 'GROUP_ENVELOPE_INVALID', '缺少审批目标成员');
  }
  const result = await serveAdminJoinRequestActionOnOwner(c.env, {
    group_id: groupId,
    action: actionRaw,
    requester_worker_b_url: requesterUrl,
    requester_handle: requesterHandle,
    target_member_worker_b_url: targetUrl,
    timestamp,
    nonce,
    sig,
  });
  if (!result.ok) {
    return errorJson(c, result.status, result.error_code, result.message);
  }
  return c.json({ ok: true, data: result.data });
});

/**
 * REL-FIX-7：群主把入群审批结果回推给申请人节点。
 * 验签用本机 `group_members` 里 role='owner' 的 pin 公钥（不采信信封自带公钥）。
 */
groupsInternalApp.post('/join-decision', async (c) => {
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(c.get('internalForwardBody') ?? '{}') as Record<string, unknown>;
  } catch {
    return errorJson(c, 400, 'INVALID_BODY', '请求体必须为 JSON');
  }
  const groupId = typeof body.group_id === 'string' ? body.group_id.trim() : '';
  const decision =
    typeof body.decision === 'string' ? body.decision.trim() : '';
  const memberUrl =
    typeof body.member_worker_b_url === 'string' ? body.member_worker_b_url.trim() : '';
  const ownerUrl =
    typeof body.owner_worker_b_url === 'string' ? body.owner_worker_b_url.trim() : '';
  const ownerHandle =
    typeof body.owner_handle === 'string' ? body.owner_handle.trim() : '';
  const ownerPubkey =
    typeof body.owner_pubkey === 'string' ? body.owner_pubkey.trim() : '';
  const groupName = typeof body.group_name === 'string' ? body.group_name.trim() : '';
  const timestamp = typeof body.timestamp === 'string' ? body.timestamp.trim() : '';
  const nonce = typeof body.nonce === 'string' ? body.nonce.trim() : '';
  const sig = typeof body.sig === 'string' ? body.sig.trim() : '';
  if (!groupId || !memberUrl || !ownerUrl || !timestamp || !nonce || !sig) {
    return errorJson(c, 400, 'GROUP_ENVELOPE_INVALID', '入群审批结果字段无效');
  }
  if (decision !== 'approved' && decision !== 'rejected') {
    return errorJson(c, 400, 'GROUP_ENVELOPE_INVALID', '审批结果非法');
  }

  const { applyGroupJoinDecisionLocally } = await import('../../lib/groupJoinDecision');
  const result = await applyGroupJoinDecisionLocally(c.env, {
    kind: 'GROUP_JOIN_DECISION_V1',
    group_id: groupId,
    decision,
    group_name: groupName,
    owner_worker_b_url: ownerUrl,
    owner_handle: ownerHandle,
    owner_pubkey: ownerPubkey,
    member_worker_b_url: memberUrl,
    timestamp,
    nonce,
    sig,
  });
  if (!result.ok) {
    return errorJson(c, result.status, result.error_code, result.message);
  }
  return c.json({
    ok: true,
    data: { group_id: groupId, status: result.status, applied: result.applied },
  });
});

groupsInternalApp.post('/media/serve', async (c) => {
  // NCF-2D3：HTTP/HMAC 在中间件；验票进 services/messaging-media
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(c.get('internalForwardBody') ?? '{}') as Record<string, unknown>;
  } catch {
    return errorJson(c, 400, 'INVALID_BODY', '请求体必须为 JSON');
  }
  const storageKey =
    typeof body?.storage_key === 'string' ? body.storage_key.trim() : '';
  const ticketRaw = body?.ticket;
  if (!storageKey || !ticketRaw) {
    return errorJson(c, 400, 'INVALID_BODY', '缺少 storage_key 或 ticket');
  }
  const ticket =
    typeof ticketRaw === 'string'
      ? decodeGroupMediaFetchTicketParam(ticketRaw)
      : typeof ticketRaw === 'object'
        ? (ticketRaw as import('@hailuo/shared-types').GroupMediaFetchTicket)
        : null;
  if (!ticket) {
    return errorJson(c, 403, 'GROUP_MEDIA_TICKET_INVALID', 'ticket 无效');
  }

  const result = await executeServeMessagingMedia(c.env, {
    kind: 'group',
    ticket,
    storageKey,
  });
  return serveMessagingMediaResultToResponse(c, result);
});

/** NCF-2D3：验票 result → JSON 错误或 serveMediaObject */
function serveMessagingMediaResultToResponse(
  c: GroupContext,
  result: ServeMessagingMediaResult,
): Response | Promise<Response> {
  if (result.status === 'ok' && result.data?.storage_key) {
    return serveMediaObject(c.env, result.data.storage_key);
  }
  return errorJson(
    c,
    (result.httpStatus as 400 | 403 | 404 | 500),
    result.error_code ?? 'INTERNAL_ERROR',
    result.message ?? '媒体验票失败',
  );
}

