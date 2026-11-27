/**
 * DM 路由：站主 JWT 面（/api/dm/*、/api/me/*）。
 * NCF-AUDIT-Y-15-2：内部 HMAC ingress 已拆至 ./dm/internal.ts；共享工具见 ./dm/shared.ts。
 * 契约：路径 / 错误码 / HTTP 状态不变。
 */
import { resolveIdentityDb } from '../db/bindings';
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { DmEnvelope } from '@hailuo/shared-types';
import {
  randomDmNonceHex,
  signDmSendTicket,
  signDmEnvelope,
  verifyDmEnvelope,
  verifyDmSendTicket,
  verifyRequest,
} from '@hailuo/shared-crypto';
import { PUBLIC_PROFILE_KV_KEY, type PublicOwnerProfile } from '@hailuo/shared-types';
import type { Env, AppVariables } from '../env';
import { parseDmEnvelope, parseDmEnvelopeUnsigned, normalizeDmPeerUrl } from '../lib/dmEnvelope';
import { isNodeBlacklisted } from '../lib/blacklistLookup';
import { fetchOutboundPeer, resolveSafeOutboundPeerUrl } from '../lib/fetchOutboundPeer';
import { normalizeWorkerBOrigin } from '@hailuo/shared-utils';
import { messagingDb } from '../lib/messagingDb';
import { mirrorDmMediaFromSender } from '../lib/dmMediaMirror';
import {
  decodeDmMediaFetchTicketParam,
  issueDmMediaFetchTicket,
} from '../lib/dmMediaFetchTicket';
import { serveMediaObject } from '../lib/mediaServe';
import { resolveLocalPublicBaseUrl } from '../lib/localPublicBaseUrl';
import {
  executeServeMessagingMedia,
  type ServeMessagingMediaResult,
} from '../services/messaging-media';
import {
  executeReceiveDmInbox,
  type ReceiveDmInboxResult,
} from '../services/dm';
import {
  type AppEnv,
  type DmContext,
  DM_TICKET_TTL_SEC,
  DM_PAGE_LIMIT_MAX,
  DM_WRAPPED_KEY_MAX,
  DM_IMPORT_BATCH_MAX,
  DM_IMPORT_BODY_MAX_BYTES,
  DM_PUBKEY_RE,
  nowIso,
  nowSec,
  errorJson,
  getLocalUser,
  readRawJson,
} from './dm/shared';

export { dmInternalApp } from './dm/internal';

export const dmApp = new Hono<AppEnv>();
export const dmMeApp = new Hono<AppEnv>();

async function syncLocalDmPubkeyToPublicProfile(env: Env, dmPubkey: string): Promise<void> {
  const row = await resolveIdentityDb(env)
    .prepare(
      `SELECT handle, display_name, bio, pubkey, dm_pubkey, worker_b_url, avatar_key,
              contact_email, created_at
         FROM users LIMIT 1`,
    )
    .first<{
      handle: string;
      display_name: string;
      bio: string;
      pubkey: string;
      dm_pubkey: string;
      worker_b_url: string;
      avatar_key: string | null;
      contact_email: string | null;
      created_at: string;
    }>();
  if (!row) return;
  const profile: PublicOwnerProfile = {
    handle: row.handle,
    display_name: row.display_name,
    bio: row.bio,
    pubkey: row.pubkey,
    dm_pubkey: dmPubkey || row.dm_pubkey || '',
    worker_b_url: row.worker_b_url,
    avatar_key: row.avatar_key ?? '',
    contact_email: row.contact_email ?? '',
    created_at: row.created_at,
    updated_at: nowIso(),
  };
  // dm_pubkey 是公开协商公钥；同步到 STATE_KV 供 Worker B 无 D1 暴露。
  await env.STATE_KV.put(PUBLIC_PROFILE_KV_KEY, JSON.stringify(profile));
}

async function isFollowing(env: Env, workerBUrl: string): Promise<boolean> {
  const normalized = normalizeDmPeerUrl(workerBUrl);
  const row = await resolveIdentityDb(env)
    .prepare(`SELECT 1 AS found FROM follows WHERE follower_node_url = ? LIMIT 1`)
    .bind(normalized)
    .first<{ found: number }>()
    .catch(() => null);
  return row !== null;
}

async function isBlacklisted(env: Env, workerBUrl: string): Promise<boolean> {
  // M-OPT-SPLIT-5：统一走 GOVERNANCE_DB helper
  return isNodeBlacklisted(env, workerBUrl);
}

function parseLimit(c: DmContext): number {
  const raw = parseInt(c.req.query('limit') ?? '20', 10);
  if (Number.isNaN(raw)) return 20;
  return Math.min(Math.max(raw, 1), DM_PAGE_LIMIT_MAX);
}

