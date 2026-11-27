/**
 * 从 token 中的 Worker/Pages 项目名 + Cloudflare 账号子域解析公网 URL。
 * 供 finalize、deploy 后 verify、独立 CLI 共用。
 */

export const DEFAULT_WORKER_A_NAME = 'hailuo-worker-a';
export const DEFAULT_WORKER_B_NAME = 'hailuo-worker-b';
export const DEFAULT_PAGES_PROJECT = 'hailuo-web';

export function pickConfigString(config, keys, fallback = '') {
  for (const key of keys) {
    const v = config[key];
    if (v != null && String(v).trim()) return String(v).trim();
  }
  return fallback;
}

export function hasDeployUrl(config) {
  return Boolean(pickConfigString(config, ['WORKER_A_URL', 'WORKER_A_HOST']));
}

async function cfFetch(token, url, init = {}) {
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  const data = await res.json();
  if (!data.success) {
    throw new Error(`Cloudflare API ${url}: ${JSON.stringify(data.errors ?? data)}`);
  }
  return data.result;
}

async function getWorkersSubdomain(accountId, token) {
  const result = await cfFetch(
    token,
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/subdomain`,
  );
  const sub = result?.subdomain;
  if (!sub || typeof sub !== 'string') throw new Error('无法解析 workers.dev 子域');
  return sub;
}

function normalizeWorkersDevSubdomain(subdomain) {
  const sub = subdomain.trim().replace(/\/+$/, '');
  if (!sub) throw new Error('无法解析 workers.dev 子域');
  return sub.endsWith('.workers.dev') ? sub : `${sub}.workers.dev`;
}

export function workerUrl(workerName, subdomain) {
  const host = `${workerName}.${normalizeWorkersDevSubdomain(subdomain)}`;
  return `https://${host}`.replace(/\/+$/, '');
}

export function defaultPagesUrl(projectName) {
  return `https://${projectName}.pages.dev`.replace(/\/+$/, '');
}

/** 解析 A/B/Pages URL（不写文件） */
export async function resolveDeployUrlsFromConfig(config, options = {}) {
  const accountId = pickConfigString(config, ['CLOUDFLARE_ACCOUNT_ID']);
  const apiToken = pickConfigString(config, ['CLOUDFLARE_API_TOKEN']);
  if (!accountId || !apiToken) {
    throw new Error('token 缺少 CLOUDFLARE_ACCOUNT_ID 或 CLOUDFLARE_API_TOKEN');
  }

  const pagesProject =
    pickConfigString(config, ['PAGES_PROJECT_NAME']) || options.pagesProject || DEFAULT_PAGES_PROJECT;
  const workerAName = pickConfigString(config, ['WORKER_A_NAME'], DEFAULT_WORKER_A_NAME);
  const workerBName = pickConfigString(config, ['WORKER_B_NAME'], DEFAULT_WORKER_B_NAME);

  const subdomain = await getWorkersSubdomain(accountId, apiToken);
  const workerAUrl = workerUrl(workerAName, subdomain);
  const workerBUrl = workerUrl(workerBName, subdomain);
  const pagesUrl = defaultPagesUrl(pagesProject);

  return { workerAUrl, workerBUrl, pagesUrl, workerAName, workerBName, pagesProject };
}

/** 将解析结果写入 config 对象（可变） */
export function applyDeployUrlsToConfig(config, urls) {
  config.WORKER_A_HOST = urls.workerAUrl;
  config.WORKER_A_URL = urls.workerAUrl;
  config.WORKER_B_HOST = urls.workerBUrl;
  config.WORKER_B_URL = urls.workerBUrl;
  config.PAGES_URL = urls.pagesUrl;
  config.WORKER_A_ORIGIN = urls.pagesUrl;
  return config;
}
