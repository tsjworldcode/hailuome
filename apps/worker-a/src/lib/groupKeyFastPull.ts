/**
 * EPOCH v0.3 P1：epoch 落后时向群主权威 Fast-Pull 本成员 wrapped_key（不干等 15min sync）。
 */
import type { Env } from '../env';
import { fetchOutboundPeer } from './fetchOutboundPeer';
import { messagingDb } from './messagingDb';
import { normalizeGroupMemberUrl } from './groupMemberUrl';
import { resolveIdentityDb } from '../db/bindings';
import {
  parseGroupFetchWrappedKey,
  signGroupFetchWrappedKey,
  verifyGroupFetchWrappedKey,
  randomDmNonceHex,
  type GroupFetchWrappedKeyUnsigned,
} from '@hailuo/shared-crypto';
import { checkAndIncrementGroupFastPullRate } from './groupRateLimit';
import { trySealCurrentEpochForMember } from './groupOwnerSeal';

export type FastPullWrappedKeyResult =
  | {
      ok: true;
      data: {
        group_id: string;
        epoch: number;
        member_worker_b_url: string;
        wrapped_key_json: string;
      };
    }
  | { ok: false; status: 404 | 403 | 409 | 429 | 503; error_code: string; message: string };

function forbidden(): FastPullWrappedKeyResult {
  return { ok: false, status: 403, error_code: 'GROUP_WRAP_FORBIDDEN', message: '无权获取群密钥' };
}

/** 群主权威：只向 pin 公钥验签通过的活跃成员返回其本人 wrap。 */
export async function serveWrappedKeyOnOwner(
  env: Env,
  raw: unknown,
): Promise<FastPullWrappedKeyResult> {
  const envelope = parseGroupFetchWrappedKey(raw);
  if (!envelope) return forbidden();
  const { group_id: groupId, member_worker_b_url: memberUrl, epoch } = envelope;
  try {
    const db = messagingDb(env);
    const local = await resolveIdentityDb(env)
      .prepare(`SELECT worker_b_url FROM users LIMIT 1`)
      .first<{ worker_b_url: string }>();
    if (!local?.worker_b_url) {
      return forbidden();
    }

    const group = await db
      .prepare(`SELECT owner_worker_b_url, dissolved_at FROM groups WHERE group_id = ? LIMIT 1`)
      .bind(groupId)
      .first<{ owner_worker_b_url: string; dissolved_at: string | null }>();
    if (!group || group.dissolved_at) {
      return forbidden();
    }
    if (normalizeGroupMemberUrl(group.owner_worker_b_url) !== normalizeGroupMemberUrl(local.worker_b_url)) {
      return forbidden();
    }

    const member = await db
      .prepare(`SELECT member_pubkey, status FROM group_members WHERE group_id = ? AND member_worker_b_url = ? LIMIT 1`)
      .bind(groupId, memberUrl)
      .first<{ member_pubkey: string; status: string }>();
    // key_state 可能仍 pending_key；它正是合法补钥场景，不能据此拒绝。
    if (!member || member.status !== 'active' ||
      !await verifyGroupFetchWrappedKey(envelope, member.member_pubkey)) return forbidden();
    // SEC-5b：先原子消费 nonce。重放直接 409，不扣小时额度（防截获信封吸血）。
    const nonce = await db.prepare(
      `INSERT OR IGNORE INTO group_nonces (group_id, nonce, created_at) VALUES (?, ?, ?)`,
    ).bind(groupId, envelope.nonce, new Date().toISOString()).run();
    if (!nonce.success || typeof nonce.meta.changes !== 'number') throw new Error('fast-pull nonce unavailable');
    if (nonce.meta.changes === 0) {
      return { ok: false, status: 409, error_code: 'GROUP_NONCE_REPLAY', message: '群密钥请求已处理' };
    }
    // 仅新 nonce 才计次；超限时 nonce 已占用，客户端须换新 timestamp/nonce 重试。
    if (!await checkAndIncrementGroupFastPullRate(env, groupId, memberUrl)) {
      return { ok: false, status: 429, error_code: 'GROUP_WRAP_RATE_LIMITED', message: '群密钥获取过于频繁，请稍后重试' };
    }
    let row = await db
      .prepare(
        `SELECT wrapped_key_json FROM group_wrapped_keys
          WHERE group_id = ? AND member_worker_b_url = ? AND epoch = ? LIMIT 1`,
      )
      .bind(groupId, memberUrl, epoch)
      .first<{ wrapped_key_json: string }>();

    // OWNER-KEY-4：缺 wrap 时先尝试服务端代封（成员已有 DH + 本机持钥），再读一次
    if (!row?.wrapped_key_json) {
      await trySealCurrentEpochForMember(env, groupId, memberUrl);
      row = await db
        .prepare(
          `SELECT wrapped_key_json FROM group_wrapped_keys
            WHERE group_id = ? AND member_worker_b_url = ? AND epoch = ? LIMIT 1`,
        )
        .bind(groupId, memberUrl, epoch)
        .first<{ wrapped_key_json: string }>();
    }

    if (!row?.wrapped_key_json) {
      return { ok: false, status: 404, error_code: 'GROUP_KEY_PENDING', message: '该 epoch 密钥尚未分发' };
    }

    return {
      ok: true,
      data: {
        group_id: groupId,
        epoch,
        member_worker_b_url: memberUrl,
        wrapped_key_json: row.wrapped_key_json,
      },
    };
  } catch {
    // 禁止原始异常进入响应/日志，避免把节点 URL、签名或凭证串带出去。
    return { ok: false, status: 503, error_code: 'GROUP_WRAP_UNAVAILABLE', message: '群密钥服务暂不可用' };
  }
}

