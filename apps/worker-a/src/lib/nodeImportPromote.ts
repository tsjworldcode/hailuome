/**
 * A7-DB-RETIRE：把 DB_IMPORT staging 按表灌入 IDENTITY / GOVERNANCE / CONTENT。
 * 从 nodeImport.ts 拆出（单文件 12KB 预算）。
 */
import type { Env } from '../env';
import { resolveContentDb, resolveGovernanceDb, resolveIdentityDb } from '../db/bindings';
import { nowISO } from '@hailuo/shared-utils';
import {
  assertNoOwnerTotpRows,
  isNoSuchTableError,
  tableHasRowsFailClosed,
} from './nodeImportGuards';
import { readImportReadyStatus } from './nodeImportReconcile';
import {
  NODE_EXPORT_MAX_ROWS_PER_TABLE,
  NODE_EXPORT_TABLES,
  type NodeExportTableName,
} from './nodeExport';
import {
  assertSafeColumns,
  batchStatements,
  buildInsertStatements,
  isImportSkipTable,
  readTableColumnSet,
  resolveDbForImportTable,
  SQL_IDENT_RE,
} from './nodeImportShared';

/**
 * A7-DB-RETIRE：把 DB_IMPORT staging 按表灌入 IDENTITY / GOVERNANCE / CONTENT。
 * 替代旧 cutover「交换 DB↔DB_IMPORT database_id」（业务已不读 env.DB）。
 * 不 dump 行到日志；仅返回每表 COUNT/changes。
 */
export interface PromoteStagingResult {
  imported_tables: Record<string, number>;
  skipped_tables: string[];
  import_target: 'SPLIT';
  posts_cache_dirty: boolean;
  operator_steps: string[];
}

export async function promoteStagingImportToSplit(
  env: Env,
  options: { confirmPromote: boolean; confirmOverwrite: boolean },
): Promise<PromoteStagingResult> {
  if (!options.confirmPromote) {
    throw new Error('NODE_IMPORT_PROMOTE_CONFIRM_REQUIRED');
  }

  const staging = env.DB_IMPORT;
  if (!staging) {
    throw new Error('NODE_IMPORT_STAGING_MISSING');
  }

  const identityDb = resolveIdentityDb(env);
  resolveGovernanceDb(env);
  resolveContentDb(env);

  const ready = await readImportReadyStatus(staging);
  if (!ready.import_ready) {
    throw new Error('NODE_IMPORT_NOT_READY');
  }

  const hasExisting = await tableHasRowsFailClosed(identityDb, 'users');
  if (hasExisting && !options.confirmOverwrite) {
    throw new Error('NODE_IMPORT_CONFIRM_REQUIRED');
  }

  await assertNoOwnerTotpRows(identityDb);
  await assertNoOwnerTotpRows(staging);

  const imported_tables: Record<string, number> = {};
  const skipped_tables: string[] = [];

  for (const table of NODE_EXPORT_TABLES) {
    if (isImportSkipTable(table)) {
      skipped_tables.push(table);
      continue;
    }

    const stagingCols = await readTableColumnSet(staging, table);
    if (!stagingCols) {
      skipped_tables.push(table);
      continue;
    }

    const target = resolveDbForImportTable(env, table, 'inplace', staging);
    const targetCols = await readTableColumnSet(target, table);
    if (!targetCols) {
      skipped_tables.push(table);
      continue;
    }

    let n = 0;
    try {
      const countRow = await staging.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>();
      n = Number(countRow?.n ?? 0);
    } catch (err) {
      if (isNoSuchTableError(err)) {
        skipped_tables.push(table);
        continue;
      }
      throw err;
    }

    if (n > NODE_EXPORT_MAX_ROWS_PER_TABLE) {
      throw new Error(`NODE_IMPORT_PROMOTE_TOO_LARGE:${table}`);
    }

    const dumped = await staging
      .prepare(`SELECT * FROM ${table} LIMIT ?`)
      .bind(NODE_EXPORT_MAX_ROWS_PER_TABLE)
      .all();
    const rows = (dumped.results ?? []) as Record<string, unknown>[];

    try {
      await target.prepare(`DELETE FROM ${table}`).run();
    } catch (err) {
      if (isNoSuchTableError(err)) {
        skipped_tables.push(table);
        continue;
      }
      throw err;
    }

    if (rows.length === 0) {
      imported_tables[table] = 0;
      continue;
    }

    const cols = Object.keys(rows[0]!).filter((c) => targetCols.has(c) && SQL_IDENT_RE.test(c));
    assertSafeColumns(cols, targetCols);
    const stmts = buildInsertStatements(target, table, rows, cols);
    const results = stmts.length > 0 ? await batchStatements(target, stmts) : [];
    imported_tables[table] = results.reduce((sum, r) => sum + (r.meta?.changes ?? 0), 0);
  }

  const iso = nowISO();
  await identityDb
    .prepare(
      `INSERT OR REPLACE INTO system_config(key, value, updated_at) VALUES('posts_cache_dirty', 'true', ?)`,
    )
    .bind(iso)
    .run()
    .catch(() => undefined);

  await staging
    .prepare(
      `INSERT OR REPLACE INTO system_config(key, value, updated_at) VALUES('import_promoted_at', ?, ?)`,
    )
    .bind(iso, iso)
    .run()
    .catch(() => undefined);

  return {
    imported_tables,
    skipped_tables: [...new Set(skipped_tables)],
    import_target: 'SPLIT',
    posts_cache_dirty: true,
    operator_steps: [
      'staging 已按 NODE_EXPORT_TABLE_BINDING 灌入 IDENTITY/GOVERNANCE/CONTENT。',
      '无需再交换旧 DB binding；请 smoke：登录 / 发帖 / 关注。',
      '按 image_manifest 复制 IMAGE_KV；MESSAGING_DB 用 M10-5b 单独恢复。',
      '请在 Settings 重新启用站主 TOTP（owner_totp_* 不迁入）。',
    ],
  };
}
