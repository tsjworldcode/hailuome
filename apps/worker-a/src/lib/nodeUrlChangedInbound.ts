/**
 * M7-30f-4：入站 `node_url_changed` 事件 — 验签后更新本站 follows。
 * M7-30j-3：SSRF 门禁 + nonce 去重 + 来源限频 + 验签短缓存（全 D1）。
 */

import { resolveIdentityDb } from '../db/bindings';
import {
  buildNodeUrlChangedCanonical,
  type NodeUrlChangedEvent,
  type NodeUrlMovedDeclaration,
} from '@hailuo/shared-types';
import { verifyMessage } from '@hailuo/shared-crypto';
import {
  assertSafeOutboundHttpsUrl,
  isPrivateProofTargetAllowed,
} from '@hailuo/shared-utils';
import type { Env } from '../env';
import {
  applyFollowUrlMigration,
  normalizeFollowNodeUrl,
} from './followUrlMigrate';

const NODE_FETCH_TIMEOUT_MS = 8_000;
const VERIFY_CACHE_TTL_MS = 5 * 60_000;
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_PER_WINDOW = 30;

function isNodeUrlChangedEvent(value: unknown): value is NodeUrlChangedEvent {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return (
    row.type === 'node_url_changed' &&
    typeof row.from_handle === 'string' &&
    typeof row.from_node_url_old === 'string' &&
    typeof row.from_node_url_new === 'string' &&
    typeof row.changed_at === 'string' &&
    typeof row.grace_until === 'string' &&
    typeof row.nonce === 'string' &&
    typeof row.sig === 'string'
  );
}

function ssrfAllowPrivate(env: Env): boolean {
  return isPrivateProofTargetAllowed(env);
}

export type VerifiedNodeUrlChangedEvent = NodeUrlChangedEvent & {
  readonly verified_pubkey?: string;
};

/** M7-30j-3：出站 URL 须通过 registry 同款 SSRF 门禁 */
export function assertNodeEventUrlsSafe(
  env: Env,
  event: NodeUrlChangedEvent,
): { ok: true } | { ok: false; reason: string } {
  const allowPrivate = ssrfAllowPrivate(env);
  for (const raw of [event.from_node_url_old, event.from_node_url_new]) {
    const check = assertSafeOutboundHttpsUrl(raw, { allowPrivate });
    if (!check.ok) return { ok: false, reason: check.reason };
  }
  return { ok: true };
}

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function verifyCacheKey(
  oldUrl: string,
  newUrl: string,
  handle: string,
): Promise<string> {
  return sha256Hex(`${oldUrl}|${newUrl}|${handle}`);
}

async function readVerifyCache(
  env: Env,
  cacheKey: string,
): Promise<{ ok: boolean; pubkey: string | null } | null> {
  const now = new Date().toISOString();
  try {
    const row = await resolveIdentityDb(env).prepare(
      `SELECT ok, pubkey FROM node_event_verify_cache WHERE cache_key = ? AND expires_at > ? LIMIT 1`,
    )
      .bind(cacheKey, now)
      .first<{ ok: number; pubkey: string | null }>();
    if (!row) return null;
    return { ok: row.ok === 1, pubkey: row.pubkey?.trim() || null };
  } catch {
    return null;
  }
}

async function writeVerifyCache(
  env: Env,
  cacheKey: string,
  ok: boolean,
  pubkey: string | null,
): Promise<void> {
  const expires = new Date(Date.now() + VERIFY_CACHE_TTL_MS).toISOString();
  try {
    await resolveIdentityDb(env).prepare(
      `INSERT OR REPLACE INTO node_event_verify_cache (cache_key, ok, pubkey, expires_at)
       VALUES (?, ?, ?, ?)`,
    )
      .bind(cacheKey, ok ? 1 : 0, pubkey, expires)
      .run();
  } catch (err) {
    console.warn('[nodeUrlChangedInbound] 写 verify_cache 失败', err);
  }
}

