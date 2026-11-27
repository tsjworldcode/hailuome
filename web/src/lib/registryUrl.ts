/** 默认官方注册中心 API 根地址（与 worker-a REGISTRY_URL 默认一致） */
export const DEFAULT_REGISTRY_URL = 'https://hailuo-registry.allovo.eu.org';

/** 注册中心 Turnstile 桥接页路径（仅注册中心域名托管，节点 iframe 嵌入） */
export const REGISTRY_TURNSTILE_BRIDGE_PATH = '/turnstile-bridge';

function stripTrailingSlashUrl(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

/** 构建 / 内联注入的注册中心 URL（同步回退，不含 Worker B 运行时列表）。 */
export function getRegistryUrlFallback(): string {
  const fromEnv = import.meta.env.PUBLIC_REGISTRY_URL;
  if (typeof fromEnv === 'string' && fromEnv.trim()) {
    return stripTrailingSlashUrl(fromEnv.trim());
  }
  if (typeof window !== 'undefined') {
    const inline = window.__HAILUO_DEPLOY__?.registry_url;
    if (inline && inline.trim()) return stripTrailingSlashUrl(inline.trim());
  }
  return DEFAULT_REGISTRY_URL;
}

/** @deprecated 优先使用 resolveRegistryUrl()；保留供尚未异步化的调用方。 */
export function getRegistryUrl(): string {
  return getRegistryUrlFallback();
}

export function getRegistryTurnstileBridgeUrl(
  parentOrigin: string,
  registryUrl?: string,
): string {
  const base = stripTrailingSlashUrl(registryUrl?.trim() || getRegistryUrlFallback());
  const q = new URLSearchParams({ parent: parentOrigin });
  return `${base}${REGISTRY_TURNSTILE_BRIDGE_PATH}?${q.toString()}`;
}

export function isRegistryOrigin(origin: string, registryUrl: string): boolean {
  try {
    return new URL(origin).origin === new URL(registryUrl).origin;
  } catch {
    return false;
  }
}
