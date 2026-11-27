/**
 * M7-29b/c：登记信息 registry 代理与本地 D1 同步。
 * SPILL-1c-node-a：人口学 / 明文 email 已从 registry DROP；PATCH 仅允许 email。
 */
import type { Env } from '../env';
import { resolveIdentityDb } from '../db/bindings';
import { readPublicProfileEmailVerified } from './publicProfileKv';

/** SPILL-1c：registry 侧仅 email 可改；人口学字段一律拒绝 */
const PATCHABLE_KEYS = ['email'] as const;
const REMOVED_DEMOGRAPHICS_KEYS = ['birth_date', 'country', 'phone', 'gender'] as const;

export type RegistrationProfilePatchKey = (typeof PATCHABLE_KEYS)[number];

export type RegistrationProfilePatchBody = Partial<
  Record<RegistrationProfilePatchKey, unknown>
> &
  Partial<Record<(typeof REMOVED_DEMOGRAPHICS_KEYS)[number], unknown>>;

/** 本地登记副本：注册成功时写入 system_config / users，供 GET 补空与注册中心暂不可用时回落。 */
export type LocalRegistrationProfileFallback = {
  /** HANDLE-SLIM：本中心短名（来自 users.handle） */
  readonly handle_local: string | null;
  /** HANDLE-SLIM：对外正式名（来自 system_config.handle_qualified；缺则回退短名） */
  readonly handle_qualified: string | null;
  /** M7-37：登记邮箱（来自 users.registration_email，登记时写入，仅本人可见） */
  readonly registration_email: string | null;
  readonly terms_version: string | null;
  readonly terms_accepted_at: string | null;
  readonly registered: boolean;
};

/** Worker A 代理前校验：拒绝已 DROP 的人口学字段，避免无效请求打到注册中心。 */
export function prevalidateRegistrationProfilePatch(
  body: RegistrationProfilePatchBody,
): { ok: true } | { ok: false; error_code: string; message: string; status: number } {
  for (const key of REMOVED_DEMOGRAPHICS_KEYS) {
    if (Object.prototype.hasOwnProperty.call(body, key) && body[key] !== undefined) {
      return {
        ok: false,
        error_code: 'DEMOGRAPHICS_REMOVED',
        message: '出生日期、国家、手机与性别已下架，无法再通过登记资料修改',
        status: 400,
      };
    }
  }
  return { ok: true };
}

/**
 * M7-41b：登记邮箱**认证完成后**禁止再改（未认证仍可改，即使已有邮箱）。
 * 判定权威 = 本节点公开资料蓝标 email_verified（认证成功时写入）。
 * 同值幂等 PATCH 放行，避免无意义 409。
 */
export async function assertRegistrationEmailWritable(
  env: Env,
  body: RegistrationProfilePatchBody,
): Promise<{ ok: true } | { ok: false; error_code: string; message: string; status: number }> {
  if (!('email' in body) || body.email === undefined) return { ok: true };
  // 中文注释：未认证（蓝标 false）允许改邮箱；认证完成后硬锁
  const verified = await readPublicProfileEmailVerified(env);
  if (!verified) return { ok: true };
  const local = await readLocalRegistrationProfileFallback(env);
  const next = typeof body.email === 'string' ? body.email.trim() : '';
  if (
    local.registration_email &&
    next &&
    next.toLowerCase() === local.registration_email.toLowerCase()
  ) {
    return { ok: true };
  }
  return {
    ok: false,
    error_code: 'REGISTRATION_EMAIL_LOCKED',
    message: '登记邮箱已通过认证，不可再修改',
    status: 409,
  };
}

/**
 * M7-41：中心已有邮箱、本节点 users.registration_email 仍为空时回填。
 * 覆盖「登记早于 M7-36 列」的旧节点，让 /auth/me 与个人主页能显示。
 */
export async function backfillLocalRegistrationEmailIfEmpty(
  env: Env,
  email: unknown,
): Promise<void> {
  if (typeof email !== 'string') return;
  const trimmed = email.trim();
  if (!trimmed) return;
  const local = await readLocalRegistrationProfileFallback(env);
  if (local.registration_email) return;
  await resolveIdentityDb(env)
    .prepare(`UPDATE users SET registration_email = ?`)
    .bind(trimmed)
    .run();
}

export { syncLocalEmailVerifiedAfterEmailPatch } from './registryEmailCertify';

/**
 * 读本节点登记时落盘的 handle / 许可版本。
 * 注册中心响应缺字段或暂不可用时，设置页只读栏不再空白。
 */
