/**
 * M34-1 / M13-4 / M34-5 / M13-17：站主在线心跳 + 未读轮询（单 timer）。
 * - 60s：先心跳，再刷新未读（可见时）
 * - M13-17：重复 start 幂等 + in-flight 共享；隐藏页暂停未读计数；恢复即刷；失败退避+抖动
 * - 心跳独立于未读：隐藏页仍按节拍心跳，避免 OWNER_SESSION_TTL（默认 300s）过期
 */
import { createWorkerAClient } from './workerA';
import { getOwnerJwt, resolveWorkerAUrl } from './auth';
import { ApiError } from './errors';
import { refreshUnreadDmCount } from './dmUnreadStore';
import { refreshUnreadNotificationCount } from './notificationsStore';
import { refreshUnreadFriendRequestCount } from './friendRequestUnreadStore';

export const OWNER_UNREAD_TICK_MS = 60_000;
/** 兼容 M-F5 / 旧引用 */
export const TICK_MS = OWNER_UNREAD_TICK_MS;
/** 页面刷新 / visibility 连发时节流，避免短时多次 D1 写 */
export const OWNER_HEARTBEAT_MIN_GAP_MS = 10_000;
/** 未读失败退避上限（仍远小于 session TTL，避免永久停刷） */
export const OWNER_UNREAD_BACKOFF_MAX_MS = 5 * 60_000;
const OWNER_SESSION_ID_KEY = 'hailuo:owner-session-id';

let pollTimer: ReturnType<typeof setInterval> | null = null;
let lastPulseAt = 0;
let presenceListenersInstalled = false;

/** 在途：整轮 tick / start 突发；并发调用共享同一 Promise */
let tickInflight: Promise<void> | null = null;
/** 在途：仅未读三路刷新 */
let unreadInflight: Promise<void> | null = null;
/** 连续未读失败次数（成功清零） */
let unreadFailStreak = 0;
/** 下次允许跑未读的墙钟时间（隐藏恢复 / 退避） */
let unreadNotBeforeMs = 0;

type VisibilityState = 'visible' | 'hidden';

let nowFn: () => number = () => Date.now();
let visibilityFn: () => VisibilityState = () => {
  if (typeof document === 'undefined') return 'visible';
  // DocumentVisibilityState 在部分 lib 仅含 visible|hidden；其它态按可见处理
  return document.visibilityState === 'hidden' ? 'hidden' : 'visible';
};
let randomFn: () => number = () => Math.random();

/** M13-17：是否应在当前可见性下刷未读（隐藏 → 否） */
export function shouldRefreshUnreadForVisibility(state: VisibilityState | string): boolean {
  return state === 'visible';
}

/**
 * M13-17：失败退避毫秒（指数 × 抖动）。failures=0 → 0。
 * 基线 = TICK_MS * 2^(failures-1)，封顶 BACKOFF_MAX；抖动 ∈ [0.7, 1.3)。
 */
export function computeUnreadBackoffMs(failures: number, random: () => number = Math.random): number {
  if (failures <= 0) return 0;
  const exp = Math.min(failures - 1, 4);
  const base = OWNER_UNREAD_TICK_MS * 2 ** exp;
  const capped = Math.min(base, OWNER_UNREAD_BACKOFF_MAX_MS);
  const jitter = 0.7 + random() * 0.6;
  return Math.floor(capped * jitter);
}

export function getStoredOwnerSessionId(): string | null {
  if (typeof window === 'undefined') return null;
  return window.sessionStorage.getItem(OWNER_SESSION_ID_KEY);
}

export function setStoredOwnerSessionId(sessionId: string | null | undefined): void {
  if (typeof window === 'undefined') return;
  if (sessionId) window.sessionStorage.setItem(OWNER_SESSION_ID_KEY, sessionId);
  else window.sessionStorage.removeItem(OWNER_SESSION_ID_KEY);
}

export function clearStoredOwnerSessionId(): void {
  setStoredOwnerSessionId(null);
}

/** 并行刷新通知、私信、好友请求未读数（in-flight 共享） */
export async function refreshOwnerUnreadCounts(): Promise<void> {
  if (unreadInflight) return unreadInflight;
  unreadInflight = (async () => {
    try {
      const results = await Promise.all([
        refreshUnreadNotificationCount(),
        refreshUnreadDmCount(),
        refreshUnreadFriendRequestCount(),
      ]);
      if (results.every((ok) => ok)) {
        unreadFailStreak = 0;
        unreadNotBeforeMs = 0;
      } else {
        unreadFailStreak += 1;
        const delay = computeUnreadBackoffMs(unreadFailStreak, randomFn);
        unreadNotBeforeMs = nowFn() + delay;
        console.warn('[ownerUnread] 未读刷新部分失败，已退避', {
          streak: unreadFailStreak,
          delayMs: delay,
          results,
        });
      }
    } finally {
      unreadInflight = null;
    }
  })();
  return unreadInflight;
}

function isRecoverableSessionError(err: unknown): boolean {
  return (
    err instanceof ApiError &&
    (err.code === 'SESSION_EXPIRED' || err.code === 'SESSION_NOT_FOUND')
  );
}

