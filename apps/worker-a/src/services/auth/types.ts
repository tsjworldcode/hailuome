/**
 * NCF-2B：站主登录深模块 command / result / 窄依赖。
 * 契约见 docs/m-refactor-ncf-2-plan.md §5.3。
 */

export type OwnerLoginStatus =
  | 'ok'
  | 'invalid'
  | 'locked'
  | 'totp_required'
  | 'totp_invalid'
  | 'recovery_invalid'
  | 'misconfigured'
  | 'error';

export type OwnerLoginCommand = {
  /** 频控键（可信客户端 IP）；禁止写入对外 message / 回显字段 */
  attemptKey: string;
  username: string;
  /** 浏览器 PBKDF2 完整 v1 串；正式路径必填 */
  passwordHash: string;
  /** @deprecated 仅凭证表空时与 legacySecret 兼容 */
  passwordPlain?: string;
  legacySecret?: string;
  totpCode?: string;
  recoveryCode?: string;
};

export type OwnerLoginSuccessData = {
  token: string;
  expires_at: string;
  legacy_mode?: boolean;
  must_change_credentials?: boolean;
};

export type OwnerLoginResult = {
  status: OwnerLoginStatus;
  httpStatus: number;
  error_code?: string;
  message?: string;
  /** LOGIN_LOCKED 时与历史契约一致：顶层 locked_until */
  locked_until?: string;
  /** 成功时含 token；TOTP_REQUIRED 时仅 totp_required */
  data?: Partial<OwnerLoginSuccessData> & {
    totp_required?: boolean;
  };
};

export type OwnerCredential = {
  username: string;
  password_hash: string;
};

export type TotpGateOutcome =
  | { kind: 'jwt_ready' }
  | { kind: 'totp_required' }
  | { kind: 'totp_invalid' }
  | { kind: 'recovery_invalid' };

/** 窄依赖：核心禁止 Env / Hono Context */
export type OwnerLoginDeps = {
  lockoutRepo: {
    check(attemptKey: string): Promise<{ locked: boolean; lockedUntil?: string }>;
    recordFailure(attemptKey: string): Promise<void>;
    clearFailures(attemptKey: string): Promise<void>;
  };
  credentialsRepo: {
    isEmpty(): Promise<boolean>;
    loadByUsername(username: string): Promise<OwnerCredential | null>;
    getMustChange(): Promise<boolean>;
  };
  passwordProof: {
    compare(clientHash: string, storedHash: string): boolean;
    dummyStoredHash(): string;
  };
  totpGate: {
    evaluate(
      username: string,
      input: { totpCode?: string; recoveryCode?: string },
    ): Promise<TotpGateOutcome>;
  };
  jwtIssuer: {
    sign(
      handle: string,
      options?: { ownerUsername?: string },
    ): Promise<{ token: string; expiresAtIso: string }>;
  };
  bootstrap: {
    jwtSecretConfigured(): boolean;
    legacySecretExpected(): string;
    ownerHandle(fallbackUsername: string): string;
  };
  clock: { nowIso(): string };
  logger: {
    warn(msg: string, detail?: unknown): void;
    error(msg: string, detail?: unknown): void;
    /** LOGIN_DIAG 分支；不得含密码/secret/完整 hash */
    diag?(outcome: 'success' | 'reject', detail: Record<string, unknown>): void;
  };
  jwtTtlSec: number;
};

// ── NCF-2B-2：改密（JWT + 旧凭证二次校验；Worker 零 PBKDF2）──

export type OwnerChangePasswordStatus =
  | 'ok'
  | 'invalid'
  | 'weak_password'
  | 'same_password'
  | 'internal_error';

export type OwnerChangePasswordCommand = {
  /** JWT sub（登记前回落用） */
  jwtSub: string;
  /** JWT oun：站主登录用户名 */
  jwtOwnerUsername?: string;
  bootstrapHandle?: string;
  oldPassword?: string;
  /** @deprecated 迁移路径明文新密码强度校验 */
  newPassword?: string;
  oldPasswordHash?: string;
  newPasswordHash?: string;
  newUsername?: string;
};

