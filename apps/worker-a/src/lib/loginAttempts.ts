/**
 * D1 login_attempts 频控（M2-1b / M7-30f-1 复用）。
 *
 * 登录与换域 step-up 共用同一 IP 窗口，禁止另开 attempts 表或 KV。
 *
 * M-OPT-SPLIT-3（A-3）签名改造：函数首参 `(db: D1Database, ...)`，由调用方
 * 注入 `resolveIdentityDb(env)`（IDENTITY_DB）结果。本库表归 IDENTITY_DB
 * （见 `db/migrations-identity/0011_owner_must_change_credentials.sql`）。
 */

/** 窗口大小：15 分钟，超过窗口起点的累计失败次数被视为新一轮统计。 */
export const LOGIN_WINDOW_MS = 15 * 60 * 1000;

/** 阈值：窗口内累计 5 次失败触发锁定。 */
export const LOGIN_FAIL_THRESHOLD = 5;

/** 锁定时长：5 分钟。 */
export const LOGIN_LOCKOUT_MS = 5 * 60 * 1000;

interface LoginAttemptRow {
  ip: string;
  fail_count: number;
  locked_until: string | null;
  first_attempt_at: string;
  last_attempt_at: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * 提取客户端 IP，用于 login_attempts 频控 PK。
 *
 * 取值优先级：
 *   1. CF-Connecting-IP（Cloudflare 边缘注入，最权威）
 *   2. X-Forwarded-For 第一段（如经过额外代理）
 *   3. "unknown"（兜底，避免 NULL PK）
 */
export function getClientIp(c: { req: { header: (name: string) => string | undefined } }): string {
  const cf = c.req.header('CF-Connecting-IP');
  if (cf && cf.length > 0) return cf;
  const xff = c.req.header('X-Forwarded-For');
  if (xff && xff.length > 0) return xff.split(',')[0]!.trim();
  return 'unknown';
}

/**
 * 查询 login_attempts 表，判定当前 IP 是否处于锁定中。
 * fail-soft：D1 查询失败时返回「未锁定」。
 *
 * @param db `D1Database` — 由 `resolveIdentityDb(env)` 注入；本表在 IDENTITY_DB。
 */
export async function checkLoginLockout(
  db: D1Database,
  ip: string,
): Promise<{ locked: boolean; lockedUntil?: string }> {
  try {
    const row = await db
      .prepare(
        `SELECT ip, fail_count, locked_until, first_attempt_at, last_attempt_at
         FROM login_attempts WHERE ip = ? LIMIT 1`,
      )
      .bind(ip)
      .first<LoginAttemptRow>();
    if (!row) return { locked: false };
    if (row.locked_until && row.locked_until > nowIso()) {
      return { locked: true, lockedUntil: row.locked_until };
    }
    return { locked: false };
  } catch (err) {
    console.error('[loginAttempts] 查 login_attempts 失败，fail-soft 视为未锁定', err);
    return { locked: false };
  }
}

/** 记录一次失败（窗口累计；达阈值写 locked_until）。fail-soft。 */
export async function recordLoginFailure(db: D1Database, ip: string): Promise<void> {
  const now = Date.now();
  const nowStr = new Date(now).toISOString();
  const windowStart = new Date(now - LOGIN_WINDOW_MS).toISOString();
  const lockUntil = new Date(now + LOGIN_LOCKOUT_MS).toISOString();

  try {
    const row = await db
      .prepare(
        `SELECT ip, fail_count, locked_until, first_attempt_at, last_attempt_at
         FROM login_attempts WHERE ip = ? LIMIT 1`,
      )
      .bind(ip)
      .first<LoginAttemptRow>();

    if (!row) {
      await db
        .prepare(
          `INSERT INTO login_attempts
           (ip, fail_count, locked_until, first_attempt_at, last_attempt_at)
           VALUES (?, 1, NULL, ?, ?)`,
        )
        .bind(ip, nowStr, nowStr)
        .run();
      return;
    }

    if (row.first_attempt_at < windowStart) {
      await db
        .prepare(
          `UPDATE login_attempts
           SET fail_count = 1, locked_until = NULL,
               first_attempt_at = ?, last_attempt_at = ?
           WHERE ip = ?`,
        )
        .bind(nowStr, nowStr, ip)
        .run();
      return;
    }

    const nextCount = row.fail_count + 1;
    const reachThreshold = nextCount >= LOGIN_FAIL_THRESHOLD;
    await db
      .prepare(
        `UPDATE login_attempts
         SET fail_count = ?, locked_until = ?, last_attempt_at = ?
         WHERE ip = ?`,
      )
      .bind(nextCount, reachThreshold ? lockUntil : row.locked_until, nowStr, ip)
      .run();
  } catch (err) {
    console.error('[loginAttempts] 写 login_attempts 失败，fail-soft 忽略', err);
  }
}

/** 成功后清掉该 IP 的失败计数行。fail-soft。 */
export async function clearLoginFailures(db: D1Database, ip: string): Promise<void> {
  try {
    await db.prepare(`DELETE FROM login_attempts WHERE ip = ?`).bind(ip).run();
  } catch (err) {
    console.error('[loginAttempts] 清 login_attempts 失败，fail-soft 忽略', err);
  }
}