async function listMessages(c: DmContext, direction: 'inbox' | 'outbox') {
  const limit = parseLimit(c);
  const cursor = c.req.query('cursor')?.trim();
  const rows = await messagingDb(c.env)
    .prepare(
      `SELECT message_id, conversation_id, direction, peer_handle, peer_worker_b_url,
              envelope_json, created_at, read_at, delivery_status
         FROM dm_messages
        WHERE direction = ? AND (? IS NULL OR created_at < ?)
        ORDER BY created_at DESC
        LIMIT ?`,
    )
    .bind(direction, cursor || null, cursor || null, limit + 1)
    .all<{
      message_id: string;
      conversation_id: string;
      direction: 'inbox' | 'outbox';
      peer_handle: string;
      peer_worker_b_url: string;
      envelope_json: string;
      created_at: string;
      read_at: string | null;
      delivery_status: string;
    }>();
  const items = (rows.results ?? []).slice(0, limit).map((row: NonNullable<(typeof rows.results)[number]>) => {
    if (!row) return undefined;
    return {
      message_id: row.message_id,
      conversation_id: row.conversation_id,
      direction: row.direction,
      peer_handle: row.peer_handle,
      peer_worker_b_url: row.peer_worker_b_url,
      envelope: JSON.parse(row.envelope_json) as DmEnvelope,
      created_at: row.created_at,
      read_at: row.read_at,
      delivery_status: row.delivery_status,
    };
  }).filter(Boolean);
  const hasMore = (rows.results ?? []).length > limit;
  return c.json({
    ok: true,
    data: {
      items,
      has_more: hasMore,
      cursor: hasMore ? items[items.length - 1]?.created_at ?? null : null,
    },
  });
}


// POST /api/dm/sign-envelope
// 签名前强校验 envelope 与本节点权威一致：
//   - sender_handle === D1 users.handle
//   - sender_worker_b_url === resolveLocalPublicBaseUrl()（防浏览器改 envelope 伪造跨节点 sender）
//   - key_epoch >= 1；epoch > 1 时必须是本节点 dm_wrapped_keys 已登记的 (conversation, epoch, peer)
//     （MULTI-CLIENT-KEY-1：会话钥轮换后，旧逻辑恒拒 epoch≠1 会让新客户端/重登后完全无法发信）
// 校验失败沿用 DM_ENVELOPE_INVALID 以保持下游诊断稳定。
dmApp.post('/sign-envelope', async (c) => {
  const body = await readRawJson(c);
  const unsigned = parseDmEnvelopeUnsigned(body?.envelope);
  if (!unsigned) return errorJson(c, 400, 'DM_ENVELOPE_INVALID', '私信 envelope 无效');
  const localUser = await getLocalUser(c.env);
  if (!localUser || unsigned.sender_handle !== localUser.handle) {
    return errorJson(c, 403, 'DM_ENVELOPE_INVALID', '只能签名本节点站主发出的私信');
  }
  const localBaseUrl = normalizeDmPeerUrl(await resolveLocalPublicBaseUrl(c.env));
  if (!localBaseUrl || unsigned.sender_worker_b_url !== localBaseUrl) {
    return errorJson(c, 403, 'DM_ENVELOPE_INVALID', 'envelope 发送方节点与本节点不一致');
  }
  if (!Number.isSafeInteger(unsigned.key_epoch) || unsigned.key_epoch < 1) {
    return errorJson(c, 403, 'DM_ENVELOPE_INVALID', 'envelope key_epoch 无效');
  }
  if (unsigned.key_epoch > 1) {
    const registered = await messagingDb(c.env)
      .prepare(
        `SELECT 1 AS ok FROM dm_wrapped_keys
          WHERE conversation_id = ? AND key_epoch = ? AND peer_handle = ?
          LIMIT 1`,
      )
      .bind(
        unsigned.conversation_id,
        unsigned.key_epoch,
        unsigned.recipient_handle.trim().toLowerCase(),
      )
      .first<{ ok: number }>();
    if (!registered) {
      return errorJson(c, 403, 'DM_ENVELOPE_INVALID', 'envelope key_epoch 未在本节点登记');
    }
  }
  const sig = await signDmEnvelope(unsigned, c.env.ED25519_PRIVATE_KEY);
  return c.json({ ok: true, data: { envelope: { ...unsigned, sig } } });
});

