/**
 * M6-4 / M-DS-1 / R-AUDIT-SEP-B：注册中心 & 联邦黑名单 → STATE_KV。
 *
 * 生产口径（B-2）：
 *   - 每轮 put+delete 上限 BLACKLIST_KV_WRITE_BUDGET（默认 100），避免冷启动打穿 Free 1K/天
 *   - 未灌完：不提交最终 etag；写 pending；既有 Cron（sync-blacklist-kv）继续灌
 *   - 联邦默认 enforce（显式 false 才关）；禁止改成单 JSON blob
 */

import {
  BLACKLIST_KV_FEDERATED_PREFIX,
  BLACKLIST_KV_REGISTRY_PREFIX,
  blacklistFederatedKey,
  blacklistRegistryKey,
} from '@hailuo/shared-utils';
import type { Env } from '../env';
import { registryFetch } from '../lib/registryFetch';
import { resolveIdentityDb } from '../db/bindings';

export interface RegistryBlacklistItem {
  worker_b_url: string;
  reason: string;
  blocked_at: string;
  updated_at: string;
}

interface BlacklistKvValue {
  reason: string;
  created_at: string;
  source: 'registry';
}

/** 每轮 KV 写（put+delete）默认上限；可用 env.BLACKLIST_KV_WRITE_BUDGET 覆盖。 */
export const DEFAULT_BLACKLIST_KV_WRITE_BUDGET = 100;

const CONFIG_REGISTRY_PENDING = 'blacklist_remote_sync_pending';
const CONFIG_FEDERATED_PENDING = 'federated_blacklist_sync_pending';
const CONFIG_FEDERATED_PENDING_PAYLOAD = 'federated_blacklist_sync_pending_payload';

type FederatedPendingItem = {
  worker_b_url: string;
  did_v2?: string | null;
  reason?: string | null;
};

type FederatedPendingPayload = {
  etag?: string | null;
  cert_epoch?: number | null;
  items: FederatedPendingItem[];
};

function isoNow(): string {
  return new Date().toISOString();
}

/**
 * 生产默认开启联邦黑名单 enforce；仅显式 false/0/off 关闭（紧急逃生）。
 * enforce_hint=true 时强制开启。
 */
export function isFederationBlacklistEnforceEnabled(
  env: Env,
  enforceHint?: boolean,
): boolean {
  if (enforceHint === true) return true;
  const raw = env.FEDERATION_BLACKLIST_ENFORCE?.trim().toLowerCase();
  if (raw === 'false' || raw === '0' || raw === 'off') return false;
  return true;
}

/** 解析每轮写预算；非法值回落默认；硬顶 500 防误配一次打穿。 */
export function resolveBlacklistKvWriteBudget(env: Env): number {
  const raw = env.BLACKLIST_KV_WRITE_BUDGET?.trim();
  if (!raw) return DEFAULT_BLACKLIST_KV_WRITE_BUDGET;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_BLACKLIST_KV_WRITE_BUDGET;
  return Math.min(n, 500);
}

/**
 * 纯函数：本轮从 toPut / toDelete 各取多少（优先 put，剩余预算给 delete）。
 * 供契约测与仿真共用语义。
 */
export function sliceBlacklistKvBudget(
  toPutLen: number,
  toDeleteLen: number,
  budget: number,
): { putTake: number; deleteTake: number; complete: boolean } {
  const safeBudget = Math.max(0, budget);
  const putTake = Math.min(Math.max(0, toPutLen), safeBudget);
  const deleteTake = Math.min(Math.max(0, toDeleteLen), Math.max(0, safeBudget - putTake));
  return {
    putTake,
    deleteTake,
    complete: putTake === toPutLen && deleteTake === toDeleteLen,
  };
}

async function readSystemConfig(env: Env, key: string): Promise<string> {
  const row = await resolveIdentityDb(env)
    .prepare(`SELECT value FROM system_config WHERE key = ?1 LIMIT 1`)
    .bind(key)
    .first<{ value: string }>();
  return row?.value ?? '';
}

