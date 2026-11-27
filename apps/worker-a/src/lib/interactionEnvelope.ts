/**
 * M9-19：跨节点互动签名 envelope 构建与验签（Worker A 权威侧）。
 */
import {
  computeBodyHash,
  signInteraction,
  verifyInteraction,
} from '@hailuo/shared-crypto';
import type { InteractionEnvelope, InteractionType } from '@hailuo/shared-types';
import { bytesToHex, isoToSec, nowISO } from '@hailuo/shared-utils';
import type { Env } from '../env';
import { resolveGovernanceDb } from '../db/bindings';
import { isNodeBlacklisted } from './blacklistLookup';

export const INTERACTION_SIGNATURE_WINDOW_SEC = 300;

export interface InteractionActorInput {
  readonly handle: string;
  readonly node_url: string;
  readonly pubkey?: string;
}

/** 点赞/unlike 的 body_hash 签名段用空串；回复/delete_reply 用 SHA-256 hex。 */
export async function resolveInteractionBodyHash(
  type: InteractionType,
  content = '',
  replyId = '',
): Promise<string> {
  if (type === 'reply') return computeBodyHash(content);
  if (type === 'delete_reply') return computeBodyHash(replyId);
  return '';
}

export async function buildSignedInteractionEnvelope(
  type: InteractionType,
  postId: string,
  actor: InteractionActorInput,
  privateKeyHex: string,
  publicKeyHex: string,
  content = '',
  replyId = '',
): Promise<InteractionEnvelope> {
  const created_at = nowISO();
  const nonce = bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
  const body_hash = await resolveInteractionBodyHash(type, content, replyId);
  const sig = await signInteraction(
    type,
    postId,
    actor.handle,
    actor.node_url,
    created_at,
    nonce,
    body_hash,
    privateKeyHex,
  );
  return {
    type,
    post_id: postId,
    actor: { handle: actor.handle, node_url: actor.node_url, pubkey: publicKeyHex },
    created_at,
    nonce,
    body_hash,
    sig,
  };
}

export function normalizeEnvelopeActor(raw: unknown): InteractionActorInput | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const handle = typeof obj.handle === 'string' ? obj.handle.trim() : '';
  const nodeUrl = typeof obj.node_url === 'string' ? obj.node_url.trim() : '';
  const pubkey = typeof obj.pubkey === 'string' ? obj.pubkey.trim() : '';
  if (!handle || !nodeUrl) return null;
  return { handle, node_url: nodeUrl, pubkey: pubkey || undefined };
}

export function parseInteractionEnvelope(raw: unknown): InteractionEnvelope | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const type = obj.type;
  if (type !== 'like' && type !== 'unlike' && type !== 'reply' && type !== 'delete_reply') return null;
  const postId = typeof obj.post_id === 'string' ? obj.post_id.trim() : '';
  const createdAt = typeof obj.created_at === 'string' ? obj.created_at.trim() : '';
  const nonce = typeof obj.nonce === 'string' ? obj.nonce.trim() : '';
  const sig = typeof obj.sig === 'string' ? obj.sig.trim() : '';
  const bodyHash = typeof obj.body_hash === 'string' ? obj.body_hash.trim() : undefined;
  const actor = normalizeEnvelopeActor(obj.actor);
  if (!postId || !createdAt || !nonce || !sig || !actor) return null;
  return {
    type,
    post_id: postId,
    actor,
    created_at: createdAt,
    nonce,
    body_hash: bodyHash,
    sig,
  };
}

export async function verifyInteractionEnvelope(
  env: Env,
  envelope: InteractionEnvelope,
  expectedBodyHash?: string,
): Promise<{ ok: true } | { ok: false; error_code: string; message: string }> {
  const { type, post_id: postId, actor, created_at, nonce, body_hash, sig } = envelope;

  const createdSec = isoToSec(created_at);
  const nowSecVal = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSecVal - createdSec) > INTERACTION_SIGNATURE_WINDOW_SEC) {
    return { ok: false, error_code: 'SIGNATURE_EXPIRED', message: '互动签名已过期' };
  }

  if (!actor.pubkey || !sig) {
    return { ok: false, error_code: 'ENVELOPE_PUBKEY_REQUIRED', message: '互动 envelope 缺少 actor 公钥或签名' };
  }

  const bodyHashForSig = body_hash ?? await resolveInteractionBodyHash(type);
  if (expectedBodyHash !== undefined && bodyHashForSig !== expectedBodyHash) {
    return { ok: false, error_code: 'BODY_HASH_MISMATCH', message: '互动 body_hash 与请求内容不一致' };
  }

  try {
    // M-OPT-SPLIT-A7-1：interaction_nonces → GOVERNANCE_DB（文件内其余路径已 resolveGovernanceDb）
    await resolveGovernanceDb(env)
      .prepare(
        `INSERT INTO interaction_nonces (post_id, actor_node_url, nonce, created_at) VALUES (?, ?, ?, ?)`,
      )
      .bind(postId, actor.node_url, nonce, created_at)
      .run();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : '';
    if (message.includes('UNIQUE') || message.includes('constraint')) {
      return { ok: false, error_code: 'NONCE_DUPLICATE', message: '互动请求已存在（防重放）' };
    }
    console.error('[interactions] nonce insert failed:', message);
    return { ok: false, error_code: 'NONCE_STORE_FAILED', message: '互动防重放记录写入失败' };
  }

  const sigValid = await verifyInteraction(
    type,
    postId,
    actor.handle,
    actor.node_url,
    created_at,
    nonce,
    bodyHashForSig,
    sig,
    actor.pubkey,
  );
  if (!sigValid) {
    return { ok: false, error_code: 'SIGNATURE_INVALID', message: '互动签名验证失败' };
  }

  // M-OPT-SPLIT-5：blacklist → GOVERNANCE_DB helper
  if (await isNodeBlacklisted(env, actor.node_url)) {
    return { ok: false, error_code: 'BLACKLISTED', message: '请求者已被封禁' };
  }

  return { ok: true };
}

/** 清理 24h 前的互动 nonce（挂 Cron，不占新槽位）。interaction_nonces → GOVERNANCE_DB */
export async function gcInteractionNonces(env: Env): Promise<number> {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const result = await resolveGovernanceDb(env)
    .prepare(`DELETE FROM interaction_nonces WHERE created_at < ?`)
    .bind(cutoff)
    .run();
  return result.meta.changes ?? 0;
}
