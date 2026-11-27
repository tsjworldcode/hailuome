/**
 * M-WORKFLOW-ED25519-1 · 部署后硬校验登记三件套
 *
 * 读线上 Worker A production bindings：
 *   - ED25519_PRIVATE_KEY（secret binding 存在）
 *   - ED25519_PUBLIC_KEY（64 hex，非 auto-generated-at-deploy）
 *   - WORKER_B_URL（https，非 placeholder）
 *
 * 任一缺失 → exit 2，避免站主打开 Pages 登记才看到「节点配置不完整」。
 * 运行：node scripts/ci-verify-register-config.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareCfEnvForWrangler } from './ci-prepare-cf-env.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const statePath =
  process.env.CI_DEPLOY_STATE_PATH ||
  path.join(repoRoot, 'scripts', '.ci-deploy-state.json');

function die(msg) {
  console.error(`错误：${msg}`);
  process.exit(2);
}

function cfAuthHeaders() {
  const token = (process.env.CLOUDFLARE_API_TOKEN || '').trim();
  if (token) return { Authorization: `Bearer ${token}` };
  const email = (process.env.CLOUDFLARE_EMAIL || '').trim();
  const key = (
    process.env.CLOUDFLARE_API_KEY ||
    process.env.CLOUDFLARE_GLOBAL_API_KEY ||
    ''
  ).trim();
  if (email && key) return { 'X-Auth-Email': email, 'X-Auth-Key': key };
  return null;
}

async function main() {
  try {
    prepareCfEnvForWrangler({ requireAccountId: true });
  } catch (err) {
    die(err?.message || String(err));
  }

  if (!fs.existsSync(statePath)) die(`缺少状态文件 ${statePath}`);
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const workerAName = state.WORKER_A_NAME;
  const accountId = (process.env.CLOUDFLARE_ACCOUNT_ID || state.account_id || '').trim();
  const headers = cfAuthHeaders();
  if (!workerAName || !accountId || !headers) {
    die('缺少 WORKER_A_NAME / CLOUDFLARE_ACCOUNT_ID / API 凭证');
  }

  console.log('\n════ CI：校验登记配置（Worker A bindings）════\n');
  console.log(`  Worker A = ${workerAName}`);

  const url =
    `https://api.cloudflare.com/client/v4/accounts/${accountId}` +
    `/workers/services/${encodeURIComponent(workerAName)}/environments/production/bindings`;
  const res = await fetch(url, { headers });
  const body = await res.json();
  if (!body?.success) {
    die(`读取 bindings 失败：${JSON.stringify(body?.errors || body).slice(0, 240)}`);
  }
  const list = Array.isArray(body.result) ? body.result : body.result?.bindings || [];
  const byName = Object.fromEntries(list.map((b) => [b.name, b]));

  const hasPriv = Boolean(byName.ED25519_PRIVATE_KEY);
  const pub = String(byName.ED25519_PUBLIC_KEY?.text ?? '').trim();
  const wb = String(byName.WORKER_B_URL?.text ?? '').trim();
  const pubOk = /^[0-9a-fA-F]{64}$/.test(pub);
  const wbOk = /^https:\/\//i.test(wb) && !/placeholder|changeme/i.test(wb);

  console.log(`  ED25519_PRIVATE_KEY binding = ${hasPriv ? 'yes' : 'NO'}`);
  console.log(`  ED25519_PUBLIC_KEY          = ${pubOk ? 'HEX64_OK' : `BAD(${pub.slice(0, 24) || 'empty'}…)`}`);
  console.log(`  WORKER_B_URL                = ${wbOk ? 'URL_OK' : `BAD(${wb.slice(0, 40) || 'empty'}…)`}`);

  const fails = [];
  if (!hasPriv) fails.push('缺 ED25519_PRIVATE_KEY secret');
  if (!pubOk) fails.push('ED25519_PUBLIC_KEY 非 64hex（常见：仍是 auto-generated-at-deploy）');
  if (!wbOk) fails.push('WORKER_B_URL 缺失或仍是占位');

  if (fails.length) {
    die(
      `登记配置未就绪：${fails.join('；')}。` +
        '请重跑 deploy:ci；若反复失败设 FORCE_PUT_SECRETS=1。站主勿在此时打开登记页（会报「节点配置不完整」）。',
    );
  }

  console.log('\n  ✓ 登记三件套齐全（可打开 Pages 完成注册中心登记）\n');
}

main().catch((err) => {
  console.error('[ci-verify-register-config]', err?.stack || err?.message || err);
  process.exit(2);
});
