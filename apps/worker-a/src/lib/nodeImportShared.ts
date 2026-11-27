/**
 * M9-7：节点搬家导入的共享小工具（分批 batch / PRAGMA 列集合 / 列白名单 / INSERT 构造 / 按表选库 / skip 表）。
 * CRON-OBSERVABILITY 之后顺手收口：从 nodeImport.ts 拆出，满足 NCF-2 的单文件 12KB 预算。
 */
import type { Env } from '../env';
import { resolveContentDb, resolveGovernanceDb, resolveIdentityDb } from '../db/bindings';
import { isNoSuchTableError } from './nodeImportGuards';
import { NODE_EXPORT_TABLE_BINDING, type NodeExportTableName } from './nodeExport';

/** SQL 标识符（列名）安全模式 */
export const SQL_IDENT_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/**
 * R-AUDIT-3：导入时永不写入/清表的表。
 * TOTP secret 由 TOTP_WRAP_SECRET 包裹，换节点后旧密文无法解密 → 强制重新 enrollment。
 */
export const NODE_IMPORT_SKIP_TABLES = [
  'owner_totp_settings',
  'owner_totp_recovery_codes',
] as const;

export function isImportSkipTable(table: string): boolean {
  return (NODE_IMPORT_SKIP_TABLES as readonly string[]).includes(table);
}

export async function batchStatements(
  db: D1Database,
  statements: D1PreparedStatement[],
  chunkSize = 50,
): Promise<D1Result[]> {
  const out: D1Result[] = [];
  for (let i = 0; i < statements.length; i += chunkSize) {
    const chunk = statements.slice(i, i + chunkSize);
    if (chunk.length === 0) continue;
    const results = await db.batch(chunk);
    out.push(...results);
  }
  return out;
}

/** 读取表真实列名；表不存在返回 null。 */
export async function readTableColumnSet(db: D1Database, table: string): Promise<Set<string> | null> {
  if (!SQL_IDENT_RE.test(table)) return null;
  try {
    const res = await db.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
    const cols = (res.results ?? []).map((r) => r.name).filter(Boolean);
    if (cols.length === 0) return null;
    return new Set(cols);
  } catch (err) {
    if (isNoSuchTableError(err)) return null;
    throw err;
  }
}

export function assertSafeColumns(cols: string[], allowed: Set<string>): void {
  if (cols.length === 0) throw new Error('NODE_IMPORT_INVALID_COLUMN');
  for (const c of cols) {
    if (!SQL_IDENT_RE.test(c) || !allowed.has(c)) {
      throw new Error('NODE_IMPORT_INVALID_COLUMN');
    }
  }
}

export function buildInsertStatements(
  db: D1Database,
  table: string,
  rows: Record<string, unknown>[],
  cols: string[],
): D1PreparedStatement[] {
  if (rows.length === 0 || cols.length === 0) return [];
  const placeholders = cols.map(() => '?').join(', ');
  const sql = `INSERT OR REPLACE INTO ${table} (${cols.join(', ')}) VALUES (${placeholders})`;
  return rows.map((row) => db.prepare(sql).bind(...cols.map((c) => row[c] ?? null)));
}

export function resolveDbForImportTable(
  env: Env,
  table: NodeExportTableName,
  mode: 'staging' | 'inplace',
  stagingDb: D1Database,
): D1Database {
  if (mode === 'staging') return stagingDb;
  const binding = NODE_EXPORT_TABLE_BINDING[table];
  if (binding === 'CONTENT') return resolveContentDb(env);
  if (binding === 'GOVERNANCE') return resolveGovernanceDb(env);
  return resolveIdentityDb(env);
}
