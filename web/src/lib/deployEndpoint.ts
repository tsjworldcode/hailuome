/**
 * 部署时绑定的节点 API 入口。
 *
 * 生产 Web 在 Cloudflare Pages 域名下运行时，浏览器优先请求同源 Pages Functions
 * 代理；本地开发仍直连 Worker B，避免 dev server 没有代理路由时失效。
 */

function stripTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

let endpointFilePromise: Promise<string | null> | null = null;

function isLocalBrowserHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

/** Worker B 真实公开地址 -> 当前浏览器可用的 API 基址。 */
export function toBrowserApiBaseUrl(publicApi: string): string {
  const normalized = stripTrailingSlash(publicApi.trim());
  if (!normalized || typeof window === 'undefined') return normalized;
  const loc = window.location;
  if (loc.protocol !== 'http:' && loc.protocol !== 'https:') return normalized;
  if (isLocalBrowserHost(loc.hostname)) return normalized;

  try {
    const workerOrigin = new URL(normalized).origin;
    if (workerOrigin === loc.origin) return normalized;
    // Pages Functions 会把 /auth、/api、/posts、/feed、/img 等同源路径代理到 Worker B。
    return loc.origin;
  } catch {
    return normalized;
  }
}

/** 构建时 / HTML 内联注入的 Worker B 真实公开地址；未配置返回 null。 */
function readConfiguredDeployEndpoint(): string | null {
  const publicApi = import.meta.env.PUBLIC_WORKER_B_URL;
  if (typeof publicApi === 'string' && publicApi.trim()) {
    return stripTrailingSlash(publicApi.trim());
  }
  const raw = import.meta.env.PUBLIC_HAILUO_ENDPOINT;
  if (typeof raw === 'string' && raw.trim()) {
    return stripTrailingSlash(raw.trim());
  }
  if (typeof window !== 'undefined') {
    const publicApiInline = window.__HAILUO_DEPLOY__?.worker_b_url;
    if (typeof publicApiInline === 'string' && publicApiInline.trim()) {
      return stripTrailingSlash(publicApiInline.trim());
    }
  }
  return null;
}

/** 构建时 / HTML 内联注入的 Worker B 真实公开地址（不做 Pages 同源改写）。 */
export function readRawDeployEndpoint(): string | null {
  return readConfiguredDeployEndpoint();
}

/** 从 deploy-env.json 补读 Worker B 真实公开地址。 */
async function fetchDeployEnvWorkerBUrl(): Promise<string | null> {
  if (typeof window === 'undefined') return null;
  if (!endpointFilePromise) {
    endpointFilePromise = (async () => {
      try {
        const res = await fetch('/deploy-env.json', { cache: 'no-cache' });
        if (!res.ok) return null;
        const parsed = (await res.json()) as { worker_b_url?: unknown };
        const workerB = parsed.worker_b_url;
        if (typeof workerB === 'string' && workerB.trim()) {
          return stripTrailingSlash(workerB.trim());
        }
      } catch {
        return null;
      }
      return null;
    })();
  }
  return endpointFilePromise;
}

/** 构建时 / HTML 内联注入的节点 API 基址；生产 Pages 下会返回同源代理地址。 */
export function readDeployEndpoint(): string | null {
  const configured = readConfiguredDeployEndpoint();
  return configured ? toBrowserApiBaseUrl(configured) : null;
}

/** 从部署快照补读 Worker B 真实公开地址。 */
export async function resolveRawDeployEndpoint(): Promise<string | null> {
  const sync = readRawDeployEndpoint();
  if (sync) return sync;
  return fetchDeployEnvWorkerBUrl();
}

/** 从部署快照文件补读节点 API 基址，兜底 Pages 构建变量未及时进入 bundle 的情况。 */
export async function resolveDeployEndpoint(): Promise<string | null> {
  const raw = await resolveRawDeployEndpoint();
  return raw ? toBrowserApiBaseUrl(raw) : null;
}

/** 站主网关模式：Pages 同源代理 / 开发直连 / 未配置。 */
export function detectOwnerGatewayMode(
  rawWorkerB: string | null,
): 'pages' | 'direct' | 'unbound' {
  if (!rawWorkerB || typeof window === 'undefined') return 'unbound';
  if (isLocalBrowserHost(window.location.hostname)) return 'direct';
  try {
    const rawOrigin = new URL(rawWorkerB).origin;
    const browserOrigin = new URL(toBrowserApiBaseUrl(rawWorkerB)).origin;
    if (browserOrigin === window.location.origin && rawOrigin !== window.location.origin) {
      return 'pages';
    }
    return 'direct';
  } catch {
    return 'direct';
  }
}

/** 是否已由部署绑定节点 API 地址；有则隐藏手动填写 UI。 */
export function isDeployEndpointBound(): boolean {
  return readConfiguredDeployEndpoint() !== null
    || (typeof window !== 'undefined' && !!window.__HAILUO_DEPLOY__?.worker_b_url);
}
