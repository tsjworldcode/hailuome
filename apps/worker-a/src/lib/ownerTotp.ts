/**
 * M12-1：站主 TOTP D1 读写与登录二次验证逻辑。
 *
 * M-OPT-SPLIT-4（A-4）签名改造：所有涉及 IDENTITY_DB 的函数首参改为
 * `(db: D1Database, ...)`，由调用方注入 `resolveIdentityDb(env)` 结果。
 * `env.TOTP_WRAP_SECRET` 相关函数保持 `(env: Env)` 签名（不访问 D1）。
 *
 * 表归属（IDENTITY_DB）：
 *   owner_credentials / system_config / owner_totp_settings /
 *   owner_totp_pending / owner_totp_recovery_codes
 */

import {
  buildOtpauthUrl,
  comparePasswordHashProof,
  generateRecoveryCodes,
  generateTotpSecretBase32,
  hashRecoveryCode,
  normalizeRecoveryCode,
  unwrapTotpSecret,
  verifyTotp,
  wrapTotpSecret,
} from '@hailuo/shared-crypto';
import { generateId } from '@hailuo/shared-utils';
import type { Env } from '../env';

const PENDING_TTL_MS = 10 * 60 * 1000;
const OWNER_MUST_CHANGE_KEY = 'owner_must_change_credentials';

function nowIso(): string {
  return new Date().toISOString();
}

export interface OwnerTotpSettingsRow {
  username: string;
  secret_wrapped: string;
  issuer: string;
  label: string;
  period: number;
  digits: number;
  algorithm: string;
  enabled_at: string;
  last_used_counter: number | null;
}

export interface OwnerTotpPendingRow {
  username: string;
  secret_wrapped: string;
  issuer: string;
  label: string;
  period: number;
  digits: number;
  algorithm: string;
  expires_at: string;
}

export interface TotpStatusData {
  enabled: boolean;
  enabled_at: string | null;
  recovery_codes_remaining: number;
}

export type LoginTotpOutcome =
  | { kind: 'jwt_ready' }
  | { kind: 'totp_required' }
  | { kind: 'totp_invalid' }
  | { kind: 'recovery_invalid' };

// ── env-only helpers（不访问 D1）───────────────────────────────────────

function requireWrapSecret(env: Env): string | null {
  const secret = env.TOTP_WRAP_SECRET?.trim();
  return secret && secret.length >= 16 ? secret : null;
}

// ── IDENTITY_DB helpers ─────────────────────────────────────────────

async function isOwnerCredentialsEmptyDb(db: D1Database): Promise<boolean> {
  try {
    const row = await db.prepare(`SELECT COUNT(*) AS n FROM owner_credentials`).first<{ n: number }>();
    return !row || (row.n ?? 0) === 0;
  } catch {
    return true;
  }
}

async function getOwnerMustChangeCredentialsDb(db: D1Database): Promise<boolean> {
  try {
    const row = await db
      .prepare(`SELECT value FROM system_config WHERE key = ? LIMIT 1`)
      .bind(OWNER_MUST_CHANGE_KEY)
      .first<{ value: string }>();
    return row?.value === 'true';
  } catch {
    return false;
  }
}

async function loadOwnerCredentialHash(db: D1Database, username: string): Promise<string | null> {
  try {
    // 必须 bind username。漏绑时 D1 直接报错；若再被吞掉，校验会一律失败，前端显示「账号或密码错误」。
    const row = await db
      .prepare(`SELECT password_hash FROM owner_credentials WHERE username = ? LIMIT 1`)
      .bind(username)
      .first<{ password_hash: string }>();
    return row?.password_hash ?? null;
  } catch (err) {
    console.error('[totp] 读取站主密码哈希失败', err);
    return null;
  }
}

async function loadOwnerTotpSettings(db: D1Database, username: string): Promise<OwnerTotpSettingsRow | null> {
  try {
    return await db
      .prepare(
        `SELECT username, secret_wrapped, issuer, label, period, digits, algorithm, enabled_at, last_used_counter
         FROM owner_totp_settings WHERE username = ? LIMIT 1`,
      )
      .bind(username)
      .first<OwnerTotpSettingsRow>();
  } catch {
    return null;
  }
}

async function isOwnerTotpEnabled(db: D1Database, username: string): Promise<boolean> {
  const row = await loadOwnerTotpSettings(db, username);
  return Boolean(row?.enabled_at);
}

