/**
 * M14-1 + M14-TOKEN-REQUIRED：读帖保护模式 SSOT（Worker A / Worker B / Web 同源解析）。
 *
 * 五档 canonical（勿改 `public-read` 语义）：
 *   - public-read：匿名可读（中间件 noop）
 *   - token-required：读帖必须合法粉丝 Token；签发**不查**关注表（挡路人，不挡会申请接口的人）
 *   - following-only：须在站主 follows 表（出站关注）
 *   - mutual-only：互粉 + proof
 *   - owner-only：不对外签发 / 读端拒绝 Bearer
 *
 * **SEC-AUDIT-ENFORCED-FORCE-2（现行产品）**：未配置时默认 `token-required`；
 * 站主可在 Settings 放宽到 `public-read` 或升更严档。程序强制锁默认**关闭**
 *（`FOLLOWER_TOKEN_MODE_FORCE_ENABLED=false`）；常量 `FOLLOWER_TOKEN_MODE_FORCED` 仅保留作可选再锁入口。
 * 注：遗留名 `enforced` 仍解析为 `following-only`——勿与默认档混用。
 */

/** Canonical 读帖保护模式（D1 / STATE_KV 写入值） */
export const FOLLOWER_TOKEN_MODES = [
  'public-read',
  'token-required',
  'following-only',
  'mutual-only',
  'owner-only',
] as const;

export type FollowerTokenMode = (typeof FOLLOWER_TOKEN_MODES)[number];

/**
 * 可选程序强制档（FORCE 再开时用）。产品默认档 = 同值 `token-required`，
 * 但 FORCE 关闭时走 D1/KV/env + Settings，不读本常量作运行时结果。
 */
export const FOLLOWER_TOKEN_MODE_FORCED: FollowerTokenMode = 'token-required';

/**
 * 未配置（空串 / 缺省）时的产品默认档。
 * FORCE-2：默认须凭证；站主可显式改成 public-read。
 */
export const FOLLOWER_TOKEN_MODE_DEFAULT: FollowerTokenMode = 'token-required';

/** 为 true 时运行时忽略 env / KV / D1 与 Settings 改档（现行产品默认关闭） */
export const FOLLOWER_TOKEN_MODE_FORCE_ENABLED = false as const;

/** FORCE 开启时返回 `FOLLOWER_TOKEN_MODE_FORCED`。 */
export function resolveForcedFollowerTokenMode(): FollowerTokenMode {
  return FOLLOWER_TOKEN_MODE_FORCED;
}

export function isFollowerTokenModeProgramForced(): boolean {
  // 常量可为 false as const；直接返回避免 `false === true` 触发 TS2367
  return FOLLOWER_TOKEN_MODE_FORCE_ENABLED;
}

/**
 * 粉丝 Token payload 中的 read_scope（protected 档签发时必填）。
 * 档位越高，要求的 scope 等级越高；高档 scope 可向下兼容低档节点。
 */
export const FOLLOWER_READ_SCOPES = ['token-required', 'following-only', 'mutual-only'] as const;

export type FollowerReadScope = (typeof FOLLOWER_READ_SCOPES)[number];

const MODE_RANK: Record<FollowerTokenMode, number> = {
  'public-read': 0,
  'token-required': 1,
  'following-only': 2,
  'mutual-only': 3,
  'owner-only': 4,
};

const READ_SCOPE_RANK: Record<FollowerReadScope, number> = {
  'token-required': 1,
  'following-only': 2,
  'mutual-only': 3,
};

/** Worker B origin 归一化：trim + 去尾斜杠（与 M10 normalizeDmPeerUrl 行为一致） */
export function normalizeWorkerBOrigin(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

/**
 * 读路径宽松解析：接受 canonical 五值 + 遗留 `enforced` alias。
 * 未知值回落 `FOLLOWER_TOKEN_MODE_DEFAULT`（勿静默公开）；**Worker B 热路径请用 `parseFollowerTokenModeForRead`**。
 */
export function normalizeFollowerTokenMode(raw: string | null | undefined): FollowerTokenMode {
  const parsed = parseFollowerTokenModeForRead(raw);
  return parsed.ok ? parsed.mode : FOLLOWER_TOKEN_MODE_DEFAULT;
}

/** Worker B 读路径严格解析：未设置 → 默认 `token-required`；非法字符串 ≠ 未设置。 */
export type FollowerTokenModeReadParse =
  | { ok: true; mode: FollowerTokenMode; unset: boolean }
  | { ok: false };

export function parseFollowerTokenModeForRead(
  raw: string | null | undefined,
): FollowerTokenModeReadParse {
  const v = typeof raw === 'string' ? raw.trim() : '';
  if (!v) {
    return { ok: true, mode: FOLLOWER_TOKEN_MODE_DEFAULT, unset: true };
  }
  if (v === 'enforced') {
    return { ok: true, mode: 'following-only', unset: false };
  }
  if ((FOLLOWER_TOKEN_MODES as readonly string[]).includes(v)) {
    return { ok: true, mode: v as FollowerTokenMode, unset: false };
  }
  return { ok: false };
}

/** PATCH body 是否接受该模式值（拒绝 `enforced` 与未知值） */
export function parseFollowerTokenModeForWrite(
  raw: string | null | undefined,
): FollowerTokenMode | null {
  const v = typeof raw === 'string' ? raw.trim() : '';
  if (!v || v === 'enforced') return null;
  if ((FOLLOWER_TOKEN_MODES as readonly string[]).includes(v)) {
    return v as FollowerTokenMode;
  }
  return null;
}

export function isProtectedFollowerTokenMode(mode: FollowerTokenMode): boolean {
  return mode !== 'public-read';
}

/**
 * 当前档是否需要 Worker B 媒体票据（`<img>` 无法带 Authorization）。
 * `owner-only` 走站主 JWT 读图，不在此列；`public-read` 匿名可读也不需要票据。
 */
export function modeWantsMediaTickets(mode: FollowerTokenMode): boolean {
  return (
    mode === 'token-required' ||
    mode === 'following-only' ||
    mode === 'mutual-only'
  );
}

/**
 * Worker B 校验 Token read_scope 是否满足当前节点模式。
 * `public-read` 不校验 scope；`owner-only` 由中间件在验签前短路。
 *
 * 兼容性：`following-only` / `mutual-only` scope 可访问更松的 `token-required` 节点；
 * 仅有 `token-required` scope 的 Token **不能**访问 `following-only` 节点（防松档钥匙越权）。
 */
export function checkReadScopeForMode(
  mode: FollowerTokenMode,
  tokenScope: FollowerReadScope | undefined,
): { ok: true } | { ok: false; error_code: 'TOKEN_SCOPE_INSUFFICIENT' } {
  if (mode === 'public-read' || mode === 'owner-only') {
    return { ok: true };
  }
  if (!tokenScope) {
    return { ok: false, error_code: 'TOKEN_SCOPE_INSUFFICIENT' };
  }
  const requiredRank = MODE_RANK[mode];
  const scopeRank = READ_SCOPE_RANK[tokenScope];
  if (scopeRank >= requiredRank) {
    return { ok: true };
  }
  return { ok: false, error_code: 'TOKEN_SCOPE_INSUFFICIENT' };
}