async function upsertSystemConfig(env: Env, key: string, value: string): Promise<void> {
  const now = isoNow();
  await resolveIdentityDb(env)
    .prepare(
      `INSERT INTO system_config (key, value, updated_at) VALUES (?1, ?2, ?3)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .bind(key, value, now)
    .run();
}

async function writeRemoteSyncMeta(env: Env, etag: string, syncedAt: string): Promise<void> {
  // system_config 在 IDENTITY_DB（A-2 §0090 汇总），跨 binding 不能 batch，
  // 拆顺序两步：etag → last_sync_at；任一失败 catch 兜底，幂等回滚。
  const identityDb = resolveIdentityDb(env);
  await identityDb
    .prepare(`UPDATE system_config SET value = ?1, updated_at = ?2 WHERE key = 'blacklist_remote_etag'`)
    .bind(etag, syncedAt)
    .run();
  await identityDb
    .prepare(
      `UPDATE system_config SET value = ?1, updated_at = ?2 WHERE key = 'blacklist_remote_last_sync_at'`,
    )
    .bind(syncedAt, syncedAt)
    .run();
}

async function isRegistrySyncPending(env: Env): Promise<boolean> {
  return (await readSystemConfig(env, CONFIG_REGISTRY_PENDING)).trim() === 'true';
}

async function setRegistrySyncPending(env: Env, pending: boolean): Promise<void> {
  await upsertSystemConfig(env, CONFIG_REGISTRY_PENDING, pending ? 'true' : 'false');
}

async function isFederatedSyncPending(env: Env): Promise<boolean> {
  return (await readSystemConfig(env, CONFIG_FEDERATED_PENDING)).trim() === 'true';
}

async function setFederatedSyncPending(
  env: Env,
  pending: boolean,
  payload: FederatedPendingPayload | null,
): Promise<void> {
  await upsertSystemConfig(env, CONFIG_FEDERATED_PENDING, pending ? 'true' : 'false');
  await upsertSystemConfig(
    env,
    CONFIG_FEDERATED_PENDING_PAYLOAD,
    pending && payload ? JSON.stringify(payload) : '',
  );
}

async function listRegistryBlacklistKvKeys(env: Env): Promise<Set<string>> {
  const keys = new Set<string>();
  let cursor: string | undefined;
  do {
    const page: KVNamespaceListResult<unknown, string> = await env.STATE_KV.list({
      prefix: BLACKLIST_KV_REGISTRY_PREFIX,
      cursor,
    });
    for (const k of page.keys) keys.add(k.name);
    if (page.list_complete) break;
    cursor = page.cursor;
  } while (cursor);
  return keys;
}

async function listFederatedBlacklistKvKeys(env: Env): Promise<Set<string>> {
  const keys = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await env.STATE_KV.list({ prefix: BLACKLIST_KV_FEDERATED_PREFIX, cursor });
    for (const k of page.keys) keys.add(k.name);
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return keys;
}

type KvPutItem = { key: string; value: string };

async function applyKvDiffWithBudget(
  env: Env,
  toPut: KvPutItem[],
  toDelete: string[],
  budget: number,
  logTag: string,
): Promise<{
  complete: boolean;
  putAttempted: number;
  deleteAttempted: number;
  putRemaining: number;
  deleteRemaining: number;
  failures: number;
}> {
  const { putTake, deleteTake } = sliceBlacklistKvBudget(toPut.length, toDelete.length, budget);
  const putSlice = toPut.slice(0, putTake);
  const deleteSlice = toDelete.slice(0, deleteTake);

  let failures = 0;
  if (putSlice.length > 0) {
    const results = await Promise.allSettled(
      putSlice.map((row) => env.STATE_KV.put(row.key, row.value)),
    );
    for (const r of results) {
      if (r.status === 'rejected') {
        failures++;
        console.error(`[${logTag}] KV put 失败`, r.reason);
      }
    }
  }
  if (deleteSlice.length > 0) {
    const results = await Promise.allSettled(deleteSlice.map((key) => env.STATE_KV.delete(key)));
    for (const r of results) {
      if (r.status === 'rejected') {
        failures++;
        console.error(`[${logTag}] KV delete 失败`, r.reason);
      }
    }
  }

  const putRemaining = toPut.length - putSlice.length;
  const deleteRemaining = toDelete.length - deleteSlice.length;
  const complete = putRemaining === 0 && deleteRemaining === 0 && failures === 0;
  return {
    complete,
    putAttempted: putSlice.length,
    deleteAttempted: deleteSlice.length,
    putRemaining,
    deleteRemaining,
    failures,
  };
}

async function syncRegistryBlacklistItemsToKv(
  env: Env,
  items: RegistryBlacklistItem[],
  etagToStore: string,
): Promise<boolean> {
  let kvKeys: Set<string>;
  try {
    kvKeys = await listRegistryBlacklistKvKeys(env);
  } catch (err) {
    console.error('[cron/registry-blacklist-sync] KV LIST 失败', err);
    return false;
  }

  const remoteKeySet = new Set<string>();
  const toPut: KvPutItem[] = [];
  for (const row of items) {
    const fullKey = blacklistRegistryKey(row.worker_b_url);
    remoteKeySet.add(fullKey);
    if (!kvKeys.has(fullKey)) {
      const value: BlacklistKvValue = {
        reason: row.reason,
        created_at: row.blocked_at,
        source: 'registry',
      };
      toPut.push({ key: fullKey, value: JSON.stringify(value) });
    }
  }

  const toDelete: string[] = [];
  for (const kvKey of kvKeys) {
    if (!remoteKeySet.has(kvKey)) {
      toDelete.push(kvKey);
    }
  }

  const budget = resolveBlacklistKvWriteBudget(env);
  const applied = await applyKvDiffWithBudget(
    env,
    toPut,
    toDelete,
    budget,
    'cron/registry-blacklist-sync',
  );

  if (!applied.complete) {
    try {
      await setRegistrySyncPending(env, true);
    } catch (err) {
      console.error('[cron/registry-blacklist-sync] 写 pending 失败', err);
    }
    console.log(
      `[cron/registry-blacklist-sync] 分轮未完成：put=${applied.putAttempted} delete=${applied.deleteAttempted} rem_put=${applied.putRemaining} rem_del=${applied.deleteRemaining} budget=${budget} fail=${applied.failures}（保留旧 etag）`,
    );
    return false;
  }

  const now = isoNow();
  try {
    await writeRemoteSyncMeta(env, etagToStore, now);
    await setRegistrySyncPending(env, false);
  } catch (err) {
    console.error('[cron/registry-blacklist-sync] 更新 remote etag / 清 pending 失败', err);
    return false;
  }

  console.log(
    `[cron/registry-blacklist-sync] 同步完成：put=${applied.putAttempted} delete=${applied.deleteAttempted} remote=${items.length} kv_before=${kvKeys.size}`,
  );
  return true;
}

async function syncFederatedBlacklistItemsToKv(
  env: Env,
  items: FederatedPendingItem[],
  meta: { etag?: string | null; cert_epoch?: number | null },
): Promise<boolean> {
  let existing: Set<string>;
  try {
    existing = await listFederatedBlacklistKvKeys(env);
  } catch (err) {
    console.error('[cron/daily-sync/federated_blacklist] KV list 失败', err);
    return false;
  }

  const now = isoNow();
  const want = new Map<string, string>();
  for (const row of items) {
    const url = row.worker_b_url.replace(/\/$/, '');
    want.set(
      blacklistFederatedKey(url),
      JSON.stringify({
        reason: row.reason ?? 'federated',
        created_at: now,
        source: 'federated',
        did_v2: row.did_v2 ?? null,
      }),
    );
  }

  const toPut: KvPutItem[] = [];
  for (const [key, value] of want) {
    if (!existing.has(key)) {
      toPut.push({ key, value });
    }
  }
  const toDelete: string[] = [];
  for (const key of existing) {
    if (!want.has(key)) toDelete.push(key);
  }

  const budget = resolveBlacklistKvWriteBudget(env);
  const applied = await applyKvDiffWithBudget(
    env,
    toPut,
    toDelete,
    budget,
    'cron/daily-sync/federated_blacklist',
  );

  if (!applied.complete) {
    try {
      await setFederatedSyncPending(env, true, {
        etag: meta.etag ?? null,
        cert_epoch: meta.cert_epoch ?? null,
        items,
      });
    } catch (err) {
      console.error('[cron/daily-sync/federated_blacklist] 写 pending 失败', err);
    }
    console.log(
      `[cron/daily-sync/federated_blacklist] 分轮未完成：put=${applied.putAttempted} delete=${applied.deleteAttempted} rem_put=${applied.putRemaining} rem_del=${applied.deleteRemaining} budget=${budget} fail=${applied.failures}`,
    );
    return false;
  }

  try {
    await setFederatedSyncPending(env, false, null);
  } catch (err) {
    console.warn('[cron/daily-sync/federated_blacklist] 清 pending 失败', err);
  }
  console.log(
    `[cron/daily-sync/federated_blacklist] enforce 同步完成 put=${applied.putAttempted} delete=${applied.deleteAttempted}`,
  );
  return true;
}

/** M-DS-1：从 daily-sync blacklist 块落库（不经独立 GET /api/blacklist）。 */
export async function applyRegistryBlacklistFromDailySync(
  env: Env,
  block: {
    unchanged?: boolean;
    etag?: string;
    items?: RegistryBlacklistItem[];
  },
): Promise<void> {
  if (block.unchanged) {
    // B-2：etag 未变但分轮可能未灌完 → 强制续拉，不能只刷 last_sync_at
    if (await isRegistrySyncPending(env)) {
      console.log('[cron/daily-sync/blacklist] unchanged 但 pending，续灌 KV');
      await syncRegistryBlacklistToKv(env);
      return;
    }
    const etag = block.etag?.trim() ?? '';
    if (etag) {
      try {
        await writeRemoteSyncMeta(env, etag, isoNow());
      } catch (err) {
        console.warn('[cron/daily-sync/blacklist] 304 等价更新 last_sync_at 失败', err);
      }
    }
    console.log('[cron/daily-sync/blacklist] unchanged，跳过 KV 写');
    return;
  }

  const items = Array.isArray(block.items)
    ? block.items.filter(
        (row) => typeof row.worker_b_url === 'string' && row.worker_b_url.startsWith('https://'),
      )
    : [];
  const etag = block.etag?.trim() ?? (await readSystemConfig(env, 'blacklist_remote_etag'));
  await syncRegistryBlacklistItemsToKv(env, items, etag);
}

/** M9-3-CL3 / 生产：daily-sync 联邦黑名单；默认 enforce 写 STATE_KV。 */
export async function applyFederatedBlacklistFromDailySync(
  env: Env,
  block: {
    etag?: string;
    cert_epoch?: number | null;
    enforce_hint?: boolean;
    items?: Array<{ worker_b_url: string; did_v2?: string | null; reason?: string | null }>;
  },
): Promise<void> {
  const items = Array.isArray(block.items)
    ? block.items.filter(
        (row) => typeof row.worker_b_url === 'string' && row.worker_b_url.startsWith('https://'),
      )
    : [];
  const now = isoNow();
  const snapshot = JSON.stringify({
    etag: block.etag ?? null,
    cert_epoch: block.cert_epoch ?? null,
    item_count: items.length,
    updated_at: now,
  });
  try {
    // system_config 在 IDENTITY_DB（A-2 §0090 汇总）。
    await resolveIdentityDb(env)
      .prepare(
        `INSERT INTO system_config (key, value, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .bind('federated_blacklist_snapshot', snapshot, now)
      .run();
  } catch (err) {
    console.warn('[cron/daily-sync/federated_blacklist] 写 snapshot 失败', err);
  }

  if (!isFederationBlacklistEnforceEnabled(env, block.enforce_hint)) {
    console.log(
      `[cron/daily-sync/federated_blacklist] enforce 已显式关闭：items=${items.length}（未写 KV）`,
    );
    return;
  }

  // R-AUDIT-SEP-B1：缺 key 才 put；B-2：按预算截断，未完写入 pending 供 Cron 续灌。
  await syncFederatedBlacklistItemsToKv(env, items, {
    etag: block.etag ?? null,
    cert_epoch: block.cert_epoch ?? null,
  });
}

/**
 * B-2：既有 Cron 挂载点 — 若 registry/federated 分轮未完成则继续灌。
 * 不新开 Cron 表达式；挂在 sync-blacklist-kv 同分钟门控。
 */
export async function continueBlacklistKvBudgetSyncIfPending(env: Env): Promise<void> {
  if (await isRegistrySyncPending(env)) {
    console.log('[cron/blacklist-kv-budget] registry pending → 续灌');
    await syncRegistryBlacklistToKv(env);
  }
  if (await isFederatedSyncPending(env)) {
    console.log('[cron/blacklist-kv-budget] federated pending → 续灌');
    const raw = await readSystemConfig(env, CONFIG_FEDERATED_PENDING_PAYLOAD);
    if (!raw.trim()) {
      console.warn('[cron/blacklist-kv-budget] federated pending 但 payload 空，清 pending');
      await setFederatedSyncPending(env, false, null);
      return;
    }
    let payload: FederatedPendingPayload;
    try {
      payload = JSON.parse(raw) as FederatedPendingPayload;
    } catch (err) {
      console.error('[cron/blacklist-kv-budget] federated payload 非法', err);
      await setFederatedSyncPending(env, false, null);
      return;
    }
    const items = Array.isArray(payload.items)
      ? payload.items.filter(
          (row) => typeof row.worker_b_url === 'string' && row.worker_b_url.startsWith('https://'),
        )
      : [];
    await syncFederatedBlacklistItemsToKv(env, items, {
      etag: payload.etag ?? null,
      cert_epoch: payload.cert_epoch ?? null,
    });
  }
}

/** 注册中心全局黑名单同步主入口（独立 GET；M-DS-1 后主路径 daily-sync；pending 续灌 / policy-digest 补拉）。 */
export async function syncRegistryBlacklistToKv(env: Env): Promise<void> {
  let cachedEtag = '';
  try {
    cachedEtag = await readSystemConfig(env, 'blacklist_remote_etag');
  } catch (err) {
    console.error('[cron/registry-blacklist-sync] 读 blacklist_remote_etag 失败', err);
    return;
  }

  const pending = await isRegistrySyncPending(env);
  const headers: Record<string, string> = {};
  // B-2：pending 时禁止 If-None-Match，否则 304 会跳过未灌完的 diff
  if (!pending && cachedEtag.trim()) {
    headers['If-None-Match'] = cachedEtag.trim();
  }

  let res: Response;
  try {
    res = await registryFetch(env, '/api/blacklist', { headers, profile: 'cron' });
  } catch (err) {
    console.error('[cron/registry-blacklist-sync] registryFetch 失败', err);
    return;
  }

  const responseEtag = res.headers.get('ETag')?.trim() ?? '';

  if (res.status === 304) {
    if (pending) {
      // 理论上 pending 不会带 If-None-Match；兜底再打一轮无条件拉取
      console.warn('[cron/registry-blacklist-sync] pending 下收到 304，改强制拉取');
      try {
        res = await registryFetch(env, '/api/blacklist', { headers: {}, profile: 'cron' });
      } catch (err) {
        console.error('[cron/registry-blacklist-sync] 强制拉取失败', err);
        return;
      }
    } else {
      if (responseEtag) {
        try {
          await writeRemoteSyncMeta(env, responseEtag, isoNow());
        } catch (err) {
          console.warn('[cron/registry-blacklist-sync] 304 后更新 last_sync_at 失败', err);
        }
      }
      console.log('[cron/registry-blacklist-sync] 304 未变更，跳过 KV 写');
      return;
    }
  }

  if (!res.ok) {
    console.error('[cron/registry-blacklist-sync] 非 2xx', res.status);
    return;
  }

  let items: RegistryBlacklistItem[] = [];
  try {
    const json = (await res.json()) as {
      ok?: boolean;
      data?: { items?: RegistryBlacklistItem[] };
    };
    if (json.ok !== true || !Array.isArray(json.data?.items)) {
      console.error('[cron/registry-blacklist-sync] 响应契约非法');
      return;
    }
    items = json.data.items.filter(
      (row) => typeof row.worker_b_url === 'string' && row.worker_b_url.startsWith('https://'),
    );
  } catch (err) {
    console.error('[cron/registry-blacklist-sync] 解析 JSON 失败', err);
    return;
  }

  const etagToStore = responseEtag || cachedEtag;
  await syncRegistryBlacklistItemsToKv(env, items, etagToStore);
}
