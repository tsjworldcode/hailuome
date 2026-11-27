/**
 * M16-1c/2：Worker B 群 ingress（极窄转发，无 D1）。
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env } from '../env.d';
import { parseGroupFetchWrappedKey } from '@hailuo/shared-crypto';
import { parseGroupModerationKick } from '@hailuo/shared-crypto';
import {
  assertWorkerABinding,
  forwardRawBodyToWorkerA,
  ingressErrorJson,
  readRawBodyWithLimit,
} from '../lib/publicIngress';

type AppEnv = { Bindings: Env };
type GroupContext = Context<AppEnv>;

const MAX_INVITE_BODY_BYTES = 16 * 1024;
const MAX_MESSAGE_BODY_BYTES = 64 * 1024;
const GROUP_ID_RE = /^grp_[a-zA-Z0-9_-]{8,128}$/;
const GMSG_ID_RE = /^gmsg_[a-zA-Z0-9_-]{8,128}$/;
const PUBKEY_RE = /^[0-9a-f]{64}$/i;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T/;

export const groupsApp = new Hono<AppEnv>();

/** MOD-1：外层只验外形，权限与 pin 验签由群主权威完成。 */
groupsApp.use('/moderation', async (c, next) => {
  await next();
  c.header('Cache-Control', 'private, no-store');
});
groupsApp.post('/moderation', async (c) => {
  try {
    return await forwardGroupIngress(c, '/groups/moderation', MAX_INVITE_BODY_BYTES,
      (raw) => parseGroupModerationKick(raw) !== null, '群管理信封无效');
  } catch {
    return ingressErrorJson(503, 'GROUP_MODERATION_UNAVAILABLE', '群管理服务暂不可用');
  }
});

function looksLikeInviteAccept(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object') return false;
  const o = raw as Record<string, unknown>;
  if (
    typeof o.invite_token !== 'string' ||
    o.invite_token.trim().length === 0 ||
    typeof o.member_worker_b_url !== 'string' ||
    o.member_worker_b_url.trim().length === 0 ||
    typeof o.member_handle !== 'string' ||
    o.member_handle.trim().length === 0 ||
    typeof o.member_pubkey !== 'string' ||
    !PUBKEY_RE.test(o.member_pubkey.trim())
  ) {
    return false;
  }
  // 旧路径：带合法 group_id；短码 / ginv_ 可无 group_id（群主查表）
  const groupId = typeof o.group_id === 'string' ? o.group_id.trim() : '';
  if (groupId) return GROUP_ID_RE.test(groupId);
  const token = o.invite_token.trim();
  if (/^[0-9A-HJKMNP-TV-Z]{8}$/i.test(token)) return true;
  return token.startsWith('ginv_') && token.length > 12;
}

/** M16-JOIN-POLICY-2：按群号加入粗校验（无 invite_token）。 */
function looksLikeGroupJoin(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object') return false;
  const o = raw as Record<string, unknown>;
  return (
    typeof o.group_id === 'string' &&
    GROUP_ID_RE.test(o.group_id.trim()) &&
    typeof o.member_worker_b_url === 'string' &&
    o.member_worker_b_url.trim().length > 0 &&
    typeof o.member_handle === 'string' &&
    o.member_handle.trim().length > 0 &&
    typeof o.member_pubkey === 'string' &&
    PUBKEY_RE.test(o.member_pubkey.trim())
  );
}

