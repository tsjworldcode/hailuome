/**
 * OWNER-KEY-5：群主节点服务端换钥——生成 next epoch 持钥 → DH 代封 → 可选 CAS commit。
 * 明文仅短暂留在内存；禁止打日志。浏览器 Batch Wrap 降为缺 wrap secret 时的迁移期兜底。
 *
 * Free Tier 单请求 CPU ~10ms：每调用最多代封 REKEY_WRAP_BATCH_MAX（32）人；
 * 未封完返回 committed=false + remaining_unsealed，由前端轮询推进，齐备后再 commit。
 */
import { bytesToHex } from '@hailuo/shared-utils';
import { resolveIdentityDb } from '../db/bindings';
import type { Env } from '../env';
import { messagingDb } from './messagingDb';
import { normalizeGroupMemberUrl } from './groupMemberUrl';
import { assertGroupOwnerOrAdmin } from './groupModeration';
import {
  loadUnwrappedGroupOwnerEpochKey,
  resolveGroupOwnerKeyWrapSecret,
  upsertGroupOwnerEpochKey,
} from './groupOwnerEpochKey';
import { wrapGroupKeyForMemberDhJson } from './groupOwnerSeal';
import { commitGroupRekey } from './groupRekey';
import {
  normalizeMemberDhPubkeyHex,
  partitionActiveMembersByDh,
  REKEY_WRAP_BATCH_MAX,
} from './groupRekeyPolicy';

function nowIso(): string {
  return new Date().toISOString();
}

