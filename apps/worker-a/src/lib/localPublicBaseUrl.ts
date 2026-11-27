/**
 * M7-30g-1：本站公开基址（Worker B / node_url）解析。
 *
 * 登记完成后以 D1 为 SSOT；env.WORKER_B_URL 仅作未登记 / 灾难回落。
 * isolate 内 60s 缓存；换域 confirm 必须调用 invalidateLocalPublicBaseUrlCache()。
 */
import { resolveIdentityDb } from '../db/bindings';
import type { Env } from '../env';

/** isolate 缓存 TTL（毫秒） */
export const LOCAL_PUBLIC_BASE_URL_CACHE_TTL_MS = 60_000;

export type LocalPublicBaseUrlSource = 'system_config' | 'users' | 'env' | 'empty';

export interface PickLocalPublicBaseUrlResult {
  readonly url: string;
  readonly source: LocalPublicBaseUrlSource;
}

type CacheEntry = { value: string; expiresAtMs: number };

let cache: CacheEntry | null = null;

/** REL-FIX-2：本机别名缓存（与 canonical 同 TTL、同失效，避免 inbox 每次多 3 次 D1 读） */
let aliasCache: { value: string[]; expiresAtMs: number } | null = null;

/** 去掉尾斜杠；空串视为无效。 */
export function normalizePublicBaseUrl(raw: string | null | undefined): string {
  if (typeof raw !== 'string') return '';
  const trimmed = raw.trim().replace(/\/+$/, '');
  return trimmed;
}

/**
 * 纯函数优先级（可单测）：
 * system_config.worker_b_url → users.worker_b_url → env → empty
 */
export function pickLocalPublicBaseUrl(parts: {
  systemConfigUrl?: string | null;
  usersUrl?: string | null;
  envUrl?: string | null;
}): PickLocalPublicBaseUrlResult {
  const fromConfig = normalizePublicBaseUrl(parts.systemConfigUrl);
  if (fromConfig) return { url: fromConfig, source: 'system_config' };

  const fromUsers = normalizePublicBaseUrl(parts.usersUrl);
  if (fromUsers) return { url: fromUsers, source: 'users' };

  const fromEnv = normalizePublicBaseUrl(parts.envUrl);
  if (fromEnv) return { url: fromEnv, source: 'env' };

  return { url: '', source: 'empty' };
}

/** 换域 / 登记写入 D1 后立刻失效，避免最多 60s 旧值。 */
export function invalidateLocalPublicBaseUrlCache(): void {
  cache = null;
  aliasCache = null;
}

/** 测试或调试：读当前别名缓存（无缓存返回 null）。 */
export function peekLocalNodeUrlAliasesCacheForTests(): { value: string[]; expiresAtMs: number } | null {
  return aliasCache;
}

/**
 * REL-FIX-2：比对专用归一（只做比对，不动存储/签名）。
 *
 * 与 `normalizeWorkerBOrigin`（trim + 去尾斜杠）的区别：
 * - host 小写（`EXAMPLE.com` 与 `example.com` 同站）
 * - 默认端口剥离（`https://h:443` ≡ `https://h`；`http://h:80` ≡ `http://h`）
 * - 只取 origin（scheme + host + 非默认端口），忽略 path/query/hash 与尾斜杠
 * - 非法协议/不可解析 → 返回 ''（调用方按不匹配 fail-closed）
 *
 * 安全约束（`03` + `12` + SEC-AUDIT-2026-10-0c）：
 * - 本函数**不**判断“是不是本机”，只做字符串归一；是否本机一律由别名表成员判定。
 * - `normalizeWorkerBOrigin` 全仓 52 处（比对/排序/签名/D1 查询）保持不动，避免改返回类型污染查询与验签。
 */
export function normalizeLocalNodeUrlForMatch(raw: string | null | undefined): string {
  if (typeof raw !== 'string') return '';
  const trimmed = raw.trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return '';
  }
  const scheme = url.protocol.toLowerCase();
  if (scheme !== 'https:' && scheme !== 'http:') return '';
  const host = url.hostname.toLowerCase();
  if (!host) return '';
  let port = url.port;
  // URL 标准库一般已剥离默认端口；显式再兜一次（防实现差异）
  if ((scheme === 'https:' && (port === '443' || port === '')) || (scheme === 'http:' && (port === '80' || port === ''))) {
    port = '';
  }
  return `${scheme}//${host}${port ? `:${port}` : ''}`;
}

/**
 * REL-FIX-2：本机别名表（canonical + 已登记历史 URL）。
 *
 * 来源（全部是本机已登记值，绝不取请求输入）：
 * 1. canonical `resolveLocalPublicBaseUrl`（system_config → users → env 优先级）
 * 2. `users.worker_b_url`（与 canonical 分叉时仍是本机曾用地址）
 * 3. `env.WORKER_B_URL`（未登记/灾难回落）
 * 4. `system_config.url_move_old_node_url`（宽限期内才认；过期旧域可能已被他人接管）
 * 5. `node_url_moved_entries.old_node_url`（宽限期内链式 entry，上限 12 跳）
 *
 * 返回已归一（`normalizeLocalNodeUrlForMatch`）去重后的 origin 列表。
 * 空表 → 调用方按 MISCONFIGURED / 400 fail-closed。
 */
