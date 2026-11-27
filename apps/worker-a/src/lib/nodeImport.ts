/**
 * M9-7 / R-AUDIT-V3 2.9：节点搬家 — 导入（staging/inplace + 列白名单 + TOTP 守卫）。
 * M-OPT-SPLIT-A7 Phase3：按 NODE_EXPORT_TABLE_BINDING 多库写入（对齐 export）。
 *   - staging：整包仍写单一 DB_IMPORT（全表 schema 容器，对账/切流）
 *   - inplace：按表写入 IDENTITY / GOVERNANCE / CONTENT（禁 env.DB）
 */
import { ed25519PrivateKeyJwkToPkcs8Hex } from '@hailuo/shared-crypto';
import { nowISO } from '@hailuo/shared-utils';
import type { Env } from '../env';
import {
  resolveContentDb,
  resolveGovernanceDb,
  resolveIdentityDb,
} from '../db/bindings';
import {
  assertNoOwnerTotpRows,
  isNoSuchTableError,
  tableHasRowsFailClosed,
} from './nodeImportGuards';
import {
  reconcileImportedBundle,
  readImportReadyStatus,
  writeImportReadyConfig,
  type NodeImportReconcileReport,
} from './nodeImportReconcile';
import {
  NODE_EXPORT_MAX_ROWS_PER_TABLE,
  NODE_EXPORT_SCHEMA_VERSION,
  NODE_EXPORT_TABLE_BINDING,
  NODE_EXPORT_TABLES,
  type NodeExportBundle,
  type NodeExportTableName,
} from './nodeExport';
import {
  assertSafeColumns,
  batchStatements,
  buildInsertStatements,
  isImportSkipTable,
  readTableColumnSet,
  resolveDbForImportTable,
} from './nodeImportShared';

export class NodeImportReconcileError extends Error {
  constructor(readonly report: NodeImportReconcileReport) {
    super('NODE_IMPORT_RECONCILE_FAILED');
    this.name = 'NodeImportReconcileError';
  }
}

export {
  assertNoOwnerTotpRows,
  isInplaceImportEnabled,
  isNoSuchTableError,
  NODE_IMPORT_TOTP_GUARD_TABLES,
  tableHasRowsFailClosed,
} from './nodeImportGuards';

export type { NodeImportReconcileReport } from './nodeImportReconcile';
export type { NodeExportBundle };

// NCF-2 12KB 预算：公共符号仍从本文件可达
export { NODE_IMPORT_SKIP_TABLES } from './nodeImportShared';
export { promoteStagingImportToSplit } from './nodeImportPromote';
export type { PromoteStagingResult } from './nodeImportPromote';



/** SQL 标识符（列名）安全模式 */
export interface NodeImportResult {
  imported_tables: Record<string, number>;
  skipped_tables: string[];
  image_manifest_count: number;
  posts_cache_dirty: boolean;
  /** staging = DB_IMPORT；inplace = 三库真分（SPLIT） */
  import_target: 'DB_IMPORT' | 'SPLIT';
  /** M9-7-S3：staging 对账报告；inplace 为 null */
  reconcile: NodeImportReconcileReport | null;
  /** staging 且对账通过时为 true */
  import_ready: boolean;
  /** 导入后须在新节点执行的 wrangler / 运维步骤 */
  operator_steps: string[];
}


function validateBundleShape(body: unknown): body is NodeExportBundle {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const record = body as Record<string, unknown>;
  const meta = record.meta;
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return false;
  if ((meta as Record<string, unknown>).schema_version !== NODE_EXPORT_SCHEMA_VERSION) return false;
  if (!record.d1 || typeof record.d1 !== 'object' || Array.isArray(record.d1)) return false;
  if (!record.crypto || typeof record.crypto !== 'object' || Array.isArray(record.crypto)) return false;
  if (!Array.isArray(record.image_manifest)) return false;
  return true;
}

/**
 * 完整校验后再动库：表名白名单、行类型、列名 ⊆ PRAGMA、标识符安全。
 * skip 表只登记，不参与清表/插入。
 */