// POST /api/dm/send-ticket
dmApp.post('/send-ticket', async (c) => {
  const body = await readRawJson(c);
  if (!body) return errorJson(c, 400, 'INVALID_BODY', '请求体必须为 JSON');
  const recipientHandle = typeof body.recipient_handle === 'string' ? body.recipient_handle.trim().toLowerCase() : '';
  const recipientWorkerBUrl = typeof body.recipient_worker_b_url === 'string'
    ? normalizeDmPeerUrl(body.recipient_worker_b_url)
    : '';
  if (!recipientWorkerBUrl.startsWith('https://')) {
    return errorJson(c, 400, 'INVALID_BODY', '收件人 Worker B URL 必须为 https://');
  }
  if (!recipientHandle || !recipientWorkerBUrl) {
    return errorJson(c, 400, 'INVALID_BODY', '缺少收件人 handle 或 Worker B URL');
  }
  if (!(await isFollowing(c.env, recipientWorkerBUrl))) {
    return errorJson(c, 403, 'DM_NOT_MUTUAL', '未与对方互粉，无法发送私信');
  }
  const localUser = await getLocalUser(c.env);
  if (!localUser) {
    return errorJson(c, 409, 'USER_NOT_REGISTERED', '节点尚未完成注册');
  }
  const ticket = {
    sender_handle: localUser.handle,
    recipient_handle: recipientHandle,
    recipient_worker_b_url: recipientWorkerBUrl,
    exp: nowSec() + DM_TICKET_TTL_SEC,
    nonce: randomDmNonceHex(16),
  };
  const sig = await signDmSendTicket(ticket, c.env.ED25519_PRIVATE_KEY);
  return c.json({ ok: true, data: { ticket: { ...ticket, sig } } });
});

/**
 * DM-PEER-PUBKEY-1：由本机 Worker A 服务端把**已签名的** DM envelope 转发到
 * 收件节点 Worker B `/dm/inbox`。浏览器不再直连对端 `workers.dev`，绕开
 * DNS 污染 / 企业代理 / 默认 token-required CORS。
 *
 * 安全：JWT 保护；收件 URL 过 SSRF 门禁；只转发 envelope 原文，不重签；
 * 日志不落完整 URL；响应 private, no-store。
 */
const DM_DELIVER_TIMEOUT_MS = 10_000;
const DM_DELIVER_BODY_MAX_BYTES = 64 * 1024;

dmApp.post('/deliver', async (c) => {
  c.header('Cache-Control', 'private, no-store');
  const body = await readRawJson(c);
  if (!body) return errorJson(c, 400, 'INVALID_BODY', '请求体必须为 JSON');
  const recipientRaw =
    typeof body.recipient_worker_b_url === 'string' ? body.recipient_worker_b_url.trim() : '';
  const envelope = body.envelope;
  if (!recipientRaw || !envelope || typeof envelope !== 'object') {
    return errorJson(c, 400, 'DM_ENVELOPE_INVALID', '缺少收件节点或 envelope');
  }
  const safe = resolveSafeOutboundPeerUrl(c.env, recipientRaw);
  if (!safe) return errorJson(c, 400, 'DM_PEER_NOT_FOUND', '收件节点地址无效');
  const recipientUrl = normalizeWorkerBOrigin(safe);
  const rawBody = JSON.stringify({ envelope });
  if (rawBody.length > DM_DELIVER_BODY_MAX_BYTES) {
    return c.json(
      { ok: false, error_code: 'DM_ENVELOPE_TOO_LARGE', message: '私信 envelope 超过大小限制' },
      413,
    );
  }
  const fetched = await fetchOutboundPeer(c.env, `${recipientUrl}/dm/inbox`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: rawBody,
    timeoutMs: DM_DELIVER_TIMEOUT_MS,
  });
  if (!fetched.ok) {
    return errorJson(c, 503, 'DM_PEER_UNREACHABLE', '暂时无法连接对方节点，请稍后重试');
  }
  // 透传对端响应：前端继续按 DM_NONCE_REPLAY / DM_TICKET_INVALID 等既有错误码处理。
  const text = await fetched.response.text();
  return new Response(text, {
    status: fetched.response.status,
    headers: {
      'Content-Type': fetched.response.headers.get('Content-Type') ?? 'application/json',
      'Cache-Control': 'private, no-store',
    },
  });
});

/**
 * MSG-FIX-2：出件箱投递态。
 * - pending：本机已落库、尚未确认对端收到
 * - sent：对端投递成功（或对端已有 → NONCE_REPLAY 幂等成功）
 * - failed：投递失败，可同信封重试
 * 旧值 `delivered` 写入时归一为 `sent`（读路径仍可能见到历史 delivered）。
 */
function normalizeDmOutboxDeliveryStatus(raw: unknown): 'pending' | 'sent' | 'failed' {
  const s = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (s === 'pending' || s === 'failed') return s;
  if (s === 'sent' || s === 'delivered') return 'sent';
  return 'pending';
}

