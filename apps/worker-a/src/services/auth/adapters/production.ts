/**
 * NCF-2B：生产 adapter — Env 只出现在本文件。
 */
import {
  comparePasswordHashProof,
  DUMMY_PASSWORD_HASH,
  signOwnerJWT,
  checkPasswordStrength,
  validatePasswordHashFormat,
  parsePasswordHashString,
  passwordKdfParamsFromStored,
  passwordKdfParamsFromDummyHash,
} from '@hailuo/shared-crypto';
import type { Env } from '../../../env';
import { resolveIdentityDb } from '../../../db/bindings';
import {
  checkLoginLockout,
  clearLoginFailures,
  recordLoginFailure,
} from '../../../lib/loginAttempts';
import {
  clearOwnerMustChangeCredentials,
  getOwnerMustChangeCredentials,
  isOwnerCredentialsEmpty,
  loadOwnerCredential,
} from '../../../lib/ownerCredentials';
import { migrateOwnerTotpUsername, evaluateLoginTotpStep } from '../../../lib/ownerTotp';
import { validateOwnerUsername } from '../changePasswordUtils';
import type {
  OwnerChangePasswordDeps,
  OwnerLoginDeps,
  OwnerLoginParamsDeps,
  OwnerMeDeps,
  OwnerPatchProfileDeps,
  OwnerPasswordParamsDeps,
  OwnerTotpManageDeps,
} from '../types';
import {
  loadOwnerRegistryIdentity,
  resolveOwnerDidV2,
  resolveOwnerHandleQualified,
  resolvePubkeyFingerprint,
} from '../ownerIdentityUtils';
import { readPublicProfileEmailVerified } from '../../../handlers/publicProfileKv';
import { PUBLIC_PROFILE_KV_KEY, type PublicOwnerProfile } from '@hailuo/shared-types';
import {
  createTotpSetup,
  disableOwnerTotp,
  enableTotpFromPending,
  getTotpStatus,
  rotateRecoveryCodes,
  verifyOwnerPasswordHash,
} from '../../../lib/ownerTotp';

const JWT_TTL_SEC = 86400;

/** NCF-2B-3：KDF 参数 adapter 共用片段 */
function createOwnerKdfParamsAdapter() {
  return {
    fromStored: (storedHash: string) => passwordKdfParamsFromStored(storedHash),
    dummy: () => passwordKdfParamsFromDummyHash(),
  };
}

function loginDiagEnabled(env: Env): boolean {
  return env.LOGIN_DIAG === 'true' || env.LOGIN_DIAG === '1';
}

export function createProductionOwnerLoginDeps(env: Env): OwnerLoginDeps {
  // M-OPT-SPLIT-3 试点：login_attempts 走 IDENTITY_DB。
  // M-OPT-SPLIT-4：owner_credentials / system_config 同库。
  // 闭包内捕获的 db 是稳定值；同 deps 内所有 repo 共用同一 binding。
  const identityDb = resolveIdentityDb(env);
  return {
    lockoutRepo: {
      check: (attemptKey) => checkLoginLockout(identityDb, attemptKey),
      recordFailure: (attemptKey) => recordLoginFailure(identityDb, attemptKey),
      clearFailures: (attemptKey) => clearLoginFailures(identityDb, attemptKey),
    },
    credentialsRepo: {
      isEmpty: () => isOwnerCredentialsEmpty(identityDb),
      loadByUsername: (username) => loadOwnerCredential(identityDb, username),
      getMustChange: () => getOwnerMustChangeCredentials(identityDb),
    },
    passwordProof: {
      compare: (clientHash, storedHash) => comparePasswordHashProof(clientHash, storedHash),
      dummyStoredHash: () => DUMMY_PASSWORD_HASH,
    },
    totpGate: {
      evaluate: (username, input) => evaluateLoginTotpStep(identityDb, env, username, input),
    },
    jwtIssuer: {
      async sign(handle, options) {
        const token = await signOwnerJWT(handle, env.JWT_SECRET, JWT_TTL_SEC, options);
        return {
          token,
          expiresAtIso: new Date(Date.now() + JWT_TTL_SEC * 1000).toISOString(),
        };
      },
    },
    bootstrap: {
      jwtSecretConfigured: () => Boolean(env.JWT_SECRET && env.JWT_SECRET.length > 0),
      legacySecretExpected: () => env.JWT_SECRET ?? '',
      ownerHandle: (fallbackUsername) => env.BOOTSTRAP_HANDLE ?? fallbackUsername,
    },
    clock: { nowIso: () => new Date().toISOString() },
    logger: {
      warn: (msg, detail) => (detail === undefined ? console.warn(msg) : console.warn(msg, detail)),
      error: (msg, detail) => (detail === undefined ? console.error(msg) : console.error(msg, detail)),
      diag: (outcome, detail) => {
        if (!loginDiagEnabled(env)) return;
        // 防身份关联：diag 不得含密码/JWT_SECRET/完整 hash；attemptKey 亦不写入此处 detail 基线
        console.info('[auth/login/diag/full] ' + JSON.stringify({ outcome, ...detail }));
      },
    },
    jwtTtlSec: JWT_TTL_SEC,
  };
}