/** 成员节点：本地无 wrap 时向群主 Worker B 快拉并落库。 */
export async function fastPullWrappedKeyLocally(
  env: Env,
  groupId: string,
  epoch: number,
): Promise<FastPullWrappedKeyResult> {
  const db = messagingDb(env);
  const local = await resolveIdentityDb(env)
    .prepare(`SELECT worker_b_url FROM users LIMIT 1`)
    .first<{ worker_b_url: string }>();
  if (!local?.worker_b_url) {
    return { ok: false, status: 409, error_code: 'USER_NOT_REGISTERED', message: '节点未注册' };
  }
  const memberUrl = normalizeGroupMemberUrl(local.worker_b_url);

  const localWrap = await db
    .prepare(
      `SELECT wrapped_key_json FROM group_wrapped_keys
        WHERE group_id = ? AND member_worker_b_url = ? AND epoch = ? LIMIT 1`,
    )
    .bind(groupId, memberUrl, epoch)
    .first<{ wrapped_key_json: string }>();
  if (localWrap?.wrapped_key_json) {
    // EPOCH-UX-2：本机已有 wrap 但 key_state 可能仍 pending_key（sync 落库未翻态）→ 一并升 active
    await db
      .prepare(
        `UPDATE group_members SET key_state = 'active'
          WHERE group_id = ? AND member_worker_b_url = ?`,
      )
      .bind(groupId, memberUrl)
      .run();
    return {
      ok: true,
      data: {
        group_id: groupId,
        epoch,
        member_worker_b_url: memberUrl,
        wrapped_key_json: localWrap.wrapped_key_json,
      },
    };
  }

  const group = await db
    .prepare(`SELECT owner_worker_b_url FROM groups WHERE group_id = ? LIMIT 1`)
    .bind(groupId)
    .first<{ owner_worker_b_url: string }>();
  if (!group?.owner_worker_b_url) {
    return { ok: false, status: 404, error_code: 'GROUP_NOT_FOUND', message: '群不存在' };
  }

  const ownerUrl = normalizeGroupMemberUrl(group.owner_worker_b_url).replace(/\/$/, '');

  try {
    const unsigned: GroupFetchWrappedKeyUnsigned = {
      group_id: groupId, member_worker_b_url: memberUrl, epoch,
      timestamp: new Date().toISOString(), nonce: randomDmNonceHex(),
    };
    const envelope = { ...unsigned, sig: await signGroupFetchWrappedKey(unsigned, env.ED25519_PRIVATE_KEY) };
    // 本机即群主也走同一验签入口，不保留未认证参数重载。
    if (ownerUrl === memberUrl) return serveWrappedKeyOnOwner(env, envelope);
    // EPOCH NET-1 / SEC-AUDIT-2026-10-1：统一出站
    const fetched = await fetchOutboundPeer(env, `${ownerUrl}/groups/fetch-wrapped-key`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(envelope),
      timeoutMs: 5_000,
    });
    if (!fetched.ok) {
      return {
        ok: false,
        status: 409,
        error_code: 'GROUP_KEY_PENDING',
        message: '向群主快拉密钥失败',
      };
    }
    const res = fetched.response;
    if (!res.ok) {
      // 仅映射受控错误，不回显对端原始正文或错误消息。
      if (res.status === 403) return forbidden();
      if (res.status === 429) return { ok: false, status: 429, error_code: 'GROUP_WRAP_RATE_LIMITED', message: '群密钥获取过于频繁，请稍后重试' };
      if (res.status === 503) return { ok: false, status: 503, error_code: 'GROUP_WRAP_UNAVAILABLE', message: '群密钥服务暂不可用' };
      return {
        ok: false,
        status: res.status === 404 ? 404 : 409,
        error_code: 'GROUP_KEY_PENDING',
        message: '向群主快拉密钥失败',
      };
    }
    const json = (await res.json()) as {
      ok?: boolean;
      data?: {
        group_id: string;
        epoch: number;
        member_worker_b_url: string;
        wrapped_key_json: string;
      };
    };
    // 防错包落库：目标三元组与密文类型/大小必须逐项匹配，不做 URL 宽松等价。
    if (json?.ok !== true || json.data?.group_id !== groupId ||
      json.data.member_worker_b_url !== memberUrl || json.data.epoch !== epoch ||
      typeof json.data.wrapped_key_json !== 'string' || !json.data.wrapped_key_json ||
      json.data.wrapped_key_json.length > 8192) {
      return { ok: false, status: 409, error_code: 'GROUP_KEY_PENDING', message: '群密钥响应无效' };
    }

    const now = new Date().toISOString();
    await db
      .prepare(
        `INSERT OR REPLACE INTO group_wrapped_keys
         (group_id, epoch, member_worker_b_url, wrapped_key_json, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(groupId, epoch, memberUrl, json.data.wrapped_key_json, now)
      .run();
    await db
      .prepare(
        `UPDATE group_members SET key_state = 'active'
          WHERE group_id = ? AND member_worker_b_url = ?`,
      )
      .bind(groupId, memberUrl)
      .run();

    return { ok: true, data: json.data };
  } catch {
    return { ok: false, status: 409, error_code: 'GROUP_KEY_PENDING', message: '快拉密钥网络失败' };
  }
}
