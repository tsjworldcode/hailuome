/**
 * M8-12/13 · 部署后回填 URL 到 wrangler.toml production vars（对齐本地 finalize）
 *
 * 优先：Cloudflare API（需 CLOUDFLARE_API_TOKEN）解析 workers.dev 子域
 * 回落：用 wrangler deployments list 抓已部署 URL
 *
 * 与本地 `finalize-hailuo-deploy.mjs` 同口径：写 `[env.production.vars]` 的
 * WORKER_B_URL / WORKER_A_ORIGIN，再由后续 Redeploy 生效。
 * **禁止**再对这些名字做 `wrangler secret put`——首次 deploy 已从 toml 建了
 * plain var，同名 secret 会报 Cloudflare 10053 Binding name already in use。
 *
 * Worker A URL 仅写入状态文件，不进公开文档。
 * 运行：node scripts/ci-finalize-urls.mjs
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  defaultPagesUrl,
  resolveDeployUrlsFromConfig,
  workerUrl,
} from './resolve-deploy-urls.mjs';
import { prepareCfEnvForWrangler } from './ci-prepare-cf-env.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const statePath =
  process.env.CI_DEPLOY_STATE_PATH ||
  path.join(repoRoot, 'scripts', '.ci-deploy-state.json');

const WRANGLER_PKG = 'wrangler@3.114.17';

function die(msg) {
  console.error(`错误：${msg}`);
  process.exit(2);
}

/** 幂等更新 wrangler.toml 中某 vars 键（与 finalize-hailuo-deploy.mjs 同形） */
function upsertTomlVar(filePath, key, value) {
  if (!fs.existsSync(filePath)) throw new Error(`wrangler.toml 不存在: ${filePath}`);
  const content = fs.readFileSync(filePath, 'utf8');
  const re = new RegExp(`^(${key}\\s*=\\s*")[^"]*(")`, 'm');
  if (!re.test(content)) return false;
  fs.writeFileSync(filePath, content.replace(re, `$1${value}$2`), 'utf8');
  return true;
}

function wranglerOut(args, cwd) {
  const bin = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  const r = spawnSync(bin, ['--yes', WRANGLER_PKG, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, CI: 'true' },
    shell: process.platform === 'win32',
  });
  return `${r.stdout || ''}${r.stderr || ''}`;
}

/** 从已部署 Worker 的 wrangler 输出里抓 https://name.*.workers.dev */
function tryUrlFromDeployments(workerName, workerDir) {
  const out = wranglerOut(
    ['deployments', 'list', '--name', workerName, '--env', 'production'],
    path.join(repoRoot, workerDir),
  );
  const re = new RegExp(
    `https://${workerName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.[a-z0-9-]+\\.workers\\.dev`,
    'i',
  );
  const m = out.match(re) || out.match(/https:\/\/[a-z0-9.-]+\.workers\.dev/i);
  return m ? m[0].replace(/\/+$/, '') : null;
}

function subdomainFromWorkerUrl(url, workerName) {
  try {
    const host = new URL(url).hostname;
    const prefix = `${workerName}.`;
    if (!host.toLowerCase().startsWith(prefix.toLowerCase())) return null;
    return host.slice(prefix.length);
  } catch {
    return null;
  }
}

