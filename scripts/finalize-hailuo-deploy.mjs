/**
 * M8-8：部署收尾 — 解析 Worker/Pages URL，写回 token 与 wrangler.toml production vars。
 *
 * 用法：
 *   node scripts/finalize-hailuo-deploy.mjs --token-file scripts/cloudflare-api-token.json
 *
 * 需环境变量或 token 文件内：CLOUDFLARE_ACCOUNT_ID、CLOUDFLARE_API_TOKEN
 * 可选：PAGES_PROJECT_NAME（默认 hailuo-web）
 *
 * M7-30g-5：写入 wrangler `WORKER_B_URL` 与 Pages `PUBLIC_WORKER_B_URL` **仅 bootstrap**。
 * 换域后公开基址以 D1 + STATE_KV `public:canonical_worker_b_url` 为准，不必为换域再跑本脚本。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applyDeployUrlsToConfig,
  resolveDeployUrlsFromConfig,
} from './resolve-deploy-urls.mjs';

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPTS_DIR, '..');
const DEFAULT_PAGES_PROJECT = 'hailuo-web';

function parseArgs(argv) {
  const opts = { tokenFile: path.join(SCRIPTS_DIR, 'cloudflare-api-token.json'), pagesProject: DEFAULT_PAGES_PROJECT };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--token-file' && argv[i + 1]) opts.tokenFile = path.resolve(argv[++i]);
    else if (a.startsWith('--token-file=')) opts.tokenFile = path.resolve(a.slice('--token-file='.length));
    else if (a === '--pages-project' && argv[i + 1]) opts.pagesProject = argv[++i];
    else if (a.startsWith('--pages-project=')) opts.pagesProject = a.slice('--pages-project='.length);
    else if (a === '--help' || a === '-h') {
      console.log('用法: node scripts/finalize-hailuo-deploy.mjs --token-file <path> [--pages-project name]');
      process.exit(0);
    }
  }
  return opts;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, obj) {
  fs.writeFileSync(filePath, `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
}

/** 幂等更新 wrangler.toml 中某 vars 键（不依赖 changeme 占位符） */
function upsertTomlVar(filePath, key, value) {
  if (!fs.existsSync(filePath)) throw new Error(`wrangler.toml 不存在: ${filePath}`);
  const content = fs.readFileSync(filePath, 'utf8');
  const re = new RegExp(`^(${key}\\s*=\\s*")[^"]*(")`, 'm');
  if (!re.test(content)) return false;
  fs.writeFileSync(filePath, content.replace(re, `$1${value}$2`), 'utf8');
  return true;
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

/** 尝试为 Pages Production 设置公开读变量、Owner Gateway、WORKER_A 与 STATE_KV。 */
async function trySetPagesProductionEnv(
  accountId,
  token,
  projectName,
  { workerBUrl, workerAName, workerBName, internalForwardSecret, registryUrl, stateKvId },
) {
  try {
    const project = await cfFetch(
      token,
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/pages/projects/${encodeURIComponent(projectName)}`,
    );
    const prod = project.deployment_configs?.production ?? {};
    const preview = project.deployment_configs?.preview ?? {};
    // 与 ci-patch-pages 同：禁止把 GET 回来的无 value secret_text 原样 PATCH（会清空线上密钥）
    const envVars = {};
    for (const [key, raw] of Object.entries(prod.env_vars ?? {})) {
      if (!raw || typeof raw !== 'object') continue;
      const type = raw.type;
      const value = raw.value;
      if (type === 'secret_text' && (value == null || String(value).length === 0)) continue;
      envVars[key] = raw;
    }
    const services = { ...(prod.services ?? {}) };
    const kvNamespaces = { ...(prod.kv_namespaces ?? {}) };
    // CF 8000066：production / preview 的 fail_open 必须相同
    const failOpen =
      typeof prod.fail_open === 'boolean'
        ? prod.fail_open
        : typeof preview.fail_open === 'boolean'
          ? preview.fail_open
          : false;
    envVars.PUBLIC_WORKER_B_URL = { type: 'plain_text', value: workerBUrl };
    // M7-30g-5：PUBLIC_WORKER_B_URL 仅 bootstrap / 未绑 KV 回落；换域后公开代理读 STATE_KV。
    // M9-23：Web 站主写层只走 Pages Owner Gateway，不再注入旧的公开 Worker A 端点。
    delete envVars.PUBLIC_HAILUO_ENDPOINT;
    if (internalForwardSecret) {
      envVars.INTERNAL_FORWARD_SECRET = { type: 'secret_text', value: internalForwardSecret };
    }
    if (registryUrl) {
      envVars.PUBLIC_REGISTRY_URL = { type: 'secret_text', value: registryUrl };
    }
    if (workerAName) {
      // Cloudflare Pages Production 的 services 是按 binding 名称索引的 Service Binding map。
      services.WORKER_A = {
        service: workerAName,
        environment: 'production',
      };
    }
    if (workerBName) {
      // M7-36：公开读代理优先 Service Binding，避免 workers.dev 公网不可达导致 Feed 503。
      services.WORKER_B = {
        service: workerBName,
        environment: 'production',
      };
    }
    // M7-30g-2：与 Worker A/B 共用 STATE_KV，运行时读 public:canonical_worker_b_url（换域免 redeploy）。
    if (stateKvId) {
      kvNamespaces.STATE_KV = { namespace_id: stateKvId };
    }
    const body = {
      deployment_configs: {
        ...project.deployment_configs,
        production: {
          ...prod,
          env_vars: envVars,
          services,
          kv_namespaces: kvNamespaces,
          fail_open: failOpen,
        },
        preview: {
          ...preview,
          fail_open: failOpen,
        },
      },
    };
    await cfFetch(
      token,
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/pages/projects/${encodeURIComponent(projectName)}`,
      { method: 'PATCH', body: JSON.stringify(body) },
    );
    return true;
  } catch (err) {
    console.warn('[finalize] Pages Production 配置 PATCH 失败（可稍后控制台手填）:', err.message);
    return false;
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(opts.tokenFile)) {
    console.error(`未找到 token 文件: ${opts.tokenFile}`);
    process.exit(1);
  }

  const config = readJson(opts.tokenFile);
  const accountId = config.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = config.CLOUDFLARE_API_TOKEN;
  if (!accountId || !apiToken) {
    console.error('token 文件缺少 CLOUDFLARE_ACCOUNT_ID 或 CLOUDFLARE_API_TOKEN');
    process.exit(1);
  }

  const pagesProject =
    (config.PAGES_PROJECT_NAME && String(config.PAGES_PROJECT_NAME).trim()) || opts.pagesProject;

  const urls = await resolveDeployUrlsFromConfig(config, { pagesProject });
  applyDeployUrlsToConfig(config, urls);
  writeJson(opts.tokenFile, config);

  const { workerAUrl, workerBUrl, pagesUrl, workerAName, workerBName } = urls;

  const tomlA = path.join(REPO_ROOT, 'apps', 'worker-a', 'wrangler.toml');
  const tomlB = path.join(REPO_ROOT, 'apps', 'worker-b', 'wrangler.toml');

  for (const key of ['WORKER_B_URL', 'WORKER_A_ORIGIN']) {
    const val = key === 'WORKER_B_URL' ? workerBUrl : pagesUrl;
    // M7-30g-5：toml / Pages env 仅 bootstrap；换域后运行时以 D1 + STATE_KV 为准，不必为换域再跑 finalize。
    if (upsertTomlVar(tomlA, key, val)) {
      console.log(`[finalize] 已更新 ${path.relative(REPO_ROOT, tomlA)} ${key}`);
    } else {
      console.warn(`[finalize] 跳过 toml 未找到 ${key}: ${path.relative(REPO_ROOT, tomlA)}`);
    }
  }
  if (upsertTomlVar(tomlB, 'WORKER_A_ORIGIN', pagesUrl)) {
    console.log(`[finalize] 已更新 ${path.relative(REPO_ROOT, tomlB)} WORKER_A_ORIGIN`);
  }

  const stateKvId =
    (config.STATE_KV_ID && String(config.STATE_KV_ID).trim()) || '';
  if (!stateKvId) {
    console.warn(
      '[finalize] token 缺少 STATE_KV_ID：跳过 Pages STATE_KV 绑定（换域零 redeploy 需手工绑同 id）',
    );
  }

  const pagesEnvOk = await trySetPagesProductionEnv(
    accountId,
    apiToken,
    pagesProject,
    {
      workerBUrl,
      workerAName,
      workerBName,
      internalForwardSecret:
        (config.INTERNAL_FORWARD_SECRET && String(config.INTERNAL_FORWARD_SECRET).trim()) || '',
      registryUrl:
        (config.REGISTRY_URL && String(config.REGISTRY_URL).trim()) || 'https://hailuo-registry.allovo.eu.org',
      stateKvId,
    },
  );

  const out = {
    ok: true,
    worker_a_url: workerAUrl,
    worker_b_url: workerBUrl,
    pages_url: pagesUrl,
    worker_a_service: workerAName,
    BOOTSTRAP_HANDLE: config.BOOTSTRAP_HANDLE ?? config.OWNER_HANDLE ?? '',
    owner_login_username: config.OWNER_LOGIN_USERNAME ?? '',
    pages_production_config_updated: pagesEnvOk,
    pages_env_updated: pagesEnvOk,
  };
  process.stdout.write(JSON.stringify(out));
}

main().catch((err) => {
  console.error('[finalize-hailuo-deploy] 失败:', err);
  process.exit(1);
});