// POST /api/dm/outbox
dmApp.post('/outbox', async (c) => {
  const body = await readRawJson(c);
  const envelope = parseDmEnvelope(body?.envelope);
  if (!envelope) return errorJson(c, 400, 'DM_ENVELOPE_INVALID', '私信 envelope 无效');
  const localUser = await getLocalUser(c.env);
  if (!localUser || envelope.sender_handle !== localUser.handle) {
    return errorJson(c, 403, 'DM_ENVELOPE_INVALID', '发件箱副本必须属于本节点站主');
  }
  if (envelope.sender_worker_b_url !== normalizeDmPeerUrl(await resolveLocalPublicBaseUrl(c.env))) {
    return errorJson(c, 403, 'DM_ENVELOPE_INVALID', '发件箱副本发送方节点不匹配');
  }
  if (!(await isFollowing(c.env, envelope.send_ticket.recipient_worker_b_url))) {
    return errorJson(c, 403, 'DM_NOT_MUTUAL', '未与对方互粉，无法保存发件箱副本');
  }
  // 发件箱验签统一用 D1 users.pubkey，与 env binding 解耦。
  if (!(await verifyDmSendTicket(envelope.send_ticket, localUser.pubkey))) {
    return errorJson(c, 403, 'DM_TICKET_INVALID', '私信 ticket 签名无效');
  }
  if (!(await verifyDmEnvelope(envelope, localUser.pubkey))) {
    return errorJson(c, 400, 'DM_ENVELOPE_INVALID', '私信 envelope 签名无效');
  }
  // MSG-FIX-2：默认 pending（local-first）；客户端投递成功后再写 sent
  const deliveryStatus = normalizeDmOutboxDeliveryStatus(body?.delivery_status);
  await messagingDb(c.env)
    .prepare(
      `INSERT OR REPLACE INTO dm_messages
       (message_id, conversation_id, direction, peer_handle, peer_worker_b_url, envelope_json, created_at, delivery_status)
       VALUES (?, ?, 'outbox', ?, ?, ?, ?, ?)`,
    )
    .bind(
      envelope.message_id,
      envelope.conversation_id,
      envelope.recipient_handle,
      envelope.send_ticket.recipient_worker_b_url,
      JSON.stringify(envelope),
      envelope.created_at,
      deliveryStatus,
    )
    .run();
  return c.json({
    ok: true,
    data: { message_id: envelope.message_id, delivery_status: deliveryStatus },
  });
});

// GET /api/dm/inbox
dmApp.get('/inbox', (c) => listMessages(c, 'inbox'));

// GET /api/dm/outbox
dmApp.get('/outbox', (c) => listMessages(c, 'outbox'));

// GET /api/dm/outbox/:messageId — MSG-FIX-2：同信封重试时取回本机已存 envelope
dmApp.get('/outbox/:messageId', async (c) => {
  const messageId = c.req.param('messageId')?.trim() ?? '';
  if (!messageId) return errorJson(c, 400, 'DM_ENVELOPE_INVALID', 'message_id 无效');
  const row = await messagingDb(c.env)
    .prepare(
      `SELECT message_id, conversation_id, direction, peer_handle, peer_worker_b_url,
              envelope_json, created_at, read_at, delivery_status
         FROM dm_messages
        WHERE message_id = ? AND direction = 'outbox'
        LIMIT 1`,
    )
    .bind(messageId)
    .first<{
      message_id: string;
      conversation_id: string;
      direction: 'outbox';
      peer_handle: string;
      peer_worker_b_url: string;
      envelope_json: string;
      created_at: string;
      read_at: string | null;
      delivery_status: string;
    }>();
  if (!row) return errorJson(c, 404, 'DM_MESSAGE_NOT_FOUND', '发件箱中无此消息');
  let envelope: DmEnvelope;
  try {
    envelope = JSON.parse(row.envelope_json) as DmEnvelope;
  } catch {
    return errorJson(c, 500, 'INTERNAL_ERROR', '发件箱 envelope 损坏');
  }
  return c.json({
    ok: true,
    data: {
      message_id: row.message_id,
      conversation_id: row.conversation_id,
      direction: row.direction,
      peer_handle: row.peer_handle,
      peer_worker_b_url: row.peer_worker_b_url,
      envelope,
      created_at: row.created_at,
      read_at: row.read_at,
      delivery_status: row.delivery_status,
    },
  });
});

