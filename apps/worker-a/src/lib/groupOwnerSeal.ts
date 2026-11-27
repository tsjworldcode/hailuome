/**
 * OWNER-KEY-3：群主 Worker 读持钥表，用成员 member_dh_pubkey 做 X25519 代封。
 * 算法与浏览器 `wrapGroupKeyForMemberDh` 字节同源（v2 / X25519-HKDF-v1）。
 * 明文群钥仅短暂留在内存；禁止打日志。
 */
import { encodeText, hexToBytes, bytesToHex } from '@hailuo/shared-utils';
import { resolveIdentityDb } from '../db/bindings';
import type { Env } from '../env';
import { messagingDb } from './messagingDb';
import { normalizeGroupMemberUrl } from './groupMemberUrl';
import { normalizeMemberDhPubkeyHex, REKEY_WRAP_BATCH_MAX } from './groupRekeyPolicy';
import { loadUnwrappedGroupOwnerEpochKey } from './groupOwnerEpochKey';
import { assertGroupOwnerOrAdmin } from './groupModeration';

const GROUP_WRAP_KDF_X25519 = 'X25519-HKDF-v1' as const;
const GROUP_DH_WRAP_INFO = 'hailuo-group-dh-wrap-v1';

function asBufferSource(bytes: Uint8Array): BufferSource {
  return new Uint8Array(bytes);
}

function toCryptoBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(bytes.byteLength);
  out.set(bytes);
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function nowIso(): string {
  return new Date().toISOString();
}

async function hkdfSha256(
  ikm: Uint8Array,
  salt: Uint8Array,
  info: Uint8Array,
  length: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', toCryptoBytes(ikm), 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: toCryptoBytes(salt), info: toCryptoBytes(info) },
    key,
    length * 8,
  );
  return new Uint8Array(bits);
}

async function importX25519PublicKey(hex: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    toCryptoBytes(hexToBytes(hex)),
    { name: 'X25519' },
    false,
    [],
  );
}

async function generateX25519Ephemeral(): Promise<{ publicKeyHex: string; privateKey: CryptoKey }> {
  const pair = (await crypto.subtle.generateKey({ name: 'X25519' }, true, [
    'deriveBits',
  ])) as CryptoKeyPair;
  // Workers 类型把 exportKey raw 标成 ArrayBuffer | JsonWebKey；运行时 raw 必为 ArrayBuffer
  const pubRaw = new Uint8Array(
    (await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer,
  );
  return { publicKeyHex: bytesToHex(pubRaw), privateKey: pair.privateKey };
}

async function deriveGroupDhKek(
  privateKey: CryptoKey,
  peerPublicKeyHex: string,
  groupId: string,
  epoch: number,
): Promise<Uint8Array> {
  const pub = await importX25519PublicKey(peerPublicKeyHex);
  // 运行时算法字段是 `public`；Worker lib.dom 有时写成 `$public`，cast 对齐浏览器同源实现
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { name: 'X25519', public: pub } as any,
      privateKey,
      256,
    ),
  );
  return hkdfSha256(
    shared,
    toCryptoBytes(encodeText(groupId)),
    toCryptoBytes(encodeText(`${GROUP_DH_WRAP_INFO}:${epoch}`)),
    32,
  );
}

/** 与 web `wrapGroupKeyForMemberDh` 同构的 v2 wrap JSON 字符串。 */
export async function wrapGroupKeyForMemberDhJson(
  groupKeyHex: string,
  memberDhPubkeyHex: string,
  groupId: string,
  epoch: number,
): Promise<string> {
  const peer = normalizeMemberDhPubkeyHex(memberDhPubkeyHex);
  if (!peer) throw new Error('member_dh_pubkey 无效');
  const groupKey = hexToBytes(groupKeyHex.trim().toLowerCase());
  if (groupKey.byteLength !== 32) throw new Error('group_key 无效');

  const eph = await generateX25519Ephemeral();
  const kek = await deriveGroupDhKek(eph.privateKey, peer, groupId, epoch);
  const aesKey = await crypto.subtle.importKey('raw', asBufferSource(kek), 'AES-GCM', false, [
    'encrypt',
  ]);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: asBufferSource(nonce) },
      aesKey,
      asBufferSource(groupKey),
    ),
  );
  return JSON.stringify({
    v: 2,
    wrap_alg: 'AES-256-GCM',
    kdf: GROUP_WRAP_KDF_X25519,
    epoch,
    ephemeral_pubkey: eph.publicKeyHex,
    nonce: bytesToBase64(nonce),
    ciphertext: bytesToBase64(cipher),
  });
}

export type SealMemberResult = {
  sealed: boolean;
  reason: string;
  epoch?: number;
};

/**
 * 若本机是群主且持有当前 epoch 钥、目标已有 DH：代封写入 group_wrapped_keys，
 * 并将 group_members / group_pending_members 的 key_state 置 active。
 * 缺钥 / 非群主 / 无 DH → sealed:false（调用方 fail-soft，不挡入群）。
 */