export async function readLocalRegistrationProfileFallback(
  env: Env,
): Promise<LocalRegistrationProfileFallback> {
  const identityDb = resolveIdentityDb(env);
  const [
    userRow,
    handleQualifiedRow,
    termsVersionRow,
    termsAcceptedRow,
    ownerIdRow,
  ] = await Promise.all([
    identityDb
      .prepare(
        // M7-37：登记邮箱（站主私人数据）一并读出——认证页 fallback 与邮箱通道绕开同时受益
        `SELECT handle, registration_email FROM users LIMIT 1`,
      )
      .first<{ handle: string | null; registration_email: string | null }>(),
    identityDb
      .prepare(`SELECT value FROM system_config WHERE key = 'handle_qualified' LIMIT 1`)
      .first<{ value: string }>(),
    identityDb
      .prepare(`SELECT value FROM system_config WHERE key = 'register_terms_version' LIMIT 1`)
      .first<{ value: string }>(),
    identityDb
      .prepare(`SELECT value FROM system_config WHERE key = 'register_terms_accepted_at' LIMIT 1`)
      .first<{ value: string }>(),
    identityDb
      .prepare(`SELECT value FROM system_config WHERE key = 'owner_user_id' LIMIT 1`)
      .first<{ value: string }>(),
  ]);

  // HANDLE-SLIM：短名来自 users.handle；正式名优先 system_config
  const handleLocal = userRow?.handle?.trim().toLowerCase() || null;
  const handleQualified =
    handleQualifiedRow?.value?.trim() || handleLocal || null;
  // M7-37：登记邮箱由本节点 users.registration_email 权威；不存在 / NULL / 空串都视为"未填写"
  const registrationEmailRaw = userRow?.registration_email?.trim() ?? '';
  const registrationEmail = registrationEmailRaw || null;
  const termsVersion = termsVersionRow?.value?.trim() || null;
  const termsAcceptedAt = termsAcceptedRow?.value?.trim() || null;
  const registered = Boolean(ownerIdRow?.value?.trim() || handleLocal);

  return {
    handle_local: handleLocal,
    handle_qualified: handleQualified,
    registration_email: registrationEmail,
    terms_version: termsVersion,
    terms_accepted_at: termsAcceptedAt,
    registered,
  };
}

/** 把本地副本填进登记档案 data；仅覆盖空串 / null / 缺字段，不覆盖中心已有真值。 */
export function enrichRegistrationProfileData(
  data: Record<string, unknown>,
  local: LocalRegistrationProfileFallback,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...data };
  // 中文注释：SPILL-1c — 响应面剥离人口学（纯 JS 可抽检，勿用 as const）
  for (const key of ['birth_date', 'country', 'phone', 'gender']) {
    delete next[key];
  }
  // HANDLE-SLIM：响应面去掉已废弃的 user_name
  delete next.user_name;

  const empty = (v: unknown): boolean =>
    v === undefined || v === null || (typeof v === 'string' && v.trim() === '');

  if (empty(next.handle_local) && local.handle_local) {
    next.handle_local = local.handle_local;
  }
  if (empty(next.handle_qualified) && local.handle_qualified) {
    next.handle_qualified = local.handle_qualified;
  }
  // M7-37：邮箱授权点 = 本节点 users.registration_email；本节点有值就强制覆盖（避免无端到注册中心）
  // 中心 email_verified / email_status / cert_inbound_* 等认证态字段仍以中心为准
  if (local.registration_email) {
    next.email = local.registration_email;
  }
  if (empty(next.terms_version) && local.terms_version) {
    next.terms_version = local.terms_version;
  }
  if (empty(next.terms_accepted_at) && local.terms_accepted_at) {
    next.terms_accepted_at = local.terms_accepted_at;
  }
  return next;
}

/**
 * M7-41b：合并「中心认证态 + 本节点蓝标」→ 响应面 email_verified。
 * 设置页据此决定登记邮箱是否只读（认证完成 → 只读）。
 */
export function resolveRegistrationEmailVerified(
  data: Record<string, unknown>,
  localVerified: boolean,
): boolean {
  if (data.email_verified === true) return true;
  if (typeof data.email_status === 'string' && data.email_status.trim() === 'verified') {
    return true;
  }
  return localVerified;
}

/**
 * M7-38：读本节点自己的 handle（users.handle）。
 * 用于认证请求带上 handle，让注册中心显式校验「这个 handle 是不是这个节点的」，
 * 与签名 + node_api_token 构成三重归属校验。
 */
export async function readLocalNodeHandle(env: Env): Promise<string | null> {
  const row = await resolveIdentityDb(env)
    .prepare(`SELECT handle FROM users LIMIT 1`)
    .first<{ handle: string | null }>();
  const handle = row?.handle?.trim();
  return handle || null;
}

/**
 * SPILL-1c：人口学已从 registry DROP，本地 users 副本不再同步 birth_date/country/phone/gender。
 * email 验证态同步走 syncLocalEmailVerifiedAfterEmailPatch。
 *
 * M7-38：PATCH email 成功后，把登记邮箱同步写入本节点 users.registration_email。
 * M7-41：首次填写后本地已锁；本函数仍负责首次写入双写。
 */
export async function syncLocalRegistrationProfileFromPatch(
  env: Env,
  patch: RegistrationProfilePatchBody,
): Promise<void> {
  // 中文注释：人口学字段已下架，只同步 email；未携带 email 时不动本地
  if (!('email' in patch) || patch.email === undefined) return;
  const raw = patch.email;
  if (typeof raw !== 'string') return;
  const email = raw.trim();
  if (!email) return;

  // 中文注释：只更新本节点的登记邮箱；不触碰其它列（handle / pubkey / worker_b_url）
  // 本节点 users 表只有站主一行（handle 为主键），故整表 UPDATE 等价于定点更新
  await resolveIdentityDb(env)
    .prepare(`UPDATE users SET registration_email = ?`)
    .bind(email)
    .run();
}