// PATCH /api/dm/outbox/:messageId — MSG-FIX-2：仅更新投递态（重试成功/失败）
dmApp.patch('/outbox/:messageId', async (c) => {
  const messageId = c.req.param('messageId')?.trim() ?? '';
  if (!messageId) return errorJson(c, 400, 'DM_ENVELOPE_INVALID', 'message_id 无效');
  const body = await readRawJson(c);
  if (body?.delivery_status === undefined || body?.delivery_status === null) {
    return errorJson(c, 400, 'DM_ENVELOPE_INVALID', '缺少 delivery_status');
  }
  const deliveryStatus = normalizeDmOutboxDeliveryStatus(body.delivery_status);
  const result = await messagingDb(c.env)
    .prepare(
      `UPDATE dm_messages SET delivery_status = ?
        WHERE message_id = ? AND direction = 'outbox'`,
    )
    .bind(deliveryStatus, messageId)
    .run();
  const changed = Number(result.meta?.changes ?? 0);
  if (changed < 1) return errorJson(c, 404, 'DM_MESSAGE_NOT_FOUND', '发件箱中无此消息');
  return c.json({ ok: true, data: { message_id: messageId, delivery_status: deliveryStatus } });
});

// POST /api/dm/media/fetch-ticket — MM-3
dmApp.post('/media/fetch-ticket', async (c) => {
  const body = await readRawJson(c);
  const messageId = typeof body?.message_id === 'string' ? body.message_id.trim() : '';
  const mediaId = typeof body?.media_id === 'string' ? body.media_id.trim() : '';
  const conversationId =
    typeof body?.conversation_id === 'string' ? body.conversation_id.trim() : '';
  const senderStorageKey =
    typeof body?.sender_storage_key === 'string' ? body.sender_storage_key.trim() : '';
  if (!messageId || !mediaId || !conversationId || !senderStorageKey) {
    return errorJson(c, 400, 'INVALID_BODY', '缺少 message_id / media_id / conversation_id / sender_storage_key');
  }
  const ticket = await issueDmMediaFetchTicket(c.env, {
    message_id: messageId,
    media_id: mediaId,
    conversation_id: conversationId,
    sender_storage_key: senderStorageKey,
  });
  if (!ticket) {
    return errorJson(c, 404, 'MESSAGING_MEDIA_NOT_FOUND', '私信消息或媒体不存在');
  }
  return c.json({ ok: true, data: { ticket } });
});

// GET /api/dm/unread-count
dmApp.get('/unread-count', async (c) => {
  const row = await messagingDb(c.env)
    .prepare(
      `SELECT COUNT(*) AS unread_count
         FROM dm_messages
        WHERE direction = 'inbox' AND read_at IS NULL`,
    )
    .first<{ unread_count: number }>();
  return c.json({ ok: true, data: { unread_count: row?.unread_count ?? 0 } });
});

// POST /api/dm/messages/:messageId/read
dmApp.post('/messages/:messageId/read', async (c) => {
  const messageId = c.req.param('messageId')?.trim();
  if (!messageId) {
    return errorJson(c, 400, 'INVALID_BODY', '缺少 message_id');
  }
  const row = await messagingDb(c.env)
    .prepare(
      `SELECT message_id, direction FROM dm_messages WHERE message_id = ? LIMIT 1`,
    )
    .bind(messageId)
    .first<{ message_id: string; direction: 'inbox' | 'outbox' }>();
  if (!row) {
    return errorJson(c, 404, 'DM_MESSAGE_NOT_FOUND', '私信不存在');
  }
  if (row.direction !== 'inbox') {
    return errorJson(c, 400, 'INVALID_BODY', '仅收件箱消息可标记已读');
  }
  const readAt = nowIso();
  await messagingDb(c.env)
    .prepare(`UPDATE dm_messages SET read_at = ? WHERE message_id = ?`)
    .bind(readAt, messageId)
    .run();
  return c.json({ ok: true, data: { message_id: messageId, read_at: readAt } });
});

// DELETE /api/dm/messages/:messageId
dmApp.delete('/messages/:messageId', async (c) => {
  const messageId = c.req.param('messageId')?.trim();
  if (!messageId) {
    return errorJson(c, 400, 'INVALID_BODY', '缺少 message_id');
  }
  const result = await messagingDb(c.env)
    .prepare(`DELETE FROM dm_messages WHERE message_id = ?`)
    .bind(messageId)
    .run();
  if ((result.meta.changes ?? 0) === 0) {
    return errorJson(c, 404, 'DM_MESSAGE_NOT_FOUND', '私信不存在');
  }
  return c.json({ ok: true, data: { message_id: messageId, deleted: true } });
});