export type OwnerServerRekeyResult =
  | {
      ok: true;
      data: {
        group_id: string;
        previous_epoch: number;
        next_epoch: number;
        key_fingerprint: string;
        /** 本批新写入的 wrap 数（≤ REKEY_WRAP_BATCH_MAX） */
        sealed: number;
        deferred_count: number;
        /** 仍缺同源 fingerprint wrap 的 sealable 人数（不含本批刚写） */
        remaining_unsealed: number;
        /** true = 已 CAS 推进 epoch；false = 仅写完本批 wraps / 未齐备 */
        committed: boolean;
        new_epoch: number | null;
        rekey_scheduled: boolean;
        wrapped_count: number;
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
 * 群主节点：为 `rekey_scheduled` 群生成/复用 next 持钥，按批代封已登记 DH 的 active 成员。
 * 默认同源 wraps 齐备后才 commit；单次请求最多密封 REKEY_WRAP_BATCH_MAX 人。
 */
export async function runOwnerServerRekey(
  env: Env,
  groupId: string,
  actorWorkerBUrl: string,
  opts?: { expectedEpoch?: number; commit?: boolean },
): Promise<OwnerServerRekeyResult> {
  const gate = await assertGroupOwnerOrAdmin(env, groupId, actorWorkerBUrl);
  if (!gate.ok) return gate;

  const db = messagingDb(env);
  const group = await db
    .prepare(
      `SELECT epoch, rekey_scheduled, owner_worker_b_url, dissolved_at
         FROM groups WHERE group_id = ? LIMIT 1`,
    )
    .bind(groupId)
    .first<{
      epoch: number;
      rekey_scheduled: number;
      owner_worker_b_url: string;
      dissolved_at: string | null;
    }>();
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
      message: '仅群主节点可服务端换钥代封',
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

  const expectedEpoch =
    opts?.expectedEpoch != null && Number.isSafeInteger(opts.expectedEpoch)
      ? opts.expectedEpoch
      : group.epoch;
  if (group.epoch !== expectedEpoch) {
    return {
      ok: false,
      status: 409,
      error_code: 'EPOCH_CONFLICT',
      message: `epoch 冲突：期望 ${expectedEpoch}，当前 ${group.epoch}`,
    };
  }

  if (!resolveGroupOwnerKeyWrapSecret(env)) {
    return {
      ok: false,
      status: 503,
      error_code: 'GROUP_OWNER_KEY_WRAP_SECRET_MISSING',
      message: '未配置群主持钥 secret，无法服务端换钥（可回落浏览器密封）',
    };
  }

  const nextEpoch = expectedEpoch + 1;
  let owned = await loadUnwrappedGroupOwnerEpochKey(env, groupId, nextEpoch);
  if (!owned) {
    const raw = crypto.getRandomValues(new Uint8Array(32));
    const groupKeyHex = bytesToHex(raw);
    const upsert = await upsertGroupOwnerEpochKey(env, {
      groupId,
      epoch: nextEpoch,
      groupKeyHex,
    });
    if (!upsert.ok) {
      return {
        ok: false,
        status: upsert.status,
        error_code: upsert.error_code,
        message: upsert.message,
      };
    }
    owned = { group_key_hex: groupKeyHex, key_fingerprint: upsert.data.key_fingerprint };
  }

  const { results: activeRows } = await db
    .prepare(
      `SELECT member_worker_b_url, member_dh_pubkey FROM group_members
        WHERE group_id = ? AND status = 'active'`,
    )
    .bind(groupId)
    .all<{ member_worker_b_url: string; member_dh_pubkey: string | null }>();

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

  // 已有 wraps：同源 fingerprint 可续批；异源 / 缺指纹 → 整 epoch 清掉再封（防浏览器半成品混入）
  const { results: existingWrapRows } = await db
    .prepare(
      `SELECT member_worker_b_url, key_fingerprint FROM group_wrapped_keys
        WHERE group_id = ? AND epoch = ?`,
    )
    .bind(groupId, nextEpoch)
    .all<{ member_worker_b_url: string; key_fingerprint: string | null }>();

  const alreadySealed = new Set<string>();
  let hasForeignWrap = false;
  for (const row of existingWrapRows ?? []) {
    const url = normalizeGroupMemberUrl(row.member_worker_b_url);
    const fp = (row.key_fingerprint ?? '').trim().toLowerCase();
    if (!url) continue;
    if (fp === owned.key_fingerprint) {
      alreadySealed.add(url);
    } else {
      hasForeignWrap = true;
    }
  }
  if (hasForeignWrap) {
    await db
      .prepare(`DELETE FROM group_wrapped_keys WHERE group_id = ? AND epoch = ?`)
      .bind(groupId, nextEpoch)
      .run();
    alreadySealed.clear();
  }

  const dhByUrl = new Map<string, string>();
  for (const row of activeRows ?? []) {
    const url = normalizeGroupMemberUrl(row.member_worker_b_url);
    const dh = normalizeMemberDhPubkeyHex(row.member_dh_pubkey);
    if (url && dh) dhByUrl.set(url, dh);
  }

  const pendingUrls = sealableUrls.filter((u) => !alreadySealed.has(u));
  const batchUrls = pendingUrls.slice(0, REKEY_WRAP_BATCH_MAX);
  const now = nowIso();
  const statements: ReturnType<D1Database['prepare']>[] = [];
  let sealed = 0;
  for (const memberUrl of batchUrls) {
    const dh = dhByUrl.get(memberUrl);
    if (!dh) continue;
    let wrappedJson: string;
    try {
      wrappedJson = await wrapGroupKeyForMemberDhJson(
        owned.group_key_hex,
        dh,
        groupId,
        nextEpoch,
      );
    } catch (err) {
      console.warn(
        '[owner-rekey] 代封失败',
        err instanceof Error ? err.message : 'unknown',
      );
      return {
        ok: false,
        status: 503,
        error_code: 'GROUP_WRAP_UNAVAILABLE',
        message: '服务端代封失败，请稍后重试',
      };
    }
    statements.push(
      db
        .prepare(
          `INSERT OR REPLACE INTO group_wrapped_keys
           (group_id, epoch, member_worker_b_url, wrapped_key_json, updated_at, key_fingerprint)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .bind(groupId, nextEpoch, memberUrl, wrappedJson, now, owned.key_fingerprint),
    );
    sealed += 1;
  }
  if (statements.length > 0) {
    await db.batch(statements);
  }

  const remainingUnsealed = Math.max(0, pendingUrls.length - sealed);
  const wrappedCount = alreadySealed.size + sealed;
  const shouldCommit = opts?.commit !== false && remainingUnsealed === 0;

  if (!shouldCommit) {
    return {
      ok: true,
      data: {
        group_id: groupId,
        previous_epoch: expectedEpoch,
        next_epoch: nextEpoch,
        key_fingerprint: owned.key_fingerprint,
        sealed,
        deferred_count: deferredUrls.length,
        remaining_unsealed: remainingUnsealed,
        committed: false,
        new_epoch: null,
        rekey_scheduled: true,
        wrapped_count: wrappedCount,
        batch_limit: REKEY_WRAP_BATCH_MAX,
      },
    };
  }

  const committed = await commitGroupRekey(env, groupId, actorWorkerBUrl, expectedEpoch);
  if (!committed.ok) return committed;

  return {
    ok: true,
    data: {
      group_id: groupId,
      previous_epoch: committed.data.previous_epoch,
      next_epoch: committed.data.new_epoch,
      key_fingerprint: owned.key_fingerprint,
      sealed,
      deferred_count: committed.data.deferred_count,
      remaining_unsealed: 0,
      committed: true,
      new_epoch: committed.data.new_epoch,
      rekey_scheduled: false,
      wrapped_count: committed.data.wrapped_count,
      batch_limit: REKEY_WRAP_BATCH_MAX,
    },
  };
}