async function countUnusedRecoveryCodes(db: D1Database, username: string): Promise<number> {
  try {
    const row = await db
      .prepare(
        `SELECT COUNT(*) AS n FROM owner_totp_recovery_codes
         WHERE username = ? AND used_at IS NULL`,
      )
      .bind(username)
      .first<{ n: number }>();
    return row?.n ?? 0;
  } catch {
    return 0;
  }
}

async function purgeExpiredTotpPending(db: D1Database, username?: string): Promise<void> {
  const now = nowIso();
  try {
    if (username) {
      await db
        .prepare(`DELETE FROM owner_totp_pending WHERE username = ? AND expires_at <= ?`)
        .bind(username, now)
        .run();
    } else {
      await db.prepare(`DELETE FROM owner_totp_pending WHERE expires_at <= ?`).bind(now).run();
    }
  } catch (err) {
    console.error('[totp] 清理 pending 失败', err);
  }
}

async function loadPendingRow(db: D1Database, username: string): Promise<OwnerTotpPendingRow | null> {
  await purgeExpiredTotpPending(db, username);
  return db
    .prepare(
      `SELECT username, secret_wrapped, issuer, label, period, digits, algorithm, expires_at
       FROM owner_totp_pending WHERE username = ? LIMIT 1`,
    )
    .bind(username)
    .first<OwnerTotpPendingRow>()
    .catch(() => null);
}

async function unwrapSettingsSecret(env: Env, row: OwnerTotpSettingsRow): Promise<string | null> {
  const wrap = requireWrapSecret(env);
  if (!wrap) return null;
  try {
    return await unwrapTotpSecret(row.secret_wrapped, wrap);
  } catch {
    return null;
  }
}

async function unwrapPendingSecret(env: Env, row: OwnerTotpPendingRow): Promise<string | null> {
  const wrap = requireWrapSecret(env);
  if (!wrap) return null;
  try {
    return await unwrapTotpSecret(row.secret_wrapped, wrap);
  } catch {
    return null;
  }
}

async function insertRecoveryCodes(
  db: D1Database,
  username: string,
  codes: readonly string[],
): Promise<void> {
  const stmts = [];
  for (const code of codes) {
    const normalized = normalizeRecoveryCode(code);
    if (!normalized) continue;
    const codeHash = await hashRecoveryCode(normalized);
    stmts.push(
      db
        .prepare(
          `INSERT INTO owner_totp_recovery_codes (id, username, code_hash, created_at, used_at)
           VALUES (?, ?, ?, ?, NULL)`,
        )
        .bind(generateId('rc'), username, codeHash, nowIso()),
    );
  }
  if (stmts.length > 0) await db.batch(stmts);
}

// ── 公开导出（兼容壳）─────────────────────────────────────────────

/**
 * 判定是否允许配置 TOTP。
 *
 * @param db `D1Database` — IDENTITY_DB。
 * @param env `Env` — 用于读取 `TOTP_WRAP_SECRET`（非 DB）。
 */
export async function assertTotpManagementAllowed(db: D1Database, env: Env): Promise<
  | { ok: true }
  | { ok: false; error_code: string; message: string; status: number }
> {
  if (await isOwnerCredentialsEmptyDb(db)) {
    return {
      ok: false,
      error_code: 'TOTP_NOT_ENABLED',
      message: '请先完成站主凭证迁移后再配置二次验证',
      status: 400,
    };
  }
  if (await getOwnerMustChangeCredentialsDb(db)) {
    return {
      ok: false,
      error_code: 'BAD_REQUEST',
      message: '请先修改默认用户名和密码，再开启二次验证',
      status: 400,
    };
  }
  if (!requireWrapSecret(env)) {
    return {
      ok: false,
      error_code: 'INTERNAL_ERROR',
      message: '节点未配置 TOTP_WRAP_SECRET，无法启用二次验证',
      status: 500,
    };
  }
  return { ok: true };
}

/**
 * 读 owner_totp_settings 表。
 *
 * @param db `D1Database` — IDENTITY_DB。
 */
export async function loadOwnerTotpSettingsExport(
  db: D1Database,
  username: string,
): Promise<OwnerTotpSettingsRow | null> {
  return loadOwnerTotpSettings(db, username);
}

/**
 * 判定 TOTP 是否已启用。
 *
 * @param db `D1Database` — IDENTITY_DB。
 */
export async function isOwnerTotpEnabledExport(db: D1Database, username: string): Promise<boolean> {
  return isOwnerTotpEnabled(db, username);
}

/**
 * 清理过期 pending + 读 TOTP 状态。
 *
 * @param db `D1Database` — IDENTITY_DB。
 */