async function validateBundleForImport(
  env: Env,
  bundle: NodeExportBundle,
  mode: 'staging' | 'inplace',
  stagingDb: D1Database | null,
): Promise<{
  tablesToImport: NodeExportTableName[];
  columnPlan: Map<string, string[]>;
  skippedForPolicy: string[];
  missingTables: string[];
}> {
  const tableNames = Object.keys(bundle.d1);
  for (const name of tableNames) {
    if (!(NODE_EXPORT_TABLES as readonly string[]).includes(name)) {
      throw new Error('NODE_IMPORT_FORBIDDEN_TABLE');
    }
  }

  const tablesToImport: NodeExportTableName[] = [];
  const columnPlan = new Map<string, string[]>();
  const skippedForPolicy: string[] = [];
  const missingTables: string[] = [];

  for (const table of NODE_EXPORT_TABLES) {
    const rows = bundle.d1[table];
    if (rows === undefined) continue;
    if (!Array.isArray(rows)) throw new Error('NODE_IMPORT_INVALID');

    if (isImportSkipTable(table)) {
      skippedForPolicy.push(table);
      continue;
    }

    if (rows.length === 0) {
      tablesToImport.push(table);
      columnPlan.set(table, []);
      continue;
    }

    if (mode === 'staging' && !stagingDb) {
      throw new Error('NODE_IMPORT_STAGING_MISSING');
    }
    const db = resolveDbForImportTable(env, table, mode, stagingDb as D1Database);
    const allowed = await readTableColumnSet(db, table);
    if (!allowed) {
      missingTables.push(table);
      continue;
    }

    const cols = Object.keys(rows[0]!);
    assertSafeColumns(cols, allowed);
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i]!;
      if (!row || typeof row !== 'object' || Array.isArray(row)) {
        throw new Error('NODE_IMPORT_INVALID');
      }
      const keys = Object.keys(row);
      if (keys.length !== cols.length || keys.some((k) => !cols.includes(k))) {
        throw new Error('NODE_IMPORT_INVALID_COLUMN');
      }
    }

    tablesToImport.push(table);
    columnPlan.set(table, cols);
  }

  return { tablesToImport, columnPlan, skippedForPolicy, missingTables };
}

/**
 * M-OPT-SPLIT-A7 Phase3：多库导入入口。
 * staging → DB_IMPORT 单库全表；inplace → 按 NODE_EXPORT_TABLE_BINDING 分库。
 */
