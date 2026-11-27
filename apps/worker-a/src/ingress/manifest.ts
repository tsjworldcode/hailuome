/**
 * NCF-INGRESS-1：Worker A 入口四态分类与关键路径 SSOT。
 * 契约见 docs/m-refactor-ncf-2-plan.md §3 / §5.11。
 */

export type IngressClass =
  | 'owner-gateway'
  | 'dev-only'
  | 'internal-service'
  | 'public';

/** 本地开发专用：生产必须 403，且禁止挂站主 JWT / Owner Gateway。 */
export const DEV_ONLY_PATHS = [
  '/api/local/setup-proof',
  '/api/local/save-node-creds',
] as const;

/**
 * 公开探活 / 登录入口（无站主 JWT）。
 * 注意：`/auth/*` 内其它写接口仍走 JWT（由 auth 子应用自行挂载）。
 */
export const PUBLIC_PATHS = [
  '/health',
  '/auth/login',
  '/auth/login-params',
  '/.well-known/hailuo-proof',
] as const;

/**
 * 内部 Service Binding + HMAC 入口（无站主 JWT）。
 * 路径为挂载前缀；子路径仍属 internal。
 */
export const INTERNAL_SERVICE_PREFIXES = [
  '/api/follower-tokens',
  '/api/node/events',
  '/api/internal',
  '/internal',
  '/dm',
  '/groups',
  '/interactions',
] as const;

/** NCF-INGRESS-1：已升格的原 legacy 路径（现为 owner-gateway）。 */
export const PROMOTED_FROM_LEGACY_PATHS = ['/api/local/register'] as const;

/** 禁止的 JWT star 挂载字面量（吞掉 dev-only）。 */
export const FORBIDDEN_LOCAL_JWT_STAR_PATTERNS = [
  "app.use('/api/local/*', requireOwnerJWT())",
  'app.use("/api/local/*", requireOwnerJWT())',
  "app.use('/api/local', requireOwnerJWT())",
  'app.use("/api/local", requireOwnerJWT())',
] as const;

export function isDevOnlyPath(pathname: string): boolean {
  return (DEV_ONLY_PATHS as readonly string[]).includes(pathname);
}

export function isPublicPath(pathname: string): boolean {
  return (PUBLIC_PATHS as readonly string[]).includes(pathname);
}

export function isInternalServicePath(pathname: string): boolean {
  return INTERNAL_SERVICE_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

/**
 * 粗粒度分类：优先 public → dev-only → internal → 默认 owner-gateway。
 * `/api/local/register` 已升格，归入 owner-gateway。
 */
export function classifyIngressPath(pathname: string): IngressClass {
  if (isPublicPath(pathname)) return 'public';
  if (isDevOnlyPath(pathname)) return 'dev-only';
  if (isInternalServicePath(pathname)) return 'internal-service';
  return 'owner-gateway';
}
