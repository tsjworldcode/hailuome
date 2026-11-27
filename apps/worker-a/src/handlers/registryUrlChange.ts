/**
 * M7-30a：换域 precheck/confirm 与本地 D1/KV 同步。
 */
import type { Env } from '../env';
import {
  REGISTRY_PROOF_KV_TTL_SEC,
  REGISTRY_URL_CHANGE_PROOF_KV_KEY,
} from '@hailuo/shared-types';
import { resolveGovernanceDb, resolveIdentityDb } from '../db/bindings';
import { syncPublicProfileWorkerBUrl } from './publicProfileKv';
import { syncRegistryEndpointsToKv } from './registryEndpointsKvSync';
import {
  readRegistryEndpoints,
  saveRegistryEndpoints,
  type RegistryEndpoint,
} from '../lib/registryEndpoints';
import { invalidateLocalPublicBaseUrlCache, resolveLocalPublicBaseUrl } from '../lib/localPublicBaseUrl';
import { writeNodeUrlMovedKv } from '../lib/nodeUrlMoved';
import { enqueueUrlChangeNotifyJobs } from '../lib/urlChangeNotify';
import { applyGroupUrlMigration } from '../lib/groupUrlMigrate';
import { announceGroupUrlChangeAfterConfirm } from '../lib/groupUrlChangeAnnounce';

export interface UrlChangePrecheckBody {
  new_node_url: string;
  new_worker_b_url: string;
}

export interface UrlChangeConfirmBody {
  url_change_id: string;
  /** precheck 返回的 nonce；JWT 鉴权下 Worker A 可代为 Ed25519 签名 */
  nonce?: string;
  /** 可选：外部已签好的 registry base64 签名 */
  signature?: string;
  /**
   * M7-30f-1：L3 step-up（必填）。
   * password_hash 与登录同形；若站主已启用 TOTP 则 totp_code 必填。
   */
  step_up?: {
    password_hash?: string;
    totp_code?: string;
  };
}

export interface UrlChangePrecheckRegistryData {
  url_change_id: string;
  nonce: string;
  expires_at: string;
  new_node_url: string;
  new_worker_b_url: string;
}

export interface UrlChangeConfirmRegistryData {
  user_id: string;
  node_url: string;
  worker_b_url: string;
  changed_at: string;
}

/** 将 `<url_change_id>.<nonce>` 写入独立 KV key，供新 URL 上 Worker B proof 端点暴露。 */
export async function syncUrlChangeProofToKv(
  env: Env,
  data: Pick<UrlChangePrecheckRegistryData, 'url_change_id' | 'nonce'>,
): Promise<void> {
  const body = `${data.url_change_id}.${data.nonce}`;
  await env.STATE_KV.put(REGISTRY_URL_CHANGE_PROOF_KV_KEY, body, {
    expirationTtl: REGISTRY_PROOF_KV_TTL_SEC,
  });
}

/** confirm 成功后清理 url_change proof KV。 */
export async function clearUrlChangeProofKv(env: Env): Promise<void> {
  await env.STATE_KV.delete(REGISTRY_URL_CHANGE_PROOF_KV_KEY).catch((err) => {
    console.error('[registryUrlChange] url_change proof KV 清理失败', err);
  });
}

/** 备用 registry_endpoints[1..] 标记 url 未同步（Phase 1 不自动换域）。 */
export async function markBackupRegistryEndpointsUrlStale(env: Env): Promise<void> {
  // A-5c-2：registry_endpoints 表在 GOVERNANCE_DB
  const governanceDb = resolveGovernanceDb(env);
  const endpoints = await readRegistryEndpoints(governanceDb);
  if (endpoints.length <= 1) return;

  const nowIso = new Date().toISOString();
  let changed = false;
  const updated: RegistryEndpoint[] = endpoints.map((endpoint, index) => {
    if (index === 0) return endpoint;
    if (endpoint.url_sync_state === 'stale') return endpoint;
    changed = true;
    return { ...endpoint, url_sync_state: 'stale' as const };
  });
  if (!changed) return;
  await saveRegistryEndpoints(env, governanceDb, updated, nowIso);
}