/** Worker B 粗校验 GROUP_MESSAGE envelope（权威验签在 Worker A）。 */
function looksLikeGroupMessageEnvelope(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object') return false;
  const e = raw as Record<string, unknown>;
  return (
    e.v === 1 &&
    e.kind === 'GROUP_MESSAGE' &&
    typeof e.group_id === 'string' &&
    GROUP_ID_RE.test(e.group_id) &&
    typeof e.message_id === 'string' &&
    GMSG_ID_RE.test(e.message_id) &&
    typeof e.epoch === 'number' &&
    typeof e.sender_handle === 'string' &&
    typeof e.sender_worker_b_url === 'string' &&
    typeof e.owner_worker_b_url === 'string' &&
    typeof e.created_at === 'string' &&
    ISO_RE.test(e.created_at) &&
    typeof e.expires_at === 'string' &&
    ISO_RE.test(e.expires_at) &&
    typeof e.nonce === 'string' &&
    (e.msg_kind === 'chat' || e.msg_kind === 'system') &&
    typeof e.ciphertext === 'string' &&
    typeof e.sig === 'string'
  );
}

function looksLikeGroupInbound(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object') return false;
  const o = raw as Record<string, unknown>;
  return looksLikeGroupMessageEnvelope(o.envelope);
}

function looksLikeGroupRelay(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object') return false;
  const o = raw as Record<string, unknown>;
  const hop = o.hop_count === undefined ? 0 : o.hop_count;
  return looksLikeGroupMessageEnvelope(o.envelope) && typeof hop === 'number' && hop >= 0 && hop <= 10;
}

async function forwardGroupIngress(
  c: GroupContext,
  upstreamPath: string,
  maxBytes: number,
  validate: (raw: unknown) => boolean,
  invalidMessage: string,
): Promise<Response> {
  const bindingErr = assertWorkerABinding(c.env);
  if (bindingErr) return bindingErr;

  const bodyRead = await readRawBodyWithLimit(c.req.raw, maxBytes);
  if (!bodyRead.ok) {
    return ingressErrorJson(413, 'GROUP_ENVELOPE_TOO_LARGE', '请求体超过大小限制');
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(bodyRead.rawBody) as Record<string, unknown>;
  } catch {
    return ingressErrorJson(400, 'INVALID_BODY', '请求体必须为 JSON');
  }
  if (!validate(parsed)) {
    return ingressErrorJson(400, 'GROUP_ENVELOPE_INVALID', invalidMessage);
  }

  return forwardRawBodyToWorkerA(c.env, {
    upstreamPath,
    method: 'POST',
    rawBody: bodyRead.rawBody,
  });
}

groupsApp.post('/invite-accept', async (c) => {
  const bindingErr = assertWorkerABinding(c.env);
  if (bindingErr) return bindingErr;

  const bodyRead = await readRawBodyWithLimit(c.req.raw, MAX_INVITE_BODY_BYTES);
  if (!bodyRead.ok) {
    return ingressErrorJson(413, 'GROUP_ENVELOPE_TOO_LARGE', '请求体超过大小限制');
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(bodyRead.rawBody) as Record<string, unknown>;
  } catch {
    return ingressErrorJson(400, 'INVALID_BODY', '请求体必须为 JSON');
  }
  if (!looksLikeInviteAccept(parsed)) {
    return ingressErrorJson(400, 'GROUP_ENVELOPE_INVALID', '入群请求字段无效');
  }

  return forwardRawBodyToWorkerA(c.env, {
    upstreamPath: '/groups/invite-accept',
    method: 'POST',
    rawBody: bodyRead.rawBody,
  });
});

groupsApp.post('/join', async (c) => {
  const bindingErr = assertWorkerABinding(c.env);
  if (bindingErr) return bindingErr;

  const bodyRead = await readRawBodyWithLimit(c.req.raw, MAX_INVITE_BODY_BYTES);
  if (!bodyRead.ok) {
    return ingressErrorJson(413, 'GROUP_ENVELOPE_TOO_LARGE', '请求体超过大小限制');
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(bodyRead.rawBody) as Record<string, unknown>;
  } catch {
    return ingressErrorJson(400, 'INVALID_BODY', '请求体必须为 JSON');
  }
  if (!looksLikeGroupJoin(parsed)) {
    return ingressErrorJson(400, 'GROUP_ENVELOPE_INVALID', '按群号入群字段无效');
  }

  return forwardRawBodyToWorkerA(c.env, {
    upstreamPath: '/groups/join',
    method: 'POST',
    rawBody: bodyRead.rawBody,
  });
});

