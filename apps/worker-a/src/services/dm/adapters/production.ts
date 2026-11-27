/**
 * NCF-2D1：生产 adapter — Env 只出现在本文件。
 * 防身份关联：不得把对端完整 IP/邮箱写进日志；本域只用 peer Worker B URL 做门禁。
 */
import { verifyDmEnvelope, verifyDmSendTicket } from '@hailuo/shared-crypto';
import type { DmEnvelope } from '@hailuo/shared-types';
import type { Env } from '../../../env';
import { normalizeDmPeerUrl } from '../../../lib/dmEnvelope';
import { isNodeBlacklisted } from '../../../lib/blacklistLookup';
import { checkAndIncrementDmInboxRate } from '../../../lib/dmRateLimit';
import {
  fetchTargetUserProfile,
  handlesReferToSameIdentity,
} from '../../../lib/friendRequestOutboxFetcher';
import { resolveLocalPublicBaseUrl } from '../../../lib/localPublicBaseUrl';
import { messagingDb } from '../../../lib/messagingDb';
import { resolveIdentityDb } from '../../../db/bindings';
import type { ReceiveDmInboxDeps } from '../types';

const PIN_RE = /^[0-9a-f]{64}$/i;

type SenderKeyResolution = {
  pubkey: string | null;
  backfillAfterVerify: boolean;
};

/**
 * 已关注节点的身份公钥以 follows.followed_pubkey 为准。
 * 有 Pin 时不再访问对端，避免换钥后的新公钥被当成好友。
 * 只有历史空 Pin 才取档，并且必须核对是同一个人。
 */
async function resolveSenderPubkey(env: Env, envelope: DmEnvelope): Promise<SenderKeyResolution> {
  const normalized = normalizeDmPeerUrl(envelope.sender_worker_b_url);
  const senderHandle = envelope.sender_handle.trim().toLowerCase();
  const none: SenderKeyResolution = { pubkey: null, backfillAfterVerify: false };
  let row: { followed_pubkey: string | null; followed_handle: string | null } | null = null;
  try {
    row = await resolveIdentityDb(env)
      .prepare(
        `SELECT followed_pubkey, followed_handle FROM follows
          WHERE follower_node_url = ?
          LIMIT 1`,
      )
      .bind(normalized)
      .first<{ followed_pubkey: string | null; followed_handle: string | null }>();
  } catch (err) {
    console.error('[dm] 读取 followed_pubkey 失败', err instanceof Error ? err.message : 'unknown');
    return none;
  }

  const storedHandle = row?.followed_handle?.trim().toLowerCase() ?? '';
  if (storedHandle && senderHandle && !handlesReferToSameIdentity(storedHandle, senderHandle)) {
    return none;
  }

  const pin = row?.followed_pubkey?.trim() ?? '';
  if (PIN_RE.test(pin)) {
    return { pubkey: pin, backfillAfterVerify: false };
  }

  const profile = await fetchTargetUserProfile(normalized, senderHandle, env);
  const fetched = profile?.pubkey?.trim() ?? '';
  if (!PIN_RE.test(fetched)) return none;
  return { pubkey: fetched, backfillAfterVerify: true };
}

/** 只补空 Pin。验签未通过时调用方不得进来。 */
async function backfillSenderPubkey(env: Env, envelope: DmEnvelope, pubkeyHex: string): Promise<void> {
  const pubkey = pubkeyHex.trim().toLowerCase();
  if (!PIN_RE.test(pubkey)) return;
  const normalized = normalizeDmPeerUrl(envelope.sender_worker_b_url);
  await resolveIdentityDb(env)
    .prepare(
      `UPDATE follows
          SET followed_pubkey = ?
        WHERE follower_node_url = ?
          AND (followed_pubkey IS NULL OR followed_pubkey = '')`,
    )
    .bind(pubkey, normalized)
    .run();
}