async function resolveUrls(state) {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID || state.account_id || '';
  const apiToken = process.env.CLOUDFLARE_API_TOKEN || '';

  const config = {
    CLOUDFLARE_ACCOUNT_ID: accountId,
    CLOUDFLARE_API_TOKEN: apiToken,
    WORKER_A_NAME: state.WORKER_A_NAME,
    WORKER_B_NAME: state.WORKER_B_NAME,
    PAGES_PROJECT_NAME: state.PAGES_PROJECT_NAME,
  };

  if (config.CLOUDFLARE_API_TOKEN && config.CLOUDFLARE_ACCOUNT_ID) {
    console.log('  · 走 Cloudflare API 解析 workers.dev 子域');
    try {
      return await resolveDeployUrlsFromConfig(config);
    } catch (err) {
      console.warn(`  ⚠ API 解析失败，回落 deployments list：${err?.message || err}`);
    }
  } else {
    console.log(
      `  · 跳过 API 解析（token=${Boolean(apiToken)} accountId=${Boolean(accountId)}）→ wrangler deployments list`,
    );
  }

  const bUrl = tryUrlFromDeployments(state.WORKER_B_NAME, 'apps/worker-b');
  if (!bUrl) {
    die(
      [
        '无法解析 Worker B URL（API 与 wrangler deployments list 都失败）。',
        '排障：确认 Worker B 已 deploy；Secrets 含有效 CLOUDFLARE_API_TOKEN + ACCOUNT_ID。',
      ].join('\n'),
    );
  }

  const sub = subdomainFromWorkerUrl(bUrl, state.WORKER_B_NAME);
  const aUrl = sub
    ? workerUrl(state.WORKER_A_NAME, sub)
    : tryUrlFromDeployments(state.WORKER_A_NAME, 'apps/worker-a') ||
      bUrl.replace(state.WORKER_B_NAME, state.WORKER_A_NAME);

  const pagesUrl = defaultPagesUrl(state.PAGES_PROJECT_NAME);
  return {
    workerAUrl: aUrl,
    workerBUrl: bUrl,
    pagesUrl,
    workerAName: state.WORKER_A_NAME,
    workerBName: state.WORKER_B_NAME,
    pagesProject: state.PAGES_PROJECT_NAME,
  };
}

async function main() {
  try {
    prepareCfEnvForWrangler({ requireAccountId: true });
  } catch (err) {
    die(err?.message || String(err));
  }

  if (!fs.existsSync(statePath)) die(`状态文件不存在：${statePath}`);
  let state;
  try {
    state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch (err) {
    die(`解析 state 失败：${err?.message || err}`);
  }

  console.log('\n════ CI：解析部署 URL ════\n');
  let urls;
  try {
    urls = await resolveUrls(state);
  } catch (err) {
    console.error('[ci-finalize-urls] resolveUrls 失败：', err?.stack || err?.message || err);
    die(err?.message || String(err));
  }
  console.log(`  Worker B = ${urls.workerBUrl}`);
  console.log(`  Pages    = ${urls.pagesUrl}`);
  console.log('  Worker A = （已解析，仅写入状态文件，不公开打印）');

  state.urls = {
    worker_b_url: urls.workerBUrl,
    pages_url: urls.pagesUrl,
    worker_a_url: urls.workerAUrl,
    worker_a_origin: urls.pagesUrl,
  };
  try {
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');
  } catch (err) {
    die(`写回 state 失败：${err?.message || err}`);
  }

  // 对齐本地 finalize：写 toml vars，后续 Redeploy 生效（勿 secret put → 10053）
  console.log('\n════ CI：回填 URL 到 wrangler.toml vars ════\n');
  const tomlA = path.join(repoRoot, 'apps', 'worker-a', 'wrangler.toml');
  const tomlB = path.join(repoRoot, 'apps', 'worker-b', 'wrangler.toml');
  try {
    for (const key of ['WORKER_B_URL', 'WORKER_A_ORIGIN']) {
      const val = key === 'WORKER_B_URL' ? urls.workerBUrl : urls.pagesUrl;
      if (upsertTomlVar(tomlA, key, val)) {
        console.log(`  ✓ apps/worker-a  ${key}`);
      } else {
        die(`apps/worker-a/wrangler.toml 未找到 ${key}=... 行（无法回填）`);
      }
    }
    if (upsertTomlVar(tomlB, 'WORKER_A_ORIGIN', urls.pagesUrl)) {
      console.log('  ✓ apps/worker-b  WORKER_A_ORIGIN');
    } else {
      die('apps/worker-b/wrangler.toml 未找到 WORKER_A_ORIGIN=... 行（无法回填）');
    }
  } catch (err) {
    die(err?.message || String(err));
  }

  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(
      process.env.GITHUB_OUTPUT,
      [`worker_b_url=${urls.workerBUrl}`, `pages_url=${urls.pagesUrl}`].join('\n') + '\n',
      'utf8',
    );
  }

  console.log('\n════ CI：URL 回填完成（后续 Redeploy 应用 toml vars）════\n');
}

main().catch((err) => {
  console.error('[ci-finalize-urls] 未捕获异常：', err?.stack || err?.message || err);
  process.exit(2);
});
