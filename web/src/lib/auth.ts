// M7-1：凭证存取与粉丝 Token 自动获取
//
// 安全约定（见 web/AGENTS.md §安全红线）：
// - JWT 存 sessionStorage：关闭标签即失效，配合 Worker A `expires_at` 24h TTL
// - 粉丝 Token 默认 sessionStorage（M7-18）；勾选「记住我」后存 localStorage，24h TTL + 60s 预过期
// - Worker A URL 存 localStorage：用户在 M7-5 设置页配置；§F-02 红线要求 URL 不进客户端 bundle，故运行时从用户输入读取
//
// 本模块仅做"存取 + 形态校验"，不做任何 fetch；网络调用由 api.ts / workerA.ts 完成。

import type { ReadMutualProof } from '@hailuo/shared-types';
import { ApiError } from './errors';
import { fetchReadMutualProofForTarget } from './readMutualProofClient';
import {
  readDeployEndpoint,
  resolveDeployEndpoint,
  toBrowserApiBaseUrl,
} from './deployEndpoint';

// =====================================================================
// 存储 key 常量
// =====================================================================

const SK = {
  /** sessionStorage：站主 JWT */
  OWNER_JWT: 'hailuo:owner-jwt',
} as const;

const LK = {
  /** localStorage / sessionStorage：粉丝 Token（24h TTL）；存储介质由 remember 偏好决定 */
  FOLLOWER_TOKEN: 'hailuo:follower-token',
  /** localStorage / sessionStorage：粉丝 Token expires_at（unix ms） */
  FOLLOWER_TOKEN_EXPIRES_AT: 'hailuo:follower-token-expires-at',
  /** localStorage only：粉丝 Token 是否跨会话保留（'on' | 'off'，默认 off → sessionStorage） */
  FOLLOWER_TOKEN_REMEMBER: 'hailuo:follower-token-remember',
  /**
   * localStorage：本节点写层地址（§F-02 红线：不从 env 注入，由用户登录后在 M7-5 设置页手动填写）。
   * JS 标识符与 storage key 都故意避开 `WORKER_A_URL` 与 `worker-a` 字面量，
   * 避免与构建脚本里的 env 变量名重名 + 避免本字符串在 dist bundle 中被红线扫描误报为 URL 字面量泄露。
   * M7-3 起 Settings.tsx / Composer.tsx 会把 auth.ts 整体打包进 dist，故 storage key 必须与 `worker-a` 彻底解耦。
   */
  PRIVATE_ENDPOINT_URL: 'hailuo:endpoint',
} as const;

/** 粉丝 Token「记住我」偏好（仅偏好位存 localStorage） */
export type FollowerTokenRememberPref = 'on' | 'off';

const PRE_EXPIRE_MS = 60_000;

function tokenKeyPart(value: string): string {
  const normalized = stripTrailingSlash(value.trim());
  try {
    return new URL(normalized).origin;
  } catch {
    return normalized;
  }
}

function followerTokenKey(workerBUrl?: string, followerNodeUrl?: string): string {
  const normalized = workerBUrl ? stripTrailingSlash(workerBUrl.trim()) : '';
  if (!normalized) return LK.FOLLOWER_TOKEN;
  const follower = followerNodeUrl ? `:${tokenKeyPart(followerNodeUrl)}` : '';
  return `${LK.FOLLOWER_TOKEN}:${tokenKeyPart(normalized)}${follower}`;
}

function followerTokenExpiresKey(workerBUrl?: string, followerNodeUrl?: string): string {
  return `${followerTokenKey(workerBUrl, followerNodeUrl)}:expires-at`;
}

// =====================================================================
// 类型
// =====================================================================

/**
 * 后端 `POST /api/follower-tokens` 成功响应（per docs/worker-b-api.md）。
 * Worker B 通过 Service Binding 转发到 Worker A，返回结构一致。
 */
export interface IssueFollowerTokenResponse {
  readonly token: string;
  /** ISO 8601 字符串（per Worker A 实装） */
  readonly expires_at: string;
}

/** Worker B/A 标准包络 `{ ok: true, data: T }` → 取出 data（兼容旧版扁平体） */
function unwrapFollowerTokenPayload(parsed: unknown): IssueFollowerTokenResponse | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  if (obj.ok === true && obj.data && typeof obj.data === 'object') {
    const inner = obj.data as Record<string, unknown>;
    if (typeof inner.token === 'string' && typeof inner.expires_at === 'string') {
      return { token: inner.token, expires_at: inner.expires_at };
    }
    return null;
  }
  if (typeof obj.token === 'string' && typeof obj.expires_at === 'string') {
    return { token: obj.token, expires_at: obj.expires_at };
  }
  return null;
}

