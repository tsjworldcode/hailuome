/**
 * R-AUDIT-5b：原地导入前置守卫（fail-closed）。
 * 与 DELETE/INSERT 解耦，便于契约测试用 mock D1 验证零副作用。
 */

/** 目标库任一行即拒导（含未完成 enrollment 的 pending） */
export const NODE_IMPORT_TOTP_GUARD_TABLES = [
  'owner_totp_settings',
  'owner_totp_pending',
  'owner_totp_recovery_codes',
] as const;

export function isNoSuchTableError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /no such table/i.test(msg);
}

/** R-AUDIT-5：仅显式 true/1 允许原地导入。 */
export function isInplaceImportEnabled(raw: string | undefined): boolean {
  const v = (raw ?? '').trim().toLowerCase();
  return v === 'true' || v === '1';
}

/**
 * 表存在且有行 → true；表不存在 → false；其它 D1 错误必须抛出（禁止 fail-open）。
 */
export async function tableHasRowsFailClosed(
  db: D1Database,
  table: string,
): Promise<boolean> {
  try {
    const row = await db.prepare(`SELECT 1 AS n FROM ${table} LIMIT 1`).first<{ n: number }>();
    return row != null;
  } catch (err) {
    if (isNoSuchTableError(err)) return false;
    throw err;
  }
}

/** 目标库有任意 owner_totp_* 行则抛 NODE_IMPORT_TOTP_PRESENT。 */
export async function assertNoOwnerTotpRows(db: D1Database): Promise<void> {
  for (const totpTable of NODE_IMPORT_TOTP_GUARD_TABLES) {
    if (await tableHasRowsFailClosed(db, totpTable)) {
      throw new Error('NODE_IMPORT_TOTP_PRESENT');
    }
  }
}
