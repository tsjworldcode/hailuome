/**
 * 部署时注入的公开配置：构建变量 / deploy-env.json 作 API 回落；
 * **对外展示身份**优先 `/auth/me`.worker_b_url（D1 SSOT）与会话缓存。
 */
import { stripTrailingSlash } from './auth';
import { toBrowserApiBaseUrl } from './deployEndpoint';

export interface DeployEnvFile {
  readonly worker_b_url?: string;
  readonly registry_url?: string;
}

let deployEnvCache: DeployEnvFile | null | undefined;

/** 会话内缓存的站主公开基址（ownerSession 写入；换域后随 getMe 刷新） */
export const OWNER_SESSION_WORKER_B_URL_KEY = 'hailuo:owner-worker-b-url';

declare global {
  interface Window {
    __HAILUO_DEPLOY__?: DeployEnvFile;
  }
}

/** 构建时写入 Layout 内联脚本 / deploy-env.json 的快照。 */
function readInlineDeployEnv(): DeployEnvFile | null {
  if (typeof window === 'undefined') return null;
  const inline = window.__HAILUO_DEPLOY__;
  if (!inline || typeof inline !== 'object') return null;
  return inline;
}

/** 构建时 PUBLIC_WORKER_B_URL（Astro 打进 bundle）。 */
export function readBuildTimeWorkerBUrl(): string {
  const raw = import.meta.env.PUBLIC_WORKER_B_URL ?? '';
  return typeof raw === 'string' ? stripTrailingSlash(raw.trim()) : '';
}

function readSessionOwnerWorkerBUrl(): string {
  if (typeof window === 'undefined') return '';
  try {
    const raw = window.sessionStorage.getItem(OWNER_SESSION_WORKER_B_URL_KEY);
    return typeof raw === 'string' ? stripTrailingSlash(raw.trim()) : '';
  } catch {
    return '';
  }
}

/**
 * 公开身份用的 Worker B 真实地址（二维码 / 对照 / 「本站」判断）。
 * M7-30g-4：优先 profile / 会话缓存，禁止仅信构建期 PUBLIC_WORKER_B_URL。
 * 不要替换成 Pages 同源代理地址。
 */
export function resolvePublicWorkerBBaseUrlSync(profileWorkerB?: string): string {
  if (profileWorkerB?.trim()) return stripTrailingSlash(profileWorkerB.trim());
  const fromSession = readSessionOwnerWorkerBUrl();
  if (fromSession) return fromSession;
  const fromBuild = readBuildTimeWorkerBUrl();
  if (fromBuild) return fromBuild;
  const inline = readInlineDeployEnv();
  if (inline?.worker_b_url) return stripTrailingSlash(inline.worker_b_url.trim());
  return '';
}

/** 读取构建产物中的 deploy-env.json（由 write-deploy-env.mjs 生成）。 */
export async function loadDeployEnvFile(): Promise<DeployEnvFile | null> {
  if (deployEnvCache !== undefined) return deployEnvCache;
  if (typeof window === 'undefined') {
    deployEnvCache = null;
    return null;
  }
  try {
    const res = await fetch('/deploy-env.json', { cache: 'no-cache' });
    if (!res.ok) {
      deployEnvCache = null;
      return null;
    }
    deployEnvCache = (await res.json()) as DeployEnvFile;
    return deployEnvCache;
  } catch {
    deployEnvCache = null;
    return null;
  }
}

/** 解析浏览器 API 基址；生产 Pages 下会返回同源代理地址。 */
export async function resolveWorkerBBaseUrl(profileWorkerB?: string): Promise<string> {
  // API 代理仍优先构建期（指向 Pages 同源改写所需的真实 B，供 toBrowserApiBaseUrl）
  const fromBuild = readBuildTimeWorkerBUrl();
  if (fromBuild) return toBrowserApiBaseUrl(fromBuild);

  const inline = readInlineDeployEnv();
  if (inline?.worker_b_url) return toBrowserApiBaseUrl(inline.worker_b_url.trim());

  const file = await loadDeployEnvFile();
  if (file?.worker_b_url) return toBrowserApiBaseUrl(file.worker_b_url.trim());

  if (profileWorkerB) return toBrowserApiBaseUrl(profileWorkerB.trim());
  const fromSession = readSessionOwnerWorkerBUrl();
  if (fromSession) return toBrowserApiBaseUrl(fromSession);
  return '';
}

/** 同步解析浏览器 API 基址，供 Timeline 首屏使用。 */
export function resolveWorkerBBaseUrlSync(profileWorkerB?: string): string {
  const fromBuild = readBuildTimeWorkerBUrl();
  if (fromBuild) return toBrowserApiBaseUrl(fromBuild);
  const inline = readInlineDeployEnv();
  if (inline?.worker_b_url) return toBrowserApiBaseUrl(inline.worker_b_url.trim());
  if (profileWorkerB) return toBrowserApiBaseUrl(profileWorkerB.trim());
  const fromSession = readSessionOwnerWorkerBUrl();
  if (fromSession) return toBrowserApiBaseUrl(fromSession);
  return '';
}
