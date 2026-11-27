/**
 * M-REFACTOR-1a：operation_logs D1 查询（从 local-reads 路由层下沉）。
 */
import type { Env } from '../../env';
import { resolveGovernanceDb } from '../../db/bindings';

export interface OperationLogRow {
  id: string;
  source: string;
  level: string;
  event: string;
  message: string;
  details: string;
  created_at: string;
}

function parseDetails(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export interface OperationLogItem {
  id: string;
  source: string;
  level: string;
  event: string;
  message: string;
  details: unknown;
  created_at: string;
}

/** 查询运行日志（可选 source 过滤） */
export async function queryOperationLogs(
  env: Env,
  opts: { limit: number; source?: string },
): Promise<OperationLogItem[]> {
  const { limit, source } = opts;
  const governanceDb = resolveGovernanceDb(env);
  const result = source
    ? await governanceDb.prepare(
        `SELECT id, source, level, event, message, details, created_at
           FROM operation_logs
          WHERE source = ?
          ORDER BY created_at DESC
          LIMIT ?`,
      )
        .bind(source, limit)
        .all<OperationLogRow>()
    : await governanceDb.prepare(
        `SELECT id, source, level, event, message, details, created_at
           FROM operation_logs
          ORDER BY created_at DESC
          LIMIT ?`,
      )
        .bind(limit)
        .all<OperationLogRow>();

  return (result.results ?? []).map((row) => ({
    ...row,
    details: parseDetails(row.details),
  }));
}
