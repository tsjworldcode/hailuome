/**
 * M7-30f-2 / M7-30h-6：Worker B 读取 STATE_KV 链式迁址声明（只读）。
 * R-AUDIT-V3 2.6：模块级缓存 TTL 60s（含负缓存），压低 /posts|/feed|/health 附加头的 KV 读。
 */

import {
  NODE_URL_MOVED_ENTRY_KEY_PREFIX,
  NODE_URL_MOVED_HEADER,
  NODE_URL_MOVED_INDEX_KV_KEY,
  NODE_URL_MOVED_KV_KEY,
  type NodeUrlMovedDeclaration,
  type NodeUrlMovedIndex,
} from '@hailuo/shared-types';
import type { Env } from '../env.d';

/** R-AUDIT-V3 2.6：与计划一致 60s（原 legacy 路径为 30s）。 */
export const NODE_URL_MOVED_CACHE_TTL_MS = 60_000;

type CacheEntry = {
  declaration: NodeUrlMovedDeclaration | null;
  fetchedAt: number;
};

/**
 * isolate 短缓存。
 * key：`legacy` | `origin:<url>` | `old:<url>`
 * 值为 null 也缓存（负缓存），避免未迁址节点每请求打 KV。
 */
const cacheByKey = new Map<string, CacheEntry>();

/** 契约/单测：清空模块缓存。 */
export function resetNodeUrlMovedCacheForTests(): void {
  cacheByKey.clear();
}

function stripTrailingSlash(url: string): string {
  return url.trim().replace(/\/+$/, '');
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

function isNodeUrlMovedIndex(value: unknown): value is NodeUrlMovedIndex {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return Array.isArray(row.entries);
}

function isWithinGrace(declaration: NodeUrlMovedDeclaration, nowIso = new Date().toISOString()): boolean {
  return declaration.grace_until >= nowIso;
}

function cacheGet(
  key: string,
  nowMs: number,
): NodeUrlMovedDeclaration | null | undefined {
  const hit = cacheByKey.get(key);
  if (!hit) return undefined;
  if (nowMs - hit.fetchedAt >= NODE_URL_MOVED_CACHE_TTL_MS) {
    cacheByKey.delete(key);
    return undefined;
  }
  return hit.declaration;
}

function cacheSet(
  key: string,
  declaration: NodeUrlMovedDeclaration | null,
  nowMs: number,
): void {
  cacheByKey.set(key, { declaration, fetchedAt: nowMs });
}

async function hashNodeUrlForEntryKey(oldNodeUrl: string): Promise<string> {
  const normalized = stripTrailingSlash(oldNodeUrl);
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalized));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 16);
}

async function readEntryByOldUrl(
  env: Env,
  oldUrl: string,
): Promise<NodeUrlMovedDeclaration | null> {
  const hash = await hashNodeUrlForEntryKey(oldUrl);
  const key = `${NODE_URL_MOVED_ENTRY_KEY_PREFIX}${hash}`;
  try {
    const raw = await env.STATE_KV.get(key, 'json');
    if (isNodeUrlMovedDeclaration(raw) && isWithinGrace(raw)) {
      return raw;
    }
  } catch (err) {
    console.error('[nodeUrlMoved] entry 读取失败', key, err);
  }
  return null;
}

async function readEntryFromIndexByOrigin(
  env: Env,
  requestOrigin: string,
): Promise<NodeUrlMovedDeclaration | null> {
  const origin = stripTrailingSlash(requestOrigin);
  if (!origin) return null;
  try {
    const rawIndex = await env.STATE_KV.get(NODE_URL_MOVED_INDEX_KV_KEY, 'json');
    if (!isNodeUrlMovedIndex(rawIndex)) return null;
    const nowIso = new Date().toISOString();
    const match = rawIndex.entries.find(
      (e) => stripTrailingSlash(e.old_node_url) === origin && e.grace_until >= nowIso,
    );
    if (!match) return null;
    const raw = await env.STATE_KV.get(match.key, 'json');
    if (isNodeUrlMovedDeclaration(raw) && isWithinGrace(raw)) {
      return raw;
    }
  } catch (err) {
    console.error('[nodeUrlMoved] index/origin 匹配失败', err);
  }
  return null;
}