export type OwnerChangePasswordSuccessData = {
  rotated_at: string;
  requires_dm_key_rewrap: boolean;
  requires_notes_key_rewrap: boolean;
  /** 存在 group_wrapped_keys 时须浏览器用旧 password_hash 解包再以新 hash 重包 */
  requires_group_key_rewrap: boolean;
  migrated_from_legacy?: boolean;
  username_changed_to?: string;
};

export type OwnerChangePasswordResult = {
  status: OwnerChangePasswordStatus;
  httpStatus: number;
  error_code?: string;
  message?: string;
  data?: OwnerChangePasswordSuccessData;
};

export type OwnerChangePasswordDeps = {
  credentialsRepo: {
    isEmpty(): Promise<boolean>;
    loadByUsername(username: string): Promise<OwnerCredential | null>;
    insertCredential(input: {
      username: string;
      passwordHash: string;
      iterations: number;
      saltHex: string;
    }): Promise<void>;
    updatePassword(input: {
      username: string;
      passwordHash: string;
      iterations: number;
      saltHex: string;
    }): Promise<void>;
    replaceUsername(input: {
      fromUsername: string;
      toUsername: string;
      passwordHash: string;
      iterations: number;
      saltHex: string;
    }): Promise<void>;
    usernameExists(username: string): Promise<boolean>;
  };
  mustChangeRepo: {
    get(): Promise<boolean>;
    clear(): Promise<void>;
  };
  passwordProof: {
    compare(clientHash: string, storedHash: string): boolean;
  };
  passwordFormat: {
    validateNewHash(hash: string): { ok: boolean; reason?: string };
    checkStrength(plain: string): { ok: boolean; reason?: string };
    parseHash(hash: string): { iterations: number; saltHex: string } | null;
  };
  bootstrap: {
    legacySecretExpected(): string;
    bootstrapHandle(jwtSub: string): string;
  };
  totpMigration: {
    migrateUsername(fromUsername: string, toUsername: string): Promise<void>;
  };
  rewrapHints: {
    buildSuccessData(
      extra?: Partial<Pick<OwnerChangePasswordSuccessData, 'migrated_from_legacy' | 'username_changed_to'>>,
    ): Promise<OwnerChangePasswordSuccessData>;
  };
  usernameRules: {
    validate(username: string): { ok: true } | { ok: false; reason: string };
  };
  clock: { nowIso(): string };
  logger: {
    error(message: string, err?: unknown): void;
  };
};

// ── NCF-2B-3：KDF 参数只读（login-params / password-params；Worker 零 PBKDF2）──

/** 与 shared-crypto PasswordKdfParams 字段一致 */
export type OwnerPasswordKdfParamsData = {
  kdf_version: string;
  kdf_algo: string;
  iterations: number;
  hash_name: string;
  salt_hex: string;
};

export type OwnerLoginParamsStatus = 'ok' | 'bad_request' | 'no_credentials' | 'internal_error';

export type OwnerLoginParamsCommand = {
  /** 路由 query username */
  username: string;
};

export type OwnerLoginParamsResult = {
  status: OwnerLoginParamsStatus;
  httpStatus: number;
  error_code?: string;
  message?: string;
  data?: OwnerPasswordKdfParamsData;
};

export type OwnerLoginParamsDeps = {
  credentialsRepo: {
    isEmpty(): Promise<boolean>;
    loadByUsername(username: string): Promise<OwnerCredential | null>;
  };
  kdfParams: {
    fromStored(storedHash: string): OwnerPasswordKdfParamsData | null;
    dummy(): OwnerPasswordKdfParamsData;
  };
};

export type OwnerPasswordParamsStatus = 'ok' | 'invalid' | 'internal_error';