export async function trySealCurrentEpochForMember(
  env: Env,
  groupId: string,
  memberWorkerBUrl: string,
): Promise<SealMemberResult> {
  const memberUrl = normalizeGroupMemberUrl(memberWorkerBUrl);
  if (!memberUrl) return { sealed: false, reason: 'bad_member_url' };

  const db = messagingDb(env);
  const group = await db
    .prepare(
      `SELECT epoch, owner_worker_b_url, dissolved_at FROM groups WHERE group_id = ? LIMIT 1`,
    )
    .bind(groupId)
    .first<{ epoch: number; owner_worker_b_url: string; dissolved_at: string | null }>();
  if (!group || group.dissolved_at) return { sealed: false, reason: 'group_missing' };

  const local = await resolveIdentityDb(env)
    .prepare(`SELECT worker_b_url FROM users LIMIT 1`)
    .first<{ worker_b_url: string }>();
  const localUrl = normalizeGroupMemberUrl(local?.worker_b_url ?? '');
  if (!localUrl || localUrl !== normalizeGroupMemberUrl(group.owner_worker_b_url)) {
    return { sealed: false, reason: 'not_owner_node' };
  }

  const epoch = group.epoch;
  // 已有 wrap → 仍把 key_state 翻 active（兼容客户端已上传 wrap 的路径）
  const existingWrap = await db
    .prepare(
      `SELECT 1 AS ok FROM group_wrapped_keys
        WHERE group_id = ? AND epoch = ? AND member_worker_b_url = ? LIMIT 1`,
    )
    .bind(groupId, epoch, memberUrl)
    .first<{ ok: number }>();

  let dh = '';
  const memberRow = await db
    .prepare(
      `SELECT member_dh_pubkey FROM group_members
        WHERE group_id = ? AND member_worker_b_url = ? AND status IN ('active', 'pending')
        LIMIT 1`,
    )
    .bind(groupId, memberUrl)
    .first<{ member_dh_pubkey: string | null }>();
  if (memberRow) {
    dh = normalizeMemberDhPubkeyHex(memberRow.member_dh_pubkey);
  } else {
    const pending = await db
      .prepare(
        `SELECT member_dh_pubkey FROM group_pending_members
          WHERE group_id = ? AND member_worker_b_url = ? LIMIT 1`,
      )
      .bind(groupId, memberUrl)
      .first<{ member_dh_pubkey: string | null }>();
    dh = normalizeMemberDhPubkeyHex(pending?.member_dh_pubkey);
  }
  if (!dh) return { sealed: false, reason: 'no_dh' };

  if (!existingWrap) {
    const owned = await loadUnwrappedGroupOwnerEpochKey(env, groupId, epoch);
    if (!owned) return { sealed: false, reason: 'owner_key_missing' };

    let wrappedJson: string;
    try {
      wrappedJson = await wrapGroupKeyForMemberDhJson(
        owned.group_key_hex,
        dh,
        groupId,
        epoch,
      );
    } catch (err) {
      console.warn(
        '[owner-seal] X25519 代封失败',
        err instanceof Error ? err.message : 'unknown',
      );
      return { sealed: false, reason: 'wrap_failed' };
    }

    const now = nowIso();
    await db
      .prepare(
        `INSERT OR REPLACE INTO group_wrapped_keys
         (group_id, epoch, member_worker_b_url, wrapped_key_json, updated_at, key_fingerprint)
         VALUES (?, ?, ?, ?, ?, NULL)`,
      )
      .bind(groupId, epoch, memberUrl, wrappedJson, now)
      .run();
  }

  await db.batch([
    db
      .prepare(
        `UPDATE group_members SET key_state = 'active'
          WHERE group_id = ? AND member_worker_b_url = ? AND status IN ('active', 'pending')`,
      )
      .bind(groupId, memberUrl),
    db
      .prepare(
        `UPDATE group_pending_members SET key_state = 'active'
          WHERE group_id = ? AND member_worker_b_url = ?`,
      )
      .bind(groupId, memberUrl),
  ]);

  return { sealed: true, reason: existingWrap ? 'already_wrapped' : 'sealed', epoch };
}

export type SealPendingBatchResult =
  | {
      ok: true;
      data: {
        group_id: string;
        epoch: number;
        /** 本批新写入或已有 wrap 并翻 active 的人数 */
        sealed: number;
        /** 仍 pending_key 但尚未登记 DH */
        skipped_no_dh: number;
        /** 代封失败人数 */
        failed: number;
        /** 本批处理后仍为 pending_key 的估算（含无 DH + 失败） */
        remaining_pending_key: number;
        batch_limit: number;
      };
    }
  | {
      ok: false;
      status: 400 | 403 | 404 | 409 | 503;
      error_code: string;
      message: string;
    };

