/**
 * M7-30f-4 / M7-30b-ux2：换域后对已知联系人尽力推送（outbox + Cron）。
 *
 * 装填目标（站主拍板）：**互关好友** + **私信对端** + **所在群成员/群主**。
 * 不再推送：单向关注、赞/回互动 actor。
 *
 * 存储：`url_change_notify_jobs`（D1）；attempts / next_attempt_at 禁止 KV。
 * 配额：每次 Cron 最多 20 次外部 POST（子请求）。
 *
 * M-OPT-SPLIT-5c-6：跨库契约收口 ——
 *   - `system_config` + `url_change_notify_events` + `follows` / `users` → **IDENTITY_DB**
 *   - `friend_requests`（互关投影）→ **CONTENT_DB**（经 `listAcceptedMutualPeers`）
 *   - `url_change_notify_jobs` → **GOVERNANCE_DB**
 *   - `dm_messages` / `groups` / `group_members` → **MESSAGING_DB**
 *   跨库禁止单 batch。
 */

import {
  buildNodeUrlChangedCanonical,
  type NodeUrlChangedEvent,
} from '@hailuo/shared-types';
import { signMessage } from '@hailuo/shared-crypto';
import type { Env } from '../env';
import { resolveGovernanceDb, resolveIdentityDb } from '../db/bindings';
import { normalizePublicBaseUrl } from './localPublicBaseUrl';
import { isManualRedirectStatus, OUTBOUND_PEER_UA, resolveSafeOutboundPeerUrl } from './fetchOutboundPeer';
import { normalizeFollowNodeUrl } from './followUrlMigrate';
import { listAcceptedMutualPeers } from './mutualFriendsProjection';

const MAX_ATTEMPTS = 8;
/** 每分钟投递上限（外部子请求） */
/**
 * CRON-SCHEDULE-AUDIT：Cron 只在偶数分钟 / %5 分钟进重任务块；
 * 因此换域通知必须与 Feed 共分钟。Feed 实际可到 40 次外部，
 * 本批降到 8 → 40+8=48，留 2 次余量。每 10 分钟 8 条足够消化通知。
 */
export const URL_CHANGE_NOTIFY_BATCH = 8;
/** M7-30j-2：processing lease（秒） */
export const URL_CHANGE_NOTIFY_LEASE_MS = 180_000;

/** mutual=互关；follows 仅兼容历史 outbox 行 */
export type UrlChangeNotifySource = 'mutual' | 'follows' | 'dm' | 'interaction' | 'group';

export type UrlMoveNotifyMeta = {
  urlChangeId: string;
  oldNodeUrl: string;
  newNodeUrl: string;
  changedAt: string;
  graceUntil: string;
  handle: string;
};

function jobId(): string {
  return `ucn_${crypto.randomUUID().replace(/-/g, '')}`;
}

function eventNonce(): string {
  return `nce_${crypto.randomUUID().replace(/-/g, '')}`;
}

/** 指数退避分钟：1,2,4,… 封顶 1440（约 1 天） */
function backoffMinutes(attemptsAfterFail: number): number {
  const exp = Math.min(Math.max(attemptsAfterFail - 1, 0), 10);
  return Math.min(2 ** exp, 1440);
}

async function upsertSystemConfig(
  identityDb: D1Database,
  key: string,
  value: string,
  isoNow: string,
): Promise<void> {
  await identityDb
    .prepare(
      `INSERT OR REPLACE INTO system_config (key, value, updated_at) VALUES (?, ?, ?)`,
    )
    .bind(key, value, isoNow)
    .run();
}

/**
 * 写入 system_config 迁址元数据（Settings 当前宽限期）+
 * 按 url_change_id 固化已签名信封（M7-30j-1，防连续换域串信）。
 * fail-soft：私钥缺失时仍写 URL/grace，但无 sig 则 Cron 跳过投递。
 */
