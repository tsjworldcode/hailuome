/**
 * 站主会话：登录 / 校验 / 登出（Web 整站门禁共用）
 *
 * §F-02：Worker A 地址仅经 auth.getWorkerAUrl 运行时读取，不读 import.meta.env。
 */

import {
  clearOwnerJwt,
  clearFollowerToken,
  clearWorkerAUrl,
  getOwnerJwt,
  resolveWorkerAUrl,
  setOwnerJwt,
  setWorkerAUrl,
  stripTrailingSlash,
  writeFollowerTokenRememberPref,
} from './auth';
import { ApiError } from './errors';
import { clearAll } from './localDb';
import { clearDmSessionSecrets, setDmKekMaterial } from './dmSession';
import {
  clearPrivateNotesSessionSecrets,
  hydratePrivateNotesMasterKey,
} from './privateNotesService';
import { purgeLegacyDmIdbStores } from './dmLocalDb';
import { buildLoginPasswordHash } from './ownerPassword';
import { createWorkerAClient, type OwnerProfile } from './workerA';
import { hydrateDmWrappedIdentity, hydrateDmWrappedKeys } from './dmService';
import { ensureVault, rebuildVaultOuter, VaultUnrecoverableError } from './ensureVault';
import { setVaultUnlockFailed } from './vaultSession';
import { migrateLegacyWrapsToVault } from './migrateLegacyWrapsToVault';
import { OWNER_SESSION_WORKER_B_URL_KEY } from './deployEnv';

export interface OwnerSession {
  readonly handle: string;
  readonly mustChangeCredentials: boolean;
  readonly legacyMode: boolean;
}

export interface LoginOwnerInput {
  readonly username: string;
  readonly password: string;
  /** M12-1：第二步登录 TOTP */
  readonly totpCode?: string;
  /** M12-1：或恢复码 */
  readonly recoveryCode?: string;
}

const OWNER_SESSION_HANDLE_KEY = 'hailuo:owner-handle';
const OWNER_SESSION_DISPLAY_NAME_KEY = 'hailuo:owner-display-name';

export interface CachedOwnerIdentity {
  readonly handle: string;
  readonly displayName: string;
  /** M7-30g-4：公开基址展示用（换域后随 getMe 更新） */
  readonly workerBUrl?: string;
}

/** 读取最近一次已校验站主 handle；只作首屏显示兜底，不替代 JWT 鉴权。 */
export function readCachedOwnerHandle(): string | null {
  if (typeof window === 'undefined') return null;
  return window.sessionStorage.getItem(OWNER_SESSION_HANDLE_KEY);
}

export function readCachedOwnerIdentity(): CachedOwnerIdentity | null {
  if (typeof window === 'undefined') return null;
  const handle = window.sessionStorage.getItem(OWNER_SESSION_HANDLE_KEY);
  if (!handle) return null;
  return {
    handle,
    displayName: window.sessionStorage.getItem(OWNER_SESSION_DISPLAY_NAME_KEY) ?? '',
    workerBUrl: window.sessionStorage.getItem(OWNER_SESSION_WORKER_B_URL_KEY) ?? undefined,
  };
}

function writeCachedOwnerIdentity(
  profile: Pick<OwnerProfile, 'handle' | 'display_name' | 'worker_b_url'>,
): void {
  if (typeof window === 'undefined') return;
  window.sessionStorage.setItem(OWNER_SESSION_HANDLE_KEY, profile.handle);
  window.sessionStorage.setItem(OWNER_SESSION_DISPLAY_NAME_KEY, profile.display_name ?? '');
  const workerB = typeof profile.worker_b_url === 'string' ? profile.worker_b_url.trim() : '';
  if (workerB) {
    window.sessionStorage.setItem(OWNER_SESSION_WORKER_B_URL_KEY, stripTrailingSlash(workerB));
  }
}

