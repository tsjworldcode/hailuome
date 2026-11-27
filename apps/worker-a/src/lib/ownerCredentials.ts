/**
 * 站主凭证 D1 读写（登录 / 改密共用）。
 * NCF-2B：供 auth 路由与 services/auth production adapter 共用，避免 Env 进核心。
 *
 * M-OPT-SPLIT-4（A-4）签名改造：函数首参改为 `(db: D1Database, ...)`，
 * 由调用方注入 `resolveIdentityDb(env)`（IDENTITY_DB）结果。
 * 本库表归 IDENTITY_DB（owner_credentials + system_config.owner_must_change_credentials）。
 */

const OWNER_MUST_CHANGE_KEY = 'owner_must_change_credentials';

export interface OwnerCredentialRow {
  username: string;
  password_hash: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * 读取 owner_credentials 行；行不存在或查询失败均返 null。
 *
 * @param db `D1Database` — 由 `resolveIdentityDb(env)` 注入；本表在 IDENTITY_DB。
 */
export async function loadOwnerCredential(
  db: D1Database,
  username: string,
): Promise<OwnerCredentialRow | null> {
  try {
    return await db
      .prepare(`SELECT username, password_hash FROM owner_credentials WHERE username = ? LIMIT 1`)
      .bind(username)
      .first<OwnerCredentialRow>();
  } catch (err) {
    console.error('[auth] 查 owner_credentials 失败', err);
    return null;
  }
}

/**
 * 判断 owner_credentials 表是否为空（用于决定是否启用老 secret 回落路径）。
 * 表不存在 / 查询异常时一律视为空（继续走老回落）。
 *
 * @param db `D1Database` — 由 `resolveIdentityDb(env)` 注入。
 */
export async function isOwnerCredentialsEmpty(db: D1Database): Promise<boolean> {
  try {
    const row = await db
      .prepare(`SELECT COUNT(*) AS n FROM owner_credentials`)
      .first<{ n: number }>();
    return !row || (row.n ?? 0) === 0;
  } catch (err) {
    console.error('[auth] COUNT owner_credentials 失败，视为空表走老回落', err);
    return true;
  }
}

/**
 * 排障用：统计 owner_credentials 行数；失败时返回 count=-1。
 *
 * @param db `D1Database` — 由 `resolveIdentityDb(env)` 注入。
 */
export async function countOwnerCredentials(db: D1Database): Promise<{ count: number; d1Error?: string }> {
  try {
    const row = await db
      .prepare(`SELECT COUNT(*) AS n FROM owner_credentials`)
      .first<{ n: number }>();
    return { count: row?.n ?? 0 };
  } catch (err) {
    return { count: -1, d1Error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * 读 system_config 的 owner_must_change_credentials 布尔值。
 *
 * @param db `D1Database` — 由 `resolveIdentityDb(env)` 注入。
 */
export async function getOwnerMustChangeCredentials(db: D1Database): Promise<boolean> {
  try {
    const row = await db
      .prepare(`SELECT value FROM system_config WHERE key = ? LIMIT 1`)
      .bind(OWNER_MUST_CHANGE_KEY)
      .first<{ value: string }>();
    return row?.value === 'true';
  } catch (err) {
    console.error('[auth] 读 owner_must_change_credentials 失败，fail-soft 视为 false', err);
    return false;
  }
}

/**
 * 写 system_config 的 owner_must_change_credentials = 'false'。
 *
 * @param db `D1Database` — 由 `resolveIdentityDb(env)` 注入。
 */
export async function clearOwnerMustChangeCredentials(db: D1Database): Promise<void> {
  try {
    await db
      .prepare(
        `INSERT OR REPLACE INTO system_config (key, value, updated_at) VALUES (?, 'false', ?)`,
      )
      .bind(OWNER_MUST_CHANGE_KEY, nowIso())
      .run();
  } catch (err) {
    console.error('[auth] 清 owner_must_change_credentials 失败', err);
  }
}

export { OWNER_MUST_CHANGE_KEY };
