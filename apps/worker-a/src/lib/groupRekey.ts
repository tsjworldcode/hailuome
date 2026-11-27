/**
 * EPOCH-REKEY-2：成员 DH 公钥登记 + rekey-commit CAS。
 * 浏览器密封；Worker 只收密文 wrap，齐备后才翻 epoch。
 */
import type { Env } from '../env';
import { messagingDb } from './messagingDb';
import { normalizeGroupMemberUrl } from './groupMemberUrl';
import { assertGroupOwnerOrAdmin } from './groupModeration';
import {
  REKEY_WRAP_BATCH_MAX,
  isValidMemberDhPubkeyHex,
  normalizeMemberDhPubkeyHex,
  partitionActiveMembersByDh,
  wrapsShareHomogeneousFingerprint,
  type RekeyWrapCandidate,
} from './groupRekeyPolicy';

function nowIso(): string {
  return new Date().toISOString();
}

export { REKEY_WRAP_BATCH_MAX };

/** 本机为某群登记 X25519 `member_dh_pubkey`（禁止用签名钥）。 */
export async function putMemberDhPubkey(
  env: Env,
  groupId: string,
  memberWorkerBUrl: string,
  dhPubkeyHex: string,
): Promise<
  | { ok: true; data: { group_id: string; member_worker_b_url: string; member_dh_pubkey: string } }
  | { ok: false; status: 400 | 403 | 404 | 409; error_code: string; message: string }
> {
  const memberUrl = normalizeGroupMemberUrl(memberWorkerBUrl);
  if (!memberUrl) {
    return { ok: false, status: 400, error_code: 'GROUP_ENVELOPE_INVALID', message: 'member_worker_b_url 无效' };
  }
  const pubkey = normalizeMemberDhPubkeyHex(dhPubkeyHex);
  if (!pubkey) {
    return {
      ok: false,
      status: 400,
      error_code: 'GROUP_ENVELOPE_INVALID',
      message: 'member_dh_pubkey 须为 64 位小写 hex（X25519 raw）',
    };
  }

  const db = messagingDb(env);
  const group = await db
    .prepare(`SELECT dissolved_at FROM groups WHERE group_id = ? LIMIT 1`)
    .bind(groupId)
    .first<{ dissolved_at: string | null }>();
  if (!group || group.dissolved_at) {
    return { ok: false, status: 404, error_code: 'GROUP_NOT_FOUND', message: '群不存在' };
  }

  const member = await db
    .prepare(
      `SELECT status FROM group_members
        WHERE group_id = ? AND member_worker_b_url = ? LIMIT 1`,
    )
    .bind(groupId, memberUrl)
    .first<{ status: string }>();
  if (!member || (member.status !== 'active' && member.status !== 'pending')) {
    return { ok: false, status: 403, error_code: 'GROUP_NOT_MEMBER', message: '非群成员' };
  }

  const result = await db
    .prepare(
      `UPDATE group_members SET member_dh_pubkey = ?
        WHERE group_id = ? AND member_worker_b_url = ? AND status IN ('active', 'pending')`,
    )
    .bind(pubkey, groupId, memberUrl)
    .run();
  if (!(result.meta?.changes ?? 0)) {
    return { ok: false, status: 409, error_code: 'GROUP_NOT_MEMBER', message: '成员状态已变化，请重试' };
  }

  return {
    ok: true,
    data: {
      group_id: groupId,
      member_worker_b_url: memberUrl,
      member_dh_pubkey: pubkey,
    },
  };
}

/**
 * 管理员提交：确认 next_epoch wraps 已覆盖全部留下的 active 成员后 CAS epoch++。
 * crash-safe：齐备前不翻 epoch，旧钥继续可用。
 */
export async function commitGroupRekey(
  env: Env,
  groupId: string,
  actorWorkerBUrl: string,
  expectedEpoch: number,
): Promise<
  | {
      ok: true;
      data: {
        group_id: string;
        previous_epoch: number;
        new_epoch: number;
        rekey_scheduled: false;
        wrapped_count: number;
        /** 未登记 DH、本轮未密封、须上线补钥的活跃成员数 */
        deferred_count: number;
      };
    }
  | { ok: false; status: 400 | 403 | 404 | 409; error_code: string; message: string }