/** SEC-5：B 只检查信封和时间，成员 pin 验签/nonce/频控由 A 权威执行。 */
groupsApp.use('/fetch-wrapped-key', async (c, next) => {
  await next();
  // 入口可能直接返回 Response，必须在最终响应上设置，不能只预置 context header。
  c.header('Cache-Control', 'private, no-store');
});
groupsApp.post('/fetch-wrapped-key', async (c) => {
  const bindingErr = assertWorkerABinding(c.env);
  if (bindingErr) return bindingErr;

  const bodyRead = await readRawBodyWithLimit(c.req.raw, MAX_INVITE_BODY_BYTES);
  if (!bodyRead.ok) {
    return ingressErrorJson(413, 'GROUP_ENVELOPE_TOO_LARGE', '请求体超过大小限制');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyRead.rawBody);
  } catch {
    return ingressErrorJson(400, 'INVALID_BODY', '请求体必须为 JSON');
  }
  if (!parseGroupFetchWrappedKey(parsed)) {
    return ingressErrorJson(403, 'GROUP_WRAP_FORBIDDEN', '无权获取群密钥');
  }

  try {
    return await forwardRawBodyToWorkerA(c.env, {
      upstreamPath: '/groups/fetch-wrapped-key',
      method: 'POST',
      rawBody: bodyRead.rawBody,
    });
  } catch {
    return ingressErrorJson(503, 'GROUP_WRAP_UNAVAILABLE', '群密钥服务暂不可用');
  }
});

/** EPOCH v0.3 + SEC-1：成员退群异步通知（须 GROUP_MEMBER_LEFT_V1：timestamp/nonce/sig） */
groupsApp.post('/member-left', async (c) => {
  const bindingErr = assertWorkerABinding(c.env);
  if (bindingErr) return bindingErr;

  const bodyRead = await readRawBodyWithLimit(c.req.raw, MAX_INVITE_BODY_BYTES);
  if (!bodyRead.ok) {
    return ingressErrorJson(413, 'GROUP_ENVELOPE_TOO_LARGE', '请求体超过大小限制');
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(bodyRead.rawBody) as Record<string, unknown>;
  } catch {
    return ingressErrorJson(400, 'INVALID_BODY', '请求体必须为 JSON');
  }
  if (
    typeof parsed.group_id !== 'string' ||
    !GROUP_ID_RE.test(parsed.group_id.trim()) ||
    typeof parsed.member_worker_b_url !== 'string' ||
    parsed.member_worker_b_url.trim().length === 0 ||
    typeof parsed.timestamp !== 'string' ||
    parsed.timestamp.trim().length === 0 ||
    typeof parsed.nonce !== 'string' ||
    parsed.nonce.trim().length === 0 ||
    typeof parsed.sig !== 'string' ||
    parsed.sig.trim().length === 0
  ) {
    return ingressErrorJson(400, 'GROUP_ENVELOPE_INVALID', 'member-left 字段无效');
  }

  return forwardRawBodyToWorkerA(c.env, {
    upstreamPath: '/groups/member-left',
    method: 'POST',
    rawBody: bodyRead.rawBody,
  });
});

/** M7-30-GROUP-URL：成员换域通知主责名单（群主改权威并代发；其余人验签改址） */
groupsApp.post('/member-url-changed', async (c) => {
  const bindingErr = assertWorkerABinding(c.env);
  if (bindingErr) return bindingErr;

  const bodyRead = await readRawBodyWithLimit(c.req.raw, MAX_INVITE_BODY_BYTES);
  if (!bodyRead.ok) {
    return ingressErrorJson(413, 'GROUP_ENVELOPE_TOO_LARGE', '请求体超过大小限制');
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(bodyRead.rawBody) as Record<string, unknown>;
  } catch {
    return ingressErrorJson(400, 'INVALID_BODY', '请求体必须为 JSON');
  }
  if (typeof parsed.group_id !== 'string' || !parsed.event || typeof parsed.event !== 'object') {
    return ingressErrorJson(400, 'GROUP_ENVELOPE_INVALID', 'member-url-changed 字段无效');
  }

  return forwardRawBodyToWorkerA(c.env, {
    upstreamPath: '/groups/member-url-changed',
    method: 'POST',
    rawBody: bodyRead.rawBody,
  });
});

