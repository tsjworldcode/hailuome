/**
 * M9-7-S3：staging 导入对账（表 COUNT + 关键表抽样 hash）与 import_ready 标记。
 * 对账结果写 D1 system_config（非 KV），符合 Free Tier 写频约束。
 */
import { nowISO } from '@hailuo/shared-utils';
import { isNoSuchTableError } from './nodeImportGuards';
import type { NodeExportBundle } from './nodeExport';

const SQL_IDENT_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/** system_config：切流脚本读此键，值为 true/false */
export const IMPORT_READY_CONFIG_KEY = 'import_ready' as const;
/** system_config：对账明细 JSON */
export const IMPORT_RECONCILE_CONFIG_KEY = 'import_reconcile' as const;

/** 抽样 hash 的关键表（有稳定主键） */
export const NODE_IMPORT_SAMPLE_HASH_TABLES = [
  { table: 'users', orderBy: 'handle', limit: 50 },
  { table: 'posts', orderBy: 'id', limit: 50 },
  { table: 'follows', orderBy: 'id', limit: 50 },
  { table: 'owner_credentials', orderBy: 'username', limit: 10 },
] as const;

/** system_config 导入后会再写 posts_cache_dirty / import_*，不做严格 COUNT */
const COUNT_SKIP_TABLES = new Set(['system_config']);

export interface NodeImportTableCountResult {
  readonly expected: number;
  readonly actual: number;
  readonly ok: boolean;
}

export interface NodeImportSampleHashResult {
  readonly ok: boolean;
  readonly bundle_hash: string;
  readonly db_hash: string;
  readonly sample_rows: number;
}

export interface NodeImportReconcileReport {
  readonly ok: boolean;
  readonly reconciled_at: string;
  readonly table_counts: Record<string, NodeImportTableCountResult>;
  readonly sample_hashes: Record<string, NodeImportSampleHashResult>;
  readonly mismatches: readonly string[];
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return bytesToHex(new Uint8Array(buf));
}

/** 行规范化：键排序后 JSON，保证 bundle / D1 可比 */
export function canonicalizeImportRow(row: Record<string, unknown>): string {
  const keys = Object.keys(row).sort();
  const normalized: Record<string, unknown> = {};
  for (const k of keys) {
    const v = row[k];
    normalized[k] = v === undefined ? null : v;
  }
  return JSON.stringify(normalized);
}

export async function hashImportRowSample(
  rows: readonly Record<string, unknown>[],
  orderBy: string,
  limit: number,
): Promise<{ hash: string; sample_rows: number }> {
  const sorted = [...rows].sort((a, b) =>
    String(a[orderBy] ?? '').localeCompare(String(b[orderBy] ?? '')),
  );
  const sample = sorted.slice(0, limit);
  const payload = sample.map((r) => canonicalizeImportRow(r)).join('\n');
  return { hash: await sha256Hex(payload), sample_rows: sample.length };
}

async function countTableRows(db: D1Database, table: string): Promise<number> {
  if (!SQL_IDENT_RE.test(table)) throw new Error('NODE_IMPORT_INVALID');
  try {
    const row = await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>();
    return Number(row?.n ?? 0);
  } catch (err) {
    if (isNoSuchTableError(err)) return 0;
    throw err;
  }
}

async function readDbSampleRows(
  db: D1Database,
  table: string,
  orderBy: string,
  cols: string[],
  limit: number,
): Promise<Record<string, unknown>[]> {
  if (!SQL_IDENT_RE.test(table) || !SQL_IDENT_RE.test(orderBy)) {
    throw new Error('NODE_IMPORT_INVALID');
  }
  for (const c of cols) {
    if (!SQL_IDENT_RE.test(c)) throw new Error('NODE_IMPORT_INVALID_COLUMN');
  }
  if (cols.length === 0) return [];
  try {
    const sql = `SELECT ${cols.join(', ')} FROM ${table} ORDER BY ${orderBy} ASC LIMIT ?`;
    const res = await db.prepare(sql).bind(limit).all<Record<string, unknown>>();
    return res.results ?? [];
  } catch (err) {
    if (isNoSuchTableError(err)) return [];
    throw err;
  }
}