/** 按 handle + 新址 origin 限频（D1） */
async function checkNodeEventRateLimit(
  env: Env,
  handle: string,
  newUrl: string,
): Promise<boolean> {
  let origin = '';
  try {
    origin = new URL(newUrl).origin;
  } catch {
    return false;
  }
  const bucketKey = `${handle}|${origin}`.slice(0, 200);
  const nowMs = Date.now();
  const windowStart = new Date(Math.floor(nowMs / RATE_WINDOW_MS) * RATE_WINDOW_MS).toISOString();
  try {
    const row = await resolveIdentityDb(env).prepare(
      `SELECT window_start, count FROM node_event_rate WHERE bucket_key = ? LIMIT 1`,
    )
      .bind(bucketKey)
      .first<{ window_start: string; count: number }>();
    if (!row || row.window_start !== windowStart) {
      await resolveIdentityDb(env).prepare(
        `INSERT OR REPLACE INTO node_event_rate (bucket_key, window_start, count)
         VALUES (?, ?, 1)`,
      )
        .bind(bucketKey, windowStart)
        .run();
      return true;
    }
    if (row.count >= RATE_MAX_PER_WINDOW) return false;
    await resolveIdentityDb(env).prepare(
      `UPDATE node_event_rate SET count = count + 1 WHERE bucket_key = ? AND window_start = ?`,
    )
      .bind(bucketKey, windowStart)
      .run();
    return true;
  } catch (err) {
    console.warn('[nodeUrlChangedInbound] 限频表失败，fail-open', err);
    return true;
  }
}

/** nonce 占坑；changes=0 表示重放 */
async function claimNodeEventNonce(env: Env, nonce: string): Promise<boolean> {
  try {
    const result = await resolveIdentityDb(env).prepare(
      `INSERT OR IGNORE INTO node_event_nonces (nonce, created_at) VALUES (?, ?)`,
    )
      .bind(nonce, new Date().toISOString())
      .run();
    return (result.meta.changes ?? 0) === 1;
  } catch (err) {
    console.warn('[nodeUrlChangedInbound] nonce 写入失败', err);
    return false;
  }
}

/**
 * 验签 + 语义（M7-30j-3：可走短缓存，仍须新 nonce 才 apply）：
 * - grace_until 未过期
 * - 用新址 /users/:handle 的 pubkey 验 Ed25519
 */
export async function verifyNodeUrlChangedEvent(
  env: Env,
  event: NodeUrlChangedEvent,
): Promise<VerifiedNodeUrlChangedEvent | null> {
  const oldUrl = normalizeFollowNodeUrl(event.from_node_url_old);
  const newUrl = normalizeFollowNodeUrl(event.from_node_url_new);
  const handle = event.from_handle.trim().toLowerCase();
  const nowIso = new Date().toISOString();

  if (!oldUrl || !newUrl || !handle || !event.sig.trim() || !event.nonce.trim()) {
    return null;
  }
  if (oldUrl === newUrl) return null;
  if (event.grace_until < nowIso) return null;

  const ssrf = assertNodeEventUrlsSafe(env, event);
  if (!ssrf.ok) return null;

  const cacheKey = await verifyCacheKey(oldUrl, newUrl, handle);
  const cached = await readVerifyCache(env, cacheKey);
  if (cached && !cached.ok) return null;

  let pubkey = cached?.pubkey ?? '';
  if (!pubkey) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), NODE_FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(`${newUrl}/users/${encodeURIComponent(handle)}`, {
        headers: { Accept: 'application/json', 'User-Agent': 'hailuo-node-events/1.0' },
        signal: controller.signal,
        redirect: 'manual',
      });
      if (!res.ok) {
        await writeVerifyCache(env, cacheKey, false, null);
        return null;
      }
      const json = (await res.json()) as {
        ok?: boolean;
        data?: { pubkey?: string; handle?: string };
      };
      if (json.ok !== true || typeof json.data?.pubkey !== 'string') {
        await writeVerifyCache(env, cacheKey, false, null);
        return null;
      }
      pubkey = json.data.pubkey.trim();
      const remoteHandle =
        typeof json.data.handle === 'string' ? json.data.handle.trim().toLowerCase() : '';
      if (remoteHandle && remoteHandle !== handle) {
        await writeVerifyCache(env, cacheKey, false, null);
        return null;
      }
    } catch {
      await writeVerifyCache(env, cacheKey, false, null);
      return null;
    } finally {
      clearTimeout(timer);
    }
    if (!pubkey) {
      await writeVerifyCache(env, cacheKey, false, null);
      return null;
    }
  }

  const canonical = buildNodeUrlChangedCanonical({
    from_handle: handle,
    from_node_url_old: oldUrl,
    from_node_url_new: newUrl,
    changed_at: event.changed_at,
    grace_until: event.grace_until,
    nonce: event.nonce,
  });
  const ok = await verifyMessage(canonical, event.sig, pubkey);
  if (!ok) {
    await writeVerifyCache(env, cacheKey, false, null);
    return null;
  }
  await writeVerifyCache(env, cacheKey, true, pubkey);

  return {
    type: 'node_url_changed',
    from_handle: handle,
    from_node_url_old: oldUrl,
    from_node_url_new: newUrl,
    changed_at: event.changed_at,
    grace_until: event.grace_until,
    nonce: event.nonce,
    sig: event.sig,
    verified_pubkey: pubkey,
  };
}