/**
 * OWNER-KEY-4：扫描 `active + pending_key`，对已有 DH 者批量代封当前 epoch（≤32/批）。
 * 仅群主节点可写持钥；调用方须为主/管且本机即群主。
 */
export async function sealPendingKeyMembersBatch(
  env: Env,
  groupId: string,
  actorWorkerBUrl: string,
  opts?: { limit?: number },
): Promise<SealPendingBatchResult> {
  const gate = await assertGroupOwnerOrAdmin(env, groupId, actorWorkerBUrl);
  if (!gate.ok) return gate;

  const db = messagingDb(env);
  const group = await db
    .prepare(
      `SELECT epoch, owner_worker_b_url, dissolved_at FROM groups WHERE group_id = ? LIMIT 1`,
    )
    .bind(groupId)
    .first<{ epoch: number; owner_worker_b_url: string; dissolved_at: string | null }>();
  if (!group || group.dissolved_at) {
    return { ok: false, status: 404, error_code: 'GROUP_NOT_FOUND', message: '群不存在' };
  }

  const local = await resolveIdentityDb(env)
    .prepare(`SELECT worker_b_url FROM users LIMIT 1`)
    .first<{ worker_b_url: string }>();
  const localUrl = normalizeGroupMemberUrl(local?.worker_b_url ?? '');
  if (!localUrl || localUrl !== normalizeGroupMemberUrl(group.owner_worker_b_url)) {
    return {
      ok: false,
      status: 403,
      error_code: 'GROUP_NOT_MEMBER',
      message: '仅群主节点可代封群密钥',
    };
  }

  const limit = Math.min(
    Math.max(1, opts?.limit ?? REKEY_WRAP_BATCH_MAX),
    REKEY_WRAP_BATCH_MAX,
  );
  const epoch = group.epoch;

  const owned = await loadUnwrappedGroupOwnerEpochKey(env, groupId, epoch);
  if (!owned) {
    return {
      ok: false,
      status: 503,
      error_code: 'GROUP_OWNER_KEY_MISSING',
      message: '本节点尚未托管当前 epoch 群密钥，请群主先打开本群完成密钥托管',
    };
  }

  const { results: rows } = await db
    .prepare(
      `SELECT member_worker_b_url, member_dh_pubkey FROM group_members
        WHERE group_id = ? AND status = 'active' AND key_state = 'pending_key'
        ORDER BY joined_at ASC
        LIMIT ?`,
    )
    .bind(groupId, limit)
    .all<{ member_worker_b_url: string; member_dh_pubkey: string | null }>();

  let sealed = 0;
  let skippedNoDh = 0;
  let failed = 0;

  for (const row of rows ?? []) {
    const memberUrl = normalizeGroupMemberUrl(row.member_worker_b_url);
    if (!memberUrl) {
      failed += 1;
      continue;
    }
    const dh = normalizeMemberDhPubkeyHex(row.member_dh_pubkey);
    if (!dh) {
      skippedNoDh += 1;
      continue;
    }

    try {
      const existingWrap = await db
        .prepare(
          `SELECT 1 AS ok FROM group_wrapped_keys
            WHERE group_id = ? AND epoch = ? AND member_worker_b_url = ? LIMIT 1`,
        )
        .bind(groupId, epoch, memberUrl)
        .first<{ ok: number }>();

      if (!existingWrap) {
        const wrappedJson = await wrapGroupKeyForMemberDhJson(
          owned.group_key_hex,
          dh,
          groupId,
          epoch,
        );
        const now = nowIso();
        await db
          .prepare(
            `INSERT OR REPLACE INTO group_wrapped_keys
             (group_id, epoch, member_worker_b_url, wrapped_key_json, updated_at, key_fingerprint)
             VALUES (?, ?, ?, ?, ?, NULL)`,
          )
          .bind(groupId, epoch, memberUrl, wrappedJson, now)
          .run();
      }

      await db
        .prepare(
          `UPDATE group_members SET key_state = 'active'
            WHERE group_id = ? AND member_worker_b_url = ? AND status = 'active'`,
        )
        .bind(groupId, memberUrl)
        .run();
      sealed += 1;
    } catch (err) {
      failed += 1;
      console.warn(
        '[owner-seal] batch 代封失败',
        err instanceof Error ? err.message : 'unknown',
      );
    }
  }

  const remainRow = await db
    .prepare(
      `SELECT COUNT(*) AS c FROM group_members
        WHERE group_id = ? AND status = 'active' AND key_state = 'pending_key'`,
    )
    .bind(groupId)
    .first<{ c: number }>();

  return {
    ok: true,
    data: {
      group_id: groupId,
      epoch,
      sealed,
      skipped_no_dh: skippedNoDh,
      failed,
      remaining_pending_key: Number(remainRow?.c ?? 0),
      batch_limit: limit,
    },
  };
}