export async function importNodeExportBundle(
  env: Env,
  body: unknown,
  options: {
    confirmOverwrite: boolean;
    mode: 'staging' | 'inplace';
    unsafeInplaceImport: boolean;
    inplaceImportEnabled: boolean;
  },
): Promise<NodeImportResult> {
  if (!validateBundleShape(body)) {
    throw new Error('NODE_IMPORT_INVALID');
  }

  if (options.mode === 'inplace') {
    if (!options.inplaceImportEnabled) {
      throw new Error('NODE_IMPORT_DISABLED');
    }
    if (!options.unsafeInplaceImport) {
      throw new Error('NODE_IMPORT_UNSAFE_REQUIRED');
    }
  }

  const stagingDb = options.mode === 'staging' ? env.DB_IMPORT ?? null : null;
  if (options.mode === 'staging' && !stagingDb) {
    throw new Error('NODE_IMPORT_STAGING_MISSING');
  }

  const usersDb =
    options.mode === 'staging'
      ? (stagingDb as D1Database)
      : resolveIdentityDb(env);

  const hasExisting = await tableHasRowsFailClosed(usersDb, 'users');
  if (hasExisting && !options.confirmOverwrite) {
    throw new Error('NODE_IMPORT_CONFIRM_REQUIRED');
  }

  await assertNoOwnerTotpRows(usersDb);

  const bundle = body;
  const { tablesToImport, columnPlan, skippedForPolicy, missingTables } =
    await validateBundleForImport(env, bundle, options.mode, stagingDb);

  const imported_tables: Record<string, number> = {};
  const skipped_tables: string[] = [...skippedForPolicy, ...missingTables];

  const deleteOrder = [...tablesToImport].reverse();
  for (const table of deleteOrder) {
    const db = resolveDbForImportTable(env, table, options.mode, stagingDb as D1Database);
    try {
      await db.prepare(`DELETE FROM ${table}`).run();
    } catch (err) {
      if (!isNoSuchTableError(err)) throw err;
      skipped_tables.push(table);
    }
  }

  for (const table of tablesToImport) {
    const rows = bundle.d1[table];
    if (!rows) continue;
    const cols = columnPlan.get(table) ?? [];
    const db = resolveDbForImportTable(env, table, options.mode, stagingDb as D1Database);
    try {
      const stmts = buildInsertStatements(
        db,
        table,
        rows as Record<string, unknown>[],
        cols,
      );
      const results = stmts.length > 0 ? await batchStatements(db, stmts) : [];
      imported_tables[table] = results.reduce((sum, r) => sum + (r.meta?.changes ?? 0), 0);
    } catch (err) {
      if (isNoSuchTableError(err)) {
        skipped_tables.push(table);
        continue;
      }
      throw err;
    }
  }

  // system_config dirty：staging 写 DB_IMPORT；inplace 写 IDENTITY
  const dirtyDb =
    options.mode === 'staging' ? (stagingDb as D1Database) : resolveIdentityDb(env);
  const iso = nowISO();
  await dirtyDb
    .prepare(
      `INSERT OR REPLACE INTO system_config(key, value, updated_at) VALUES('posts_cache_dirty', 'true', ?)`,
    )
    .bind(iso)
    .run()
    .catch(() => undefined);

  let reconcile: NodeImportReconcileReport | null = null;
  let import_ready = false;
  if (options.mode === 'staging') {
    reconcile = await reconcileImportedBundle(stagingDb as D1Database, bundle, tablesToImport);
    await writeImportReadyConfig(stagingDb as D1Database, reconcile);
    import_ready = reconcile.ok;
    if (!reconcile.ok) {
      throw new NodeImportReconcileError(reconcile);
    }
  }

  let pkcs8Hint = bundle.crypto.ed25519_private_key_pkcs8_hex_hint?.trim() ?? '';
  if (!pkcs8Hint && bundle.crypto.ed25519_private_key_jwk) {
    try {
      pkcs8Hint = await ed25519PrivateKeyJwkToPkcs8Hex(bundle.crypto.ed25519_private_key_jwk);
    } catch {
      pkcs8Hint = '';
    }
  }

  const import_target = options.mode === 'staging' ? 'DB_IMPORT' : 'SPLIT';
  const operator_steps =
    options.mode === 'staging'
      ? [
          '对账通过：system_config.import_ready=true。请调用 POST /api/node/import/promote-staging（confirm_promote:true）把 staging 灌入 IDENTITY/GOVERNANCE/CONTENT，或运行 scripts/cutover-db-import.ps1（A7-DB-RETIRE：不再交换旧 DB id）。',
          pkcs8Hint
            ? `切流后执行：npm exec -- wrangler secret put ED25519_PRIVATE_KEY（PKCS8 hex 共 ${pkcs8Hint.length} 字符，见 bundle.crypto）。`
            : '切流后从 bundle.crypto.ed25519_private_key_jwk 还原 PKCS8 hex 并写入 secret。',
          '按 image_manifest 复制 IMAGE_KV；MESSAGING_DB 用 M10-5b 单独恢复。',
          '切流后请在 Settings 重新启用站主 TOTP（owner_totp_* 不迁入）。',
        ]
      : [
          'inplace 已按 NODE_EXPORT_TABLE_BINDING 写入 IDENTITY/GOVERNANCE/CONTENT 三库。',
          '在新 Cloudflare 账号部署 Worker A/B 后，执行：npm exec -- wrangler secret put ED25519_PRIVATE_KEY --config apps/worker-a/wrangler.toml',
          pkcs8Hint
            ? `粘贴 PKCS8 hex（与 bundle.crypto.ed25519_private_key_pkcs8_hex_hint 相同，共 ${pkcs8Hint.length} 字符）。`
            : '从 bundle.crypto.ed25519_private_key_jwk 还原 PKCS8 hex 后写入 secret。',
          '按 image_manifest 复制 IMAGE_KV 对象，或接受图片缺失后由站主重新上传。',
          '更新 WORKER_B_URL / 注册中心 node_url；MESSAGING_DB 请单独用 M10-5b 备份恢复。',
          '请在 Settings 重新启用站主 TOTP（owner_totp_* 未迁移）。',
          '本导入为不安全的原地覆盖路径；生产默认需 NODE_INPLACE_IMPORT_ENABLED=true；正规路径为 DB_IMPORT staging + 脚本切流。',
        ];

  return {
    imported_tables,
    skipped_tables: [...new Set(skipped_tables)],
    image_manifest_count: bundle.image_manifest.length,
    posts_cache_dirty: true,
    import_target,
    reconcile,
    import_ready,
    operator_steps,
  };
}
