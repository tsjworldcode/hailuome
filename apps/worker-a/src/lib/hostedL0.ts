/**
 * M9-8：托管 L0 状态、隐私同意与账号删除（D1 system_config，无 KV 写）。
 */

import {
  buildHostedL0PrivacyDocument,
  HOSTED_L0_ACCOUNT_DELETE_CONFIRM_PHRASE,
  HOSTED_L0_DATA_RETENTION_DAYS,
  HOSTED_L0_PRIVACY_VERSION,
  isHostedL0ModeEnabled,
  nowISO,
  type DeploymentMode,
} from '@hailuo/shared-utils';
import { NODE_EXPORT_TABLES } from './nodeExportImport';

const PRIVACY_VERSION_KEY = 'hosted_l0_privacy_version';
const PRIVACY_ACCEPTED_AT_KEY = 'hosted_l0_privacy_accepted_at';
const ACCOUNT_DELETED_AT_KEY = 'account_deleted_at';

export interface HostedL0Status {
  deployment_mode: DeploymentMode;
  hosted_l0_enabled: boolean;
  operator_label: string;
  privacy_version: string;
  privacy_accepted: boolean;
  privacy_accepted_at: string | null;
  data_retention_days: number;
  export_available: boolean;
  account_deleted: boolean;
  account_deleted_at: string | null;
  requires_privacy_acceptance: boolean;
}

export interface AccountDeleteResult {
  deleted_tables: Record<string, number>;
  skipped_tables: string[];
  account_deleted_at: string;
  operator_steps: string[];
}

async function readConfigMap(
  db: D1Database,
  keys: readonly string[],
): Promise<Map<string, string>> {
  if (keys.length === 0) return new Map();
  const placeholders = keys.map(() => '?').join(', ');
  const res = await db
    .prepare(`SELECT key, value FROM system_config WHERE key IN (${placeholders})`)
    .bind(...keys)
    .all<{ key: string; value: string }>();
  const map = new Map<string, string>();
  for (const row of res.results ?? []) {
    map.set(row.key, row.value);
  }
  return map;
}

function resolveDeploymentMode(env: { HOSTED_L0_MODE?: string }): DeploymentMode {
  return isHostedL0ModeEnabled(env.HOSTED_L0_MODE) ? 'hosted_l0' : 'self_hosted';
}

export async function getHostedL0Status(
  db: D1Database,
  env: { HOSTED_L0_MODE?: string; HOSTED_L0_OPERATOR_LABEL?: string },
): Promise<HostedL0Status> {
  const deployment_mode = resolveDeploymentMode(env);
  const hosted_l0_enabled = deployment_mode === 'hosted_l0';
  const cfg = await readConfigMap(db, [
    PRIVACY_VERSION_KEY,
    PRIVACY_ACCEPTED_AT_KEY,
    ACCOUNT_DELETED_AT_KEY,
  ]);

  const privacyVersion = cfg.get(PRIVACY_VERSION_KEY)?.trim() ?? '';
  const privacyAcceptedAt = cfg.get(PRIVACY_ACCEPTED_AT_KEY)?.trim() ?? '';
  const accountDeletedAt = cfg.get(ACCOUNT_DELETED_AT_KEY)?.trim() ?? '';
  const privacyAccepted =
    privacyVersion === HOSTED_L0_PRIVACY_VERSION && privacyAcceptedAt.length > 0;

  return {
    deployment_mode,
    hosted_l0_enabled,
    operator_label: env.HOSTED_L0_OPERATOR_LABEL?.trim() || '海螺托管试用',
    privacy_version: HOSTED_L0_PRIVACY_VERSION,
    privacy_accepted: privacyAccepted,
    privacy_accepted_at: privacyAccepted ? privacyAcceptedAt : null,
    data_retention_days: HOSTED_L0_DATA_RETENTION_DAYS,
    export_available: true,
    account_deleted: accountDeletedAt.length > 0,
    account_deleted_at: accountDeletedAt || null,
    requires_privacy_acceptance: hosted_l0_enabled && !privacyAccepted,
  };
}

export function getHostedL0PrivacyDeclaration() {
  return buildHostedL0PrivacyDocument();
}