/** 只读 legacy `node:url-moved`（无缓存）。 */
async function readLegacyDeclaration(env: Env): Promise<NodeUrlMovedDeclaration | null> {
  try {
    const raw = await env.STATE_KV.get(NODE_URL_MOVED_KV_KEY, 'json');
    if (isNodeUrlMovedDeclaration(raw) && isWithinGrace(raw)) {
      return raw;
    }
  } catch (err) {
    console.error('[nodeUrlMoved] STATE_KV legacy 读取失败', err);
  }
  return null;
}

/**
 * 读取宽限期内有效的迁址声明。
 * @param opts.oldUrl 显式旧址（query `old_url`）
 * @param opts.requestOrigin 请求 Origin，匹配 index 中 old_node_url
 * @param nowMs 可注入，便于测 TTL
 */
export async function readActiveNodeUrlMoved(
  env: Env,
  opts: { oldUrl?: string; requestOrigin?: string } = {},
  nowMs: number = Date.now(),
): Promise<NodeUrlMovedDeclaration | null> {
  const explicitOld = opts.oldUrl?.trim() ? stripTrailingSlash(opts.oldUrl) : '';
  if (explicitOld) {
    const key = `old:${explicitOld}`;
    const hit = cacheGet(key, nowMs);
    if (hit !== undefined) return hit;
    const declaration = await readEntryByOldUrl(env, explicitOld);
    cacheSet(key, declaration, nowMs);
    return declaration;
  }

  const origin = opts.requestOrigin?.trim() ? stripTrailingSlash(opts.requestOrigin) : '';
  if (origin) {
    const key = `origin:${origin}`;
    const hit = cacheGet(key, nowMs);
    if (hit !== undefined) return hit;
    // 热路径：index → legacy；整段结果缓存（含 null）
    const fromOrigin = await readEntryFromIndexByOrigin(env, origin);
    const declaration = fromOrigin ?? (await readLegacyDeclaration(env));
    cacheSet(key, declaration, nowMs);
    return declaration;
  }

  const legacyHit = cacheGet('legacy', nowMs);
  if (legacyHit !== undefined) return legacyHit;
  const declaration = await readLegacyDeclaration(env);
  cacheSet('legacy', declaration, nowMs);
  return declaration;
}

/** 若宽限期内有迁址声明，写入 X-Hailuo-Node-Moved（指向该跳 new_node_url）。 */
export async function attachNodeMovedHeader(
  env: Env,
  headers: Headers,
  requestOrigin?: string,
  nowMs: number = Date.now(),
): Promise<void> {
  const active = await readActiveNodeUrlMoved(env, { requestOrigin }, nowMs);
  if (!active) return;
  headers.set(NODE_URL_MOVED_HEADER, active.new_node_url.replace(/\/+$/, ''));
}

/** 列出 index 中仍有效的 entry（供 well-known 调试，可选） */
export async function listActiveNodeUrlMovedEntries(env: Env): Promise<NodeUrlMovedDeclaration[]> {
  const nowIso = new Date().toISOString();
  try {
    const rawIndex = await env.STATE_KV.get(NODE_URL_MOVED_INDEX_KV_KEY, 'json');
    if (!isNodeUrlMovedIndex(rawIndex)) return [];
    const out: NodeUrlMovedDeclaration[] = [];
    for (const entry of rawIndex.entries) {
      if (entry.grace_until < nowIso) continue;
      const raw = await env.STATE_KV.get(entry.key, 'json');
      if (isNodeUrlMovedDeclaration(raw) && isWithinGrace(raw)) {
        out.push(raw);
      }
    }
    return out;
  } catch (err) {
    console.error('[nodeUrlMoved] list entries 失败', err);
    return [];
  }
}