async function callHeartbeatOnce(sessionId: string | undefined): Promise<string | null> {
  const baseUrl = await resolveWorkerAUrl();
  const jwt = getOwnerJwt();
  if (!baseUrl || !jwt) return null;
  const client = createWorkerAClient({ baseUrl, getJwt: () => jwt });
  const data = await client.sessionHeartbeat({
    ...(sessionId ? { sessionId } : {}),
  });
  return data.session_id ?? null;
}

/**
 * 发送一次站主心跳。JWT 有效时旧 session 失效会清 id 并重试（兼容旧后端错误码）。
 * @param force 忽略节流（定时器 tick / 登录启动用）
 */
export async function runOwnerSessionHeartbeat(opts?: { force?: boolean }): Promise<void> {
  const jwt = getOwnerJwt();
  if (!jwt) return;

  const now = nowFn();
  if (!opts?.force && now - lastPulseAt < OWNER_HEARTBEAT_MIN_GAP_MS) return;

  try {
    const sid = await callHeartbeatOnce(getStoredOwnerSessionId() ?? undefined);
    if (sid) setStoredOwnerSessionId(sid);
    lastPulseAt = nowFn();
  } catch (err) {
    // M34-5：旧后端若仍返 SESSION_*，清 id 后无 session_id 再打一次
    if (!isRecoverableSessionError(err)) return;
    clearStoredOwnerSessionId();
    try {
      const sid = await callHeartbeatOnce(undefined);
      if (sid) setStoredOwnerSessionId(sid);
      lastPulseAt = nowFn();
    } catch {
      // 心跳失败不踢登录；JWT 失效由业务 401 处理
    }
  }
}

/** 页面进入 / 可见时补心跳（带节流） */
export function pulseOwnerSessionHeartbeat(): void {
  void runOwnerSessionHeartbeat({ force: false });
}

/**
 * 一轮：心跳（始终）+ 未读（仅可见且过退避窗）。
 * 并发调用共享同一 Promise。
 */
export async function runOwnerPresenceTick(opts?: {
  forceHeartbeat?: boolean;
  forceUnread?: boolean;
}): Promise<void> {
  if (tickInflight) return tickInflight;
  tickInflight = (async () => {
    try {
      await runOwnerSessionHeartbeat({ force: opts?.forceHeartbeat ?? true });
      const visible = shouldRefreshUnreadForVisibility(visibilityFn());
      const due = opts?.forceUnread === true || nowFn() >= unreadNotBeforeMs;
      if (visible && due) {
        await refreshOwnerUnreadCounts();
      }
    } finally {
      tickInflight = null;
    }
  })();
  return tickInflight;
}

function installPresenceListeners(): void {
  if (typeof window === 'undefined' || presenceListenersInstalled) return;
  presenceListenersInstalled = true;
  document.addEventListener('visibilitychange', () => {
    if (!getOwnerJwt()) return;
    if (document.visibilityState === 'visible') {
      // 恢复前台：立刻心跳（节流）+ 强制刷未读
      void runOwnerPresenceTick({ forceHeartbeat: false, forceUnread: true });
    }
    // 隐藏：不主动停 timer；tick 内跳过未读即可（心跳继续）
  });
  window.addEventListener('pageshow', () => {
    if (getOwnerJwt()) pulseOwnerSessionHeartbeat();
  });
}

/**
 * 登录 / 恢复会话 / 任意页面挂载后：立即心跳 + 未读，之后每 60s。
 * M13-17：timer 已在跑时不再叠并行突发，只共享 in-flight 补一次（心跳仍节流）。
 */
export function startOwnerUnreadPolling(): void {
  if (typeof window === 'undefined') return;
  installPresenceListeners();

  const alreadyRunning = pollTimer !== null;
  // 已在跑：合并到在途 tick，避免多 island / 重复 mount 打出第二套 4 路请求
  void runOwnerPresenceTick({
    forceHeartbeat: !alreadyRunning,
    forceUnread: true,
  });

  if (alreadyRunning) return;
  pollTimer = setInterval(() => {
    void runOwnerPresenceTick({ forceHeartbeat: true, forceUnread: false });
  }, OWNER_UNREAD_TICK_MS);
}

export function stopOwnerUnreadPolling(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  tickInflight = null;
  unreadInflight = null;
  unreadFailStreak = 0;
  unreadNotBeforeMs = 0;
  lastPulseAt = 0;
}

/** 显式别名：M34 文档口径 */
export const startOwnerSessionHeartbeat = startOwnerUnreadPolling;
export const stopOwnerSessionHeartbeat = stopOwnerUnreadPolling;

/** 契约 / 假时钟测专用：重置模块态并注入时钟 */
export function __resetOwnerUnreadPollingForTests(opts?: {
  now?: () => number;
  visibility?: () => VisibilityState;
  random?: () => number;
}): void {
  stopOwnerUnreadPolling();
  presenceListenersInstalled = false;
  nowFn = opts?.now ?? (() => Date.now());
  visibilityFn = opts?.visibility ?? (() => 'visible');
  randomFn = opts?.random ?? (() => Math.random());
}

export function __ownerUnreadPollingTestState(): {
  hasTimer: boolean;
  unreadFailStreak: number;
  unreadNotBeforeMs: number;
  hasTickInflight: boolean;
  hasUnreadInflight: boolean;
} {
  return {
    hasTimer: pollTimer !== null,
    unreadFailStreak,
    unreadNotBeforeMs,
    hasTickInflight: tickInflight !== null,
    hasUnreadInflight: unreadInflight !== null,
  };
}
