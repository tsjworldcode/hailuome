import type { Env } from '../env';
import { resolveGovernanceDb } from '../db/bindings';

export type OperationLogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface OperationLogInput {
  readonly source: 'worker-a' | 'worker-b-proxy' | 'registry';
  readonly level: OperationLogLevel;
  readonly event: string;
  readonly message: string;
  readonly details?: Record<string, unknown>;
}

const LOG_RETENTION_MS = 60 * 60 * 1000;
const MAX_DETAILS_CHARS = 2000;

function isoNow(): string {
  return new Date().toISOString();
}

function newLogId(): string {
  return `log_${Date.now().toString(36)}_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

function safeDetails(details: Record<string, unknown> | undefined): string {
  if (!details) return '{}';
  try {
    const text = JSON.stringify(details);
    return text.length > MAX_DETAILS_CHARS ? `${text.slice(0, MAX_DETAILS_CHARS)}...` : text;
  } catch {
    return '{"serialization_error":true}';
  }
}

/** 写入站主可见运行日志；日志失败不能影响主业务。 */
export async function writeOperationLog(env: Env, input: OperationLogInput): Promise<void> {
  try {
    await resolveGovernanceDb(env)
      .prepare(
        `INSERT INTO operation_logs (id, source, level, event, message, details, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        newLogId(),
        input.source,
        input.level,
        input.event.slice(0, 80),
        input.message.slice(0, 500),
        safeDetails(input.details),
        isoNow(),
      )
      .run();
  } catch (err) {
    console.warn('[operation-log] write failed', err);
  }
}

/** 清理过期日志；默认保留最近 1 小时。 */
export async function cleanupOperationLogs(env: Env, olderThanMs = LOG_RETENTION_MS): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanMs).toISOString();
  const result = await resolveGovernanceDb(env)
    .prepare(`DELETE FROM operation_logs WHERE created_at < ?`)
    .bind(cutoff)
    .run();
  return result.meta.changes ?? 0;
}