export async function persistUrlMoveNotifyEnvelope(
  env: Env,
  meta: UrlMoveNotifyMeta,
): Promise<NodeUrlChangedEvent | null> {
  const isoNow = new Date().toISOString();
  const oldUrl = normalizePublicBaseUrl(meta.oldNodeUrl);
  const newUrl = normalizePublicBaseUrl(meta.newNodeUrl);
  const handle = meta.handle.trim().toLowerCase() || 'owner';
  if (!oldUrl || !newUrl || oldUrl === newUrl) return null;

  // M-OPT-SPLIT-5c-6：system_config + url_change_notify_events 都在 IDENTITY_DB
  const identityDb = resolveIdentityDb(env);

  await identityDb.batch([
    identityDb.prepare(
      `INSERT OR REPLACE INTO system_config (key, value, updated_at) VALUES ('url_move_old_node_url', ?, ?)`,
    ).bind(oldUrl, isoNow),
    identityDb.prepare(
      `INSERT OR REPLACE INTO system_config (key, value, updated_at) VALUES ('url_move_new_node_url', ?, ?)`,
    ).bind(newUrl, isoNow),
    identityDb.prepare(
      `INSERT OR REPLACE INTO system_config (key, value, updated_at) VALUES ('url_move_grace_until', ?, ?)`,
    ).bind(meta.graceUntil, isoNow),
    identityDb.prepare(
      `INSERT OR REPLACE INTO system_config (key, value, updated_at) VALUES ('url_move_changed_at', ?, ?)`,
    ).bind(meta.changedAt, isoNow),
    identityDb.prepare(
      `INSERT OR REPLACE INTO system_config (key, value, updated_at) VALUES ('url_move_from_handle', ?, ?)`,
    ).bind(handle, isoNow),
    identityDb.prepare(
      `INSERT OR REPLACE INTO system_config (key, value, updated_at) VALUES ('url_move_url_change_id', ?, ?)`,
    ).bind(meta.urlChangeId, isoNow),
  ]);

  const privateKey = env.ED25519_PRIVATE_KEY?.trim() ?? '';
  if (!privateKey) {
    console.error('[urlChangeNotify] ED25519_PRIVATE_KEY 未配置，跳过 events 签名');
    return null;
  }

  const nonce = eventNonce();
  const unsigned: Omit<NodeUrlChangedEvent, 'sig'> = {
    type: 'node_url_changed',
    from_handle: handle,
    from_node_url_old: oldUrl,
    from_node_url_new: newUrl,
    changed_at: meta.changedAt,
    grace_until: meta.graceUntil,
    nonce,
  };
  const sig = await signMessage(buildNodeUrlChangedCanonical(unsigned), privateKey);
  const event: NodeUrlChangedEvent = { ...unsigned, sig };

  await upsertSystemConfig(identityDb, 'url_move_event_nonce', nonce, isoNow);
  await upsertSystemConfig(identityDb, 'url_move_event_sig', sig, isoNow);

  // M7-30j-1：按换域 id 固化快照；投递只认本行，不读被覆盖的全局 config
  try {
    await identityDb
      .prepare(
        `INSERT OR REPLACE INTO url_change_notify_events
           (url_change_id, event_json, grace_until, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .bind(meta.urlChangeId, JSON.stringify(event), meta.graceUntil, isoNow)
      .run();
  } catch (err) {
    console.error('[urlChangeNotify] 写入 url_change_notify_events 失败', err);
    return null;
  }

  return event;
}

async function collectMutualTargets(env: Env): Promise<Map<string, UrlChangeNotifySource>> {
  const map = new Map<string, UrlChangeNotifySource>();
  // 与 GET /api/local/mutual-follows 同源：accepted friend_requests ∩ 本地仍 follows
  const peers = await listAcceptedMutualPeers(env, { limit: 200 });
  for (const peer of peers) {
    const url = normalizeFollowNodeUrl(peer.node_url);
    if (url) map.set(url, 'mutual');
  }
  return map;
}

async function collectDmTargets(env: Env): Promise<Map<string, UrlChangeNotifySource>> {
  const map = new Map<string, UrlChangeNotifySource>();
  if (!env.MESSAGING_DB) return map;
  try {
    const { results } = await env.MESSAGING_DB
      .prepare(`SELECT DISTINCT peer_worker_b_url FROM dm_messages`)
      .all<{ peer_worker_b_url: string }>();
    for (const row of results ?? []) {
      const url = normalizeFollowNodeUrl(row.peer_worker_b_url);
      if (url) map.set(url, 'dm');
    }
  } catch (err) {
    console.warn('[urlChangeNotify] 读 dm_messages 失败（可无表）', err);
  }
  return map;
}

/** M7-30-GROUP-URL：群主与同群成员节点（双保险；群内另有 system 广播） */
async function collectGroupTargets(env: Env): Promise<Map<string, UrlChangeNotifySource>> {
  const map = new Map<string, UrlChangeNotifySource>();
  if (!env.MESSAGING_DB) return map;
  try {
    const { results: owners } = await env.MESSAGING_DB
      .prepare(
        `SELECT DISTINCT owner_worker_b_url AS u FROM groups WHERE dissolved_at IS NULL`,
      )
      .all<{ u: string }>();
    for (const row of owners ?? []) {
      const url = normalizeFollowNodeUrl(row.u);
      if (url) map.set(url, 'group');
    }
    const { results: members } = await env.MESSAGING_DB
      .prepare(
        `SELECT DISTINCT member_worker_b_url AS u FROM group_members
          WHERE status IN ('active', 'pending')`,
      )
      .all<{ u: string }>();
    for (const row of members ?? []) {
      const url = normalizeFollowNodeUrl(row.u);
      if (url) map.set(url, 'group');
    }
  } catch (err) {
    console.warn('[urlChangeNotify] 读群目标失败', err);
  }
  return map;
}

/**
 * confirm 成功后装填 outbox（一次）。
 * 目标：互关 > 私信 > 群；不含单向关注与互动 actor。
 */
export async function enqueueUrlChangeNotifyJobs(
  env: Env,
  meta: UrlMoveNotifyMeta,
): Promise<{ enqueued: number }> {
  const event = await persistUrlMoveNotifyEnvelope(env, meta);
  if (!event) {
    console.warn('[urlChangeNotify] 信封未就绪，跳过装填');
    return { enqueued: 0 };
  }

  const oldUrl = normalizeFollowNodeUrl(meta.oldNodeUrl);
  const newUrl = normalizeFollowNodeUrl(meta.newNodeUrl);
  const exclude = new Set([oldUrl, newUrl].filter(Boolean));

  const merged = new Map<string, UrlChangeNotifySource>();
  const addAll = (src: Map<string, UrlChangeNotifySource>) => {
    for (const [url, source] of src) {
      if (exclude.has(url)) continue;
      const prev = merged.get(url);
      // 优先级：mutual > dm > group
      if (
        !prev ||
        (source === 'mutual' && prev !== 'mutual') ||
        (source === 'dm' && prev === 'group')
      ) {
        merged.set(url, source);
      }
    }
  };
  addAll(await collectMutualTargets(env));
  addAll(await collectDmTargets(env));
  addAll(await collectGroupTargets(env));

  const isoNow = new Date().toISOString();
  let enqueued = 0;
  // M-OPT-SPLIT-5c-6：url_change_notify_jobs 在 GOVERNANCE_DB（migration 0046）
  const governanceDb = resolveGovernanceDb(env);
  const stmts = [];
  for (const [target, source] of merged) {
    stmts.push(
      governanceDb.prepare(
        `INSERT OR IGNORE INTO url_change_notify_jobs
          (id, url_change_id, target_node_url, source, status, attempts, last_error, next_attempt_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'pending', 0, NULL, ?, ?, ?)`,
      ).bind(jobId(), meta.urlChangeId, target, source, isoNow, isoNow, isoNow),
    );
  }
  // D1 batch 上限约 100；超量分批
  for (let i = 0; i < stmts.length; i += 80) {
    const chunk = stmts.slice(i, i + 80);
    const result = await governanceDb.batch(chunk);
    for (const r of result) {
      if (r.meta.changes) enqueued += 1;
    }
  }

  console.log(
    `[urlChangeNotify] 装填 url_change_id=${meta.urlChangeId} targets=${merged.size} enqueued=${enqueued}`,
  );
  return { enqueued };
}

async function readConfigMap(
  env: Env,
  keys: string[],
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (keys.length === 0) return map;
  // M-OPT-SPLIT-5c-6：system_config 在 IDENTITY_DB
  const identityDb = resolveIdentityDb(env);
  const placeholders = keys.map(() => '?').join(',');
  const { results } = await identityDb
    .prepare(`SELECT key, value FROM system_config WHERE key IN (${placeholders})`)
    .bind(...keys)
    .all<{ key: string; value: string }>();
  for (const row of results ?? []) {
    map.set(row.key, row.value);
  }
  return map;
}

function parseStoredNotifyEvent(raw: string): NodeUrlChangedEvent | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const row = parsed as Record<string, unknown>;
    if (
      row.type !== 'node_url_changed' ||
      typeof row.from_handle !== 'string' ||
      typeof row.from_node_url_old !== 'string' ||
      typeof row.from_node_url_new !== 'string' ||
      typeof row.changed_at !== 'string' ||
      typeof row.grace_until !== 'string' ||
      typeof row.nonce !== 'string' ||
      typeof row.sig !== 'string'
    ) {
      return null;
    }
    return {
      type: 'node_url_changed',
      from_handle: row.from_handle.trim().toLowerCase(),
      from_node_url_old: normalizePublicBaseUrl(row.from_node_url_old),
      from_node_url_new: normalizePublicBaseUrl(row.from_node_url_new),
      changed_at: row.changed_at,
      grace_until: row.grace_until,
      nonce: row.nonce,
      sig: row.sig,
    };
  } catch {
    return null;
  }
}

/** @deprecated 仅兼容旧调用；投递请用 loadUrlChangeNotifyEventById */
export async function loadUrlChangeNotifyEvent(
  env: Env,
): Promise<NodeUrlChangedEvent | null> {
  const cfg = await readConfigMap(env, ['url_move_url_change_id']);
  const id = (cfg.get('url_move_url_change_id') ?? '').trim();
  if (!id) return null;
  return loadUrlChangeNotifyEventById(env, id);
}

/**
 * M7-30j-1：按 url_change_id 取固化信封。
 * 缺 events 行时，仅当 system_config 当前 url_change_id 一致才回落组装并回填。
 */
export async function loadUrlChangeNotifyEventById(
  env: Env,
  urlChangeId: string,
): Promise<NodeUrlChangedEvent | null> {
  const id = urlChangeId.trim();
  if (!id) return null;

  // M-OPT-SPLIT-5c-6：url_change_notify_events 在 IDENTITY_DB（migration 0048）
  const identityDb = resolveIdentityDb(env);

  try {
    const row = await identityDb
      .prepare(
        `SELECT event_json, grace_until FROM url_change_notify_events WHERE url_change_id = ? LIMIT 1`,
      )
      .bind(id)
      .first<{ event_json: string; grace_until: string }>();
    if (row?.event_json) {
      if (row.grace_until < new Date().toISOString()) {
        console.info(`[urlChangeNotify] url_change_id=${id} grace_until 已过`);
        return null;
      }
      return parseStoredNotifyEvent(row.event_json);
    }
  } catch (err) {
    console.warn('[urlChangeNotify] 读 url_change_notify_events 失败（表可能未迁移）', err);
  }

  // 兼容：仅当前全局 config 属于同一 url_change_id 时允许回落
  const cfg = await readConfigMap(env, [
    'url_move_url_change_id',
    'url_move_from_handle',
    'url_move_old_node_url',
    'url_move_new_node_url',
    'url_move_changed_at',
    'url_move_grace_until',
    'url_move_event_nonce',
    'url_move_event_sig',
  ]);
  if ((cfg.get('url_move_url_change_id') ?? '').trim() !== id) {
    return null;
  }
  const from_handle = (cfg.get('url_move_from_handle') ?? '').trim().toLowerCase();
  const from_node_url_old = normalizePublicBaseUrl(cfg.get('url_move_old_node_url') ?? '');
  const from_node_url_new = normalizePublicBaseUrl(cfg.get('url_move_new_node_url') ?? '');
  const changed_at = cfg.get('url_move_changed_at') ?? '';
  const grace_until = cfg.get('url_move_grace_until') ?? '';
  const nonce = cfg.get('url_move_event_nonce') ?? '';
  const sig = cfg.get('url_move_event_sig') ?? '';
  if (
    !from_handle ||
    !from_node_url_old ||
    !from_node_url_new ||
    !changed_at ||
    !grace_until ||
    !nonce ||
    !sig
  ) {
    return null;
  }
  if (grace_until < new Date().toISOString()) {
    return null;
  }
  const event: NodeUrlChangedEvent = {
    type: 'node_url_changed',
    from_handle,
    from_node_url_old,
    from_node_url_new,
    changed_at,
    grace_until,
    nonce,
    sig,
  };
  try {
    await identityDb
      .prepare(
        `INSERT OR REPLACE INTO url_change_notify_events
           (url_change_id, event_json, grace_until, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .bind(id, JSON.stringify(event), grace_until, new Date().toISOString())
      .run();
  } catch {
    /* 回填失败不阻断本次投递 */
  }
  return event;
}

async function markJob(
  env: Env,
  input: {
    id: string;
    status: string;
    attempts: number;
    lastError: string | null;
    nextAttemptAt: string | null;
  },
): Promise<void> {
  const isoNow = new Date().toISOString();
  // M-OPT-SPLIT-5c-6：url_change_notify_jobs 在 GOVERNANCE_DB（migration 0046）
  const governanceDb = resolveGovernanceDb(env);
  await governanceDb
    .prepare(
      `UPDATE url_change_notify_jobs
          SET status = ?, attempts = ?, last_error = ?, next_attempt_at = ?, lease_until = NULL, updated_at = ?
        WHERE id = ?`,
    )
    .bind(
      input.status,
      input.attempts,
      input.lastError,
      input.nextAttemptAt,
      isoNow,
      input.id,
    )
    .run();
}

/**
 * M7-30j-2：条件 UPDATE 抢占一条 job；changes===1 才算拿到。
 * 候选：due 的 pending/failed，或 lease 已过期的 processing。
 */
async function claimNotifyJob(
  env: Env,
  row: { id: string; attempts: number },
  nowIso: string,
  leaseUntil: string,
): Promise<boolean> {
  // M-OPT-SPLIT-5c-6：url_change_notify_jobs 在 GOVERNANCE_DB
  const governanceDb = resolveGovernanceDb(env);
  try {
    const result = await governanceDb
      .prepare(
        `UPDATE url_change_notify_jobs
            SET status = 'processing', lease_until = ?, updated_at = ?
          WHERE id = ?
            AND (
              (
                status IN ('pending', 'failed')
                AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
              )
              OR (
                status = 'processing'
                AND lease_until IS NOT NULL
                AND lease_until < ?
              )
            )`,
      )
      .bind(leaseUntil, nowIso, row.id, nowIso, nowIso)
      .run();
    return (result.meta.changes ?? 0) === 1;
  } catch (err) {
    console.warn('[urlChangeNotify] claim 失败', row.id, err);
    return false;
  }
}

/**
 * Cron：投递到期 pending/failed 任务，每轮 ≤ URL_CHANGE_NOTIFY_BATCH。
 * M7-30j-1：每条 job 按自身 url_change_id 取信封。
 * M7-30j-2：先 claim→processing+lease，再投递，防重叠 Cron 双发。
 */
export async function deliverUrlChangeNotifyJobs(env: Env): Promise<void> {
  const nowIso = new Date().toISOString();
  const leaseUntil = new Date(Date.now() + URL_CHANGE_NOTIFY_LEASE_MS).toISOString();
  let rows: Array<{
    id: string;
    url_change_id: string;
    target_node_url: string;
    attempts: number;
  }>;
  // M-OPT-SPLIT-5c-6：url_change_notify_jobs 在 GOVERNANCE_DB
  const governanceDb = resolveGovernanceDb(env);
  try {
    const { results } = await governanceDb
      .prepare(
        `SELECT id, url_change_id, target_node_url, attempts
           FROM url_change_notify_jobs
          WHERE (
              status IN ('pending', 'failed')
              AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
            )
            OR (
              status = 'processing'
              AND lease_until IS NOT NULL
              AND lease_until < ?
            )
          ORDER BY created_at ASC
          LIMIT ?`,
      )
      .bind(nowIso, nowIso, URL_CHANGE_NOTIFY_BATCH)
      .all<{
        id: string;
        url_change_id: string;
        target_node_url: string;
        attempts: number;
      }>();
    rows = results ?? [];
  } catch (err) {
    console.error('[urlChangeNotify] 查询 outbox 失败', err);
    return;
  }
  if (rows.length === 0) return;

  console.log(`[urlChangeNotify] 本轮候选 ${rows.length} 条`);

  // 同 url_change_id 复用已加载信封，避免 N 次 D1
  const eventCache = new Map<string, NodeUrlChangedEvent | null>();

  for (const row of rows) {
    const claimed = await claimNotifyJob(env, row, nowIso, leaseUntil);
    if (!claimed) continue;

    const changeId = String(row.url_change_id ?? '').trim();
    if (!changeId) {
      await markJob(env, {
        id: row.id,
        status: 'skipped',
        attempts: row.attempts,
        lastError: 'missing_url_change_id',
        nextAttemptAt: null,
      });
      continue;
    }

    let event: NodeUrlChangedEvent | null;
    if (eventCache.has(changeId)) {
      event = eventCache.get(changeId) ?? null;
    } else {
      event = await loadUrlChangeNotifyEventById(env, changeId);
      eventCache.set(changeId, event);
    }
    if (!event) {
      await markJob(env, {
        id: row.id,
        status: 'dead',
        attempts: row.attempts,
        lastError: 'event_snapshot_missing_or_expired',
        nextAttemptAt: null,
      });
      continue;
    }

    const target = normalizeFollowNodeUrl(row.target_node_url);
    const url = target
      ? resolveSafeOutboundPeerUrl(env, `${target}/api/node/events`)
      : null;
    if (!target || !url) {
      await markJob(env, {
        id: row.id,
        status: 'skipped',
        attempts: row.attempts,
        lastError: target ? 'unsafe_target' : 'empty_target',
        nextAttemptAt: null,
      });
      continue;
    }

    const body = JSON.stringify(event);
    let httpStatus = 0;
    let errMsg: string | null = null;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8_000);
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'User-Agent': OUTBOUND_PEER_UA,
          },
          body,
          signal: controller.signal,
          redirect: 'manual',
        });
        httpStatus = res.status;
        if (isManualRedirectStatus(res.status)) {
          errMsg = 'redirect_refused';
        } else if (!res.ok) {
          const text = await res.text().catch(() => '');
          errMsg = `http_${res.status}:${text.slice(0, 120)}`;
        }
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      errMsg = err instanceof Error ? err.message : String(err);
    }

    const attempts = row.attempts + 1;
    if (!errMsg && httpStatus >= 200 && httpStatus < 300) {
      await markJob(env, {
        id: row.id,
        status: 'sent',
        attempts,
        lastError: null,
        nextAttemptAt: null,
      });
      continue;
    }

    // 4xx（对端明确拒绝）或 3xx（拒绝跟随）→ dead；网络/5xx → 退避
    const permanent =
      isManualRedirectStatus(httpStatus) || (httpStatus >= 400 && httpStatus < 500);
    if (permanent || attempts >= MAX_ATTEMPTS) {
      await markJob(env, {
        id: row.id,
        status: 'dead',
        attempts,
        lastError: errMsg ?? `http_${httpStatus}`,
        nextAttemptAt: null,
      });
    } else {
      const next = new Date(
        Date.now() + backoffMinutes(attempts) * 60_000,
      ).toISOString();
      await markJob(env, {
        id: row.id,
        status: 'failed',
        attempts,
        lastError: errMsg ?? `http_${httpStatus}`,
        nextAttemptAt: next,
      });
    }
  }
}

