/**
 * MM-5：群媒体 fetch ticket 签发与发送方验签。
 * NCF-2D3：发送方 serve 验票迁入 services/messaging-media；本文件保留签发 / 远端拉取 / 兼容壳。
 */
import type { GroupMediaFetchTicket, GroupMessageEnvelope } from '@hailuo/shared-types';
import {
  randomDmNonceHex,
  signGroupMediaFetchTicket,
} from '@hailuo/shared-crypto';
import type { Env } from '../env';
import {
  executeServeMessagingMedia,
  type ServeMessagingMediaResult,
} from '../services/messaging-media';
import { parseGroupMessageEnvelope } from './groupEnvelope';
import { messagingDb } from './messagingDb';
import { fetchMemberGroupEnvelopeJson } from './messagingShard';
import { parseMessagingMediaSigned, type FetchRemoteMediaOptions } from './dmMediaFetchTicket';
import { fetchOutboundPeer } from './fetchOutboundPeer';
import { assertMediaIntegrity, readResponseBodyWithLimit } from './remoteBodyLimit';
import { resolveLocalPublicBaseUrl } from './localPublicBaseUrl';

export const GROUP_MEDIA_TICKET_TTL_SEC = 300;

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function normalizeWorkerBUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

export async function loadGroupEnvelopeByMessageId(
  env: Env,
  groupId: string,
  messageId: string,
): Promise<GroupMessageEnvelope | null> {
  const raw = await fetchMemberGroupEnvelopeJson(env, groupId, messageId);
  if (raw) {
    try {
      return parseGroupMessageEnvelope(JSON.parse(raw));
    } catch {
      return null;
    }
  }

  const outbox = await messagingDb(env)
    .prepare(
      `SELECT envelope_json FROM group_outbox
        WHERE group_id = ? AND message_id = ? LIMIT 1`,
    )
    .bind(groupId, messageId)
    .first<{ envelope_json: string }>();
  if (!outbox) return null;
  try {
    return parseGroupMessageEnvelope(JSON.parse(outbox.envelope_json));
  } catch {
    return null;
  }
}

export interface IssueGroupMediaFetchTicketInput {
  group_id: string;
  message_id: string;
  media_id: string;
  sender_storage_key: string;
  sender_worker_b_url: string;
}

/** 请求方 Worker A：校验本地群消息行后签发 ticket。 */
export async function issueGroupMediaFetchTicket(
  env: Env,
  input: IssueGroupMediaFetchTicketInput,
): Promise<GroupMediaFetchTicket | null> {
  const envelope = await loadGroupEnvelopeByMessageId(env, input.group_id, input.message_id);
  if (!envelope) return null;
  const media = envelope.media;
  if (!media) return null;
  if (media.media_id !== input.media_id) return null;
  if (media.sender_storage_key !== input.sender_storage_key) return null;
  if (normalizeWorkerBUrl(media.sender_worker_b_url) !== normalizeWorkerBUrl(input.sender_worker_b_url)) {
    return null;
  }

  const unsigned: Omit<GroupMediaFetchTicket, 'sig'> = {
    v: 1,
    group_id: envelope.group_id,
    message_id: envelope.message_id,
    media_id: media.media_id,
    sender_storage_key: media.sender_storage_key,
    sender_worker_b_url: normalizeWorkerBUrl(media.sender_worker_b_url),
    requester_worker_b_url: normalizeWorkerBUrl(await resolveLocalPublicBaseUrl(env)),
    exp: nowSec() + GROUP_MEDIA_TICKET_TTL_SEC,
    nonce: randomDmNonceHex(),
  };
  const sig = await signGroupMediaFetchTicket(unsigned, env.ED25519_PRIVATE_KEY);
  return { ...unsigned, sig };
}

/** NCF-2D3：深模块 result → 既有 {ok} 形 */
function serveResultToLegacy(
  result: ServeMessagingMediaResult,
): { ok: true } | { ok: false; error_code: string; message: string } {
  if (result.status === 'ok') return { ok: true };
  return {
    ok: false,
    error_code: result.error_code ?? 'INTERNAL_ERROR',
    message: result.message ?? '媒体验票失败',
  };
}

/** 发送方 Worker A：委托 NCF-2D3 `executeServeMessagingMedia`。 */
export async function verifyGroupMediaFetchTicketOnSender(
  env: Env,
  ticket: GroupMediaFetchTicket,
  storageKey: string,
): Promise<{ ok: true } | { ok: false; error_code: string; message: string }> {
  const result = await executeServeMessagingMedia(env, {
    kind: 'group',
    ticket,
    storageKey,
  });
  return serveResultToLegacy(result);
}

export function encodeGroupMediaFetchTicketParam(ticket: GroupMediaFetchTicket): string {
  return encodeURIComponent(JSON.stringify(ticket));
}

export function decodeGroupMediaFetchTicketParam(raw: string): GroupMediaFetchTicket | null {
  try {
    const parsed = JSON.parse(decodeURIComponent(raw)) as GroupMediaFetchTicket;
    if (parsed?.v !== 1 || typeof parsed.sig !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

/** 从发送方 Worker B 拉取群图密文 blob（server-side；R-AUDIT-2 硬上限 + 可选 hash）。 */
export async function fetchGroupMediaFromSenderWorkerB(
  env: Env,
  senderWorkerBUrl: string,
  storageKey: string,
  ticket: GroupMediaFetchTicket,
  options: FetchRemoteMediaOptions,
): Promise<ArrayBuffer | null> {
  const url = `${normalizeWorkerBUrl(senderWorkerBUrl)}/groups/media/${encodeURIComponent(storageKey)}?ticket=${encodeGroupMediaFetchTicketParam(ticket)}`;
  // SEC-AUDIT-2026-10-8：统一出站网关（SSRF 门禁 + redirect:manual + 中性 UA + 超时）。
  // URL 来自外部可控的 media.sender_worker_b_url → 非法时 0 连接；302 不跟随。
  const fetched = await fetchOutboundPeer(env, url, { timeoutMs: 30_000 });
  if (!fetched.ok) {
    console.warn('[groupMediaFetchTicket] outbound blocked', {
      host: fetched.host,
      reason: fetched.reason,
    });
    return null;
  }
  try {
    const res = fetched.response;
    if (!res.ok) return null;
    const read = await readResponseBodyWithLimit(res, options.maxBytes);
    if (!read.ok) {
      console.warn('[groupMediaFetchTicket] remote body rejected', read.reason);
      return null;
    }
    const intact = await assertMediaIntegrity(read.bytes, {
      expectedSizeBytes: options.expectedSizeBytes,
      expectedSha256Hex: options.expectedSha256Hex,
    });
    if (!intact) {
      console.warn('[groupMediaFetchTicket] remote body integrity mismatch');
      return null;
    }
    return read.bytes;
  } catch (err) {
    console.error('[groupMediaFetchTicket] fetch sender blob failed', err);
    return null;
  }
}

export { parseMessagingMediaSigned };
