/**
 * 确保 Cloudflare Pages 项目存在（REST API，比 wrangler create 更稳）。
 *
 * 用法：node scripts/ensure-pages-project.mjs --token-file scripts/cloudflare-api-token.json
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pickConfigString } from './resolve-deploy-urls.mjs';

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));

async function cfFetch(token, url, init = {}) {
  const headers = { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) };
  if (init.body && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(url, { ...init, headers });
  const data = await res.json();
  return { res, data };
}

function parseArgs(argv) {
  const opts = { tokenFile: path.join(SCRIPTS_DIR, 'cloudflare-api-token.json'), branch: 'main' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--token-file' && argv[i + 1]) opts.tokenFile = path.resolve(argv[++i]);
    else if (a.startsWith('--token-file=')) opts.tokenFile = path.resolve(a.slice('--token-file='.length));
    else if (a === '--branch' && argv[i + 1]) opts.branch = argv[++i];
  }
  return opts;
}

async function listPagesProjects(accountId, token) {
  const { res, data } = await cfFetch(
    token,
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/pages/projects`,
  );
  if (!data.success) {
    throw new Error(`列出 Pages 项目失败: ${JSON.stringify(data.errors ?? data)}`);
  }
  return data.result ?? [];
}

async function createPagesProject(accountId, token, name, branch) {
  const { res, data } = await cfFetch(
    token,
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/pages/projects`,
    {
      method: 'POST',
      body: JSON.stringify({ name, production_branch: branch }),
    },
  );
  if (data.success) return data.result;
  const code = data.errors?.[0]?.code;
  const msg = data.errors?.[0]?.message ?? JSON.stringify(data.errors);
  throw new Error(`创建 Pages 项目失败 (${res.status}, code ${code}): ${msg}`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(opts.tokenFile)) {
    console.error(`[ensure-pages-project] 未找到: ${opts.tokenFile}`);
    process.exit(1);
  }

  const config = JSON.parse(fs.readFileSync(opts.tokenFile, 'utf8'));
  const accountId = pickConfigString(config, ['CLOUDFLARE_ACCOUNT_ID']);
  const token = pickConfigString(config, ['CLOUDFLARE_API_TOKEN']);
  const projectName = pickConfigString(config, ['PAGES_PROJECT_NAME']);
  const branch = pickConfigString(config, ['PAGES_BRANCH']) || opts.branch;

  if (!accountId || !token || !projectName) {
    console.error('[ensure-pages-project] token 缺少 CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN / PAGES_PROJECT_NAME');
    process.exit(1);
  }

  const projects = await listPagesProjects(accountId, token);
  const existing = projects.find((p) => p.name === projectName);
  if (existing) {
    console.log(`[ensure-pages-project] 已存在: ${projectName}`);
    process.stdout.write(JSON.stringify({ ok: true, created: false, name: projectName }));
    return;
  }

  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await createPagesProject(accountId, token, projectName, branch);
      console.log(`[ensure-pages-project] 已创建: ${projectName}`);
      process.stdout.write(JSON.stringify({ ok: true, created: true, name: projectName }));
      return;
    } catch (err) {
      lastErr = err;
      if (attempt < 3) {
        console.warn(`[ensure-pages-project] 第 ${attempt} 次失败，5s 后重试: ${err.message}`);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }

  console.error(`[ensure-pages-project] ${lastErr?.message ?? lastErr}`);
  console.error('[ensure-pages-project] 可在 Cloudflare 控制台手动创建 Pages 项目后重跑 deploy-all.ps1');
  process.exit(1);
}

main().catch((err) => {
  console.error('[ensure-pages-project] 失败:', err.message ?? err);
  process.exit(1);
});