export async function acceptHostedL0Privacy(
  db: D1Database,
  env: { HOSTED_L0_MODE?: string },
  body: unknown,
): Promise<{ privacy_version: string; privacy_accepted_at: string }> {
  if (!isHostedL0ModeEnabled(env.HOSTED_L0_MODE)) {
    throw new Error('HOSTED_L0_NOT_ENABLED');
  }

  const version =
    body != null && typeof body === 'object' && !Array.isArray(body)
      ? String((body as Record<string, unknown>).privacy_version ?? '').trim()
      : '';
  if (version && version !== HOSTED_L0_PRIVACY_VERSION) {
    throw new Error('HOSTED_L0_PRIVACY_VERSION_MISMATCH');
  }

  const accepted = nowISO();
  await db.batch([
    db
      .prepare(`INSERT OR REPLACE INTO system_config(key, value, updated_at) VALUES(?, ?, ?)`)
      .bind(PRIVACY_VERSION_KEY, HOSTED_L0_PRIVACY_VERSION, accepted),
    db
      .prepare(`INSERT OR REPLACE INTO system_config(key, value, updated_at) VALUES(?, ?, ?)`)
      .bind(PRIVACY_ACCEPTED_AT_KEY, accepted, accepted),
  ]);

  return { privacy_version: HOSTED_L0_PRIVACY_VERSION, privacy_accepted_at: accepted };
}

function isNoSuchTableError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /no such table/i.test(msg);
}

/** 清空站主 D1 权威数据（复用 M9-7 表白名单；MESSAGING_DB 不在此范围） */
export async function deleteOwnerAccountData(
  db: D1Database,
  options: {
    confirmPhrase: string;
    exportAcknowledged: boolean;
    hostedL0Only: boolean;
    hostedL0Enabled: boolean;
  },
): Promise<AccountDeleteResult> {
  if (options.hostedL0Only && !options.hostedL0Enabled) {
    throw new Error('ACCOUNT_DELETE_HOSTED_ONLY');
  }
  if (options.confirmPhrase !== HOSTED_L0_ACCOUNT_DELETE_CONFIRM_PHRASE) {
    throw new Error('ACCOUNT_DELETE_CONFIRM_INVALID');
  }
  if (!options.exportAcknowledged) {
    throw new Error('ACCOUNT_DELETE_EXPORT_ACK_REQUIRED');
  }

  const deleted_tables: Record<string, number> = {};
  const skipped_tables: string[] = [];
  const deleteOrder = [...NODE_EXPORT_TABLES].reverse();

  for (const table of deleteOrder) {
    try {
      const res = await db.prepare(`DELETE FROM ${table}`).run();
      deleted_tables[table] = res.meta?.changes ?? 0;
    } catch (err) {
      if (isNoSuchTableError(err)) {
        skipped_tables.push(table);
        continue;
      }
      throw err;
    }
  }

  const accountDeletedAt = nowISO();
  await db.batch([
    db.prepare(`DELETE FROM owner_credentials`),
    db
      .prepare(`INSERT OR REPLACE INTO system_config(key, value, updated_at) VALUES(?, ?, ?)`)
      .bind(ACCOUNT_DELETED_AT_KEY, accountDeletedAt, accountDeletedAt),
    db
      .prepare(`INSERT OR REPLACE INTO system_config(key, value, updated_at) VALUES('posts_cache_dirty', 'true', ?)`)
      .bind(accountDeletedAt),
  ]);

  const operator_steps = [
    '向注册中心申请注销节点目录（若已登记）；本接口不代发注销请求。',
    '按需清空 IMAGE_KV / POSTS_CACHE_KV / STATE_KV 对象（本接口不删除 KV 二进制）。',
    'MESSAGING_DB 请单独清理或保留；删除前应先导出 M10-5b 私信备份。',
    options.hostedL0Enabled
      ? `托管运营方离线备份将在最多 ${HOSTED_L0_DATA_RETENTION_DAYS} 天内销毁。`
      : '自托管节点请自行在 Cloudflare 控制台删除 Worker/D1/KV 资源。',
  ];

  return {
    deleted_tables,
    skipped_tables,
    account_deleted_at: accountDeletedAt,
    operator_steps,
  };
}