// DELETE /api/dm/conversations/:conversationId
dmApp.delete('/conversations/:conversationId', async (c) => {
  const conversationId = c.req.param('conversationId')?.trim();
  if (!conversationId) {
    return errorJson(c, 400, 'INVALID_BODY', '缺少 conversation_id');
  }
  const msgResult = await messagingDb(c.env)
    .prepare(`DELETE FROM dm_messages WHERE conversation_id = ?`)
    .bind(conversationId)
    .run();
  await messagingDb(c.env)
    .prepare(`DELETE FROM dm_wrapped_keys WHERE conversation_id = ?`)
    .bind(conversationId)
    .run();
  if ((msgResult.meta.changes ?? 0) === 0) {
    const wrapped = await messagingDb(c.env)
      .prepare(`SELECT 1 AS found FROM dm_wrapped_keys WHERE conversation_id = ? LIMIT 1`)
      .bind(conversationId)
      .first<{ found: number }>();
    if (!wrapped) {
      return errorJson(c, 404, 'DM_CONVERSATION_NOT_FOUND', '会话不存在');
    }
  }
  return c.json({
    ok: true,
    data: {
      conversation_id: conversationId,
      deleted_messages: msgResult.meta.changes ?? 0,
    },
  });
});

// GET /api/dm/wrapped-keys
dmApp.get('/wrapped-keys', async (c) => {
  const rows = await messagingDb(c.env)
    .prepare(
      `SELECT conversation_id, key_epoch, peer_handle, wrapped_key_json, updated_at
         FROM dm_wrapped_keys
        ORDER BY updated_at DESC`,
    )
    .all<{
      conversation_id: string;
      key_epoch: number;
      peer_handle: string;
      wrapped_key_json: string;
      updated_at: string;
    }>();
  return c.json({ ok: true, data: { items: rows.results ?? [] } });
});