/** M7-30f-5：Settings 换域宽限期 / 推送进度 */
export type UrlMoveNotifyCounts = {
  total: number;
  pending: number;
  sent: number;
  failed: number;
  dead: number;
  skipped: number;
};

export type UrlMoveStatusData = {
  active: boolean;
  url_change_id: string | null;
  from_handle: string | null;
  old_node_url: string | null;
  new_node_url: string | null;
  changed_at: string | null;
  grace_until: string | null;
  grace_active: boolean;
  days_remaining: number | null;
  /** 探测旧址 /health；未请求探测时为 null */
  old_route_reachable: boolean | null;
  notify: UrlMoveNotifyCounts;
  checklist: {
    /** 宽限期内必须保留旧路由 */
    keep_old_route_required: boolean;
    /** 宽限期已结束，可关旧入口 */
    may_close_old_route: boolean;
  };
};

async function probeOldRouteReachable(env: Env, oldUrl: string): Promise<boolean> {
  const base = normalizeFollowNodeUrl(oldUrl);
  const url = base ? resolveSafeOutboundPeerUrl(env, `${base}/health`) : null;
  if (!url) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': OUTBOUND_PEER_UA },
      signal: controller.signal,
      redirect: 'manual',
    });
    if (isManualRedirectStatus(res.status)) return false;
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 站主 Settings 读取换域宽限期与 outbox 汇总。
 * @param probeOld 为 true 时额外探测旧址 /health（+1 子请求）
 */
