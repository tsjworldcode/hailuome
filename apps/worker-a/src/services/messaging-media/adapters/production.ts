/**
 * NCF-2D3：生产 adapter — Env 只出现在本文件。
 * 防身份关联：禁止把 ticket.sig / ciphertext / 完整 IP 打进日志。
 * 注意：不 import dmMediaFetchTicket / groupMediaFetchTicket（避免与兼容壳循环依赖）。
 * M-OPT-SPLIT-7：media_object_registry → resolveIdentityDb；消息表仍 messagingDb。
 */
import {
  verifyDmMediaFetchTicket,
  verifyGroupMediaFetchTicket,
} from '@hailuo/shared-crypto';
import type { Env } from '../../../env';
import { resolveIdentityDb } from '../../../db/bindings';
import { parseDmEnvelope } from '../../../lib/dmEnvelope';
import { parseGroupMessageEnvelope } from '../../../lib/groupEnvelope';
import { normalizeGroupMemberUrl } from '../../../lib/groupMemberUrl';
import { fetchOutboundPeer } from '../../../lib/fetchOutboundPeer';
import { resolveLocalPublicBaseUrl } from '../../../lib/localPublicBaseUrl';
import { messagingDb } from '../../../lib/messagingDb';
import { fetchMemberGroupEnvelopeJson, fetchOwnerGroupEnvelopeJson } from '../../../lib/messagingShard';
import type { ServeMessagingMediaDeps } from '../types';

function normalizeWorkerBUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

async function fetchRequesterPubkey(
  env: Env,
  requesterWorkerBUrl: string,
  handle: string,
): Promise<string | null> {
  // SEC-AUDIT-2026-10-1：统一出站（SSRF + redirect:manual）
  const fetched = await fetchOutboundPeer(
    env,
    `${normalizeWorkerBUrl(requesterWorkerBUrl)}/users/${encodeURIComponent(handle)}`,
    { timeoutMs: 5_000 },
  );
  if (!fetched.ok) return null;
  try {
    const res = fetched.response;
    if (!res.ok) return null;
    const parsed = (await res.json()) as { data?: { pubkey?: unknown } };
    const pubkey = typeof parsed.data?.pubkey === 'string' ? parsed.data.pubkey.trim() : '';
    return /^[0-9a-f]{64}$/i.test(pubkey) ? pubkey.toLowerCase() : null;
  } catch {
    return null;
  }
}

export function createProductionServeMessagingMediaDeps(env: Env): ServeMessagingMediaDeps {
  return {
    localPublicBase: {
      async getNormalizedUrl() {
        return normalizeWorkerBUrl(await resolveLocalPublicBaseUrl(env));
      },
    },
    clock: {
      nowSec: () => Math.floor(Date.now() / 1000),
      nowIso: () => new Date().toISOString(),
    },
    dm: {
      async loadOutboxEnvelope(messageId) {
        const row = await messagingDb(env)
          .prepare(
            `SELECT envelope_json FROM dm_messages WHERE message_id = ? AND direction = 'outbox' LIMIT 1`,
          )
          .bind(messageId)
          .first<{ envelope_json: string }>();
        if (!row) return null;
        try {
          return parseDmEnvelope(JSON.parse(row.envelope_json));
        } catch {
          return null;
        }
      },
      async getOutboxPeerWorkerBUrl(messageId) {
        const row = await messagingDb(env)
          .prepare(
            `SELECT peer_worker_b_url FROM dm_messages WHERE message_id = ? AND direction = 'outbox' LIMIT 1`,
          )
          .bind(messageId)
          .first<{ peer_worker_b_url: string }>();
        return row?.peer_worker_b_url ?? null;
      },
      verifyTicket: (ticket, pubkeyHex) => verifyDmMediaFetchTicket(ticket, pubkeyHex),
      async consumeNonce(nonce, createdAt) {
        try {
          await messagingDb(env)
            .prepare(`INSERT INTO dm_nonces (nonce, created_at) VALUES (?, ?)`)
            .bind(nonce, createdAt)
            .run();
          return 'ok';
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (message.includes('UNIQUE') || message.includes('constraint')) {
            return 'replay';
          }
          console.error('[messaging-media] dm nonce insert failed (constraint or internal)');
          return 'error';
        }
      },
    },
    group: {
      async loadEnvelope(groupId, messageId) {
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
      },
      async loadOwnerEnvelope(groupId, messageId) {
        const ownerJson = await fetchOwnerGroupEnvelopeJson(env, groupId, messageId);
        if (!ownerJson) return null;
        try {
          return parseGroupMessageEnvelope(JSON.parse(ownerJson));
        } catch {
          return null;
        }
      },
      async getActiveMemberHandle(groupId, memberWorkerBUrl) {
        const row = await messagingDb(env)
          .prepare(
            `SELECT member_handle FROM group_members
              WHERE group_id = ? AND member_worker_b_url = ? AND status = 'active' LIMIT 1`,
          )
          .bind(groupId, normalizeGroupMemberUrl(memberWorkerBUrl))
          .first<{ member_handle: string }>();
        return row?.member_handle ?? null;
      },
      verifyTicket: (ticket, pubkeyHex) => verifyGroupMediaFetchTicket(ticket, pubkeyHex),
      async consumeNonce(groupId, nonce, createdAt) {
        try {
          await messagingDb(env)
            .prepare(`INSERT INTO group_nonces (group_id, nonce, created_at) VALUES (?, ?, ?)`)
            .bind(groupId, nonce, createdAt)
            .run();
          return 'ok';
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (message.includes('UNIQUE') || message.includes('constraint')) {
            return 'replay';
          }
          console.error('[messaging-media] group nonce insert failed (constraint or internal)');
          return 'error';
        }
      },
    },
    requesterPubkey: {
      fetch: (requesterWorkerBUrl, handle) => fetchRequesterPubkey(env, requesterWorkerBUrl, handle),
    },
    registry: {
      async hasActiveMessagingObject(storageKey) {
        const row = await resolveIdentityDb(env).prepare(
          `SELECT 1 FROM media_object_registry
            WHERE object_key = ?
              AND scope = 'messaging'
              AND released_at IS NULL
            LIMIT 1`,
        )
          .bind(storageKey)
          .first();
        return row !== null;
      },
    },
    logger: {
      error: (msg, detail) =>
        detail === undefined ? console.error(msg) : console.error(msg, detail),
    },
  };
}