/** confirm 成功后同步本地 users、system_config、公开 KV、迁址声明与 registry_endpoints KV。 */
export async function syncLocalAfterUrlChangeConfirm(
  env: Env,
  data: Pick<UrlChangeConfirmRegistryData, 'node_url' | 'worker_b_url'> & {
    /** M7-30f-4：装填 outbox 用 */
    url_change_id?: string;
  },
): Promise<void> {
  // 必须在覆盖 D1 之前记下旧公开基址，供粉丝侧旧址发现
  const oldNodeUrl = await resolveLocalPublicBaseUrl(env);

  const isoNow = new Date().toISOString();
  const workerBUrl = data.worker_b_url;
  const nodeUrl = data.node_url;

  // A-5c-2：users + system_config 都在 IDENTITY_DB；本步 batch 全是单库，可保留 batch 形式
  const identityDb = resolveIdentityDb(env);
  await identityDb.batch([
    identityDb.prepare(
      `UPDATE users SET worker_b_url = ? WHERE rowid = (SELECT rowid FROM users LIMIT 1)`,
    ).bind(workerBUrl),
    identityDb.prepare(
      `INSERT OR REPLACE INTO system_config (key, value, updated_at) VALUES ('worker_b_url', ?, ?)`,
    ).bind(workerBUrl, isoNow),
    identityDb.prepare(
      `INSERT OR REPLACE INTO system_config (key, value, updated_at) VALUES ('node_url', ?, ?)`,
    ).bind(nodeUrl, isoNow),
  ]);

  // M7-30-GROUP-URL：本机群表旧址 → 新址（fail-soft）
  try {
    await applyGroupUrlMigration(env, oldNodeUrl, workerBUrl);
  } catch (err) {
    console.error('[registryUrlChange] groupUrlMigrate 失败', err);
  }

  // M7-30g-1：D1 已是新公开基址，立刻丢掉 isolate 缓存，避免最多 60s 旧 env/旧 D1 值
  invalidateLocalPublicBaseUrlCache();

  await markBackupRegistryEndpointsUrlStale(env);
  await syncPublicProfileWorkerBUrl(env, workerBUrl);
  await syncRegistryEndpointsToKv(env);
  await clearUrlChangeProofKv(env);

  // M7-30f-2：旧址迁址声明（1 次 KV put）；失败不影响 confirm 主路径
  let movedMeta: Awaited<ReturnType<typeof writeNodeUrlMovedKv>> = null;
  try {
    movedMeta = await writeNodeUrlMovedKv(env, { oldNodeUrl, newNodeUrl: nodeUrl });
  } catch (err) {
    console.error('[registryUrlChange] node:url-moved 写入失败', err);
  }

  // M7-30f-4：已知联系人 outbox（D1）；失败不影响 confirm
  const urlChangeId = data.url_change_id?.trim() ?? '';
  if (movedMeta && urlChangeId) {
    try {
      await enqueueUrlChangeNotifyJobs(env, {
        urlChangeId,
        oldNodeUrl: movedMeta.oldNodeUrl,
        newNodeUrl: movedMeta.newNodeUrl,
        changedAt: movedMeta.changedAt,
        graceUntil: movedMeta.graceUntil,
        handle: movedMeta.handle,
      });
    } catch (err) {
      console.error('[registryUrlChange] url_change_notify outbox 装填失败', err);
    }

    // M7-30-GROUP-URL：所在群广播（fail-soft）
    try {
      await announceGroupUrlChangeAfterConfirm(env, {
        urlChangeId,
        oldNodeUrl: movedMeta.oldNodeUrl,
        newNodeUrl: movedMeta.newNodeUrl,
        changedAt: movedMeta.changedAt,
        graceUntil: movedMeta.graceUntil,
        handle: movedMeta.handle,
      });
    } catch (err) {
      console.error('[registryUrlChange] groupUrlChange 广播失败', err);
    }
  }
}