// =====================================================================
// 站主 JWT（sessionStorage）
// =====================================================================

/** 取当前会话 JWT；未登录返回 null */
export function getOwnerJwt(): string | null {
  if (typeof window === 'undefined') return null;
  return window.sessionStorage.getItem(SK.OWNER_JWT);
}

/** 保存 JWT；登录成功后调用 */
export function setOwnerJwt(jwt: string): void {
  if (typeof window === 'undefined') return;
  window.sessionStorage.setItem(SK.OWNER_JWT, jwt);
}

/** 清除 JWT；登出 / 401 后调用 */
export function clearOwnerJwt(): void {
  if (typeof window === 'undefined') return;
  window.sessionStorage.removeItem(SK.OWNER_JWT);
}

/**
 * OWNER-RENAME：从当前 JWT 里读站主登录名（`oun`）。
 * 只用于设置页展示「当前登录名」和判重；不是鉴权依据，读不到就返回空串。
 */
export function getOwnerLoginUsername(): string {
  const jwt = getOwnerJwt();
  if (!jwt) return '';
  const part = jwt.split('.')[1];
  if (!part) return '';
  try {
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const payload = JSON.parse(atob(padded)) as { oun?: unknown };
    return typeof payload.oun === 'string' ? payload.oun : '';
  } catch {
    return '';
  }
}

// =====================================================================
// 粉丝 Token（sessionStorage 默认；remember=on → localStorage）
// =====================================================================

/** 读取「记住我」偏好；SSR → off；升级前仅有 localStorage Token 视为 on */
export function readFollowerTokenRememberPref(): FollowerTokenRememberPref {
  if (typeof window === 'undefined') return 'off';
  const raw = window.localStorage.getItem(LK.FOLLOWER_TOKEN_REMEMBER);
  if (raw === 'on' || raw === 'off') return raw;
  // M7-18 向前兼容：升级前 Token 只写在 localStorage
  if (window.localStorage.getItem(LK.FOLLOWER_TOKEN)) return 'on';
  return 'off';
}

/**
 * 写入「记住我」偏好并在切换时迁移 Token（localStorage ↔ sessionStorage）。
 * 偏好本身始终存 localStorage。
 */
export function writeFollowerTokenRememberPref(pref: FollowerTokenRememberPref): void {
  if (typeof window === 'undefined') return;
  const prev = readFollowerTokenRememberPref();
  window.localStorage.setItem(LK.FOLLOWER_TOKEN_REMEMBER, pref);
  if (prev !== pref) {
    migrateFollowerTokenBetweenStores(pref);
  }
}

function followerTokenStore(pref: FollowerTokenRememberPref = readFollowerTokenRememberPref()): Storage {
  return pref === 'on' ? window.localStorage : window.sessionStorage;
}

/** 切换 remember 时把 Token 从旧介质搬到新介质，避免重复两份 */
function migrateFollowerTokenBetweenStores(targetPref: FollowerTokenRememberPref): void {
  if (typeof window === 'undefined') return;
  const from = targetPref === 'on' ? window.sessionStorage : window.localStorage;
  const to = followerTokenStore(targetPref);
  const keys: string[] = [];
  for (let i = 0; i < from.length; i++) {
    const key = from.key(i);
    if (
      key === LK.FOLLOWER_TOKEN ||
      key === LK.FOLLOWER_TOKEN_EXPIRES_AT ||
      key?.startsWith(`${LK.FOLLOWER_TOKEN}:`)
    ) {
      keys.push(key);
    }
  }
  for (const key of keys) {
    const value = from.getItem(key);
    from.removeItem(key);
    if (value !== null) to.setItem(key, value);
  }
}

function clearFollowerTokenBothStores(): void {
  if (typeof window === 'undefined') return;
  for (const store of [window.localStorage, window.sessionStorage]) {
    const keys: string[] = [];
    for (let i = 0; i < store.length; i++) {
      const key = store.key(i);
      if (
        key === LK.FOLLOWER_TOKEN ||
        key === LK.FOLLOWER_TOKEN_EXPIRES_AT ||
        key?.startsWith(`${LK.FOLLOWER_TOKEN}:`)
      ) {
        keys.push(key);
      }
    }
    for (const key of keys) store.removeItem(key);
  }
}