/** URL 格式校验（与 Settings 同源）+ 常见部署卡片误粘贴修正 */
export function validateWorkerAUrl(raw: string): { ok: true; normalized: string } | { ok: false; reason: string } {
  let trimmed = raw.trim();
  if (!trimmed) return { ok: false, reason: '地址不能为空' };

  // 部署卡片旧版或复制截断：缺 .workers.dev 后缀（如 …worker-a.<account-subdomain>）
  try {
    const probe = new URL(trimmed);
    if (
      probe.protocol === 'https:' &&
      probe.hostname.includes('.') &&
      !probe.hostname.endsWith('.workers.dev') &&
      !probe.hostname.endsWith('.pages.dev') &&
      /^[a-z0-9-]+\.[a-z0-9-]+$/i.test(probe.hostname)
    ) {
      trimmed = `${trimmed.replace(/\/+$/, '')}.workers.dev`;
    }
  } catch {
    /* 下方统一校验 */
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, reason: '地址格式不合法（需以 http:// 或 https:// 开头）' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: '仅支持 http:// 或 https:// 协议' };
  }
  if (!parsed.host) return { ok: false, reason: '地址缺少主机名' };
  if (
    parsed.protocol === 'https:' &&
    !parsed.hostname.endsWith('.workers.dev') &&
    !parsed.hostname.endsWith('.pages.dev')
  ) {
    return { ok: false, reason: 'Worker A 地址通常应以 .workers.dev 结尾，请检查是否复制完整' };
  }
  return { ok: true, normalized: stripTrailingSlash(trimmed) };
}

function profileToSession(me: OwnerProfile, legacyMode = false): OwnerSession {
  return {
    handle: me.handle,
    mustChangeCredentials: me.must_change_credentials === true,
    legacyMode,
  };
}

function clearOwnerSessionStorage(): void {
  clearOwnerJwt();
  clearDmSessionSecrets();
  clearPrivateNotesSessionSecrets();
  // 共用电脑：清掉用户在 Settings 填写的写层地址，避免下一位用户继承旧站点的地址
  clearWorkerAUrl();
  if (typeof window !== 'undefined') {
    window.sessionStorage.removeItem(OWNER_SESSION_HANDLE_KEY);
    window.sessionStorage.removeItem(OWNER_SESSION_DISPLAY_NAME_KEY);
    window.sessionStorage.removeItem(OWNER_SESSION_WORKER_B_URL_KEY);
    window.sessionStorage.removeItem('hailuo:owner-session-id');
  }
  clearFollowerToken();
  // 共用电脑：关闭「记住浏览令牌」，避免下一位用户继承读帖凭证偏好。
  writeFollowerTokenRememberPref('off');
}

function replaceToLogin(): void {
  if (typeof window === 'undefined') return;
  // 半月前 b586c479 的形态 —— `window.location.replace('/')` 直接覆盖当前历史项；
  // 这样浏览器把这次导航视为"重置"，让 SiteAuthGate 在新页里正常走登录分支，
  // 不会被 View Transitions 复用旧 island 卡在登录后的壳里。
  window.location.replace('/');
}

/** 会话过期入口：同步清掉过期凭证，再回整站登录门禁 */
export function clearOwnerSessionForLogin(): void {
  clearOwnerSessionStorage();
  replaceToLogin();
}

/** 保存 Worker A 地址到 localStorage */
export function saveWorkerAUrl(raw: string): { ok: true; normalized: string } | { ok: false; reason: string } {
  const result = validateWorkerAUrl(raw);
  if (!result.ok) return result;
  setWorkerAUrl(result.normalized);
  return result;
}

/** 用现有 JWT 向 Worker A 校验会话；无效则清 JWT 并返回 null */
export async function tryRestoreOwnerSession(): Promise<OwnerSession | null> {
  const baseUrl = await resolveWorkerAUrl();
  const jwt = getOwnerJwt();
  if (!baseUrl || !jwt) return null;

  const client = createWorkerAClient({ baseUrl, getJwt: () => jwt });
  try {
    const me = await client.getMe();
    writeCachedOwnerIdentity(me);
    return profileToSession(me);
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      clearOwnerJwt();
    }
    return null;
  }
}

