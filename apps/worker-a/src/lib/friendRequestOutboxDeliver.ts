/**
 * REL-FIX-1 · 好友 outbox 投递（accept/reject/cancel）— route waitUntil 与 cron 共用。
 *
 * 从 `routes/friend-requests.ts` 下沉，供 `gcFriendRequestOutbox` 真重投，禁止「只扫不投」。
 * 防身份关联：日志只打 requestId / 短 error_code，不落完整对端 URL。
 */
import { randomNonceHex } from '@hailuo/shared-utils';
import type { Env } from '../env';
import { resolveContentDb, resolveIdentityDb } from '../db/bindings';
import {
  buildSignedFriendRequestOutboxEnvelope,
  deliverFriendRequestOutboxToOrigin,
} from './friendRequestDelivery';
import { fetchTargetUserProfile } from './friendRequestOutboxFetcher';
// REL-FIX-10：本机判定统一走 REL-FIX-2 别名体系，消除两套 URL 匹配标准分叉
import { resolveLocalNodeUrlAliases, isLocalNodeUrlMatch } from './localPublicBaseUrl';

/** 写 outbox_status='pending_retry'（首次进窗刷新 updated_at；已在窗内只刷 last_retry）。 */
export async function recordOutboxRetry(
  env: Env,
  requestId: string,
  status: 'accepted' | 'rejected' | 'cancelled',
  target: string,
  errCode: string,
): Promise<void> {
  try {
    const nowIso = new Date().toISOString();
    const safeCode = (errCode || 'OUTBOX_DELIVERY_FAILED').slice(0, 64);
    // 已是 pending_retry：不动 updated_at（giveup 窗起点）；否则写入作为窗起点
    await resolveContentDb(env)
      .prepare(
        `UPDATE friend_requests
            SET outbox_status = 'pending_retry',
                outbox_error = ?,
                outbox_last_retry_at = ?,
                updated_at = CASE
                  WHEN outbox_status = 'pending_retry' THEN updated_at
                  ELSE ?
                END
          WHERE id = ? AND status IN ('accepted','rejected','cancelled')`,
      )
      .bind(safeCode, nowIso, nowIso, requestId)
      .run();
    console.warn('[friendRequests] outbox 投递失败 pending_retry', {
      requestId,
      status,
      err_code: safeCode,
      // 12：不打完整 target URL
      target_host: (() => {
        try {
          return target ? new URL(target).host : '';
        } catch {
          return '';
        }
      })(),
    });
  } catch (err) {
    console.warn('[friendRequests] recordOutboxRetry 写 D1 失败', err);
  }
}

/** 写 outbox_status='acked'。fail-soft。 */
export async function markOutboxAcked(env: Env, requestId: string): Promise<void> {
  try {
    const nowIso = new Date().toISOString();
    await resolveContentDb(env)
      .prepare(
        `UPDATE friend_requests
            SET outbox_status = 'acked',
                outbox_error = '',
                outbox_last_retry_at = '',
                updated_at = ?
          WHERE id = ?`,
      )
      .bind(nowIso, requestId)
      .run();
  } catch (err) {
    console.warn('[friendRequests] markOutboxAcked 写 D1 失败', err);
  }
}

/**
 * REL-FIX-10：判断「目标节点」是否就是本机。
 *
 * 旧实现是裸字符串比对 `targetNodeUrl.toLowerCase() === users.worker_b_url.trim().toLowerCase()`，
 * 与 REL-FIX-2 建立的别名体系（`resolveLocalNodeUrlAliases` + `isLocalNodeUrlMatch`）口径分叉：
 * - 尾斜杠（`https://x.example/` vs `https://x.example`）→ 判 false
 * - host 大小写（`https://X.Example`）→ 判 false
 * - 默认端口（`https://x.example:443`）→ 判 false
 * - 换域名（宽限期内旧址 / `users.worker_b_url` 与 `system_config.worker_b_url` 分叉）→ 判 false
 *
 * 后果：本机其实就在被投递的对端（自环）却被当成远端 → 白白对外发一次
 * `GET /users/:handle` 公开拉档；旧域已失效时更拉不到 → 回执长期卡在 `pending_retry`。
 *
 * 修法：统一走 REL-FIX-2 的别名成员判定（origin 级归一 + 别名表命中）。
 * 归一只做比对，**不**改落库原文；是否本机一律由别名表成员判定，禁止裸 accept 任意 host。
 */
