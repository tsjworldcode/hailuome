/**
 * M17-4-2a：互粉投影（好友名单公开子集）
 *
 * - 权威语义与 `GET /api/local/mutual-follows` 同源：accepted friend_requests ∩ 本地 follows
 * - 对外投影仅三字段：handle / node_url / display_name（禁 pubkey / email / avatar_key / request_id）
 * - 默认与上限均为 20（FOOF_PER_FRIEND_LIMIT）
 *
 * 跨库：friend_requests → CONTENT_DB；users / follows → IDENTITY_DB；禁止单 batch 跨库。
 */
import { normalizeWorkerBOrigin } from '@hailuo/shared-utils';
import type { Env } from '../env';
import { resolveContentDb, resolveIdentityDb } from '../db/bindings';

/** 对外投影每请求上限（与计划 FOOF_PER_FRIEND_LIMIT 一致） */
export const MUTUAL_FRIENDS_PROJECTION_MAX = 20;

export type MutualPeerRow = {
  readonly node_url: string;
  readonly handle: string;
  readonly display_name: string;
  readonly avatar_key: string;
  readonly request_id: string;
  readonly accepted_at: string | null;
};

/** 公开 / 跨节点投影：严格三字段 */
export type MutualFriendProjectionItem = {
  readonly handle: string;
  readonly node_url: string;
  readonly display_name: string;
};

export function clampMutualFriendsLimit(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number.parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(n) || n < 1) return MUTUAL_FRIENDS_PROJECTION_MAX;
  return Math.min(Math.floor(n), MUTUAL_FRIENDS_PROJECTION_MAX);
}

/** 站主通讯录上限（与历史 mutual-follows 一致） */
const OWNER_MUTUAL_LIST_MAX = 200;

function resolveListLimit(raw: number | undefined): number {
  if (raw === undefined) return OWNER_MUTUAL_LIST_MAX;
  if (!Number.isFinite(raw) || raw < 1) return OWNER_MUTUAL_LIST_MAX;
  return Math.min(Math.floor(raw), OWNER_MUTUAL_LIST_MAX);
}

/**
 * 列出本站「仍互粉」的好友行（含站主本地列表所需扩展字段）。
 * `limit` 默认 200；公开投影请先 `clampMutualFriendsLimit` 再传入。
 */
export async function listAcceptedMutualPeers(
  env: Env,
  options?: { limit?: number },
): Promise<MutualPeerRow[]> {
  const limit = resolveListLimit(options?.limit);
  const identityDb = resolveIdentityDb(env);
  const contentDb = resolveContentDb(env);

  const own = await identityDb
    .prepare(`SELECT handle FROM users LIMIT 1`)
    .first<{ handle: string }>();
  if (!own?.handle) return [];

  const frResult = await contentDb
    .prepare(
      `SELECT fr.id AS request_id,
              fr.accepted_at AS accepted_at,
              fr.updated_at AS updated_at,
              fr.origin_handle AS origin_handle,
              fr.origin_node_url AS origin_node_url,
              fr.origin_display_name AS origin_display_name,
              fr.origin_avatar_key AS origin_avatar_key,
              fr.target_handle AS target_handle,
              fr.target_node_url AS target_node_url
         FROM friend_requests fr
        WHERE fr.status = 'accepted'
          AND (fr.origin_handle = ? OR fr.target_handle = ?)
        ORDER BY COALESCE(fr.accepted_at, fr.updated_at) DESC
        LIMIT 200`,
    )
    .bind(own.handle, own.handle)
    .all<{
      request_id: string;
      accepted_at: string | null;
      updated_at: string | null;
      origin_handle: string;
      origin_node_url: string;
      origin_display_name: string;
      origin_avatar_key: string;
      target_handle: string;
      target_node_url: string;
    }>();

  const rows = frResult.results ?? [];
  if (rows.length === 0) return [];

  const peerUrls: string[] = [];
  for (const row of rows) {
    const iAmOrigin = row.origin_handle === own.handle;
    peerUrls.push(iAmOrigin ? row.target_node_url : row.origin_node_url);
  }
  const uniquePeers = [...new Set(peerUrls.filter((u) => typeof u === 'string' && u.length > 0))];

  const followByUrl = new Map<
    string,
    { followed_handle: string | null; followed_display_name: string; followed_avatar_key: string }
  >();
  if (uniquePeers.length > 0) {
    const placeholders = uniquePeers.map(() => '?').join(', ');
    const follows = await identityDb
      .prepare(
        `SELECT follower_node_url, followed_handle, followed_display_name, followed_avatar_key
           FROM follows
          WHERE follower_node_url IN (${placeholders})`,
      )
      .bind(...uniquePeers)
      .all<{
        follower_node_url: string;
        followed_handle: string | null;
        followed_display_name: string;
        followed_avatar_key: string;
      }>();
    for (const f of follows.results ?? []) {
      followByUrl.set(f.follower_node_url, f);
    }
  }

  const items: MutualPeerRow[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const iAmOrigin = row.origin_handle === own.handle;
    const rawUrl = iAmOrigin ? row.target_node_url : row.origin_node_url;
    const follow = followByUrl.get(rawUrl);
    if (!follow) continue;

    let node_url: string;
    try {
      node_url = normalizeWorkerBOrigin(rawUrl);
    } catch {
      node_url = rawUrl;
    }
    if (seen.has(node_url)) continue;
    seen.add(node_url);

    const handle =
      (follow.followed_handle && follow.followed_handle.trim()) ||
      (iAmOrigin ? row.target_handle : row.origin_handle);

    items.push({
      node_url,
      handle,
      display_name: follow.followed_display_name || (iAmOrigin ? '' : row.origin_display_name) || '',
      avatar_key: follow.followed_avatar_key || (iAmOrigin ? '' : row.origin_avatar_key) || '',
      request_id: row.request_id,
      accepted_at: row.accepted_at,
    });

    if (items.length >= limit) break;
  }

  return items;
}

/** 转为跨节点安全投影（三字段） */
export function toFriendsProjection(
  rows: readonly MutualPeerRow[],
): MutualFriendProjectionItem[] {
  return rows.map((row) => ({
    handle: row.handle,
    node_url: row.node_url,
    display_name: row.display_name || '',
  }));
}

/** 读取本站站主 handle（无用户行则 null） */
export async function readLocalOwnerHandle(env: Env): Promise<string | null> {
  const identityDb = resolveIdentityDb(env);
  const own = await identityDb
    .prepare(`SELECT handle FROM users LIMIT 1`)
    .first<{ handle: string }>();
  const h = own?.handle?.trim().toLowerCase() ?? '';
  return h || null;
}