// PUT /api/dm/wrapped-keys
dmApp.put('/wrapped-keys', async (c) => {
  const body = await readRawJson(c);
  if (!body) return errorJson(c, 400, 'INVALID_BODY', '请求体必须为 JSON');
  const conversationId = typeof body.conversation_id === 'string' ? body.conversation_id.trim() : '';
  const peerHandle = typeof body.peer_handle === 'string' ? body.peer_handle.trim().toLowerCase() : '';
  const keyEpoch = typeof body.key_epoch === 'number' && Number.isInteger(body.key_epoch) ? body.key_epoch : 1;
  const wrappedKey = body.wrapped_key_json;
  const wrappedKeyJson = typeof wrappedKey === 'string' ? wrappedKey : JSON.stringify(wrappedKey ?? {});
  if (!conversationId || !peerHandle || keyEpoch < 1 || wrappedKeyJson.length > DM_WRAPPED_KEY_MAX) {
    return errorJson(c, 400, 'INVALID_BODY', '包裹密钥字段无效');
  }
  await messagingDb(c.env)
    .prepare(
      `INSERT OR REPLACE INTO dm_wrapped_keys
       (conversation_id, key_epoch, peer_handle, wrapped_key_json, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(conversationId, keyEpoch, peerHandle, wrappedKeyJson, nowIso())
    .run();
  return c.json({ ok: true, data: { conversation_id: conversationId, key_epoch: keyEpoch } });
});

interface DmImportMessageItem {
  message_id: string;
  conversation_id: string;
  direction: 'inbox' | 'outbox';
  peer_handle: string;
  peer_worker_b_url: string;
  envelope_json: string;
  created_at: string;
  read_at: string | null;
  delivery_status: string;
}

/** M10-5b：校验备份导入单行；须与本节点站主 handle 一致。 */
function parseDmImportItem(
  raw: unknown,
  localHandle: string,
): { ok: true; item: DmImportMessageItem } | { ok: false; reason: string } {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, reason: '条目必须为对象' };
  }
  const obj = raw as Record<string, unknown>;
  const messageId = typeof obj.message_id === 'string' ? obj.message_id.trim() : '';
  const conversationId = typeof obj.conversation_id === 'string' ? obj.conversation_id.trim() : '';
  const direction = obj.direction;
  const peerHandle = typeof obj.peer_handle === 'string' ? obj.peer_handle.trim().toLowerCase() : '';
  const peerUrl =
    typeof obj.peer_worker_b_url === 'string' ? normalizeDmPeerUrl(obj.peer_worker_b_url) : '';
  const envelopeJson =
    typeof obj.envelope_json === 'string' ? obj.envelope_json.trim() : '';
  const createdAt = typeof obj.created_at === 'string' ? obj.created_at.trim() : '';
  const readAt =
    obj.read_at === null || obj.read_at === undefined
      ? null
      : typeof obj.read_at === 'string'
        ? obj.read_at.trim()
        : null;
  const deliveryStatus =
    typeof obj.delivery_status === 'string' && obj.delivery_status.trim()
      ? obj.delivery_status.trim()
      : 'delivered';

  if (!messageId || !conversationId || !peerHandle || !peerUrl || !envelopeJson || !createdAt) {
    return { ok: false, reason: '缺少必填字段' };
  }
  if (direction !== 'inbox' && direction !== 'outbox') {
    return { ok: false, reason: 'direction 无效' };
  }
  let envelope: DmEnvelope;
  try {
    const parsed = parseDmEnvelope(JSON.parse(envelopeJson));
    if (!parsed) return { ok: false, reason: 'envelope 无效' };
    envelope = parsed;
  } catch {
    return { ok: false, reason: 'envelope_json 非 JSON' };
  }
  if (envelope.message_id !== messageId || envelope.conversation_id !== conversationId) {
    return { ok: false, reason: 'envelope 与 message_id/conversation_id 不一致' };
  }
  const handle = localHandle.trim().toLowerCase();
  if (direction === 'inbox' && envelope.recipient_handle !== handle) {
    return { ok: false, reason: '收件箱消息不属于本节点站主' };
  }
  if (direction === 'outbox' && envelope.sender_handle !== handle) {
    return { ok: false, reason: '发件箱消息不属于本节点站主' };
  }
  if (readAt !== null && Number.isNaN(Date.parse(readAt))) {
    return { ok: false, reason: 'read_at 非 ISO 时间' };
  }
  return {
    ok: true,
    item: {
      message_id: messageId,
      conversation_id: conversationId,
      direction,
      peer_handle: peerHandle,
      peer_worker_b_url: peerUrl,
      envelope_json: envelopeJson,
      created_at: createdAt,
      read_at: readAt,
      delivery_status: deliveryStatus,
    },
  };
}

// POST /api/dm/import-messages — M10-5b 合并导入备份中的 dm_messages 副本
dmApp.post('/import-messages', async (c) => {
  const rawBody = c.get('internalForwardBody') as string | undefined;
  const bodyText = rawBody ?? (await c.req.text());
  if (bodyText.length > DM_IMPORT_BODY_MAX_BYTES) {
    return errorJson(c, 400, 'DM_IMPORT_BATCH_TOO_LARGE', '导入批次过大');
  }
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(bodyText) as Record<string, unknown>;
  } catch {
    return errorJson(c, 400, 'DM_IMPORT_INVALID', '请求体必须为 JSON');
  }
  const itemsRaw = body.items;
  if (!Array.isArray(itemsRaw)) {
    return errorJson(c, 400, 'DM_IMPORT_INVALID', 'items 必须为数组');
  }
  if (itemsRaw.length === 0 || itemsRaw.length > DM_IMPORT_BATCH_MAX) {
    return errorJson(c, 400, 'DM_IMPORT_BATCH_TOO_LARGE', `单次最多导入 ${DM_IMPORT_BATCH_MAX} 条消息`);
  }
  const localUser = await getLocalUser(c.env);
  if (!localUser) {
    return errorJson(c, 409, 'USER_NOT_REGISTERED', '节点尚未完成注册');
  }
  const parsedItems: DmImportMessageItem[] = [];
  const errors: string[] = [];
  for (let i = 0; i < itemsRaw.length; i++) {
    const parsed = parseDmImportItem(itemsRaw[i], localUser.handle);
    if (!parsed.ok) {
      errors.push(`items[${i}]: ${parsed.reason}`);
      continue;
    }
    parsedItems.push(parsed.item);
  }
  if (parsedItems.length === 0) {
    return errorJson(c, 400, 'DM_IMPORT_INVALID', errors[0] ?? '无有效导入行');
  }
  let inserted = 0;
  let skipped = 0;
  for (const item of parsedItems) {
    const result = await messagingDb(c.env)
      .prepare(
        `INSERT OR IGNORE INTO dm_messages
         (message_id, conversation_id, direction, peer_handle, peer_worker_b_url,
          envelope_json, created_at, read_at, delivery_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        item.message_id,
        item.conversation_id,
        item.direction,
        item.peer_handle,
        item.peer_worker_b_url,
        item.envelope_json,
        item.created_at,
        item.read_at,
        item.delivery_status,
      )
      .run();
    const changes = result.meta.changes ?? 0;
    if (changes > 0) inserted += 1;
    else skipped += 1;
  }
  console.info(
    `[dm] import-messages inserted=${inserted} skipped=${skipped} invalid=${errors.length}`,
  );
  return c.json({
    ok: true,
    data: {
      inserted,
      skipped,
      invalid: errors.length,
      errors: errors.slice(0, 20),
    },
  });
});

// GET /api/dm/wrapped-identity — 登录 hydrate 读取包裹身份私钥
dmApp.get('/wrapped-identity', async (c) => {
  const localUser = await getLocalUser(c.env);
  if (!localUser) return errorJson(c, 409, 'USER_NOT_REGISTERED', '节点尚未完成注册');
  const row = await messagingDb(c.env)
    .prepare(
      `SELECT owner_handle, public_key_hex, wrapped_identity_json, updated_at
         FROM dm_wrapped_identity
        WHERE owner_handle = ?`,
    )
    .bind(localUser.handle)
    .first<{
      owner_handle: string;
      public_key_hex: string;
      wrapped_identity_json: string;
      updated_at: string;
    }>();
  if (!row) {
    return c.json({ ok: true, data: null });
  }
  return c.json({ ok: true, data: row });
});