export async function resolveLocalNodeUrlAliases(env: Env): Promise<string[]> {
  const now = Date.now();
  if (aliasCache && aliasCache.expiresAtMs > now) {
    return aliasCache.value;
  }

  const canonical = await resolveLocalPublicBaseUrl(env);

  const identityDb = resolveIdentityDb(env);
  const [usersRow, moveCfg, movedRows] = await Promise.all([
    identityDb
      .prepare(`SELECT worker_b_url FROM users LIMIT 1`)
      .first<{ worker_b_url: string | null }>()
      .catch(() => null),
    identityDb
      .prepare(
        `SELECT key, value FROM system_config WHERE key IN ('url_move_old_node_url', 'url_move_new_node_url', 'url_move_grace_until')`,
      )
      .all<{ key: string; value: string }>()
      .catch(() => null),
    identityDb
      .prepare(`SELECT old_node_url FROM node_url_moved_entries WHERE grace_until >= ? ORDER BY grace_until DESC LIMIT 12`)
      .bind(new Date().toISOString())
      .all<{ old_node_url: string }>()
      .catch(() => null),
  ]);

  const cfg = new Map<string, string>();
  for (const row of moveCfg?.results ?? []) {
    if (row && typeof row.key === 'string') cfg.set(row.key, row.value ?? '');
  }
  const graceUntil = (cfg.get('url_move_grace_until') ?? '').trim();
  const oldMoveUrl = (cfg.get('url_move_old_node_url') ?? '').trim();
  // 旧址只在宽限期内有效；无 grace 字段时为兼容仍收录（confirm 历史行缺少该键），由 entry 表过期兜底
  const oldMoveInGrace = oldMoveUrl ? (!graceUntil || graceUntil >= new Date().toISOString()) : false;

  const rawCandidates: Array<string | null | undefined> = [
    canonical,
    usersRow?.worker_b_url ?? null,
    env.WORKER_B_URL ?? null,
    oldMoveInGrace ? oldMoveUrl : null,
  ];
  for (const row of movedRows?.results ?? []) {
    rawCandidates.push(row?.old_node_url ?? null);
  }

  const seen = new Set<string>();
  for (const raw of rawCandidates) {
    const norm = normalizeLocalNodeUrlForMatch(raw);
    if (norm) seen.add(norm);
  }
  const aliases = [...seen];
  aliasCache = { value: aliases, expiresAtMs: now + LOCAL_PUBLIC_BASE_URL_CACHE_TTL_MS };
  return aliases;
}

/**
 * REL-FIX-2：候选 URL 是否命中本机别名表（纯函数，可单测）。
 * candidate 与 aliases 必须都已是 `normalizeLocalNodeUrlForMatch` 形态；本函数内对 candidate 再归一一次，调用方可直接传原文。
 */
export function isLocalNodeUrlMatch(candidateRaw: string | null | undefined, aliases: readonly string[]): boolean {
  const norm = normalizeLocalNodeUrlForMatch(candidateRaw);
  if (!norm) return false;
  return aliases.includes(norm);
}

/** 测试或调试：读当前缓存（无缓存返回 null）。 */
export function peekLocalPublicBaseUrlCacheForTests(): CacheEntry | null {
  return cache;
}

/**
 * 解析本站对外公开基址（无尾斜杠）。
 * 调用方在空串时自行返回 MISCONFIGURED。
 */
export async function resolveLocalPublicBaseUrl(env: Env): Promise<string> {
  const now = Date.now();
  if (cache && cache.expiresAtMs > now) {
    return cache.value;
  }

  const [sysRow, userRow] = await Promise.all([
    resolveIdentityDb(env).prepare(`SELECT value FROM system_config WHERE key = 'worker_b_url' LIMIT 1`)
      .first<{ value: string }>()
      .catch(() => null),
    resolveIdentityDb(env).prepare(`SELECT worker_b_url FROM users LIMIT 1`)
      .first<{ worker_b_url: string | null }>()
      .catch(() => null),
  ]);

  const sysUrl = sysRow?.value ?? null;
  const usersUrl = userRow?.worker_b_url ?? null;
  const sysNorm = normalizePublicBaseUrl(sysUrl);
  const usersNorm = normalizePublicBaseUrl(usersUrl);
  // 双写分叉时以 system_config 为准（与 pick 优先级一致），并打 warn 便于排障
  if (sysNorm && usersNorm && sysNorm !== usersNorm) {
    console.warn('[localPublicBaseUrl] system_config 与 users.worker_b_url 不一致，以 system_config 为准', {
      system_config: sysNorm,
      users: usersNorm,
    });
  }

  const picked = pickLocalPublicBaseUrl({
    systemConfigUrl: sysUrl,
    usersUrl,
    envUrl: env.WORKER_B_URL,
  });

  cache = { value: picked.url, expiresAtMs: now + LOCAL_PUBLIC_BASE_URL_CACHE_TTL_MS };
  return picked.url;
}
