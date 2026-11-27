/**
 * M7-30f-2 / M7-30h-6 / M7-30k-1：换域成功后写入链式迁址声明。
 *
 * D1 `node_url_moved_entries` 为 SSOT；STATE_KV entry/index/legacy 由 D1 快照同步，
 * 避免连续换域时在 KV index 上 read-modify-write 丢跳。
 */

import { resolveIdentityDb } from '../db/bindings';
import {
  NODE_URL_MOVED_ENTRY_KEY_PREFIX,
  NODE_URL_MOVED_INDEX_KV_KEY,
  NODE_URL_MOVED_KV_KEY,
  URL_MOVE_CHAIN_MAX_ENTRIES,
  buildNodeUrlMovedCanonical,
  clampUrlMoveGraceDays,
  type NodeUrlMovedDeclaration,
  type NodeUrlMovedIndex,
  type NodeUrlMovedIndexEntry,
} from '@hailuo/shared-types';
import { signMessage } from '@hailuo/shared-crypto';
import type { Env } from '../env';
import { normalizePublicBaseUrl } from './localPublicBaseUrl';

async function readGraceDays(env: Env): Promise<number> {
  const row = await resolveIdentityDb(env)
    .prepare(`SELECT value FROM system_config WHERE key = 'url_move_grace_days' LIMIT 1`)
    .first<{ value: string }>()
    .catch(() => null);
  return clampUrlMoveGraceDays(row?.value);
}

/** 旧址 URL → entry KV key（16 hex） */
export async function hashNodeUrlForEntryKey(oldNodeUrl: string): Promise<string> {
  const normalized = oldNodeUrl.trim().replace(/\/+$/, '');
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalized));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 16);
}

function isNodeUrlMovedDeclaration(value: unknown): value is NodeUrlMovedDeclaration {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.old_node_url === 'string' &&
    typeof row.new_node_url === 'string' &&
    typeof row.changed_at === 'string' &&
    typeof row.grace_until === 'string' &&
    typeof row.handle === 'string' &&
    typeof row.sig === 'string'
  );
}

/** 写入成功后供 f-4 outbox 装填复用的元数据 */
export type NodeUrlMovedWriteResult = {
  oldNodeUrl: string;
  newNodeUrl: string;
  changedAt: string;
  graceUntil: string;
  handle: string;
  graceDays: number;
};

type NodeUrlMovedD1Row = {
  entry_key: string;
  old_node_url: string;
  declaration_json: string;
  grace_until: string;
};