function toMovedDeclaration(event: NodeUrlChangedEvent): NodeUrlMovedDeclaration {
  return {
    old_node_url: event.from_node_url_old,
    new_node_url: event.from_node_url_new,
    changed_at: event.changed_at,
    grace_until: event.grace_until,
    handle: event.from_handle,
    sig: event.sig,
  };
}

export type ApplyNodeUrlChangedResult =
  | { ok: true; applied: number; matched: number }
  | { ok: false; reason: string; error_code?: string };

/**
 * 查找 follows 中仍指向旧址的行并 UPDATE。
 * M7-30j-3：SSRF → 限频 → nonce → 验签。
 */
export async function applyNodeUrlChangedToFollows(
  env: Env,
  event: NodeUrlChangedEvent,
): Promise<ApplyNodeUrlChangedResult> {
  const ssrf = assertNodeEventUrlsSafe(env, event);
  if (!ssrf.ok) {
    return { ok: false, reason: 'ssrf_blocked', error_code: 'EVENT_URL_BLOCKED' };
  }

  const handle = event.from_handle.trim().toLowerCase();
  const newUrl = normalizeFollowNodeUrl(event.from_node_url_new);
  const allowed = await checkNodeEventRateLimit(env, handle, newUrl);
  if (!allowed) {
    return { ok: false, reason: 'rate_limited', error_code: 'EVENT_RATE_LIMITED' };
  }

  const nonceOk = await claimNodeEventNonce(env, event.nonce.trim());
  if (!nonceOk) {
    return { ok: false, reason: 'replay', error_code: 'EVENT_REPLAY' };
  }

  const verified = await verifyNodeUrlChangedEvent(env, event);
  if (!verified) {
    return { ok: false, reason: 'verify_failed', error_code: 'EVENT_VERIFY_FAILED' };
  }

  const oldUrl = verified.from_node_url_old;
  const declaration = toMovedDeclaration(verified);

  const { results } = await resolveIdentityDb(env)
    .prepare(
      `SELECT id, follower_node_url, followed_worker_b_url, followed_handle
         FROM follows`,
    )
    .all<{
      id: string;
      follower_node_url: string;
      followed_worker_b_url: string | null;
      followed_handle: string | null;
    }>();

  const matches = (results ?? []).filter((row) => {
    const a = normalizeFollowNodeUrl(row.follower_node_url);
    const b = normalizeFollowNodeUrl(row.followed_worker_b_url ?? '');
    return a === oldUrl || b === oldUrl;
  });

  let applied = 0;
  for (const row of matches) {
    const result = await applyFollowUrlMigration(env, {
      followId: row.id,
      declaration,
      followedHandle: row.followed_handle,
      verifiedPubkey: (verified as { verified_pubkey?: string }).verified_pubkey,
    });
    if (result.ok) applied += 1;
  }

  // M7-30-GROUP-URL：双保险 — 群表也改址
  try {
    const { applyGroupUrlMigration } = await import('./groupUrlMigrate');
    const g = await applyGroupUrlMigration(env, oldUrl, verified.from_node_url_new);
    if (g.touched > 0) applied += g.touched;
  } catch (err) {
    console.warn('[nodeUrlChangedInbound] groupUrlMigrate 失败', err);
  }

  return { ok: true, applied, matched: matches.length };
}

export function parseNodeUrlChangedBody(
  body: unknown,
): NodeUrlChangedEvent | null {
  if (!isNodeUrlChangedEvent(body)) return null;
  return body;
}
