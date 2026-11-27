/**
 * 注册中心策略探测：GET /api/node/policy-digest（ETag/304）+ 变更时补拉公告/黑名单。
 */
import type { Env } from '../env';
import { resolveIdentityDb } from '../db/bindings';
import { registryFetch } from '../lib/registryFetch';
import { writeOperationLog } from '../lib/operationLog';
import {
  continueBlacklistKvBudgetSyncIfPending,
  syncRegistryBlacklistToKv,
} from './registryBlacklistSync';
import { pullRegistryOfficialFeedAfterRegistration } from './feedFetch';

const POLICY_DIGEST_PATH = '/api/node/policy-digest';
const CONFIG_POLICY_ETAG = 'registry_policy_digest_etag';
const CONFIG_POLICY_LAST_STATUS = 'registry_policy_poll_last_status';
const CONFIG_POLICY_LAST_AT = 'registry_policy_poll_last_at';
const CONFIG_POLICY_LAST_ERROR = 'registry_policy_poll_last_error';
const CONFIG_POLICY_POLL_INTERVAL_DAYS = 'policy_poll_interval_days';

async function readSystemConfig(env: Env, key: string): Promise<string> {
  // A-5c-3：system_config 在 IDENTITY_DB，先解析
  const identityDb = resolveIdentityDb(env);
  const row = await identityDb
    .prepare(`SELECT value FROM system_config WHERE key = ?1 LIMIT 1`)
    .bind(key)
    .first<{ value: string }>();
  return row?.value?.trim() ?? '';
}

async function writeSystemConfig(env: Env, key: string, value: string): Promise<void> {
  // A-5c-3：system_config 在 IDENTITY_DB，先解析
  const identityDb = resolveIdentityDb(env);
  const now = new Date().toISOString();
  await identityDb.prepare(
    `INSERT OR REPLACE INTO system_config (key, value, updated_at) VALUES (?, ?, ?)`,
  )
    .bind(key, value, now)
    .run();
}

async function writePolicyPollMeta(
  env: Env,
  status: 'ok' | 'not_modified' | 'failed',
  errorMessage: string | null,
): Promise<void> {
  // A-5c-3：system_config 在 IDENTITY_DB，先解析（batch 同事务保留）
  const identityDb = resolveIdentityDb(env);
  const now = new Date().toISOString();
  await identityDb.batch([
    identityDb.prepare(
      `INSERT OR REPLACE INTO system_config (key, value, updated_at) VALUES (?, ?, ?)`,
    ).bind(CONFIG_POLICY_LAST_STATUS, status, now),
    identityDb.prepare(
      `INSERT OR REPLACE INTO system_config (key, value, updated_at) VALUES (?, ?, ?)`,
    ).bind(CONFIG_POLICY_LAST_AT, now, now),
    identityDb.prepare(
      `INSERT OR REPLACE INTO system_config (key, value, updated_at) VALUES (?, ?, ?)`,
    ).bind(CONFIG_POLICY_LAST_ERROR, errorMessage ?? '', now),
  ]);
}

export interface RegistryPolicyPollDiagnostics {
  last_status: string | null;
  last_at: string | null;
  last_error: string | null;
  policy_etag: string | null;
  policy_poll_interval_days: number;
}

export async function readRegistryPolicyPollDiagnostics(
  env: Env,
): Promise<RegistryPolicyPollDiagnostics> {
  const [lastStatus, lastAt, lastError, etag, intervalRaw] = await Promise.all([
    readSystemConfig(env, CONFIG_POLICY_LAST_STATUS),
    readSystemConfig(env, CONFIG_POLICY_LAST_AT),
    readSystemConfig(env, CONFIG_POLICY_LAST_ERROR),
    readSystemConfig(env, CONFIG_POLICY_ETAG),
    readSystemConfig(env, CONFIG_POLICY_POLL_INTERVAL_DAYS),
  ]);
  const interval = Number.parseInt(intervalRaw, 10);
  return {
    last_status: lastStatus || null,
    last_at: lastAt || null,
    last_error: lastError || null,
    policy_etag: etag || null,
    policy_poll_interval_days: Number.isFinite(interval) && interval > 0 ? interval : 7,
  };
}

