// M7-19：Worker B 图片 URL 拼接（Profile / Bookmarks 等与 api.ts imageUrl 同形）

import { stripTrailingSlash, getWorkerAUrl } from './auth';
import { readBuildTimeWorkerBUrl } from './deployEnv';
import { toBrowserApiBaseUrl, readDeployEndpoint } from './deployEndpoint';

/** 读取 PUBLIC_WORKER_B_URL（§F-02 允许进 bundle 的公开变量） */
export function readPublicWorkerBBaseUrl(): string {
  const workerB = readBuildTimeWorkerBUrl();
  return workerB ? toBrowserApiBaseUrl(workerB) : '';
}

/** 单张图片 key → 可访问 URL（与 createWorkerBClient().imageUrl 同形） */
export function buildWorkerBImageUrl(baseUrl: string, key: string): string {
  if (!baseUrl) return '';
  return `${stripTrailingSlash(baseUrl)}/img/${encodeURIComponent(key)}`;
}

/** M14-11 / SEC-10-12：站主 JWT 读路径（保护档下替代 Worker B /img/） */
export function buildOwnerImageUrl(baseUrl: string, key: string): string {
  if (!baseUrl || !key) return '';
  return `${stripTrailingSlash(baseUrl)}/api/images/${encodeURIComponent(key)}`;
}

/** 站主读图 API 基址：localStorage 写层地址优先，生产 Pages 回落同源 deploy endpoint */
export function resolveOwnerImageApiBaseUrl(): string {
  if (typeof window === 'undefined') return readDeployEndpoint() ?? '';
  return getWorkerAUrl() ?? readDeployEndpoint() ?? '';
}

/** 批量映射 image_keys → Worker B /img/ URL */
export function mapImageKeysToUrls(
  baseUrl: string,
  keys: readonly string[],
): readonly string[] {
  if (!baseUrl || keys.length === 0) return [];
  return keys.map((k) => buildWorkerBImageUrl(baseUrl, k));
}

/** M14-11 / SEC-10-12：保护档批量映射 → Worker A GET /api/images/:key */
export function mapImageKeysToOwnerUrls(
  baseUrl: string,
  keys: readonly string[],
): readonly string[] {
  if (!baseUrl || keys.length === 0) return [];
  return keys.map((k) => buildOwnerImageUrl(baseUrl, k));
}

/** 是否需 fetch + Authorization（`<img>` 无法带 JWT） */
export function needsOwnerJwtImageFetch(url: string): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(
      url,
      typeof window !== 'undefined' ? window.location.origin : 'https://localhost',
    );
    return parsed.pathname.startsWith('/api/images/');
  } catch {
    return url.includes('/api/images/');
  }
}

/**
 * 把 Worker B 返回的绝对 `/img/...` URL 改写成浏览器可用基址。
 * 生产 Pages 下 workers.dev 直链常不可达，应走同源 Pages Functions 代理（与个人主页一致）。
 */
export function rewriteImageUrlsForBrowser(urls: readonly string[]): readonly string[] {
  if (urls.length === 0) return urls;
  const browserBase =
    readPublicWorkerBBaseUrl() ||
    (typeof window !== 'undefined' ? window.location.origin : '');
  if (!browserBase) return urls;
  const base = stripTrailingSlash(browserBase);
  return urls.map((raw) => {
    if (!raw || typeof raw !== 'string') return raw;
    try {
      const u = new URL(raw, base);
      const match = u.pathname.match(/^\/img\/(.+)$/);
      if (!match) return raw;
      if (typeof window !== 'undefined' && u.origin === window.location.origin) return raw;
      const key = decodeURIComponent(match[1] ?? '');
      if (!key) return raw;
      return buildWorkerBImageUrl(base, key);
    } catch {
      return raw;
    }
  });
}

/** 归一化 origin（小写、去尾斜杠路径），非法 URL 返回空串。 */
function normalizeOriginKey(raw: string): string {
  if (!raw || typeof raw !== 'string') return '';
  try {
    return new URL(raw).origin.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * SEC-AUDIT-2026-10-10 / 10-12 · 保护档：本站公开 `/img/:key` → 站主 JWT `/api/images/:key`。
 *
 * 【为什么】feed_cache / Following 聚合写入的仍是 Worker B `/img/`；保护档下
 * 站主无法给本站申领粉丝 Token（不在 follows 表），票据与 Bearer 都救不了本站图。
 * For you 本节点帖用 `mapImageKeysToOwnerUrls`；本函数补齐 **Following / feed_cache 本站图**。
 *
 * 【边界】远端节点 `/img/` 不动（站主 JWT 管不了对端 Worker B）。
 *
 * @param forceRewriteImgPaths 帖子已判定为本站时：即便图片 host 与当前公开基址不完全一致，
 *   仍改写路径为 `/img/` 的 URL（换域残留 workers.dev 图址常见）。
 */
export function rewriteLocalImgUrlsToOwnerApi(
  urls: readonly string[],
  args: {
    readonly ownerApiBase: string;
    readonly localOrigins: readonly string[];
    readonly forceRewriteImgPaths?: boolean;
  },
): readonly string[] {
  if (!args.ownerApiBase || urls.length === 0) return urls;
  const local = new Set(
    args.localOrigins.map(normalizeOriginKey).filter((o) => o.length > 0),
  );
  if (local.size === 0 && !args.forceRewriteImgPaths) return urls;
  const ownerBase = stripTrailingSlash(args.ownerApiBase);
  return urls.map((raw) => {
    if (!raw || typeof raw !== 'string') return raw;
    try {
      const u = new URL(raw, ownerBase);
      const match = u.pathname.match(/^\/img\/(.+)$/);
      if (!match) return raw;
      const originKey = u.origin.toLowerCase();
      const originOk = local.has(originKey);
      if (!originOk && !args.forceRewriteImgPaths) return raw;
      const key = decodeURIComponent(match[1] ?? '');
      if (!key) return raw;
      return buildOwnerImageUrl(ownerBase, key);
    } catch {
      return raw;
    }
  });
}

/**
 * 对 Feed 列表批量改写：本站帖的 `/img/` → owner JWT 路径；远端帖不动。
 */
export function remapFeedItemsLocalImgToOwnerApi<
  T extends { readonly node_url: string; readonly image_urls: readonly string[] },
>(
  items: readonly T[],
  args: {
    readonly ownerApiBase: string;
    readonly localOrigins: readonly string[];
  },
): readonly T[] {
  if (!args.ownerApiBase || items.length === 0) return items;
  const local = new Set(
    args.localOrigins.map(normalizeOriginKey).filter((o) => o.length > 0),
  );
  if (local.size === 0) return items;
  return items.map((item) => {
    const nodeOrigin = normalizeOriginKey(item.node_url);
    const isLocalPost = Boolean(nodeOrigin && local.has(nodeOrigin));
    const nextUrls = rewriteLocalImgUrlsToOwnerApi(item.image_urls, {
      ownerApiBase: args.ownerApiBase,
      localOrigins: args.localOrigins,
      forceRewriteImgPaths: isLocalPost,
    });
    if (nextUrls === item.image_urls) return item;
    // 无变化时 rewrite 仍返回新数组；比对内容避免无谓拷贝
    let changed = nextUrls.length !== item.image_urls.length;
    if (!changed) {
      for (let i = 0; i < nextUrls.length; i += 1) {
        if (nextUrls[i] !== item.image_urls[i]) {
          changed = true;
          break;
        }
      }
    }
    if (!changed) return item;
    return { ...item, image_urls: nextUrls };
  });
}