export async function getTotpStatus(db: D1Database, username: string): Promise<TotpStatusData> {
  await purgeExpiredTotpPending(db, username);
  const settings = await loadOwnerTotpSettings(db, username);
  if (!settings) {
    return { enabled: false, enabled_at: null, recovery_codes_remaining: 0 };
  }
  return {
    enabled: true,
    enabled_at: settings.enabled_at,
    recovery_codes_remaining: await countUnusedRecoveryCodes(db, username),
  };
}

/**
 * 校验站主密码 hash proof（登录 / step-up 共用）。
 *
 * @param db `D1Database` — IDENTITY_DB。
 */
export async function verifyOwnerPasswordHash(
  db: D1Database,
  username: string,
  passwordHash: string,
): Promise<boolean> {
  const stored = await loadOwnerCredentialHash(db, username);
  if (!stored) return false;
  return comparePasswordHashProof(passwordHash, stored);
}

/**
 * 发起 TOTP 设置（生成待启用密钥）。
 *
 * @param db `D1Database` — IDENTITY_DB。
 * @param env `Env` — 用于读取 `TOTP_WRAP_SECRET`（非 DB）。
 */
export async function createTotpSetup(
  db: D1Database,
  env: Env,
  username: string,
  label: string,
): Promise<
  | { ok: true; secret_base32: string; otpauth_url: string; expires_at: string }
  | { ok: false; error_code: string; message: string; status: number }
> {
  const allowed = await assertTotpManagementAllowed(db, env);
  if (!allowed.ok) return allowed;

  const existing = await loadOwnerTotpSettings(db, username);
  if (existing) {
    return {
      ok: false,
      error_code: 'TOTP_ALREADY_ENABLED',
      message: '二次验证已启用',
      status: 400,
    };
  }

  const wrap = requireWrapSecret(env)!;
  const secretBase32 = generateTotpSecretBase32();
  const secretWrapped = await wrapTotpSecret(secretBase32, wrap);
  const expiresAt = new Date(Date.now() + PENDING_TTL_MS).toISOString();
  const issuer = 'hailuo-node';

  try {
    await db
      .prepare(
        `INSERT INTO owner_totp_pending
         (username, secret_wrapped, issuer, label, period, digits, algorithm, expires_at)
         VALUES (?, ?, ?, ?, 30, 6, 'SHA1', ?)
         ON CONFLICT(username) DO UPDATE SET
           secret_wrapped = excluded.secret_wrapped,
           issuer = excluded.issuer,
           label = excluded.label,
           period = excluded.period,
           digits = excluded.digits,
           algorithm = excluded.algorithm,
           expires_at = excluded.expires_at`,
      )
      .bind(username, secretWrapped, issuer, label, expiresAt)
      .run();
  } catch (err) {
    // 常见根因：IDENTITY_DB 未 apply owner_totp migration（表在 GOVERNANCE 却读 IDENTITY）
    console.error('[totp] 写入 owner_totp_pending 失败', err);
    return {
      ok: false,
      error_code: 'INTERNAL_ERROR',
      message: '二次验证数据表未就绪，请确认已对 IDENTITY_DB 应用 owner_totp migration',
      status: 500,
    };
  }

  return {
    ok: true,
    secret_base32: secretBase32,
    otpauth_url: buildOtpauthUrl({ secretBase32, issuer, label }),
    expires_at: expiresAt,
  };
}

