/**
 * SEC-AUDIT-2026-10-16：群 wrapped key 单条 / 真 batch 写入 + 下一 epoch 同源指纹门禁。
 * Worker 永不接收明文 group_key；只存密文 JSON + SHA-256 指纹。
 */
import type { Env } from '../env';
import { messagingDb } from './messagingDb';
import { normalizeGroupMemberUrl } from './groupMemberUrl';
import {
  REKEY_WRAP_BATCH_MAX,
  normalizeGroupKeyFingerprint,
} from './groupRekeyPolicy';

const GROUP_WRAPPED_KEY_MAX = 8192;

function nowIso(): string {
  return new Date().toISOString();
}

export type WrappedKeyWriteItem = {
  member_worker_b_url: string;
  wrapped_key_json: string;
};

export type PutGroupWrappedKeysInput = {
  groupId: string;
  actorWorkerBUrl: string;
  epoch: number;
  items: readonly WrappedKeyWriteItem[];
  /** 下一 epoch（current+1）必填；当前 epoch 可空 */
  keyFingerprint?: string | null;
  /**
   * 仅 next epoch + 主/管：先删该群该 epoch 全部 wraps 再写入。
   * 用于重试换钥时清掉上一轮未完成的异源 wrap。
   */
  replaceKey?: boolean;
};

export type PutGroupWrappedKeysResult =
  | {
      ok: true;
      data: {
        group_id: string;
        epoch: number;
        written: number;
        key_fingerprint: string | null;
        replaced: boolean;
      };
    }
  | {
      ok: false;
      status: 400 | 403 | 404 | 409;
      error_code: string;
      message: string;
    };

/**
 * 真 batch：一次请求校验后用 D1 batch 写入 ≤ REKEY_WRAP_BATCH_MAX 条。
 * 下一 epoch 强制同源 fingerprint；异源未带 replace_key → 409。
 */
