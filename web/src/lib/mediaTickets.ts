/**
 * SEC-AUDIT-2026-10-6b · 浏览器端媒体票据（批量取票 + URL 拼装 + 过期重取）。
 *
 * 【为什么需要】
 *   浏览器 `<img src>` 发不出 `Authorization` 头。节点处于 protected 档
 *   （`following-only` / `mutual-only`）时，`GET /img/:key` 必须带粉丝 Token，
 *   裸 URL 直连会被 401 拒绝 —— 前端只能退回 JS fetch → Blob（内存与 CPU 代价大，
 *   且失败时容易白屏）。Worker B 的 `POST /api/media/tickets`（SEC-AUDIT-2026-10-6a）
 *   提供了「URL 自带授权」的替代路径，本模块负责把它接进前端：
 *
 *   1. **批量取票**：一次最多 32 个 storage key，避免 N 张图 = N 次请求；
 *      同一时间窗内并发挂载的图片会被合并成一次请求（微批合并）。
 *   2. **URL 拼装**：把票据拼成 `<原 URL>?ticket=...`。
 *   3. **过期自动重取**：票据 TTL 只有 60s，缓存命中前留 10s 安全余量；
 *      图片加载被拒时可作废缓存重新取票再试一次。
 *
 * 【降级阶梯（由组件 MediaImage 执行）】
 *   裸 URL → 票据 URL → 换新票据重试一次 → Bearer fetch → Blob → 中性占位块。
 *   任何一步失败都不会白屏（占位块保证版面不塌）。
 *
 * 【会话级学习（省请求）】
 *   - `public-read` 档：裸 URL 直接可读，**不产生任何票据请求**（零额外开销）。
 *   - 一旦发现「裸 URL 失败但票据 URL 成功」，本会话标记为 protected 档，
 *     后续图片直接走票据路径，不再逐张试错（N 次失败 → 1 次失败 + 1 次批量取票）。
 *   - 票据端点被关闭（503 `MEDIA_TICKET_DISABLED`）时记住结果，不再反复重试。
 *
 * 【安全】
 *   - 票据只在本节点内存缓存，不落 localStorage / sessionStorage（票据在 URL 里，
 *     落盘会扩大泄露面）。
 *   - 票据值不写 console、不上报。
 *   - §F-02：本模块不含 Worker A 地址字面量，只面向 Worker B 公开读面。
 */

import { ensureFollowerToken } from './auth';
import { resolvePublicWorkerBBaseUrlSync } from './deployEnv';

/** 单次批量取票的最大 key 数（与 Worker B `MAX_MEDIA_TICKET_KEYS` 一致）。 */
export const MEDIA_TICKET_MAX_KEYS = 32;

/** 票据剩余寿命不足该秒数即视为过期（避免 URL 在途中失效）。 */
const TICKET_EXPIRY_MARGIN_SEC = 10;

/** 并发请求合并窗口（毫秒）：同一窗口内的取票请求合并成一次批量请求。 */
const BATCH_FLUSH_DELAY_MS = 25;

/** 解析出的媒体目标（origin + storage key）。 */
export interface MediaImageTarget {
  /** 图片所在 origin（票据端点与图片同源，便于同源代理转发） */
  readonly origin: string;
  /** 媒体 storage key（票据绑定单 key） */
  readonly storageKey: string;
}

/**
 * 从 `/img/<key>` URL 解析出票据所需信息；非媒体 URL 返回 null。
 */
export function parseMediaImageUrl(url: string): MediaImageTarget | null {
  if (!url) return null;
  try {
    const base =
      typeof window !== 'undefined' ? window.location.origin : 'https://localhost';
    const parsed = new URL(url, base);
    const match = parsed.pathname.match(/^\/img\/(.+)$/);
    if (!match) return null;
    const storageKey = decodeURIComponent(match[1] ?? '');
    if (!storageKey) return null;
    return { origin: parsed.origin, storageKey };
  } catch {
    return null;
  }
}

/**
 * 把票据拼到图片 URL 上（保留原有 query）。
 */