export function createProductionReceiveDmInboxDeps(env: Env): ReceiveDmInboxDeps {
  // M-OPT-SPLIT-5：users/follows → IDENTITY；blacklist → GOVERNANCE（走 helper）
  const identityDb = resolveIdentityDb(env);
  return {
    localUser: {
      async getHandle() {
        const row = await identityDb
          .prepare(`SELECT handle FROM users LIMIT 1`)
          .first<{ handle: string }>()
          .catch(() => null);
        return row?.handle ?? null;
      },
    },
    localPublicBase: {
      async getNormalizedUrl() {
        return normalizeDmPeerUrl(await resolveLocalPublicBaseUrl(env));
      },
    },
    blacklist: {
      // 统一走 blacklistLookup（GOVERNANCE_DB）；helper 内部再 normalize
      isBlacklisted: (senderWorkerBUrl) => isNodeBlacklisted(env, senderWorkerBUrl),
    },
    follows: {
      async isFollowing(peerWorkerBUrl) {
        const normalized = normalizeDmPeerUrl(peerWorkerBUrl);
        const row = await identityDb
          .prepare(`SELECT 1 AS found FROM follows WHERE follower_node_url = ? LIMIT 1`)
          .bind(normalized)
          .first<{ found: number }>()
          .catch(() => null);
        return row !== null;
      },
    },
    rateLimit: {
      checkAndIncrement: (senderWorkerBUrl) => checkAndIncrementDmInboxRate(env, senderWorkerBUrl),
    },
    senderPubkey: {
      resolve: (envelope) => resolveSenderPubkey(env, envelope),
      backfill: (envelope, pubkeyHex) => backfillSenderPubkey(env, envelope, pubkeyHex),
    },
    crypto: {
      verifyTicket: (ticket, pubkeyHex) => verifyDmSendTicket(ticket, pubkeyHex),
      verifyEnvelope: (envelope, pubkeyHex) => verifyDmEnvelope(envelope, pubkeyHex),
    },
    store: {
      async insertNonces(envelopeNonce, ticketNonce, createdAt) {
        try {
          await messagingDb(env)
            .prepare(`INSERT INTO dm_nonces (nonce, created_at) VALUES (?, ?)`)
            .bind(envelopeNonce, createdAt)
            .run();
          await messagingDb(env)
            .prepare(`INSERT INTO dm_nonces (nonce, created_at) VALUES (?, ?)`)
            .bind(ticketNonce, createdAt)
            .run();
          return 'ok';
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (message.includes('UNIQUE') || message.includes('constraint')) {
            return 'replay';
          }
          console.error('[dm] nonce insert failed (constraint or internal)');
          return 'error';
        }
      },
      async insertInboxMessage(envelope) {
        await messagingDb(env)
          .prepare(
            `INSERT INTO dm_messages
             (message_id, conversation_id, direction, peer_handle, peer_worker_b_url, envelope_json, created_at, delivery_status)
             VALUES (?, ?, 'inbox', ?, ?, ?, ?, 'delivered')`,
          )
          .bind(
            envelope.message_id,
            envelope.conversation_id,
            envelope.sender_handle,
            envelope.sender_worker_b_url,
            JSON.stringify(envelope),
            envelope.created_at,
          )
          .run();
      },
      async insertMessageBatch(envelope, ticketNonce) {
        const db = messagingDb(env);
        const createdAt = envelope.created_at;
        const envelopeNonce = envelope.nonce;
        const statements = [
          db.prepare(`INSERT INTO dm_nonces (nonce, created_at) VALUES (?, ?)`).bind(envelopeNonce, createdAt),
          db.prepare(`INSERT INTO dm_nonces (nonce, created_at) VALUES (?, ?)`).bind(ticketNonce, createdAt),
          db.prepare(
            `INSERT INTO dm_messages
             (message_id, conversation_id, direction, peer_handle, peer_worker_b_url, envelope_json, created_at, delivery_status)
             VALUES (?, ?, 'inbox', ?, ?, ?, ?, 'delivered')`,
          ).bind(
            envelope.message_id,
            envelope.conversation_id,
            envelope.sender_handle,
            envelope.sender_worker_b_url,
            JSON.stringify(envelope),
            createdAt,
          ),
        ];
        try {
          await db.batch(statements);
          return 'ok';
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (message.includes('UNIQUE') || message.includes('constraint')) {
            return 'replay';
          }
          console.error('[dm] batch insert failed (constraint or internal)');
          return 'error';
        }
      },
    },
    clock: { nowSec: () => Math.floor(Date.now() / 1000) },
    logger: {
      error: (msg, detail) =>
        detail === undefined ? console.error(msg) : console.error(msg, detail),
    },
  };
}