/** REL-FIX-6：跨节点管理员代理拉取 / 审批群主待审批入群申请。 */
function looksLikeAdminJoinRequest(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object') return false;
  const o = raw as Record<string, unknown>;
  const action = typeof o.action === 'string' ? o.action.trim() : 'list';
  if (action !== 'list' && action !== 'approve' && action !== 'reject') return false;
  if (
    typeof o.group_id !== 'string' ||
    !GROUP_ID_RE.test(o.group_id.trim()) ||
    typeof o.requester_worker_b_url !== 'string' ||
    o.requester_worker_b_url.trim().length === 0 ||
    typeof o.requester_handle !== 'string' ||
    o.requester_handle.trim().length === 0 ||
    typeof o.timestamp !== 'string' ||
    o.timestamp.trim().length === 0 ||
    typeof o.nonce !== 'string' ||
    o.nonce.trim().length === 0 ||
    typeof o.sig !== 'string' ||
    o.sig.trim().length === 0
  ) {
    return false;
  }
  // action=list 时 target 可空；approve/reject 必须带 target
  const target =
    typeof o.target_member_worker_b_url === 'string' ? o.target_member_worker_b_url.trim() : '';
  return action === 'list' ? true : target.length > 0;
}

groupsApp.post('/admin-join-requests', async (c) => {
  const bindingErr = assertWorkerABinding(c.env);
  if (bindingErr) return bindingErr;

  const bodyRead = await readRawBodyWithLimit(c.req.raw, MAX_INVITE_BODY_BYTES);
  if (!bodyRead.ok) {
    return ingressErrorJson(413, 'GROUP_ENVELOPE_TOO_LARGE', '请求体超过大小限制');
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(bodyRead.rawBody) as Record<string, unknown>;
  } catch {
    return ingressErrorJson(400, 'INVALID_BODY', '请求体必须为 JSON');
  }
  if (!looksLikeAdminJoinRequest(parsed)) {
    return ingressErrorJson(400, 'GROUP_ENVELOPE_INVALID', '管理员代理请求字段无效');
  }

  return forwardRawBodyToWorkerA(c.env, {
    upstreamPath: '/groups/admin-join-requests',
    method: 'POST',
    rawBody: bodyRead.rawBody,
  });
});

/** REL-FIX-7：群主把入群审批结果回推给申请人节点（外形校验，验签在 Worker A）。 */
function looksLikeGroupJoinDecision(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object') return false;
  const o = raw as Record<string, unknown>;
  const decision = typeof o.decision === 'string' ? o.decision.trim() : '';
  if (decision !== 'approved' && decision !== 'rejected') return false;
  if (
    typeof o.group_id !== 'string' ||
    !GROUP_ID_RE.test(o.group_id.trim()) ||
    typeof o.member_worker_b_url !== 'string' ||
    o.member_worker_b_url.trim().length === 0 ||
    typeof o.owner_worker_b_url !== 'string' ||
    o.owner_worker_b_url.trim().length === 0 ||
    typeof o.timestamp !== 'string' ||
    o.timestamp.trim().length === 0 ||
    typeof o.nonce !== 'string' ||
    o.nonce.trim().length === 0 ||
    typeof o.sig !== 'string' ||
    o.sig.trim().length === 0
  ) {
    return false;
  }
  return true;
}