/** M7-30k-1：D1 upsert 单跳 entry */
async function upsertNodeUrlMovedD1(
  env: Env,
  entryKey: string,
  body: NodeUrlMovedDeclaration,
  createdAt: string,
): Promise<void> {
  await resolveIdentityDb(env)
    .prepare(
      `INSERT OR REPLACE INTO node_url_moved_entries
         (entry_key, old_node_url, new_node_url, declaration_json, grace_until, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      entryKey,
      body.old_node_url,
      body.new_node_url,
      JSON.stringify(body),
      body.grace_until,
      createdAt,
    )
    .run();
}

/** 清理已过宽限期的 D1 行（fail-soft） */
async function pruneExpiredNodeUrlMovedD1(env: Env, nowIso: string): Promise<void> {
  try {
    await resolveIdentityDb(env)
      .prepare(`DELETE FROM node_url_moved_entries WHERE grace_until < ?`)
      .bind(nowIso)
      .run();
  } catch (err) {
    console.warn('[nodeUrlMoved] 清理过期 D1 entry 失败（表可能未迁移）', err);
  }
}

/** 从 D1 读取宽限期内 entry，按 grace_until 降序 */
async function listActiveNodeUrlMovedFromD1(env: Env): Promise<NodeUrlMovedD1Row[]> {
  const nowIso = new Date().toISOString();
  try {
    const { results } = await resolveIdentityDb(env)
      .prepare(
        `SELECT entry_key, old_node_url, declaration_json, grace_until
           FROM node_url_moved_entries
          WHERE grace_until >= ?
          ORDER BY grace_until DESC
          LIMIT ?`,
      )
      .bind(nowIso, URL_MOVE_CHAIN_MAX_ENTRIES)
      .all<NodeUrlMovedD1Row>();
    return results ?? [];
  } catch (err) {
    console.warn('[nodeUrlMoved] 读 D1 entry 失败（表可能未迁移）', err);
    return [];
  }
}

/**
 * M7-30k-1：用 D1 快照重写 KV entry/index/legacy，不再读 KV index merge。
 * @param latestLegacy 本跳声明，写入 legacy `node:url-moved`（最新一跳回落）
 */
async function syncNodeUrlMovedKvFromD1(
  env: Env,
  ttlSec: number,
  latestLegacy: NodeUrlMovedDeclaration,
): Promise<void> {
  const nowIso = new Date().toISOString();
  const rows = await listActiveNodeUrlMovedFromD1(env);
  const indexEntries: NodeUrlMovedIndexEntry[] = [];

  for (const row of rows) {
    let declaration: NodeUrlMovedDeclaration | null = null;
    try {
      const parsed = JSON.parse(row.declaration_json) as unknown;
      if (isNodeUrlMovedDeclaration(parsed)) {
        declaration = parsed;
      }
    } catch {
      /* 跳过损坏行 */
    }
    if (!declaration) continue;

    try {
      await env.STATE_KV.put(row.entry_key, row.declaration_json, { expirationTtl: ttlSec });
    } catch (err) {
      console.error('[nodeUrlMoved] KV entry 写入失败', row.entry_key, err);
    }
    indexEntries.push({
      key: row.entry_key,
      old_node_url: row.old_node_url,
      grace_until: row.grace_until,
    });
  }

  const index: NodeUrlMovedIndex = { entries: indexEntries, updated_at: nowIso };
  try {
    await env.STATE_KV.put(NODE_URL_MOVED_INDEX_KV_KEY, JSON.stringify(index), {
      expirationTtl: ttlSec,
    });
  } catch (err) {
    console.error('[nodeUrlMoved] KV index 写入失败', err);
  }

  try {
    await env.STATE_KV.put(NODE_URL_MOVED_KV_KEY, JSON.stringify(latestLegacy), {
      expirationTtl: ttlSec,
    });
  } catch (err) {
    console.error('[nodeUrlMoved] KV legacy 写入失败', err);
  }
}

/**
 * confirm 本地同步时调用：用换域前的旧基址 + 新 node_url 写签名声明（追加 chain entry）。
 */
export async function writeNodeUrlMovedKv(
  env: Env,
  input: { oldNodeUrl: string; newNodeUrl: string },
): Promise<NodeUrlMovedWriteResult | null> {
  const oldNodeUrl = normalizePublicBaseUrl(input.oldNodeUrl);
  const newNodeUrl = normalizePublicBaseUrl(input.newNodeUrl);
  if (!newNodeUrl) {
    console.warn('[nodeUrlMoved] 缺少 new_node_url，跳过写入');
    return null;
  }
  if (!oldNodeUrl) {
    console.warn('[nodeUrlMoved] 缺少 old_node_url，跳过写入');
    return null;
  }
  if (oldNodeUrl === newNodeUrl) {
    console.warn('[nodeUrlMoved] old/new 相同，跳过写入');
    return null;
  }

  const privateKey = env.ED25519_PRIVATE_KEY?.trim() ?? '';
  if (!privateKey) {
    console.error('[nodeUrlMoved] ED25519_PRIVATE_KEY 未配置，跳过迁址声明');
    return null;
  }

  const handle = (env.BOOTSTRAP_HANDLE?.trim() || 'owner').toLowerCase();
  const graceDays = await readGraceDays(env);
  const changedAt = new Date().toISOString();
  const graceUntil = new Date(Date.now() + graceDays * 24 * 60 * 60 * 1000).toISOString();

  const unsigned: Omit<NodeUrlMovedDeclaration, 'sig'> = {
    old_node_url: oldNodeUrl,
    new_node_url: newNodeUrl,
    changed_at: changedAt,
    grace_until: graceUntil,
    handle,
  };
  const canonical = buildNodeUrlMovedCanonical(unsigned);
  const sig = await signMessage(canonical, privateKey);
  const body: NodeUrlMovedDeclaration = { ...unsigned, sig };

  const ttlSec = graceDays * 24 * 60 * 60 + 3600;
  const entryHash = await hashNodeUrlForEntryKey(oldNodeUrl);
  const entryKey = `${NODE_URL_MOVED_ENTRY_KEY_PREFIX}${entryHash}`;

  const nowIso = new Date().toISOString();
  await pruneExpiredNodeUrlMovedD1(env, nowIso);
  await upsertNodeUrlMovedD1(env, entryKey, body, changedAt);
  await syncNodeUrlMovedKvFromD1(env, ttlSec, body);

  return {
    oldNodeUrl,
    newNodeUrl,
    changedAt,
    graceUntil,
    handle,
    graceDays,
  };
}