export function buildTicketedImageUrl(url: string, ticket: string): string {
  if (!url || !ticket) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}ticket=${encodeURIComponent(ticket)}`;
}

/** 票据缓存条目（仅内存）。 */
interface TicketCacheEntry {
  readonly ticket: string;
  /** 过期时间戳（毫秒） */
  readonly expiresAt: number;
}

/** SEC-AUDIT-2026-10-11 #6：会话级票据 Map 上限（LRU 按插入序；读命中会刷新） */
const TICKET_CACHE_MAX = 500;

const ticketCache = new Map<string, TicketCacheEntry>();

/**
 * 扫过期 + 超容淘汰最旧条目。
 * SEC-AUDIT-2026-10-17 #7：只在写票后且 size ≥ MAX 时调用，避免微批 32 次全量扫描。
 */
function pruneTicketCache(nowMs: number = Date.now()): void {
  for (const [key, entry] of ticketCache) {
    const remainSec = (entry.expiresAt - nowMs) / 1000;
    if (remainSec <= TICKET_EXPIRY_MARGIN_SEC) {
      ticketCache.delete(key);
    }
  }
  while (ticketCache.size > TICKET_CACHE_MAX) {
    const oldest = ticketCache.keys().next().value;
    if (oldest === undefined) break;
    ticketCache.delete(oldest);
  }
}

/**
 * 会话级标记：**按 origin** 记录「裸 URL 不可读、必须走票据」。
 *
 * 必须按 origin 分别记 —— 本站可能是 protected 档，而远端节点仍是 public-read；
 * 若用一个全局开关，远端节点的公开图也会被迫走票据（多一次必然失败的请求）。
 */
const protectedModeOrigins = new Set<string>();

/**
 * 会话级标记：**按 origin** 记录票据端点不可用（开关关闭 / secret 未配），不再重试。
 * 必须按 origin 分别记 —— 远端节点的票据能力可能与本站不同，不能一票否决。
 */
const ticketEndpointDisabledOrigins = new Set<string>();

/** 该 origin 是否已确认处于 protected 档（供组件跳过裸 URL 试错）。 */
export function isProtectedMediaModeDetected(origin?: string): boolean {
  if (origin) return protectedModeOrigins.has(origin);
  return protectedModeOrigins.size > 0;
}

/** 标记某 origin 为 protected 档（裸 URL 失败但票据 URL 成功时调用）。 */
export function markProtectedMediaModeDetected(origin?: string): void {
  if (origin) protectedModeOrigins.add(origin);
}

function cacheKey(origin: string, storageKey: string): string {
  return `${origin}|${storageKey}`;
}

/** 作废某张图的票据缓存（票据过期 / 加载被拒时调用）。 */
export function invalidateMediaTicket(url: string): void {
  const target = parseMediaImageUrl(url);
  if (!target) return;
  ticketCache.delete(cacheKey(target.origin, target.storageKey));
}

/** 读取缓存中的有效票据（剩余寿命需大于安全余量）。 */
function readCachedTicket(origin: string, storageKey: string): string | null {
  const key = cacheKey(origin, storageKey);
  const entry = ticketCache.get(key);
  if (!entry) return null;
  const now = Date.now();
  const remainSec = (entry.expiresAt - now) / 1000;
  if (remainSec <= TICKET_EXPIRY_MARGIN_SEC) {
    ticketCache.delete(key);
    return null;
  }
  // LRU：命中后挪到 Map 尾部
  ticketCache.delete(key);
  ticketCache.set(key, entry);
  return entry.ticket;
}

function writeCachedTicket(
  origin: string,
  storageKey: string,
  ticket: string,
  expiresAtIso: string,
): void {
  const expiresAt = Date.parse(expiresAtIso);
  if (!Number.isFinite(expiresAt)) return;
  const key = cacheKey(origin, storageKey);
  // 先删再写，保证同 key 刷新也落在尾部
  ticketCache.delete(key);
  ticketCache.set(key, { ticket, expiresAt });
  // SEC-AUDIT-2026-10-17 #7：未满容不 prune（微批 32 张时避免 32 次 O(n) 扫描）
  if (ticketCache.size >= TICKET_CACHE_MAX) {
    pruneTicketCache();
  }
}

/** 取票请求的等待者。 */
interface TicketWaiter {
  readonly origin: string;
  readonly storageKey: string;
  readonly resolve: (ticket: string | null) => void;
}

let pendingWaiters: TicketWaiter[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

/** 排队等待的取票请求（微批合并窗口）。 */
function enqueueWaiter(waiter: TicketWaiter): void {
  pendingWaiters.push(waiter);
  if (flushTimer === null) {
    flushTimer = setTimeout(() => {
      flushTimer = null;
      void flushWaiters();
    }, BATCH_FLUSH_DELAY_MS);
  }
}

/** 把等待者按 origin + key 分组，按 32 个一片批量取票。 */
async function flushWaiters(): Promise<void> {
  const batch = pendingWaiters;
  pendingWaiters = [];

  const byOrigin = new Map<string, Map<string, TicketWaiter[]>>();
  for (const waiter of batch) {
    let perKey = byOrigin.get(waiter.origin);
    if (!perKey) {
      perKey = new Map();
      byOrigin.set(waiter.origin, perKey);
    }
    const list = perKey.get(waiter.storageKey);
    if (list) list.push(waiter);
    else perKey.set(waiter.storageKey, [waiter]);
  }

  for (const [origin, perKey] of byOrigin) {
    const keys = [...perKey.keys()];
    for (let i = 0; i < keys.length; i += MEDIA_TICKET_MAX_KEYS) {
      const chunk = keys.slice(i, i + MEDIA_TICKET_MAX_KEYS);
      const chunkWaiters = chunk.flatMap((k) => perKey.get(k) ?? []);
      let issued: Map<string, string> | null = null;
      try {
        issued = await requestMediaTickets(origin, chunk);
      } catch {
        issued = null;
      }
      for (const waiter of chunkWaiters) {
        waiter.resolve(issued?.get(waiter.storageKey) ?? null);
      }
    }
  }
}

/** 粉丝 Token 申请用的本节点公开基址（Pages 同源优先）。 */
function resolveFollowerNodeUrl(): string {
  const publicWorkerB = resolvePublicWorkerBBaseUrlSync();
  if (publicWorkerB) return publicWorkerB;
  if (typeof window === 'undefined') return '';
  return window.location.origin;
}

/**
 * 向 Worker B 批量索取媒体票据。
 *
 * @returns storage key → 票据 的映射（失败时抛错，由调用方降级）
 */
export async function requestMediaTickets(
  origin: string,
  storageKeys: readonly string[],
): Promise<Map<string, string>> {
  if (!origin || storageKeys.length === 0) {
    return new Map();
  }
  const token = await ensureFollowerToken(origin, resolveFollowerNodeUrl(), null);
  const res = await fetch(`${origin}/api/media/tickets`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ storage_keys: [...storageKeys] }),
  });
  if (!res.ok) {
    // 票据能力未启用（开关关闭 / secret 未配）：记住该 origin 的结果，别反复打服务端
    if (res.status === 503) {
      ticketEndpointDisabledOrigins.add(origin);
    }
    throw new Error(`MEDIA_TICKET_HTTP_${res.status}`);
  }
  const json = (await res.json()) as {
    ok?: boolean;
    data?: {
      tickets?: Array<{ storage_key?: string; ticket?: string; expires_at?: string }>;
      storage_key?: string;
      ticket?: string;
      expires_at?: string;
    };
  };
  const out = new Map<string, string>();
  const tickets = json?.data?.tickets;
  if (Array.isArray(tickets)) {
    for (const item of tickets) {
      if (!item || typeof item.storage_key !== 'string' || typeof item.ticket !== 'string') {
        continue;
      }
      if (typeof item.expires_at === 'string') {
        writeCachedTicket(origin, item.storage_key, item.ticket, item.expires_at);
      }
      out.set(item.storage_key, item.ticket);
    }
    return out;
  }
  // 旧单 key 响应形态（后端兼容路径）
  const legacyKey = json?.data?.storage_key;
  const legacyTicket = json?.data?.ticket;
  if (typeof legacyKey === 'string' && typeof legacyTicket === 'string') {
    if (typeof json?.data?.expires_at === 'string') {
      writeCachedTicket(origin, legacyKey, legacyTicket, json.data.expires_at);
    }
    out.set(legacyKey, legacyTicket);
  }
  return out;
}

/**
 * 取一张图的票据（带缓存 + 批量合并）。
 *
 * @returns 票据字符串；不可用时返回 null（调用方应走降级路径）
 */
export function ensureMediaTicket(url: string): Promise<string | null> {
  const target = parseMediaImageUrl(url);
  if (!target) return Promise.resolve(null);
  if (ticketEndpointDisabledOrigins.has(target.origin)) return Promise.resolve(null);

  const cached = readCachedTicket(target.origin, target.storageKey);
  if (cached) return Promise.resolve(cached);

  return new Promise<string | null>((resolve) => {
    enqueueWaiter({
      origin: target.origin,
      storageKey: target.storageKey,
      resolve: (ticket) => {
        if (ticket) {
          // 后端未带 expires_at 时兜底：按 60s TTL 记，短了就当过期重取
          if (!ticketCache.has(cacheKey(target.origin, target.storageKey))) {
            writeCachedTicket(
              target.origin,
              target.storageKey,
              ticket,
              new Date(Date.now() + 60_000).toISOString(),
            );
          }
          resolve(ticket);
          return;
        }
        resolve(null);
      },
    });
  });
}

/**
 * 强制换一张新票据（票据过期 / 被拒后重试）。
 */
export async function refreshMediaTicket(url: string): Promise<string | null> {
  invalidateMediaTicket(url);
  const target = parseMediaImageUrl(url);
  if (target && ticketEndpointDisabledOrigins.has(target.origin)) return null;
  return ensureMediaTicket(url);
}

/**
 * 降级路径：用粉丝 Token 走 JS fetch → Blob（`<img>` 无法带 Authorization 时的兜底）。
 *
 * @returns objectURL；失败返回 null
 */
export async function fetchMediaAsBlobUrl(url: string): Promise<string | null> {
  const target = parseMediaImageUrl(url);
  if (!target) return null;
  try {
    const token = await ensureFollowerToken(target.origin, resolveFollowerNodeUrl(), null);
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return null;
    const blob = await res.blob();
    return URL.createObjectURL(blob);
  } catch {
    return null;
  }
}
