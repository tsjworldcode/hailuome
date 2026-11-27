#!/usr/bin/env node
/** 仅部署 Pages（含 Owner Gateway functions），用于 allowlist 等热修
 *
 * 输出过滤：wrangler pages deploy 总会同时输出「Preview URL (https://<hash>.<project>.pages.dev/)」
 * 和「生产 URL (https://<project>.pages.dev/)」。预览 URL 是 CLI 部署的硬行为——只在通过
 * git push（Dashboard Pages 启用 Git 集成）部署时才能彻底消除。这里做最小干预：
 *   ①过滤 stdout/stderr，把预览 URL 那行删掉（避免误把预览当生产）
 *   ②打印一条醒目的「生产域名」提示给运维
 *
 * 长期方案：去 Cloudflare Dashboard → Pages 项目 → Settings → Builds → 启用 "Connect to Git"
 *   改 push + Cloudflare 自动 build/deploy，只更新 production，不再创建 Preview URL。
 */
import { readFileSync } from 'node:fs';
import { execSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const token = JSON.parse(readFileSync(path.join(root, 'scripts', 'cloudflare-api-token.json'), 'utf8'));

process.env.CLOUDFLARE_API_TOKEN = token.CLOUDFLARE_API_TOKEN;
process.env.CLOUDFLARE_ACCOUNT_ID = token.CLOUDFLARE_ACCOUNT_ID;
process.env.CI = 'true';
if (token.WORKER_B_URL) process.env.PUBLIC_WORKER_B_URL = String(token.WORKER_B_URL).replace(/\/+$/, '');
if (token.REGISTRY_URL) process.env.PUBLIC_REGISTRY_URL = String(token.REGISTRY_URL).replace(/\/+$/, '');

const project = token.PAGES_PROJECT_NAME;
if (!project) throw new Error('token missing PAGES_PROJECT_NAME');

execSync('node scripts/gen-owner-gateway-allowlist.mjs', { cwd: root, stdio: 'inherit', shell: true });
execSync('npm run build --workspace=web', { cwd: root, stdio: 'inherit', shell: true });

/** wrangler 输出过滤：删除含 Preview URL（https://<8hex>.<project>.pages.dev）的行。
 *  生产分支 URL（https://<project>.pages.dev/）不带 hash 前缀，不应被误删。 */
function runDeploy(cmd, cwd) {
  const r = spawnSync(cmd, {
    cwd,
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  });
  const previewUrlRe = new RegExp(`https://[0-9a-f]{6,}\\.${project}\\.pages\\.dev/?\\S*`, 'i');
  const filterLine = (line) => (previewUrlRe.test(line) ? '' : line);
  const filteredOut = (r.stdout || '').split(/\r?\n/).map(filterLine).filter(Boolean).join('\n');
  const filteredErr = (r.stderr || '').split(/\r?\n/).map(filterLine).filter(Boolean).join('\n');
  if (filteredOut) process.stdout.write(filteredOut + (filteredOut.endsWith('\n') ? '' : '\n'));
  if (filteredErr) process.stderr.write(filteredErr + (filteredErr.endsWith('\n') ? '' : '\n'));
  if (r.status !== 0) process.exit(r.status || 1);
}

const msg = process.argv[2] || 'operator: pages deploy';
const deployCmd = `npm exec -- wrangler pages deploy dist --project-name ${project} --branch main --commit-dirty=true --commit-message "${msg.replace(/"/g, '\\"')}"`;
runDeploy(deployCmd, path.join(root, 'web'));

// 显式打出生产域名，避免运维把 Preview URL 当成生产
console.log(`\nPages deploy OK: ${project}`);
console.log(`Production URL : https://${project}.pages.dev/`);
console.log(`(Preview URL 仅 wrangler CLI 部署才会创建；要彻底消除请启用 Pages Dashboard Git 集成 + git push)`);