export type OwnerPasswordParamsCommand = {
  /** JWT 解析后的站主登录用户名 */
  loginUser: string;
};

export type OwnerPasswordParamsResult = {
  status: OwnerPasswordParamsStatus;
  httpStatus: number;
  error_code?: string;
  message?: string;
  data?: OwnerPasswordKdfParamsData;
};

export type OwnerPasswordParamsDeps = {
  credentialsRepo: {
    loadByUsername(username: string): Promise<OwnerCredential | null>;
  };
  kdfParams: {
    fromStored(storedHash: string): OwnerPasswordKdfParamsData | null;
  };
};

// ── NCF-2B-4：站主信息聚合 GET /auth/me（D1 users + registry identity）──

export type OwnerMeUserRow = {
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
};

export type OwnerMeData = {
  handle: string;
  handle_qualified: string | null;
  display_name: string;
  bio: string;
  worker_b_url: string;
  avatar_key: string;
  contact_email: string;
  /** M7-34：登记邮箱，站主私人数据，仅本人可见 */
  registration_email: string;
  created_at: string;
  pubkey: string;
  dm_pubkey: string;
  registry_user_id: string;
  pubkey_fingerprint: string;
  did_v2: string;
  registered: boolean;
  following_count: number;
  email_verified?: boolean;
  must_change_credentials?: boolean;
};

export type OwnerMeStatus = 'ok';

export type OwnerMeCommand = {
  /** JWT sub（登记前回落用） */
  jwtSub: string;
};

export type OwnerMeResult = {
  status: OwnerMeStatus;
  httpStatus: number;
  data: OwnerMeData;
};

export type OwnerRegistryIdentitySnapshot = {
  userId: string;
  pubkeyFingerprint: string;
  didV2: string;
  handleQualified: string;
};

export type OwnerMeDeps = {
  mustChangeRepo: {
    get(): Promise<boolean>;
  };
  registryIdentity: {
    load(): Promise<OwnerRegistryIdentitySnapshot>;
  };
  userRepo: {
    loadOwnerUser(): Promise<OwnerMeUserRow | null>;
    countFollowing(): Promise<number>;
  };
  profileMeta: {
    emailVerified(): Promise<boolean>;
  };
  identityResolve: {
    pubkeyFingerprint(pubkeyHex: string, cachedFingerprint: string): Promise<string>;
    didV2(cachedDid: string, pubkeyHex: string): Promise<string>;
    handleQualified(handle: string, cached: string): Promise<string>;
  };
  bootstrap: {
    fallbackHandle(jwtSub: string): string;
    fallbackPubkey(): string;
    workerBUrl(): string;
  };
};

// ── NCF-2B-5：公开资料 PATCH /auth/profile（D1 写 + KV 同步）──

export type OwnerPatchProfileCommand = {
  body: Record<string, unknown>;
};

export type OwnerPatchProfileStatus =
  | 'ok'
  | 'bad_request'
  | 'use_registration_profile'
  | 'not_registered'
  | 'internal_error';

export type OwnerPatchProfileSuccessData = {
  handle: string;
  display_name: string;
  bio: string;
  worker_b_url: string;
  avatar_key: string;
  contact_email: string;
  created_at: string;
  pubkey: string;
  dm_pubkey: string;
  registry_user_id: string;
  pubkey_fingerprint: string;
  did_v2: string;
  registered: true;
};

export type OwnerPatchProfileResult = {
  status: OwnerPatchProfileStatus;
  httpStatus: number;
  error_code?: string;
  message?: string;
  data?: OwnerPatchProfileSuccessData;
};

