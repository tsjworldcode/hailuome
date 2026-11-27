/**
 * M14-3：互粉读帖证明校验（签发 Token 时校验 Ed25519 签名 + 互粉关系）。
 * R-MSG-5b：已移除 read_proof_nonces 持久化 — nonce 不再写入 D1，
 * 改由 Ed25519 签名本身提供防滥用保障（粉丝可随时重新签名）。
 */
import type { ReadMutualProof } from '@hailuo/shared-types';
import { verifyReadMutualProof } from '@hailuo/shared-crypto';
import { normalizeWorkerBOrigin } from '@hailuo/shared-utils';
import type { Env } from '../env';
import { resolveIdentityDb } from '../db/bindings';
import { isFollowedNode } from './readProtectionMode';
// SEC-AUDIT-2026-10-9：复用 SEC-7 取档（含 handle 同一人校验 + fetchOutboundPeer），禁止自建只抽 pubkey
import { fetchTargetUserProfile } from './friendRequestOutboxFetcher';

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function parseReadMutualProof(raw: unknown): ReadMutualProof | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const reader = typeof o.reader_worker_b_url === 'string' ? o.reader_worker_b_url.trim() : '';
  const owner = typeof o.owner_worker_b_url === 'string' ? o.owner_worker_b_url.trim() : '';
  const purpose = o.purpose;
  const exp = o.exp;
  const nonce = typeof o.nonce === 'string' ? o.nonce.trim() : '';
  const sig = typeof o.sig === 'string' ? o.sig.trim() : '';
  if (
    !reader.startsWith('https://') ||
    !owner.startsWith('https://') ||
    purpose !== 'read-token' ||
    typeof exp !== 'number' ||
    !nonce ||
    !sig
  ) {
    return null;
  }
  return {
    reader_worker_b_url: normalizeWorkerBOrigin(reader),
    owner_worker_b_url: normalizeWorkerBOrigin(owner),
    purpose: 'read-token',
    exp,
    nonce,
    sig,
  };
}

const PIN_RE = /^[0-9a-f]{64}$/i;

async function loadFollowIdentity(
  env: Env,
  readerWorkerBUrl: string,
): Promise<{ handle: string; pin: string | null }> {
  const row = await resolveIdentityDb(env)
    .prepare(
      `SELECT followed_handle, followed_pubkey FROM follows WHERE follower_node_url = ? LIMIT 1`,
    )
    .bind(readerWorkerBUrl)
    .first<{ followed_handle: string | null; followed_pubkey: string | null }>();
  const handle = row?.followed_handle?.trim().toLowerCase() ?? '';
  const pin = row?.followed_pubkey?.trim() ?? '';
  return { handle, pin: PIN_RE.test(pin) ? pin : null };
}

async function backfillFollowPin(env: Env, readerWorkerBUrl: string, pubkey: string): Promise<void> {
  const normalized = pubkey.trim().toLowerCase();
  if (!PIN_RE.test(normalized)) return;
  await resolveIdentityDb(env)
    .prepare(
      `UPDATE follows
          SET followed_pubkey = ?
        WHERE follower_node_url = ?
          AND (followed_pubkey IS NULL OR followed_pubkey = '')`,
    )
    .bind(normalized, readerWorkerBUrl)
    .run();
}

export async function verifyMutualReadProofForTokenIssue(args: {
  env: Env;
  followerNodeUrl: string;
  ownerWorkerBUrl: string;
  followerHandle: string;
  proofRaw: unknown;
}): Promise<{ ok: true } | { ok: false; error_code: string; message: string }> {
  const proof = parseReadMutualProof(args.proofRaw);
  if (!proof) {
    return { ok: false, error_code: 'INVALID_BODY', message: 'read_mutual_proof 格式无效' };
  }
  if (proof.exp < nowSec()) {
    return { ok: false, error_code: 'NOT_MUTUAL_FOLLOW', message: '互粉读帖证明已过期' };
  }
  if (proof.reader_worker_b_url !== args.followerNodeUrl) {
    return { ok: false, error_code: 'NOT_MUTUAL_FOLLOW', message: '读帖证明与申领节点不匹配' };
  }
  if (proof.owner_worker_b_url !== args.ownerWorkerBUrl) {
    return { ok: false, error_code: 'NOT_MUTUAL_FOLLOW', message: '读帖证明目标节点不匹配' };
  }
  if (!(await isFollowedNode(args.env, args.followerNodeUrl))) {
    return {
      ok: false,
      error_code: 'FOLLOWER_NOT_ALLOWED',
      message: '该节点不在已关注列表，无法申领读帖 Token',
    };
  }
  const stored = await loadFollowIdentity(args.env, args.followerNodeUrl);
  const readerHandle = args.followerHandle.trim().toLowerCase() || stored.handle;
  if (!readerHandle) {
    return { ok: false, error_code: 'NOT_MUTUAL_FOLLOW', message: '无法解析读者节点 handle' };
  }
  // 有本地 Pin 就用 Pin 验签，不再相信对端此刻公布的新公钥。
  // 空 Pin 才取档，并且仍核对 handle；取档失败与验签失败同一句，避免探测。
  let readerPubkey = stored.pin;
  let backfillAfterVerify = false;
  if (!readerPubkey) {
    const readerProfile = await fetchTargetUserProfile(
      args.followerNodeUrl,
      readerHandle,
      args.env,
    );
    readerPubkey = readerProfile?.pubkey ?? null;
    backfillAfterVerify = Boolean(readerPubkey);
  }
  if (!readerPubkey || !(await verifyReadMutualProof(proof, readerPubkey))) {
    return { ok: false, error_code: 'NOT_MUTUAL_FOLLOW', message: '互粉读帖证明签名校验失败' };
  }
  if (backfillAfterVerify) {
    try {
      await backfillFollowPin(args.env, args.followerNodeUrl, readerPubkey);
    } catch (err) {
      console.warn('[read-mutual-proof] 空 Pin 回填失败', err instanceof Error ? err.message : 'unknown');
    }
  }
  return { ok: true };
}

export { parseReadMutualProof as __testOnlyParseReadMutualProof };