async function consumeRecoveryCode(
  db: D1Database,
  username: string,
  recoveryCode: string,
): Promise<boolean> {
  const normalized = normalizeRecoveryCode(recoveryCode);
  if (!normalized) return false;
  const codeHash = await hashRecoveryCode(normalized);
  const now = nowIso();
  const result = await db
    .prepare(
      `UPDATE owner_totp_recovery_codes
       SET used_at = ?
       WHERE username = ? AND code_hash = ? AND used_at IS NULL`,
    )
    .bind(now, username, codeHash)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

/**
 * 从待启用状态确认 TOTP。
 *
 * @param db `D1Database` — IDENTITY_DB。
 * @param env `Env` — 用于读取 `TOTP_WRAP_SECRET`（非 DB）。
 */
export async function enableTotpFromPending(
  db: D1Database,
  env: Env,
  username: string,
  totpCode: string,
): Promise<
  | { ok: true; recovery_codes: string[] }
  | { ok: false; error_code: string; message: string; status: number }
> {
  const allowed = await assertTotpManagementAllowed(db, env);
  if (!allowed.ok) return allowed;

  const pending = await loadPendingRow(db, username);
  if (!pending) {
    return {
      ok: false,
      error_code: 'TOTP_SETUP_EXPIRED',
      message: '二次验证设置已过期，请重新发起设置',
      status: 400,
    };
  }

  const secret = await unwrapPendingSecret(env, pending);
  if (!secret) {
    return {
      ok: false,
      error_code: 'INTERNAL_ERROR',
      message: '无法读取待启用密钥',
      status: 500,
    };
  }

  const verify = await verifyTotp(secret, totpCode, {
    period: pending.period,
    digits: pending.digits,
    algorithm: 'SHA1',
  });
  if (!verify.ok) {
    return {
      ok: false,
      error_code: 'TOTP_INVALID',
      message: '验证码不正确',
      status: 401,
    };
  }

  const enabledAt = nowIso();
  const recoveryCodes = generateRecoveryCodes(10);

  await db.batch([
    db
      .prepare(
        `INSERT INTO owner_totp_settings
         (username, secret_wrapped, issuer, label, period, digits, algorithm, enabled_at, last_used_counter, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        username,
        pending.secret_wrapped,
        pending.issuer,
        pending.label,
        pending.period,
        pending.digits,
        pending.algorithm,
        enabledAt,
        verify.counter ?? null,
        enabledAt,
        enabledAt,
      ),
    db.prepare(`DELETE FROM owner_totp_pending WHERE username = ?`).bind(username),
    db.prepare(`DELETE FROM owner_totp_recovery_codes WHERE username = ?`).bind(username),
  ]);

  await insertRecoveryCodes(db, username, recoveryCodes);

  return { ok: true, recovery_codes: recoveryCodes };
}

/**
 * 停用 TOTP。
 *
 * @param db `D1Database` — IDENTITY_DB。
 * @param env `Env` — 用于读取 `TOTP_WRAP_SECRET`（非 DB）。
 */
export async function disableOwnerTotp(
  db: D1Database,
  env: Env,
  username: string,
  input: { totpCode?: string; recoveryCode?: string },
): Promise<{ ok: true; disabled_at: string } | { ok: false; error_code: string; message: string; status: number }> {
  const settings = await loadOwnerTotpSettings(db, username);
  if (!settings) {
    return {
      ok: false,
      error_code: 'TOTP_NOT_ENABLED',
      message: '尚未启用二次验证',
      status: 400,
    };
  }

  const totpCode = input.totpCode?.trim() ?? '';
  const recoveryCode = input.recoveryCode?.trim() ?? '';

  if (totpCode) {
    const secret = await unwrapSettingsSecret(env, settings);
    if (!secret) {
      return { ok: false, error_code: 'INTERNAL_ERROR', message: '无法读取二次验证密钥', status: 500 };
    }
    const verify = await verifyTotp(secret, totpCode, {
      period: settings.period,
      digits: settings.digits,
      algorithm: 'SHA1',
      lastUsedCounter: settings.last_used_counter,
    });
    if (!verify.ok) {
      return { ok: false, error_code: 'TOTP_INVALID', message: '验证码不正确', status: 401 };
    }
  } else if (recoveryCode) {
    const ok = await consumeRecoveryCode(db, username, recoveryCode);
    if (!ok) {
      return { ok: false, error_code: 'RECOVERY_CODE_INVALID', message: '恢复码无效或已使用', status: 401 };
    }
  } else {
    return { ok: false, error_code: 'BAD_REQUEST', message: '请提供验证码或恢复码', status: 400 };
  }

  const disabledAt = nowIso();
  await db.batch([
    db.prepare(`DELETE FROM owner_totp_settings WHERE username = ?`).bind(username),
    db.prepare(`DELETE FROM owner_totp_pending WHERE username = ?`).bind(username),
    db.prepare(`DELETE FROM owner_totp_recovery_codes WHERE username = ?`).bind(username),
  ]);

  return { ok: true, disabled_at: disabledAt };
}

/**
 * 轮转恢复码。
 *
 * @param db `D1Database` — IDENTITY_DB。
 * @param env `Env` — 用于读取 `TOTP_WRAP_SECRET`（非 DB）。
 */
export async function rotateRecoveryCodes(
  db: D1Database,
  env: Env,
  username: string,
  input: { totpCode?: string; recoveryCode?: string },
): Promise<
  | { ok: true; recovery_codes: string[] }
  | { ok: false; error_code: string; message: string; status: number }
> {
  const settings = await loadOwnerTotpSettings(db, username);
  if (!settings) {
    return {
      ok: false,
      error_code: 'TOTP_NOT_ENABLED',
      message: '尚未启用二次验证',
      status: 400,
    };
  }

  const totpCode = input.totpCode?.trim() ?? '';
  const recoveryCode = input.recoveryCode?.trim() ?? '';

  if (totpCode) {
    const secret = await unwrapSettingsSecret(env, settings);
    if (!secret) {
      return { ok: false, error_code: 'INTERNAL_ERROR', message: '无法读取二次验证密钥', status: 500 };
    }
    const verify = await verifyTotp(secret, totpCode, {
      period: settings.period,
      digits: settings.digits,
      algorithm: 'SHA1',
      lastUsedCounter: settings.last_used_counter,
    });
    if (!verify.ok) {
      return { ok: false, error_code: 'TOTP_INVALID', message: '验证码不正确', status: 401 };
    }
    if (verify.counter !== undefined) {
      const upd = await db
        .prepare(
          `UPDATE owner_totp_settings SET last_used_counter = ?, updated_at = ? WHERE username = ?`,
        )
        .bind(verify.counter, nowIso(), username)
        .run();
      if ((upd.meta?.changes ?? 0) !== 1) {
        return { ok: false, error_code: 'TOTP_INVALID', message: '验证码不正确', status: 401 };
      }
    }
  } else if (recoveryCode) {
    const ok = await consumeRecoveryCode(db, username, recoveryCode);
    if (!ok) {
      return { ok: false, error_code: 'RECOVERY_CODE_INVALID', message: '恢复码无效或已使用', status: 401 };
    }
  } else {
    return { ok: false, error_code: 'BAD_REQUEST', message: '请提供验证码或恢复码', status: 400 };
  }

  const codes = generateRecoveryCodes(10);
  await db.prepare(`DELETE FROM owner_totp_recovery_codes WHERE username = ?`).bind(username).run();
  await insertRecoveryCodes(db, username, codes);
  return { ok: true, recovery_codes: codes };
}

/**
 * 登录时 TOTP 分支判定（未启用则直接 jwt_ready）。
 *
 * @param db `D1Database` — IDENTITY_DB。
 * @param env `Env` — 用于读取 `TOTP_WRAP_SECRET`（非 DB）。
 */
export async function evaluateLoginTotpStep(
  db: D1Database,
  env: Env,
  username: string,
  input: { totpCode?: string; recoveryCode?: string },
): Promise<LoginTotpOutcome> {
  const settings = await loadOwnerTotpSettings(db, username);
  if (!settings) return { kind: 'jwt_ready' };

  const totpCode = input.totpCode?.trim() ?? '';
  const recoveryCode = input.recoveryCode?.trim() ?? '';

  if (!totpCode && !recoveryCode) return { kind: 'totp_required' };

  if (totpCode) {
    const secret = await unwrapSettingsSecret(env, settings);
    if (!secret) return { kind: 'totp_invalid' };
    const verify = await verifyTotp(secret, totpCode, {
      period: settings.period,
      digits: settings.digits,
      algorithm: 'SHA1',
      lastUsedCounter: settings.last_used_counter,
    });
    if (!verify.ok) return { kind: 'totp_invalid' };
    if (verify.counter !== undefined) {
      // M7-30h-3：CAS 更新 counter，防并发 step-up/登录重放同一 TOTP
      const upd = await db
        .prepare(
          `UPDATE owner_totp_settings
              SET last_used_counter = ?, updated_at = ?
            WHERE username = ?
              AND (last_used_counter IS NULL OR last_used_counter < ?)`,
        )
        .bind(verify.counter, nowIso(), username, verify.counter)
        .run();
      if ((upd.meta?.changes ?? 0) !== 1) {
        return { kind: 'totp_invalid' };
      }
    }
    return { kind: 'jwt_ready' };
  }

  const ok = await consumeRecoveryCode(db, username, recoveryCode);
  return ok ? { kind: 'jwt_ready' } : { kind: 'recovery_invalid' };
}

/**
 * 改用户名时迁移 TOTP 三表。
 *
 * @param db `D1Database` — IDENTITY_DB。
 */
export async function migrateOwnerTotpUsername(
  db: D1Database,
  oldUsername: string,
  newUsername: string,
): Promise<void> {
  const now = nowIso();
  await db.batch([
    db
      .prepare(`UPDATE owner_totp_settings SET username = ?, label = ?, updated_at = ? WHERE username = ?`)
      .bind(newUsername, newUsername, now, oldUsername),
    db
      .prepare(`UPDATE owner_totp_pending SET username = ?, label = ? WHERE username = ?`)
      .bind(newUsername, newUsername, oldUsername),
    db
      .prepare(`UPDATE owner_totp_recovery_codes SET username = ? WHERE username = ?`)
      .bind(newUsername, oldUsername),
  ]).catch((err) => {
    console.error('[totp] 迁移 username 失败', err);
  });
}