export type OwnerPatchProfileDeps = {
  userRepo: {
    getOwnerHandle(): Promise<string | null>;
    updateProfile(input: {
      handle: string;
      displayName: string;
      bio: string;
      avatarKey: string;
      contactEmail: string;
    }): Promise<void>;
    loadOwnerUserByHandle(handle: string): Promise<OwnerMeUserRow | null>;
  };
  publicProfile: {
    syncToKv(handle: string): Promise<void>;
  };
  registryIdentity: {
    load(): Promise<OwnerRegistryIdentitySnapshot>;
  };
  identityResolve: {
    pubkeyFingerprint(pubkeyHex: string, cachedFingerprint: string): Promise<string>;
    didV2(cachedDid: string, pubkeyHex: string): Promise<string>;
  };
  logger: {
    error(message: string, err?: unknown): void;
  };
};

// ── NCF-2B-6：站主 TOTP 管理（/auth/totp/*；敏感材料不进日志）──

export type OwnerTotpStatusData = {
  enabled: boolean;
  enabled_at: string | null;
  recovery_codes_remaining: number;
};

/** lib/ownerTotp 失败形态；核心透传 error_code / message / httpStatus */
export type OwnerTotpLibFailure = {
  ok: false;
  error_code: string;
  message: string;
  status: number;
};

export type OwnerTotpManageDeps = {
  passwordProof: {
    verify(username: string, passwordHash: string): Promise<boolean>;
  };
  totp: {
    getStatus(username: string): Promise<OwnerTotpStatusData>;
    createSetup(
      username: string,
      label: string,
    ): Promise<
      | { ok: true; secret_base32: string; otpauth_url: string; expires_at: string }
      | OwnerTotpLibFailure
    >;
    enable(
      username: string,
      totpCode: string,
    ): Promise<{ ok: true; recovery_codes: string[] } | OwnerTotpLibFailure>;
    disable(
      username: string,
      input: { totpCode?: string; recoveryCode?: string },
    ): Promise<{ ok: true; disabled_at: string } | OwnerTotpLibFailure>;
    rotate(
      username: string,
      input: { totpCode?: string; recoveryCode?: string },
    ): Promise<{ ok: true; recovery_codes: string[] } | OwnerTotpLibFailure>;
  };
};

export type OwnerTotpStatusCommand = { username: string };
export type OwnerTotpStatusResult = {
  status: 'ok';
  httpStatus: 200;
  data: OwnerTotpStatusData;
};

export type OwnerTotpSetupCommand = {
  username: string;
  /** 展示用 label；通常与 username 相同 */
  label: string;
  passwordHash: string;
};
export type OwnerTotpSetupResult =
  | {
      status: 'ok';
      httpStatus: 200;
      data: { secret_base32: string; otpauth_url: string; expires_at: string };
    }
  | {
      status: 'auth_invalid' | 'op_failed';
      httpStatus: number;
      error_code: string;
      message: string;
    };

export type OwnerTotpEnableCommand = {
  username: string;
  passwordHash: string;
  totpCode: string;
};
export type OwnerTotpEnableResult =
  | {
      status: 'ok';
      httpStatus: 200;
      data: { enabled: true; recovery_codes: string[] };
    }
  | {
      status: 'auth_invalid' | 'bad_request' | 'op_failed';
      httpStatus: number;
      error_code: string;
      message: string;
    };

export type OwnerTotpDisableCommand = {
  username: string;
  passwordHash: string;
  totpCode?: string;
  recoveryCode?: string;
};
export type OwnerTotpDisableResult =
  | {
      status: 'ok';
      httpStatus: 200;
      data: { enabled: false; disabled_at: string };
    }
  | {
      status: 'auth_invalid' | 'op_failed';
      httpStatus: number;
      error_code: string;
      message: string;
    };

export type OwnerTotpRotateCommand = {
  username: string;
  passwordHash: string;
  totpCode?: string;
  recoveryCode?: string;
};
export type OwnerTotpRotateResult =
  | {
      status: 'ok';
      httpStatus: 200;
      data: { recovery_codes: string[] };
    }
  | {
      status: 'auth_invalid' | 'op_failed';
      httpStatus: number;
      error_code: string;
      message: string;
    };