// PUT /api/dm/wrapped-identity — 原子写入包裹身份 + 同步 users.dm_pubkey + STATE_KV
dmApp.put('/wrapped-identity', async (c) => {
  const body = await readRawJson(c);
  if (!body) return errorJson(c, 400, 'INVALID_BODY', '请求体必须为 JSON');
  const publicKeyHex =
    typeof body.public_key_hex === 'string' ? body.public_key_hex.trim().toLowerCase() : '';
  const wrappedRaw = body.wrapped_identity_json;
  const wrappedIdentityJson =
    typeof wrappedRaw === 'string' ? wrappedRaw : JSON.stringify(wrappedRaw ?? {});
  if (!DM_PUBKEY_RE.test(publicKeyHex) || wrappedIdentityJson.length > DM_WRAPPED_KEY_MAX) {
    return errorJson(c, 400, 'INVALID_BODY', '包裹身份字段无效');
  }
  const localUser = await getLocalUser(c.env);
  if (!localUser) return errorJson(c, 409, 'USER_NOT_REGISTERED', '节点尚未完成注册');
  const existingPubkey = (localUser.dm_pubkey ?? '').trim().toLowerCase();
  const hasBackup = await messagingDb(c.env)
    .prepare(`SELECT 1 AS found FROM dm_wrapped_identity WHERE owner_handle = ? LIMIT 1`)
    .bind(localUser.handle)
    .first<{ found: number }>();
  if (!hasBackup && existingPubkey && existingPubkey === publicKeyHex) {
    return errorJson(
      c,
      409,
      'DM_IDENTITY_BACKUP_MISSING',
      '节点已有私信公钥但缺少云端身份备份，请在设置中执行「重新生成并备份私信身份」',
    );
  }
  const updatedAt = nowIso();
  try {
    await messagingDb(c.env)
      .prepare(
        `INSERT OR REPLACE INTO dm_wrapped_identity
         (owner_handle, public_key_hex, wrapped_identity_json, updated_at)
         VALUES (?, ?, ?, ?)`,
      )
      .bind(localUser.handle, publicKeyHex, wrappedIdentityJson, updatedAt)
      .run();
  } catch (err) {
    console.error('[dm] wrapped-identity messaging insert failed');
    return errorJson(c, 500, 'INTERNAL_ERROR', '私信身份备份写入失败');
  }
  try {
    await resolveIdentityDb(c.env).prepare(`UPDATE users SET dm_pubkey = ? WHERE handle = ?`).bind(
      publicKeyHex,
      localUser.handle,
    ).run();
  } catch (err) {
    console.error('[dm] wrapped-identity pubkey sync to main DB failed');
    return errorJson(
      c,
      503,
      'DM_PUBKEY_SYNC_PENDING',
      '公钥同步主库失败，请稍后重试',
    );
  }
  try {
    await syncLocalDmPubkeyToPublicProfile(c.env, publicKeyHex);
  } catch (err) {
    console.error('[dm] wrapped-identity STATE_KV sync failed');
    return errorJson(
      c,
      503,
      'DM_PUBKEY_SYNC_PENDING',
      '公开资料同步失败，请稍后重试',
    );
  }
  return c.json({
    ok: true,
    data: { owner_handle: localUser.handle, public_key_hex: publicKeyHex, updated_at: updatedAt },
  });
});

// PUT /api/me/dm-pubkey
dmMeApp.put('/dm-pubkey', async (c) => {
  const body = await readRawJson(c);
  const dmPubkey = typeof body?.dm_pubkey === 'string' ? body.dm_pubkey.trim().toLowerCase() : '';
  if (!DM_PUBKEY_RE.test(dmPubkey)) {
    return errorJson(c, 400, 'DM_PUBKEY_INVALID', 'dm_pubkey 必须为 32 字节 hex');
  }
  const localUser = await getLocalUser(c.env);
  if (!localUser) return errorJson(c, 409, 'USER_NOT_REGISTERED', '节点尚未完成注册');
  await resolveIdentityDb(c.env)
    .prepare(`UPDATE users SET dm_pubkey = ? WHERE handle = ?`)
    .bind(dmPubkey, localUser.handle)
    .run();
  await syncLocalDmPubkeyToPublicProfile(c.env, dmPubkey);
  return c.json({ ok: true, data: { dm_pubkey: dmPubkey } });
});