groupsApp.post('/join-decision', async (c) => {
  const bindingErr = assertWorkerABinding(c.env);
  if (bindingErr) return bindingErr;

  const bodyRead = await readRawBodyWithLimit(c.req.raw, MAX_INVITE_BODY_BYTES);
  if (!bodyRead.ok) {
    return ingressErrorJson(413, 'GROUP_ENVELOPE_TOO_LARGE', '请求体超过大小限制');
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(bodyRead.rawBody) as Record<string, unknown>;
  } catch {
    return ingressErrorJson(400, 'INVALID_BODY', '请求体必须为 JSON');
  }
  if (!looksLikeGroupJoinDecision(parsed)) {
    return ingressErrorJson(400, 'GROUP_ENVELOPE_INVALID', '入群审批结果字段无效');
  }

  return forwardRawBodyToWorkerA(c.env, {
    upstreamPath: '/groups/join-decision',
    method: 'POST',
    rawBody: bodyRead.rawBody,
  });
});

groupsApp.post('/inbound', async (c) =>
  forwardGroupIngress(c, '/groups/inbound', MAX_MESSAGE_BODY_BYTES, looksLikeGroupInbound, '群消息 envelope 无效'),
);

groupsApp.post('/relay', async (c) =>
  forwardGroupIngress(c, '/groups/relay', MAX_MESSAGE_BODY_BYTES, looksLikeGroupRelay, '群 relay 载荷无效'),
);

function looksLikeGroupSync(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object') return false;
  const o = raw as Record<string, unknown>;
  return (
    o.v === 1 &&
    o.kind === 'GROUP_SYNC' &&
    typeof o.group_id === 'string' &&
    GROUP_ID_RE.test(o.group_id) &&
    typeof o.sender_handle === 'string' &&
    typeof o.sender_worker_b_url === 'string' &&
    typeof o.owner_worker_b_url === 'string' &&
    typeof o.epoch === 'number' &&
    typeof o.created_at === 'string' &&
    ISO_RE.test(o.created_at) &&
    typeof o.expires_at === 'string' &&
    ISO_RE.test(o.expires_at) &&
    typeof o.nonce === 'string' &&
    typeof o.sig === 'string' &&
    (o.cursor === null || o.cursor === undefined || (typeof o.cursor === 'string' && GMSG_ID_RE.test(o.cursor))) &&
    Array.isArray(o.acks)
  );
}

groupsApp.post('/sync-with-parent', async (c) =>
  forwardGroupIngress(
    c,
    '/groups/sync-with-parent',
    MAX_MESSAGE_BODY_BYTES,
    looksLikeGroupSync,
    '群 sync 请求无效',
  ),
);

/** MM-5：持 GROUP_MEDIA_FETCH_TICKET_V1 拉取群图密文 blob（HMAC 转发 Worker A 验签） */
groupsApp.get('/media/:storage_key', async (c) => {
  const bindingErr = assertWorkerABinding(c.env);
  if (bindingErr) {
    return ingressErrorJson(503, 'WORKER_A_BINDING_MISSING', '媒体服务暂不可用，请稍后再试');
  }

  const ticketRaw = c.req.query('ticket');
  if (!ticketRaw) {
    return ingressErrorJson(403, 'GROUP_MEDIA_TICKET_INVALID', '缺少 ticket');
  }

  let ticket: unknown;
  try {
    ticket = JSON.parse(decodeURIComponent(ticketRaw));
  } catch {
    return ingressErrorJson(403, 'GROUP_MEDIA_TICKET_INVALID', 'ticket 无效');
  }
  const exp = (ticket as { exp?: number }).exp;
  if (typeof exp !== 'number' || exp < Math.floor(Date.now() / 1000)) {
    return ingressErrorJson(403, 'GROUP_MEDIA_TICKET_INVALID', 'ticket 已过期');
  }

  const storageKey = decodeURIComponent(c.req.param('storage_key'));
  const rawBody = JSON.stringify({ storage_key: storageKey, ticket });

  return forwardRawBodyToWorkerA(c.env, {
    upstreamPath: '/groups/media/serve',
    method: 'POST',
    rawBody,
  });
});