/**
 * 对比 bundle 与目标库：全表白名单 COUNT（跳过 system_config）+ 关键表抽样 hash。
 */
export async function reconcileImportedBundle(
  db: D1Database,
  bundle: NodeExportBundle,
  tablesImported: readonly string[],
): Promise<NodeImportReconcileReport> {
  const mismatches: string[] = [];
  const table_counts: Record<string, NodeImportTableCountResult> = {};
  const sample_hashes: Record<string, NodeImportSampleHashResult> = {};
  const importedSet = new Set(tablesImported);

  for (const table of tablesImported) {
    if (COUNT_SKIP_TABLES.has(table)) continue;
    const expected = Array.isArray(bundle.d1[table]) ? bundle.d1[table]!.length : 0;
    const actual = await countTableRows(db, table);
    const ok = expected === actual;
    table_counts[table] = { expected, actual, ok };
    if (!ok) {
      mismatches.push(`count:${table}:expected=${expected}:actual=${actual}`);
    }
  }

  for (const spec of NODE_IMPORT_SAMPLE_HASH_TABLES) {
    if (!importedSet.has(spec.table)) continue;
    const bundleRows = (bundle.d1[spec.table] ?? []) as Record<string, unknown>[];
    const cols =
      bundleRows.length > 0
        ? Object.keys(bundleRows[0]!).filter((c) => SQL_IDENT_RE.test(c)).sort()
        : [];
    const bundleSample = await hashImportRowSample(bundleRows, spec.orderBy, spec.limit);
    const dbRows = await readDbSampleRows(db, spec.table, spec.orderBy, cols, spec.limit);
    const dbSample = await hashImportRowSample(dbRows, spec.orderBy, spec.limit);
    const ok = bundleSample.hash === dbSample.hash;
    sample_hashes[spec.table] = {
      ok,
      bundle_hash: bundleSample.hash,
      db_hash: dbSample.hash,
      sample_rows: bundleSample.sample_rows,
    };
    if (!ok) {
      mismatches.push(`hash:${spec.table}`);
    }
  }

  return {
    ok: mismatches.length === 0,
    reconciled_at: nowISO(),
    table_counts,
    sample_hashes,
    mismatches,
  };
}

/** 将对账结果写入 staging system_config（import_ready + import_reconcile）。 */
export async function writeImportReadyConfig(
  db: D1Database,
  report: NodeImportReconcileReport,
): Promise<void> {
  const iso = report.reconciled_at;
  await db
    .prepare(
      `INSERT OR REPLACE INTO system_config(key, value, updated_at) VALUES(?, ?, ?)`,
    )
    .bind(IMPORT_READY_CONFIG_KEY, report.ok ? 'true' : 'false', iso)
    .run();
  await db
    .prepare(
      `INSERT OR REPLACE INTO system_config(key, value, updated_at) VALUES(?, ?, ?)`,
    )
    .bind(IMPORT_RECONCILE_CONFIG_KEY, JSON.stringify(report), iso)
    .run();
}

export async function readImportReadyStatus(db: D1Database): Promise<{
  import_ready: boolean;
  reconcile: NodeImportReconcileReport | null;
}> {
  let readyRaw: string | null = null;
  let reconcileRaw: string | null = null;
  try {
    const ready = await db
      .prepare(`SELECT value FROM system_config WHERE key = ?`)
      .bind(IMPORT_READY_CONFIG_KEY)
      .first<{ value: string }>();
    readyRaw = ready?.value ?? null;
  } catch (err) {
    if (!isNoSuchTableError(err)) throw err;
  }
  try {
    const row = await db
      .prepare(`SELECT value FROM system_config WHERE key = ?`)
      .bind(IMPORT_RECONCILE_CONFIG_KEY)
      .first<{ value: string }>();
    reconcileRaw = row?.value ?? null;
  } catch (err) {
    if (!isNoSuchTableError(err)) throw err;
  }

  let reconcile: NodeImportReconcileReport | null = null;
  if (reconcileRaw) {
    try {
      reconcile = JSON.parse(reconcileRaw) as NodeImportReconcileReport;
    } catch {
      reconcile = null;
    }
  }

  return {
    import_ready: readyRaw === 'true',
    reconcile,
  };
}
