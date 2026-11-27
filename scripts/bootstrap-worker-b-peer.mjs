/**
 * DEPLOY-SB-10143：空账号 / Worker B 缺失时，先 stub 部署 Worker B（临时去掉 WORKER_A Service Binding），
 * 打破 A↔B 互指鸡生蛋，避免后续 `wrangler deploy` Worker A 报 10143。
 *
 * 若 Worker B 已存在 → 直接跳过（幂等）。
 * 部署后立刻还原 wrangler.toml（完整 B→A 绑定留给正式 Deploy Worker B 步骤）。
 *
 * 用法：
 *   node scripts/bootstrap-worker-b-peer.mjs
 *   node scripts/bootstrap-worker-b-peer.mjs --token-file scripts/cloudflare-api-token.json
 *   node scripts/bootstrap-worker-b-peer.mjs --force   # 即使已存在也 stub 再部署（一般不需要）
 *
 * 凭据：CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID（env 或 token 文件）
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { stripEnvServiceBinding } from './patch-wrangler-toml.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const defaultToken = path.join(repoRoot, 'scripts', 'cloudflare-api-token.json');
const tomlB = path.join(repoRoot, 'apps', 'worker-b', 'wrangler.toml');

function parseArgs(argv) {
  const out = { tokenFile: defaultToken, force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--token-file') out.tokenFile = path.resolve(argv[++i] || '');
    else if (a === '--force') out.force = true;
    else if (a === '--help' || a === '-h') {
      console.log(`bootstrap-worker-b-peer.mjs — 缺 B 时 stub 部署（无 WORKER_A 绑定）

用法见文件头。`);
      process.exit(0);
    } else {
      console.error(`未知参数：${a}`);
      process.exit(2);
    }
  }
  return out;
}

function loadToken(tokenFile) {
  if (!fs.existsSync(tokenFile)) return {};
  try {
    return JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
  } catch {
    return {};
  }
}

function readProductionWorkerName(tomlPath) {
  const text = fs.readFileSync(tomlPath, 'utf8');
  const m = text.match(
    /\[env\.production\][^\[]*?^\s*name\s*=\s*"([^"]+)"/m,
  );
  return m ? m[1].trim() : '';
}

async function workerExists(accountId, apiToken, workerName) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${encodeURIComponent(workerName)}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${apiToken}` },
  });
  if (res.status === 404) return false;
  if (res.status === 200) return true;
  const body = await res.text().catch(() => '');
  throw new Error(`探测 Worker ${workerName} 失败：HTTP ${res.status} ${body.slice(0, 200)}`);
}

function runWranglerDeploy() {
  const r = spawnSync(
    'npm',
    ['exec', '--', 'wrangler@3.114.17', 'deploy', '--env', 'production', '--config', 'apps/worker-b/wrangler.toml'],
    {
      cwd: repoRoot,
      env: process.env,
      encoding: 'utf8',
      shell: true,
      stdio: 'inherit',
    },
  );
  if (r.status !== 0) {
    throw new Error(`Worker B stub deploy 失败（exit ${r.status}）`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const token = loadToken(args.tokenFile);

  const apiToken = String(process.env.CLOUDFLARE_API_TOKEN || token.CLOUDFLARE_API_TOKEN || '').trim();
  const accountId = String(process.env.CLOUDFLARE_ACCOUNT_ID || token.CLOUDFLARE_ACCOUNT_ID || '').trim();
  if (!apiToken || !accountId) {
    console.error('缺少 CLOUDFLARE_API_TOKEN 或 CLOUDFLARE_ACCOUNT_ID');
    process.exit(2);
  }
  process.env.CLOUDFLARE_API_TOKEN = apiToken;
  process.env.CLOUDFLARE_ACCOUNT_ID = accountId;

  const workerBName =
    String(token.WORKER_B_NAME || '').trim() || readProductionWorkerName(tomlB);
  if (!workerBName || /placeholder/i.test(workerBName)) {
    console.error(`Worker B 名无效或仍是 placeholder：${workerBName || '(empty)'}`);
    process.exit(2);
  }

  if (!args.force) {
    const exists = await workerExists(accountId, apiToken, workerBName);
    if (exists) {
      console.log(`  ✓ Worker B 已存在（${workerBName}）→ 跳过 stub bootstrap`);
      return;
    }
    console.log(`  · Worker B 不存在（${workerBName}）→ stub 部署（临时去掉 WORKER_A 绑定）`);
  } else {
    console.log(`  · --force：强制 stub 部署 Worker B（${workerBName}）`);
  }

  if (!fs.existsSync(tomlB)) {
    console.error(`找不到 ${tomlB}`);
    process.exit(2);
  }

  const original = fs.readFileSync(tomlB, 'utf8');
  const { text: stripped, removed } = stripEnvServiceBinding(original, {
    env: 'production',
    binding: 'WORKER_A',
  });
  if (removed < 1) {
    console.warn('  WARN：未找到 [[env.production.services]] WORKER_A；仍尝试 stub 部署');
  } else {
    console.log(`  · 已临时剥离 ${removed} 处 WORKER_A Service Binding`);
  }

  fs.writeFileSync(tomlB, stripped, 'utf8');
  try {
    runWranglerDeploy();
    console.log('  ✓ Worker B stub 已部署（无 WORKER_A 绑定；正式步骤会补全）');
  } finally {
    // 无论成败都还原 toml，避免工作区留下「缺绑定」的半残配置
    fs.writeFileSync(tomlB, original, 'utf8');
    console.log('  ✓ 已还原 apps/worker-b/wrangler.toml（含 WORKER_A 绑定）');
  }
}

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