function readFollowerTokenFromStore(store: Storage, workerBUrl?: string, followerNodeUrl?: string): string | null {
  const tokenKey = followerTokenKey(workerBUrl, followerNodeUrl);
  const expiresKey = followerTokenExpiresKey(workerBUrl, followerNodeUrl);
  let token = store.getItem(tokenKey);
  let expiresAtRaw = store.getItem(expiresKey);
  if (!token && !workerBUrl) {
    // 兼容升级前的单一 token；新 API 调用都会传 workerBUrl，必须按目标节点重新取牌。
    token = store.getItem(LK.FOLLOWER_TOKEN);
    expiresAtRaw = store.getItem(LK.FOLLOWER_TOKEN_EXPIRES_AT);
  }
  if (!token) return null;
  if (!expiresAtRaw) return token;
  const expiresAtMs = Number.parseInt(expiresAtRaw, 10);
  if (!Number.isFinite(expiresAtMs)) return token;
  if (Date.now() + PRE_EXPIRE_MS >= expiresAtMs) {
    return null;
  }
  return token;
}

/**
 * 取当前粉丝 Token；不存在或已本地预过期返回 null。
 *
 * 预过期阈值：距 expires_at 还剩 ≤ 60s 视为过期，避免临界点 401。
 */
export function getFollowerToken(workerBUrl?: string, followerNodeUrl?: string): string | null {
  if (typeof window === 'undefined') return null;
  const primary = followerTokenStore();
  const token = readFollowerTokenFromStore(primary, workerBUrl, followerNodeUrl);
  if (token) return token;
  // 偏好切换后可能仍残留在另一介质，读一次兜底后不再双写
  const fallback = primary === window.localStorage ? window.sessionStorage : window.localStorage;
  return readFollowerTokenFromStore(fallback, workerBUrl, followerNodeUrl);
}

/** 保存粉丝 Token 与 expires_at（ISO 字符串）；写入当前 remember 偏好对应的介质 */
export function setFollowerToken(token: string, expiresAtIso: string, workerBUrl?: string, followerNodeUrl?: string): void {
  if (typeof window === 'undefined') return;
  const expiresAtMs = Date.parse(expiresAtIso);
  const store = followerTokenStore();
  const tokenKey = followerTokenKey(workerBUrl, followerNodeUrl);
  const expiresKey = followerTokenExpiresKey(workerBUrl, followerNodeUrl);
  if (!workerBUrl) clearFollowerTokenBothStores();
  store.setItem(tokenKey, token);
  if (Number.isFinite(expiresAtMs)) {
    store.setItem(expiresKey, String(expiresAtMs));
  } else {
    store.removeItem(expiresKey);
  }
}

/** 清除粉丝 Token（两介质都清）；签发失败或被拉黑后调用 */
export function clearFollowerToken(): void {
  clearFollowerTokenBothStores();
}

// =====================================================================
// Worker A URL（localStorage；§F-02 不进客户端 bundle）
// =====================================================================

/** 取当前节点 API 入口；localStorage 优先，否则回落部署时注入的 Worker B 地址 */
export function getWorkerAUrl(): string | null {
  const deploy = readDeployEndpoint();
  if (typeof window === 'undefined') return deploy;
  const v = window.localStorage.getItem(LK.PRIVATE_ENDPOINT_URL);
  if (v && v.length > 0) return v;
  return deploy;
}

/** 异步解析当前节点 API 入口；会补读 deploy-env.json，适合登录后页面初始化 */
export async function resolveWorkerAUrl(): Promise<string | null> {
  // 优先：用户在 Settings 手动填写的写层地址（兼容旧版部署卡片 / M7-5）。
  // 若站点是 Pages 直管，且用户没在设置页填过，则 localStorage 应为空；不能在这里返回空字符串。
  if (typeof window !== 'undefined') {
    const v = window.localStorage.getItem(LK.PRIVATE_ENDPOINT_URL);
    if (v && v.length > 0) return v;
    // 兜底1：Layout 内联脚本注入（同步，页面加载即有）。**必须**经 toBrowserApiBaseUrl 改写：
    // 生产 Pages 下 Worker B 是私有化的，浏览器不能直连 .workers.dev 域名；要让登录走 Pages 同源代理。
    const inline = window.__HAILUO_DEPLOY__?.worker_b_url;
    if (typeof inline === 'string' && inline.trim()) {
      return toBrowserApiBaseUrl(inline.trim());
    }
  }
  // 兜底2：异步读 deploy-env.json（生产已自动走 Pages 同源代理）
  const raw = await resolveDeployEndpoint();
  return raw ?? '';
}