async function isSameAsLocalWorkerB(env: Env, targetNodeUrl: string): Promise<boolean> {
  try {
    const aliases = await resolveLocalNodeUrlAliases(env);
    // 别名表为空 → 未登记 / 灾难回落状态，fail-closed（不认本机）
    if (aliases.length === 0) return false;
    return isLocalNodeUrlMatch(targetNodeUrl, aliases);
  } catch {
    return false;
  }
}

async function readLocalTargetProfile(env: Env): Promise<{
  handle: string;
  pubkey: string;
  display_name: string;
  avatar_key: string;
} | null> {
  try {
    const row = await resolveIdentityDb(env)
      .prepare(`SELECT handle, display_name, avatar_key, pubkey FROM users LIMIT 1`)
      .first<{ handle: string; display_name: string; avatar_key: string | null; pubkey: string }>();
    if (!row?.handle || !row.pubkey || row.pubkey.length !== 64) return null;
    return {
      handle: row.handle.trim().toLowerCase(),
      pubkey: row.pubkey.trim(),
      display_name: (row.display_name ?? '').trim(),
      avatar_key: (row.avatar_key ?? '').trim(),
    };
  } catch {
    return null;
  }
}

async function readLocalUser(env: Env): Promise<{
  handle: string;
  display_name: string;
  avatar_key: string | null;
  pubkey: string;
} | null> {
  try {
    const row = await resolveIdentityDb(env)
      .prepare(`SELECT handle, display_name, avatar_key, pubkey FROM users LIMIT 1`)
      .first<{
        handle: string;
        display_name: string;
        avatar_key: string | null;
        pubkey: string;
      }>();
    if (!row?.handle?.trim()) return null;
    return {
      handle: row.handle.trim().toLowerCase(),
      display_name: (row.display_name ?? '').trim(),
      avatar_key: row.avatar_key ?? null,
      pubkey: (row.pubkey ?? '').trim(),
    };
  } catch {
    return null;
  }
}

/**
 * 目标端把 accept/reject 回执投递给 origin。
 * `_privateKey` 保留签名位（当前用 env 内签名 helper）；cron 可传空串。
 */