/** 站主登录；成功写入 sessionStorage JWT */
export async function loginOwner(input: LoginOwnerInput): Promise<OwnerSession> {
  const baseUrl = await resolveWorkerAUrl();
  if (!baseUrl) {
    throw new ApiError(0, { error_code: 'BAD_REQUEST' }, '此站点未绑定节点 API 入口，请检查部署配置 PUBLIC_WORKER_B_URL。');
  }
  const password = input.password;
  if (!password) {
    throw new ApiError(0, { error_code: 'BAD_REQUEST' }, '请输入登录密码');
  }
  const username = input.username.trim();
  const client = createWorkerAClient({ baseUrl, getJwt: () => null });
  const passwordHash = await buildLoginPasswordHash(baseUrl, username, password);
  const result = await client.login({
    username,
    passwordHash,
    ...(input.totpCode ? { totpCode: input.totpCode } : {}),
    ...(input.recoveryCode ? { recoveryCode: input.recoveryCode } : {}),
  });
  setOwnerJwt(result.token);
  setDmKekMaterial(passwordHash);
  if (result.session_id) {
    const { setStoredOwnerSessionId } = await import('./ownerUnreadStore');
    setStoredOwnerSessionId(result.session_id);
  }

  const authed = createWorkerAClient({ baseUrl, getJwt: () => result.token });
  const me = await authed.getMe();
  writeCachedOwnerIdentity(me);
  try {
    // M-VAULT-3/5：先打开保险箱；DM 新建 wrap 依赖 vault，失败时旧包裹仍可尝试 password 解
    await ensureVault(authed, passwordHash);
    setVaultUnlockFailed(false);
  } catch (err) {
    // VAULT-REPAIR-AUTO：旧外层与当前凭证不匹配（重部署/凭证重播种换 salt）时，
    // 旧外层已不可恢复；直接静默重建，站主无需理解或点击。失败才在设置页留一个重试入口。
    if (err instanceof VaultUnrecoverableError) {
      try {
        await rebuildVaultOuter(authed, passwordHash);
        setVaultUnlockFailed(false);
      } catch {
        setVaultUnlockFailed(true);
      }
    } else {
      // 网络/API 抖动：不重建（可能只是暂时读不到），保持静默
      setVaultUnlockFailed(false);
    }
  }
  try {
    await purgeLegacyDmIdbStores();
    await hydrateDmWrappedIdentity(authed, passwordHash);
    await hydrateDmWrappedKeys(authed, passwordHash);
    await hydratePrivateNotesMasterKey(authed, passwordHash);
  } catch {
    // 私信 / 私有记录 hydrate 失败不阻断登录
  }
  try {
    // M-VAULT-7：旧 password 包裹迁 vault；单类失败跳过，不阻断登录
    await migrateLegacyWrapsToVault(authed, passwordHash);
  } catch {
    // 迁移失败可下次登录再试
  }
  return profileToSession(me, result.legacy_mode === true);
}

/** 登出：先同步清本地 JWT / 粉丝 Token / 偏好，跳回登录门禁；Worker A 注销 / IDB 清库异步进行（不阻塞跳转） */
export function logoutOwnerAndReload(): void {
  // 同步清所有本机凭证，确保跳回首页后 SiteAuthGate 走 login 分支
  clearOwnerSessionStorage();
  // 异步清 IDB（不阻塞跳转；IDB 不可用也不应阻塞登出）
  void clearAll().catch(() => {});
  // 异步通知 Worker A 注销会话（不阻塞跳转；网络失败也不影响本地退出）
  void (async () => {
    try {
      const baseUrl = await resolveWorkerAUrl();
      const jwt = getOwnerJwt();
      if (baseUrl && jwt) {
        const ownerUnread = await import('./ownerUnreadStore');
        ownerUnread.stopOwnerUnreadPolling();
        ownerUnread.clearStoredOwnerSessionId();
        const client = createWorkerAClient({ baseUrl, getJwt: () => jwt });
        await client.logout({ sessionId: ownerUnread.getStoredOwnerSessionId() ?? undefined }).catch(() => {});
      }
    } catch {
      /* 网络失败不影响本地退出 */
    }
  })();
  // 跳回登录门禁（带随机 querystring 强制 cache miss，避免被旧 SPA 状态卡住）
  replaceToLogin();
}