/** 保存节点写层地址（M7-5 设置页调用） */
export function setWorkerAUrl(url: string): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(LK.PRIVATE_ENDPOINT_URL, url);
}

/** 清除节点写层地址（登出 / 切换节点） */
export function clearWorkerAUrl(): void {
  if (typeof window === 'undefined') return;
  window.localStorage.removeItem(LK.PRIVATE_ENDPOINT_URL);
}

// =====================================================================
// 粉丝 Token 自动获取
// =====================================================================

/** 解码粉丝 Token payload 是否含 fan（互动身份用） */
function followerTokenPayloadHasFan(token: string): boolean {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return false;
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const json = atob(padded);
    const payload = JSON.parse(json) as { fan?: unknown };
    return typeof payload.fan === 'string' && payload.fan.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * 已存 Token 且未预过期则直接复用，否则向 Worker B 请求新 Token 并落盘。
 * mutual-only 目标在 403 NOT_MUTUAL_FOLLOW 时会经 Worker A 生成 read_mutual_proof 并重试。
 *
 * @param workerBUrl 目标节点 Worker B 基址
 * @param followerNodeUrl 读者节点 Worker B URL（写入 Token sub）
 * @param followerHandle 读者站主 handle（写入 Token fan）
 */
async function requestFollowerTokenFromWorkerB(
  workerBUrl: string,
  followerNodeUrl: string,
  followerHandle: string | null,
  readMutualProof?: ReadMutualProof,
): Promise<string> {
  const url = `${stripTrailingSlash(workerBUrl)}/api/follower-tokens`;
  const requestBody: Record<string, unknown> = {
    follower_node_url: followerNodeUrl,
  };
  if (followerHandle) {
    requestBody.follower_handle = followerHandle;
  }
  if (readMutualProof) {
    requestBody.read_mutual_proof = readMutualProof;
  }
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
    });
  } catch {
    throw new ApiError(0, { error_code: 'INTERNAL_ERROR' }, '网络异常，无法获取访问令牌');
  }

  const text = await resp.text();
  let parsed: unknown = null;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }

  if (!resp.ok) {
    const body = (parsed ?? null) as { error_code?: string; message?: string } | null;
    throw new ApiError(resp.status, body);
  }

  const data = unwrapFollowerTokenPayload(parsed);
  if (!data) {
    throw new ApiError(resp.status, { error_code: 'INTERNAL_ERROR' }, '访问令牌响应格式异常');
  }
  setFollowerToken(data.token, data.expires_at, workerBUrl, followerNodeUrl);
  return data.token;
}

export async function ensureFollowerToken(
  workerBUrl: string,
  followerNodeUrl: string,
  followerHandle?: string | null,
): Promise<string> {
  const handle = followerHandle?.trim() || null;
  const cached = getFollowerToken(workerBUrl, followerNodeUrl);
  if (cached && (!handle || followerTokenPayloadHasFan(cached))) return cached;

  try {
    return await requestFollowerTokenFromWorkerB(workerBUrl, followerNodeUrl, handle);
  } catch (err) {
    if (
      err instanceof ApiError &&
      err.code === 'NOT_MUTUAL_FOLLOW' &&
      !readMutualProofRetryDisabled()
    ) {
      const proof = await fetchReadMutualProofForTarget(workerBUrl);
      if (proof) {
        return await requestFollowerTokenFromWorkerB(
          workerBUrl,
          followerNodeUrl,
          handle,
          proof,
        );
      }
    }
    throw err;
  }
}

/** 测试钩子：禁用 mutual proof 自动重试 */
let disableMutualProofRetry = false;
export function __testOnlySetMutualProofRetryDisabled(value: boolean): void {
  disableMutualProofRetry = value;
}
function readMutualProofRetryDisabled(): boolean {
  return disableMutualProofRetry;
}

// =====================================================================
// 内部工具
// =====================================================================

/**
 * 去除 URL 末尾斜杠，便于与 path 拼接时不重复 `/`。
 * 同时供 api.ts / workerA.ts 复用。
 */
export function stripTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}