export async function getUrlMoveStatus(
  env: Env,
  options?: { probeOld?: boolean },
): Promise<UrlMoveStatusData> {
  const cfg = await readConfigMap(env, [
    'url_move_url_change_id',
    'url_move_from_handle',
    'url_move_old_node_url',
    'url_move_new_node_url',
    'url_move_changed_at',
    'url_move_grace_until',
  ]);

  const old_node_url = normalizePublicBaseUrl(cfg.get('url_move_old_node_url') ?? '') || null;
  const new_node_url = normalizePublicBaseUrl(cfg.get('url_move_new_node_url') ?? '') || null;
  const grace_until = cfg.get('url_move_grace_until') ?? null;
  const changed_at = cfg.get('url_move_changed_at') ?? null;
  const url_change_id = cfg.get('url_move_url_change_id') ?? null;
  const from_handle = (cfg.get('url_move_from_handle') ?? '').trim().toLowerCase() || null;

  const nowIso = new Date().toISOString();
  const grace_active = Boolean(grace_until && grace_until >= nowIso);
  const active = Boolean(old_node_url && new_node_url && grace_until);

  let days_remaining: number | null = null;
  if (grace_until) {
    const ms = Date.parse(grace_until) - Date.now();
    days_remaining = Number.isFinite(ms)
      ? Math.max(0, Math.ceil(ms / (24 * 60 * 60 * 1000)))
      : null;
  }

  const notify: UrlMoveNotifyCounts = {
    total: 0,
    pending: 0,
    sent: 0,
    failed: 0,
    dead: 0,
    skipped: 0,
  };

  try {
    // M-OPT-SPLIT-5c-6：url_change_notify_jobs 在 GOVERNANCE_DB
    const governanceDb = resolveGovernanceDb(env);
    const { results } = await governanceDb
      .prepare(
        `SELECT status, COUNT(*) AS cnt
           FROM url_change_notify_jobs
          GROUP BY status`,
      )
      .all<{ status: string; cnt: number }>();
    for (const row of results ?? []) {
      const n = Number(row.cnt) || 0;
      notify.total += n;
      if (row.status === 'pending' || row.status === 'processing') {
        notify.pending += n;
      } else if (row.status === 'sent') notify.sent = n;
      else if (row.status === 'failed') notify.failed = n;
      else if (row.status === 'dead') notify.dead = n;
      else if (row.status === 'skipped') notify.skipped = n;
    }
  } catch (err) {
    console.warn('[urlChangeNotify] 汇总 outbox 失败（表可能未迁移）', err);
  }

  let old_route_reachable: boolean | null = null;
  if (options?.probeOld && old_node_url) {
    old_route_reachable = await probeOldRouteReachable(env, old_node_url);
  }

  return {
    active,
    url_change_id,
    from_handle,
    old_node_url,
    new_node_url,
    changed_at,
    grace_until,
    grace_active,
    days_remaining,
    old_route_reachable,
    notify,
    checklist: {
      keep_old_route_required: grace_active,
      may_close_old_route: active && !grace_active,
    },
  };
}