> {
  if (!Number.isSafeInteger(expectedEpoch) || expectedEpoch < 1) {
    return { ok: false, status: 400, error_code: 'GROUP_ENVELOPE_INVALID', message: 'expected_epoch 无效' };
  }

  const gate = await assertGroupOwnerOrAdmin(env, groupId, actorWorkerBUrl);
  if (!gate.ok) return gate;

  const db = messagingDb(env);
  const group = await db
    .prepare(
      `SELECT epoch, rekey_scheduled, dissolved_at, owner_worker_b_url FROM groups WHERE group_id = ? LIMIT 1`,
    )
    .bind(groupId)
    .first<{
      epoch: number;
      rekey_scheduled: number;
      dissolved_at: string | null;
      owner_worker_b_url: string;
    }>();

  if (!group || group.dissolved_at) {
    return { ok: false, status: 404, error_code: 'GROUP_NOT_FOUND', message: '群不存在' };
  }
  if (group.epoch !== expectedEpoch) {
    return {
      ok: false,
      status: 409,
      error_code: 'EPOCH_CONFLICT',
      message: `epoch 冲突：期望 ${expectedEpoch}，当前 ${group.epoch}`,
    };
  }
  if (Number(group.rekey_scheduled) !== 1) {
    return {
      ok: false,
      status: 409,
      error_code: 'GROUP_REKEY_NOT_READY',
      message: '群未标记待换钥（rekey_scheduled=0）',
    };
  }

  const nextEpoch = expectedEpoch + 1;
  const { results: activeRows } = await db
    .prepare(
      `SELECT member_worker_b_url, member_dh_pubkey FROM group_members
        WHERE group_id = ? AND status = 'active'`,
    )
    .bind(groupId)
    .all<{ member_worker_b_url: string; member_dh_pubkey: string | null }>();

  // SEC-AUDIT-2026-10-15：有 DH 的必须齐 wrap；无 DH（离线）不挡换钥，commit 后标 pending_key 待补。
  const { sealableUrls, deferredUrls } = partitionActiveMembersByDh(
    activeRows ?? [],
    normalizeGroupMemberUrl,
  );
  if (sealableUrls.length === 0) {
    return {
      ok: false,
      status: 409,
      error_code: 'GROUP_REKEY_NOT_READY',
      message: '没有可密封的活跃成员（均未登记 member_dh_pubkey）',
    };
  }

  const { results: wrapRows } = await db
    .prepare(
      `SELECT member_worker_b_url, wrapped_key_json, key_fingerprint FROM group_wrapped_keys
        WHERE group_id = ? AND epoch = ?`,
    )
    .bind(groupId, nextEpoch)
    .all<{
      member_worker_b_url: string;
      wrapped_key_json: string;
      key_fingerprint: string | null;
    }>();

  const wraps: RekeyWrapCandidate[] = (wrapRows ?? []).map((r) => ({
    member_worker_b_url: normalizeGroupMemberUrl(r.member_worker_b_url),
    wrapped_key_json: r.wrapped_key_json,
    key_fingerprint: r.key_fingerprint,
  }));

  // SEC-AUDIT-2026-10-16：齐备且同源指纹，否则拒（防混钥 commit）
  const homo = wrapsShareHomogeneousFingerprint({
    remainingActiveUrls: sealableUrls,
    wraps,
    normalizeUrl: normalizeGroupMemberUrl,
  });
  if (!homo.ok) {
    const msg =
      homo.reason === 'mixed'
        ? `next epoch=${nextEpoch} wraps 混入不同 key_fingerprint，禁止推进`
        : homo.reason === 'missing'
          ? `next epoch=${nextEpoch} wraps 缺少 key_fingerprint，请用 batch 重传`
          : `next epoch=${nextEpoch} 的可读 wraps 未齐备（需覆盖 ${sealableUrls.length} 名已登记 DH 的活跃成员；另有 ${deferredUrls.length} 名待上线补钥）`;
    return {
      ok: false,
      status: 409,
      error_code: homo.reason === 'mixed' ? 'GROUP_REKEY_KEY_MISMATCH' : 'GROUP_REKEY_NOT_READY',
      message: msg,
    };
  }

  const now = nowIso();
  // CAS：仅当 epoch 未变才推进；失败则零副作用。
  const cas = await db
    .prepare(
      `UPDATE groups
          SET epoch = ?, rekey_scheduled = 0, updated_at = ?
        WHERE group_id = ? AND epoch = ? AND rekey_scheduled = 1 AND dissolved_at IS NULL`,
    )
    .bind(nextEpoch, now, groupId, expectedEpoch)
    .run();
  if (!(cas.meta?.changes ?? 0)) {
    return {
      ok: false,
      status: 409,
      error_code: 'EPOCH_CONFLICT',
      message: '群 epoch 或换钥状态已变化，请刷新后重试',
    };
  }

  // 已密封成员拉新 wrap；缺 DH 成员降为 pending_key（旧钥只能解旧 epoch，新消息不可读直至补钥）
  await db
    .prepare(
      `UPDATE group_members SET key_state = 'epoch_rotation_pending'
        WHERE group_id = ? AND status = 'active'
          AND length(trim(coalesce(member_dh_pubkey, ''))) = 64`,
    )
    .bind(groupId)
    .run();
  if (deferredUrls.length > 0) {
    await db
      .prepare(
        `UPDATE group_members SET key_state = 'pending_key'
          WHERE group_id = ? AND status = 'active'
            AND (member_dh_pubkey IS NULL OR length(trim(member_dh_pubkey)) != 64)`,
      )
      .bind(groupId)
      .run();
  }

  return {
    ok: true,
    data: {
      group_id: groupId,
      previous_epoch: expectedEpoch,
      new_epoch: nextEpoch,
      rekey_scheduled: false,
      wrapped_count: sealableUrls.length,
      deferred_count: deferredUrls.length,
    },
  };
}