export type SyncRegistryPolicyOptions = {
  /** Settings 手动：忽略本地 etag 强制拉（仍发 If-None-Match 以便 304） */
  force?: boolean;
};

/**
 * 探测 policy-digest；200 时补拉黑名单 + 官方公告增量。
 */
export async function syncRegistryPolicyDigest(
  env: Env,
  opts: SyncRegistryPolicyOptions = {},
): Promise<{ status: 'not_modified' | 'updated' | 'failed'; message: string }> {
  const cachedEtag = await readSystemConfig(env, CONFIG_POLICY_ETAG);
  const headers: Record<string, string> = {};
  if (cachedEtag && !opts.force) {
    headers['If-None-Match'] = cachedEtag;
  }

  let res: Response;
  try {
    res = await registryFetch(env, POLICY_DIGEST_PATH, {
      method: 'GET',
      headers,
      profile: 'cron',
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await writePolicyPollMeta(env, 'failed', message);
    console.error('[cron/policy-digest] registryFetch 失败', message);
    return { status: 'failed', message };
  }

  if (res.status === 304) {
    await writePolicyPollMeta(env, 'not_modified', null);
    // B-2：策略未变也可能有黑名单 KV 分轮 pending，继续灌（不占新 Cron）
    try {
      await continueBlacklistKvBudgetSyncIfPending(env);
    } catch (err) {
      console.warn('[cron/policy-digest] pending 黑名单续灌失败', err);
    }
    console.info('[cron/policy-digest] 304 未变更');
    return { status: 'not_modified', message: '策略未变更' };
  }

  if (!res.ok) {
    const message = `HTTP ${res.status}`;
    await writePolicyPollMeta(env, 'failed', message);
    console.warn('[cron/policy-digest] 非 2xx', res.status);
    return { status: 'failed', message };
  }

  let policyVersion: number | null = null;
  let etag = res.headers.get('ETag')?.trim() ?? '';
  let pollInterval: number | undefined;
  try {
    const json = (await res.json()) as {
      ok?: boolean;
      data?: {
        policy_version?: number;
        etag?: string;
        policy_poll_interval_days?: number;
      };
    };
    if (json.ok !== true || typeof json.data?.policy_version !== 'number') {
      throw new Error('policy-digest 响应契约非法');
    }
    policyVersion = json.data.policy_version;
    if (json.data.etag?.trim()) etag = json.data.etag.trim();
    if (!etag) etag = `W/"policy:${policyVersion}"`;
    if (typeof json.data.policy_poll_interval_days === 'number') {
      pollInterval = Math.floor(json.data.policy_poll_interval_days);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await writePolicyPollMeta(env, 'failed', message);
    return { status: 'failed', message };
  }

  // 中文注释：版本变化后再打辅通道，避免无变更时浪费 feed/blacklist 配额
  try {
    await syncRegistryBlacklistToKv(env);
  } catch (err) {
    console.warn('[cron/policy-digest] 黑名单补拉失败', err);
  }
  try {
    await pullRegistryOfficialFeedAfterRegistration(env);
  } catch (err) {
    console.warn('[cron/policy-digest] 官方公告补拉失败', err);
  }

  await writeSystemConfig(env, CONFIG_POLICY_ETAG, etag);
  if (pollInterval === 1 || pollInterval === 2 || pollInterval === 3 || pollInterval === 7) {
    await writeSystemConfig(env, CONFIG_POLICY_POLL_INTERVAL_DAYS, String(pollInterval));
  }
  await writePolicyPollMeta(env, 'ok', null);
  await writeOperationLog(env, {
    source: 'worker-a',
    level: 'info',
    event: 'registry_policy_poll_ok',
    message: '注册中心 policy-digest 已更新并补拉',
    details: { policy_version: policyVersion, etag },
  }).catch(() => {});

  return { status: 'updated', message: '策略已更新' };
}