export async function putGroupWrappedKeysBatch(
  env: Env,
  input: PutGroupWrappedKeysInput,
): Promise<PutGroupWrappedKeysResult> {
  const groupId = input.groupId.trim();
  const actorUrl = normalizeGroupMemberUrl(input.actorWorkerBUrl);
  const epoch = input.epoch;
  if (!actorUrl || !Number.isSafeInteger(epoch) || epoch < 1) {
    return { ok: false, status: 400, error_code: 'GROUP_ENVELOPE_INVALID', message: '写入字段无效' };
  }
  if (!Array.isArray(input.items) || input.items.length === 0) {
    return { ok: false, status: 400, error_code: 'GROUP_ENVELOPE_INVALID', message: 'items 不能为空' };
  }
  if (input.items.length > REKEY_WRAP_BATCH_MAX) {
    return {
      ok: false,
      status: 400,
      error_code: 'GROUP_ENVELOPE_INVALID',
      message: `单批最多 ${REKEY_WRAP_BATCH_MAX} 条 wrap`,
    };
  }

  const db = messagingDb(env);
  const group = await db
    .prepare(`SELECT epoch, owner_worker_b_url, dissolved_at FROM groups WHERE group_id = ? LIMIT 1`)
    .bind(groupId)
    .first<{ epoch: number; owner_worker_b_url: string; dissolved_at: string | null }>();
  if (!group || group.dissolved_at) {
    return { ok: false, status: 404, error_code: 'GROUP_NOT_FOUND', message: '群不存在' };
  }

  // 仅允许当前或下一 epoch，禁止跳写假未来钥
  if (epoch !== group.epoch && epoch !== group.epoch + 1) {
    return {
      ok: false,
      status: 400,
      error_code: 'GROUP_ENVELOPE_INVALID',
      message: `epoch 须为当前 ${group.epoch} 或下一轮 ${group.epoch + 1}`,
    };
  }

  const isNextEpoch = epoch === group.epoch + 1;
  const fingerprint = normalizeGroupKeyFingerprint(input.keyFingerprint ?? '');
  if (isNextEpoch && !fingerprint) {
    return {
      ok: false,
      status: 400,
      error_code: 'GROUP_ENVELOPE_INVALID',
      message: '下一 epoch 须携带有效 key_fingerprint（SHA-256 hex）',
    };
  }

  const selfMember = await db
    .prepare(
      `SELECT role, is_admin FROM group_members
        WHERE group_id = ? AND member_worker_b_url = ? AND status IN ('active', 'pending')
        LIMIT 1`,
    )
    .bind(groupId, actorUrl)
    .first<{ role: string; is_admin: number }>();
  if (!selfMember) {
    return { ok: false, status: 403, error_code: 'GROUP_NOT_MEMBER', message: '非群成员' };
  }
  const canUploadForOthers =
    selfMember.role === 'owner' || Number(selfMember.is_admin) === 1;

  const replaceKey = Boolean(input.replaceKey);
  if (replaceKey) {
    if (!isNextEpoch) {
      return {
        ok: false,
        status: 400,
        error_code: 'GROUP_ENVELOPE_INVALID',
        message: 'replace_key 仅允许清空下一 epoch wraps',
      };
    }
    if (!canUploadForOthers) {
      return {
        ok: false,
        status: 403,
        error_code: 'GROUP_NOT_MEMBER',
        message: '仅群主或管理员可重置下一 epoch wraps',
      };
    }
  }

  // 未 replace 时：已有 next wraps 的指纹必须与本批一致，否则拒（防混钥）
  if (isNextEpoch && !replaceKey) {
    const existing = await db
      .prepare(
        `SELECT key_fingerprint FROM group_wrapped_keys
          WHERE group_id = ? AND epoch = ? AND key_fingerprint IS NOT NULL
            AND length(trim(key_fingerprint)) > 0
          LIMIT 1`,
      )
      .bind(groupId, epoch)
      .first<{ key_fingerprint: string }>();
    if (existing) {
      const existingFp = normalizeGroupKeyFingerprint(existing.key_fingerprint);
      if (existingFp && existingFp !== fingerprint) {
        return {
          ok: false,
          status: 409,
          error_code: 'GROUP_REKEY_KEY_MISMATCH',
          message: '下一 epoch 已有不同 key_fingerprint 的 wraps；请带 replace_key=true 重开本轮密封',
        };
      }
    }
  }

  // 规范化 + 权限 / DH 预检
  const normalized: { url: string; json: string }[] = [];
  const seen = new Set<string>();
  for (const item of input.items) {
    const url = normalizeGroupMemberUrl(
      typeof item.member_worker_b_url === 'string' ? item.member_worker_b_url : '',
    );
    const json =
      typeof item.wrapped_key_json === 'string'
        ? item.wrapped_key_json.trim()
        : item.wrapped_key_json != null
          ? JSON.stringify(item.wrapped_key_json)
          : '';
    if (!url || !json || json.length > GROUP_WRAPPED_KEY_MAX) {
      return { ok: false, status: 400, error_code: 'GROUP_ENVELOPE_INVALID', message: '包裹密钥字段无效' };
    }
    if (seen.has(url)) {
      return {
        ok: false,
        status: 400,
        error_code: 'GROUP_ENVELOPE_INVALID',
        message: '同一批内成员 URL 重复',
      };
    }
    seen.add(url);

    if (url !== actorUrl) {
      if (!canUploadForOthers) {
        return {
          ok: false,
          status: 403,
          error_code: 'GROUP_NOT_MEMBER',
          message: '仅群主或管理员可为其他成员上传 wrapped key',
        };
      }
      const targetMember = await db
        .prepare(
          `SELECT member_dh_pubkey FROM group_members
            WHERE group_id = ? AND member_worker_b_url = ? AND status IN ('active', 'pending')
            LIMIT 1`,
        )
        .bind(groupId, url)
        .first<{ member_dh_pubkey: string | null }>();
      if (!targetMember) {
        return { ok: false, status: 404, error_code: 'GROUP_NOT_FOUND', message: '目标成员不在群内' };
      }
      if (isNextEpoch) {
        const dh = (targetMember.member_dh_pubkey ?? '').trim().toLowerCase();
        if (!/^[0-9a-f]{64}$/.test(dh)) {
          return {
            ok: false,
            status: 409,
            error_code: 'GROUP_REKEY_NOT_READY',
            message: '目标成员尚未登记 member_dh_pubkey，无法密封下一 epoch',
          };
        }
      }
    }

    normalized.push({ url, json });
  }

  const now = nowIso();
  const statements = [];
  if (replaceKey) {
    statements.push(
      db
        .prepare(`DELETE FROM group_wrapped_keys WHERE group_id = ? AND epoch = ?`)
        .bind(groupId, epoch),
    );
  }
  for (const row of normalized) {
    statements.push(
      db
        .prepare(
          `INSERT OR REPLACE INTO group_wrapped_keys
           (group_id, epoch, member_worker_b_url, wrapped_key_json, updated_at, key_fingerprint)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .bind(groupId, epoch, row.url, row.json, now, isNextEpoch ? fingerprint : null),
    );
  }

  // 为自己上传当前 epoch → 标记 key_state active（与单条 PUT 一致）
  const selfCurrent = normalized.some((r) => r.url === actorUrl && epoch === group.epoch);
  if (selfCurrent) {
    statements.push(
      db
        .prepare(
          `UPDATE group_members SET key_state = 'active'
            WHERE group_id = ? AND member_worker_b_url = ?`,
        )
        .bind(groupId, actorUrl),
    );
  }

  await db.batch(statements);

  return {
    ok: true,
    data: {
      group_id: groupId,
      epoch,
      written: normalized.length,
      key_fingerprint: isNextEpoch ? fingerprint : null,
      replaced: replaceKey,
    },
  };
}
