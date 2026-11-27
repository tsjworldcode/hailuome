/**
 * M9-3-7：从 Worker B 读取脱敏 registry_endpoints，供主 URL 解析与设置页展示。
 */
import type { PublicRegistryEndpoint } from '@hailuo/shared-types';
import { signal } from '@preact/signals';
import { resolvePublicWorkerBBaseUrlSync } from './deployEnv';
import { getRegistryUrlFallback } from './registryUrl';

export const publicRegistryEndpoints = signal<readonly PublicRegistryEndpoint[] | null>(null);

let loadPromise: Promise<readonly PublicRegistryEndpoint[]> | null = null;

function stripTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

/** 从 Worker B 拉取公开 registry 列表；失败时返回空数组。 */
export async function fetchPublicRegistryEndpoints(workerBBase?: string): Promise<PublicRegistryEndpoint[]> {
  const base = stripTrailingSlash(workerBBase?.trim() || resolvePublicWorkerBBaseUrlSync());
  if (!base) return [];
  try {
    const res = await fetch(`${base}/api/public/registry-endpoints`, { cache: 'no-store' });
    if (!res.ok) return [];
    const json = (await res.json()) as { ok?: boolean; data?: { items?: unknown } };
    if (!json?.ok || !Array.isArray(json.data?.items)) return [];
    return json.data.items as PublicRegistryEndpoint[];
  } catch {
    return [];
  }
}

/** 加载并缓存公开 registry 列表（幂等）。 */
export async function loadPublicRegistryEndpoints(
  workerBBase?: string,
): Promise<readonly PublicRegistryEndpoint[]> {
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    const items = await fetchPublicRegistryEndpoints(workerBBase);
    publicRegistryEndpoints.value = items;
    return items;
  })();
  try {
    return await loadPromise;
  } finally {
    loadPromise = null;
  }
}

/** 列表 [0] 的 registry_url；无列表时 null。 */
export function primaryRegistryUrlFromList(
  items: readonly PublicRegistryEndpoint[],
): string | null {
  const url = items[0]?.registry_url?.trim();
  return url ? stripTrailingSlash(url) : null;
}

/** 运行时主注册中心 URL：Worker B 列表优先，回退构建时内联/env。 */
export async function resolveRegistryUrl(workerBBase?: string): Promise<string> {
  const items = await loadPublicRegistryEndpoints(workerBBase);
  return primaryRegistryUrlFromList(items) ?? getRegistryUrlFallback();
}

export function formatRegistryStatusLabel(status: PublicRegistryEndpoint['status']): string {
  switch (status) {
    case 'active':
      return '已连通';
    case 'pending':
      return '待登记';
    case 'unreachable':
      return '不可达';
    default:
      return status;
  }
}

export function formatRegistryStatusTone(
  status: PublicRegistryEndpoint['status'],
): 'ok' | 'warn' | 'bad' {
  switch (status) {
    case 'active':
      return 'ok';
    case 'pending':
      return 'warn';
    case 'unreachable':
      return 'bad';
    default:
      return 'warn';
  }
}