export async function deliverStatusOutbox(
  env: Env,
  requestId: string,
  status: 'accepted' | 'rejected',
  _privateKey: string,
): Promise<void> {
  try {
    const row = await resolveContentDb(env)
      .prepare(
        `SELECT origin_node_url, origin_handle, target_node_url, target_handle
           FROM friend_requests WHERE id = ? LIMIT 1`,
      )
      .bind(requestId)
      .first<{
        origin_node_url: string;
        origin_handle: string;
        target_node_url: string;
        target_handle: string;
      }>();
    if (!row) {
      console.warn('[friendRequests] deliverStatusOutbox 行不存在', requestId);
      return;
    }
    const targetNodeUrl = (row.target_node_url ?? '').trim();
    const targetHandle = (row.target_handle ?? '').trim().toLowerCase();
    const originNodeUrl = (row.origin_node_url ?? '').trim();
    if (!targetNodeUrl || !targetHandle || !originNodeUrl) {
      console.warn('[friendRequests] deliverStatusOutbox 行字段缺失', { requestId });
      return;
    }

    let profile: Awaited<ReturnType<typeof fetchTargetUserProfile>> = null;
    if (await isSameAsLocalWorkerB(env, targetNodeUrl)) {
      profile = await readLocalTargetProfile(env);
    } else {
      profile = await fetchTargetUserProfile(targetNodeUrl, targetHandle);
    }

    if (!profile) {
      await recordOutboxRetry(env, requestId, status, targetNodeUrl, 'TARGET_PUBKEY_UNREACHABLE');
      return;
    }

    const ts = String(Math.floor(Date.now() / 1000));
    const nonce = randomNonceHex(16);
    const envelope = await buildSignedFriendRequestOutboxEnvelope(env, {
      request_id: requestId,
      status,
      actor: {
        node_url: targetNodeUrl,
        handle: targetHandle,
        pubkey: profile.pubkey,
        ...(profile.display_name ? { display_name: profile.display_name } : {}),
        ...(profile.avatar_key ? { avatar_key: profile.avatar_key } : {}),
      },
      nonce,
      ts,
    });
    const result = await deliverFriendRequestOutboxToOrigin(env, originNodeUrl, envelope);
    if (!result.ok) {
      await recordOutboxRetry(env, requestId, status, originNodeUrl, result.error_code);
      return;
    }

    await markOutboxAcked(env, requestId);
  } catch (err) {
    console.warn('[friendRequests] deliverStatusOutbox 异常', err);
    try {
      await recordOutboxRetry(env, requestId, status, '', 'OUTBOX_DELIVERY_EXCEPTION');
    } catch (innerErr) {
      console.warn('[friendRequests] recordOutboxRetry 异常', innerErr);
    }
  }
}

/** origin 撤回后把 cancelled 投递给 target。 */
export async function deliverCancelOutbox(env: Env, requestId: string): Promise<void> {
  try {
    const row = await resolveContentDb(env)
      .prepare(
        `SELECT origin_node_url, origin_handle, target_node_url, target_handle, status
           FROM friend_requests WHERE id = ? LIMIT 1`,
      )
      .bind(requestId)
      .first<{
        origin_node_url: string;
        origin_handle: string;
        target_node_url: string;
        target_handle: string;
        status: string;
      }>();
    if (!row || row.status !== 'cancelled') {
      console.warn('[friendRequests] deliverCancelOutbox 行缺失或非 cancelled', requestId);
      return;
    }
    const targetNodeUrl = (row.target_node_url ?? '').trim();
    const originNodeUrl = (row.origin_node_url ?? '').trim();
    if (!targetNodeUrl || !originNodeUrl) {
      console.warn('[friendRequests] deliverCancelOutbox 行字段缺失', { requestId });
      return;
    }

    const localUser = await readLocalUser(env);
    if (!localUser || !localUser.pubkey || localUser.pubkey.length !== 64) {
      await recordOutboxRetry(env, requestId, 'cancelled', targetNodeUrl, 'ORIGIN_PUBKEY_MISSING');
      return;
    }

    const ts = String(Math.floor(Date.now() / 1000));
    const nonce = randomNonceHex(16);
    const envelope = await buildSignedFriendRequestOutboxEnvelope(env, {
      request_id: requestId,
      status: 'cancelled',
      actor: {
        node_url: originNodeUrl,
        handle: localUser.handle,
        pubkey: localUser.pubkey,
        ...(localUser.display_name ? { display_name: localUser.display_name } : {}),
        ...(localUser.avatar_key ? { avatar_key: localUser.avatar_key } : {}),
      },
      nonce,
      ts,
    });
    const result = await deliverFriendRequestOutboxToOrigin(env, targetNodeUrl, envelope);
    if (!result.ok) {
      await recordOutboxRetry(env, requestId, 'cancelled', targetNodeUrl, result.error_code);
      return;
    }
    await markOutboxAcked(env, requestId);
  } catch (err) {
    console.warn('[friendRequests] deliverCancelOutbox 异常', err);
    try {
      await recordOutboxRetry(env, requestId, 'cancelled', '', 'OUTBOX_DELIVERY_EXCEPTION');
    } catch (innerErr) {
      console.warn('[friendRequests] recordOutboxRetry(cancel) 异常', innerErr);
    }
  }
}