/** M10-3 / M10-5c / M11-6：改密成功 re-wrap 提示（adapter 查库，核心不碰 Env） */
async function buildChangePasswordRewrapHints(
  env: Env,
  extra: Record<string, unknown> = {},
) {
  const [dmRow, notesRow, groupRow] = await Promise.all([
    env.MESSAGING_DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM dm_wrapped_keys) +
         (SELECT COUNT(*) FROM dm_wrapped_identity) AS dm_n`,
    )
      .first<{ dm_n: number }>()
      .catch(() => null),
    resolveIdentityDb(env).prepare(`SELECT COUNT(*) AS notes_n FROM private_notes_wrapped_key`)
      .first<{ notes_n: number }>()
      .catch(() => null),
    // 群密钥与 DM 同属 password_hash 派生 KEK；漏 rewrap 会导致发群只见「发送失败」
    env.MESSAGING_DB.prepare(`SELECT COUNT(*) AS group_n FROM group_wrapped_keys`)
      .first<{ group_n: number }>()
      .catch(() => null),
  ]);
  return {
    rotated_at: new Date().toISOString(),
    requires_dm_key_rewrap: (dmRow?.dm_n ?? 0) > 0,
    requires_notes_key_rewrap: (notesRow?.notes_n ?? 0) > 0,
    requires_group_key_rewrap: (groupRow?.group_n ?? 0) > 0,
    ...extra,
  };
}

/** NCF-2B-2：改密生产 deps */
export function createProductionOwnerChangePasswordDeps(env: Env): OwnerChangePasswordDeps {
  // M-OPT-SPLIT-4：owner_credentials / system_config 走 IDENTITY_DB。
  const identityDb = resolveIdentityDb(env);
  return {
    credentialsRepo: {
      isEmpty: () => isOwnerCredentialsEmpty(identityDb),
      loadByUsername: (username) => loadOwnerCredential(identityDb, username),
      async insertCredential({ username, passwordHash, iterations, saltHex }) {
        await identityDb.prepare(
          `INSERT INTO owner_credentials
             (username, password_hash, algo, iterations, salt)
           VALUES (?, ?, 'PBKDF2-SHA256', ?, ?)`,
        )
          .bind(username, passwordHash, iterations, saltHex)
          .run();
      },
      async updatePassword({ username, passwordHash, iterations, saltHex }) {
        await identityDb.prepare(
          `UPDATE owner_credentials
              SET password_hash = ?, algo = 'PBKDF2-SHA256', iterations = ?, salt = ?,
                  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
            WHERE username = ?`,
        )
          .bind(passwordHash, iterations, saltHex, username)
          .run();
      },
      async replaceUsername({ fromUsername, toUsername, passwordHash, iterations, saltHex }) {
        await identityDb.batch([
          identityDb.prepare(`DELETE FROM owner_credentials WHERE username = ?`).bind(fromUsername),
          identityDb.prepare(
            `INSERT INTO owner_credentials (username, password_hash, algo, iterations, salt)
             VALUES (?, ?, 'PBKDF2-SHA256', ?, ?)`,
          ).bind(toUsername, passwordHash, iterations, saltHex),
        ]);
      },
      async usernameExists(username) {
        const row = await loadOwnerCredential(identityDb, username);
        return Boolean(row);
      },
    },
    mustChangeRepo: {
      get: () => getOwnerMustChangeCredentials(identityDb),
      clear: () => clearOwnerMustChangeCredentials(identityDb),
    },
    passwordProof: {
      compare: (clientHash, storedHash) => comparePasswordHashProof(clientHash, storedHash),
    },
    passwordFormat: {
      validateNewHash: (hash) => validatePasswordHashFormat(hash),
      checkStrength: (plain) => checkPasswordStrength(plain),
      parseHash: (hash) => {
        const parsed = parsePasswordHashString(hash);
        return parsed ? { iterations: parsed.iterations, saltHex: parsed.saltHex } : null;
      },
    },
    bootstrap: {
      legacySecretExpected: () => env.JWT_SECRET ?? '',
      bootstrapHandle: (jwtSub) => env.BOOTSTRAP_HANDLE ?? jwtSub,
    },
    totpMigration: {
      migrateUsername: (fromUsername, toUsername) =>
        migrateOwnerTotpUsername(identityDb, fromUsername, toUsername),
    },
    rewrapHints: {
      buildSuccessData: (extra) => buildChangePasswordRewrapHints(env, extra ?? {}),
    },
    usernameRules: {
      validate: (username) => validateOwnerUsername(username),
    },
    clock: { nowIso: () => new Date().toISOString() },
    logger: {
      error(message, err) {
        console.error(message, err);
      },
    },
  };
}

/** NCF-2B-3：GET /auth/login-params 生产 deps */
export function createProductionOwnerLoginParamsDeps(env: Env): OwnerLoginParamsDeps {
  // M-OPT-SPLIT-4：owner_credentials 走 IDENTITY_DB。
  const identityDb = resolveIdentityDb(env);
  return {
    credentialsRepo: {
      isEmpty: () => isOwnerCredentialsEmpty(identityDb),
      loadByUsername: (username) => loadOwnerCredential(identityDb, username),
    },
    kdfParams: createOwnerKdfParamsAdapter(),
  };
}

/** NCF-2B-3：GET /auth/password-params 生产 deps */
export function createProductionOwnerPasswordParamsDeps(env: Env): OwnerPasswordParamsDeps {
  // M-OPT-SPLIT-4：owner_credentials 走 IDENTITY_DB。
  const identityDb = resolveIdentityDb(env);
  return {
    credentialsRepo: {
      loadByUsername: (username) => loadOwnerCredential(identityDb, username),
    },
    kdfParams: createOwnerKdfParamsAdapter(),
  };
}

/** NCF-2B-5：公开资料写入后同步 STATE_KV（adapter 层；合规字段不写入 KV） */
async function syncPublicProfileToKv(env: Env, handle: string): Promise<void> {
  const existingRaw = await env.STATE_KV.get(PUBLIC_PROFILE_KV_KEY, 'json').catch(() => null);
  const existingVerified = Boolean(
    existingRaw &&
      typeof existingRaw === 'object' &&
      (existingRaw as PublicOwnerProfile).email_verified === true,
  );

  const row = await resolveIdentityDb(env)
    .prepare(
      `SELECT handle, display_name, bio, pubkey, dm_pubkey, worker_b_url, avatar_key, contact_email, created_at
       FROM users WHERE handle = ? LIMIT 1`,
    )
    .bind(handle)
    .first<{
      handle: string;
      display_name: string;
      bio: string;
      pubkey: string;
      dm_pubkey: string;
      worker_b_url: string;
      avatar_key: string | null;
      contact_email: string;
      created_at: string;
    }>();
  if (!row) return;

  const profile: PublicOwnerProfile = {
    handle: row.handle,
    display_name: row.display_name,
    bio: row.bio,
    pubkey: row.pubkey,
    dm_pubkey: row.dm_pubkey ?? '',
    worker_b_url: row.worker_b_url,
    avatar_key: row.avatar_key ?? '',
    contact_email: row.contact_email ?? '',
    // SPILL-1c：不再读写人口学到公开 KV
    created_at: row.created_at,
    updated_at: new Date().toISOString(),
    email_verified: existingVerified,
  };
  // 公开资料是低频写入；写 STATE_KV 供 Worker B 无 D1 地公开读取。
  await env.STATE_KV.put(PUBLIC_PROFILE_KV_KEY, JSON.stringify(profile));
}

/** NCF-2B-4：GET /auth/me 生产 deps */
export function createProductionOwnerMeDeps(env: Env): OwnerMeDeps {
  // M-OPT-SPLIT-4：system_config 走 IDENTITY_DB。
  const identityDb = resolveIdentityDb(env);
  return {
    mustChangeRepo: {
      get: () => getOwnerMustChangeCredentials(identityDb),
    },
    registryIdentity: {
      load: () => loadOwnerRegistryIdentity(env),
    },
    userRepo: {
      async loadOwnerUser() {
        return resolveIdentityDb(env)
          .prepare(
            `SELECT handle, display_name, bio, pubkey, dm_pubkey, worker_b_url, avatar_key, contact_email, registration_email, created_at FROM users LIMIT 1`,
          )
          .first<{
            handle: string;
            display_name: string;
            bio: string;
            pubkey: string;
            dm_pubkey: string;
            worker_b_url: string;
            avatar_key: string | null;
            contact_email: string;
            registration_email: string | null;
            created_at: string;
          }>()
          .catch(() => null);
      },
      async countFollowing() {
        const row = await resolveIdentityDb(env)
          .prepare(`SELECT COUNT(*) AS n FROM follows`)
          .first<{ n: number }>()
          .catch(() => null);
        return row?.n ?? 0;
      },
    },
    profileMeta: {
      emailVerified: () => readPublicProfileEmailVerified(env),
    },
    identityResolve: {
      pubkeyFingerprint: (pubkeyHex, cachedFingerprint) =>
        resolvePubkeyFingerprint(env, pubkeyHex, cachedFingerprint),
      didV2: (cachedDid, pubkeyHex) => resolveOwnerDidV2(cachedDid, pubkeyHex),
      handleQualified: (handle, cached) => resolveOwnerHandleQualified(env, handle, cached),
    },
    bootstrap: {
      fallbackHandle: (jwtSub) => env.BOOTSTRAP_HANDLE ?? jwtSub,
      fallbackPubkey: () => env.ED25519_PUBLIC_KEY ?? '',
      workerBUrl: () => env.WORKER_B_URL ?? '',
    },
  };
}

/** NCF-2B-5：PATCH /auth/profile 生产 deps */
export function createProductionOwnerPatchProfileDeps(env: Env): OwnerPatchProfileDeps {
  return {
    userRepo: {
      async getOwnerHandle() {
        const row = await resolveIdentityDb(env)
          .prepare(`SELECT handle FROM users LIMIT 1`)
          .first<{ handle: string }>()
          .catch(() => null);
        return row?.handle ?? null;
      },
      async updateProfile({ handle, displayName, bio, avatarKey, contactEmail }) {
        await resolveIdentityDb(env)
          .prepare(
            `UPDATE users
               SET display_name = ?, bio = ?, avatar_key = NULLIF(?, ''), contact_email = ?
             WHERE handle = ?`,
          )
          .bind(displayName, bio, avatarKey, contactEmail, handle)
          .run();
      },
      async loadOwnerUserByHandle(handle) {
        return resolveIdentityDb(env)
          .prepare(
            `SELECT handle, display_name, bio, pubkey, dm_pubkey, worker_b_url, avatar_key, contact_email, registration_email, created_at
               FROM users WHERE handle = ? LIMIT 1`,
          )
          .bind(handle)
          .first<{
            handle: string;
            display_name: string;
            bio: string;
            pubkey: string;
            dm_pubkey: string;
            worker_b_url: string;
            avatar_key: string | null;
            contact_email: string;
            registration_email: string | null;
            created_at: string;
          }>()
          .catch(() => null);
      },
    },
    publicProfile: {
      syncToKv: (handle) => syncPublicProfileToKv(env, handle),
    },
    registryIdentity: {
      load: () => loadOwnerRegistryIdentity(env),
    },
    identityResolve: {
      pubkeyFingerprint: (pubkeyHex, cachedFingerprint) =>
        resolvePubkeyFingerprint(env, pubkeyHex, cachedFingerprint),
      didV2: (cachedDid, pubkeyHex) => resolveOwnerDidV2(cachedDid, pubkeyHex),
    },
    logger: {
      error(message, err) {
        console.error(message, err);
      },
    },
  };
}

/** NCF-2B-6：TOTP 管理生产 deps（业务仍在 lib/ownerTotp；核心只编排密码闸 + 映射） */
export function createProductionOwnerTotpManageDeps(env: Env): OwnerTotpManageDeps {
  // M-OPT-SPLIT-4：owner_totp_* 表走 IDENTITY_DB。
  const identityDb = resolveIdentityDb(env);
  return {
    passwordProof: {
      verify: (username, passwordHash) => verifyOwnerPasswordHash(identityDb, username, passwordHash),
    },
    totp: {
      getStatus: (username) => getTotpStatus(identityDb, username),
      createSetup: (username, label) => createTotpSetup(identityDb, env, username, label),
      enable: (username, totpCode) => enableTotpFromPending(identityDb, env, username, totpCode),
      disable: (username, input) => disableOwnerTotp(identityDb, env, username, input),
      rotate: (username, input) => rotateRecoveryCodes(identityDb, env, username, input),
    },
  };
}

export { JWT_TTL_SEC };
