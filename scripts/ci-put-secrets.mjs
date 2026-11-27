/**
 * M8-12/13 · 从 .ci-deploy-state.json 向 Worker A/B 注入 Secret
 *
 * 前置：Worker 已至少 deploy 过一次（否则 wrangler secret put 报 Worker not found）。
 * 若 state.skip_secret_put=true（升级保留线上密钥），本脚本直接跳过。
 * 运行：node scripts/ci-put-secrets.mjs
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareCfEnvForWrangler } from './ci-prepare-cf-env.mjs';
import { ensureMediaTicketSecret } from './lib/ensure-media-ticket-secret.mjs';

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

function putSecret(workerDir, key, value) {
  if (!value) die(`密钥 ${key} 为空`);
  const bin = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  console.log(`  → put ${key} @ ${workerDir}`);
  const r = spawnSync(
    bin,
    ['--yes', WRANGLER_PKG, 'secret', 'put', key, '--env', 'production', '--config', 'wrangler.toml'],
    {
      cwd: path.join(repoRoot, workerDir),
      encoding: 'utf8',
      input: value,
      env: { ...process.env, CI: 'true' },
      shell: process.platform === 'win32',
    },
  );
  if ((r.status ?? 1) !== 0) {
    process.stderr.write(r.stderr || r.stdout || '');
    const combined = `${r.stdout || ''}${r.stderr || ''}`;
    if (/Worker not found|does not exist|10007/i.test(combined)) {
      console.error(
        '[ci-put-secrets] 提示：Worker 尚不存在。请先 wrangler deploy，再 secret put（workflow 已把本步放在首次 deploy 之后）。',
      );
    }
    if (/code:\s*10000|Authentication error/i.test(combined)) {
      console.error(
        '[ci-put-secrets] 鉴权 10000：检查 ACCOUNT_ID 是否已从 state 恢复、Token 是否有效。',
      );
    }
    die(`secret put ${key} @ ${workerDir} 失败（exit ${r.status}）`);
  }
  console.log(`  ✓ ${workerDir}  ${key}`);
}

async function main() {
  try {
    prepareCfEnvForWrangler({ requireAccountId: true });
  } catch (err) {
    die(err?.message || String(err));
  }

  if (!fs.existsSync(statePath)) die(`状态文件不存在：${statePath}（请先跑 ci-bootstrap-resources.mjs）`);
  let state;
  try {
    state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch (err) {
    die(`解析 state 失败：${err?.message || err}`);
  }
  const secrets = state.secrets || {};

  // 与本地 bootstrap token 示例对齐；可用 Secret REGISTRY_URL / 环境变量覆盖
  const registryUrl = (
    process.env.REGISTRY_URL ||
    state.REGISTRY_URL ||
    'https://hailuo-registry.allovo.eu.org'
  )
    .trim()
    .replace(/\/+$/, '');

  if (state.skip_secret_put && process.env.FORCE_PUT_SECRETS !== '1') {
    console.log('\n════ CI：跳过 Secret 注入（升级保留线上密钥）════\n');
  } else {
    console.log('\n════ CI：注入 Worker A Secrets ════\n');
    putSecret('apps/worker-a', 'JWT_SECRET', secrets.JWT_SECRET);
    putSecret('apps/worker-a', 'INTERNAL_FORWARD_SECRET', secrets.INTERNAL_FORWARD_SECRET);
    putSecret('apps/worker-a', 'TOTP_WRAP_SECRET', secrets.TOTP_WRAP_SECRET);
    putSecret('apps/worker-a', 'NODE_API_TOKEN_WRAP_SECRET', secrets.NODE_API_TOKEN_WRAP_SECRET);
    if (secrets.GROUP_OWNER_KEY_WRAP_SECRET) {
      putSecret('apps/worker-a', 'GROUP_OWNER_KEY_WRAP_SECRET', secrets.GROUP_OWNER_KEY_WRAP_SECRET);
    }
    putSecret('apps/worker-a', 'ED25519_PRIVATE_KEY', secrets.ED25519_PRIVATE_KEY);
    if (registryUrl) {
      putSecret('apps/worker-a', 'REGISTRY_URL', registryUrl);
    }

    console.log('\n════ CI：注入 Worker B Secrets ════\n');
    putSecret('apps/worker-b', 'INTERNAL_FORWARD_SECRET', secrets.INTERNAL_FORWARD_SECRET);
    if (registryUrl) {
      putSecret('apps/worker-b', 'REGISTRY_URL', registryUrl);
    }
  }

  // SEC-6-SECRET：无论是否 skip_secret_put，媒体票据钥都「缺则补、有则留」（仅 Worker B）
  console.log('\n════ CI：确保 Worker B MEDIA_TICKET_SECRET（幂等）════\n');
  try {
    ensureMediaTicketSecret({
      workerDir: 'apps/worker-b',
      preferredValue: secrets.MEDIA_TICKET_SECRET || '',
      wranglerPkg: WRANGLER_PKG,
    });
  } catch (err) {
    die(err?.message || String(err));
  }

  // 供 Pages PATCH 读（不入库明文到 git；仅本机 state，已 gitignore）
  try {
    state.REGISTRY_URL = registryUrl;
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');
  } catch (err) {
    console.warn(`[ci-put-secrets] 写回 REGISTRY_URL 到 state 失败（继续）：${err?.message || err}`);
  }

  console.log('\n════ CI：Secret 注入完成 ════\n');
  console.log(
    '提示：WORKER_B_URL / WORKER_A_ORIGIN 由 ci-finalize-urls 写 toml vars（对齐本地；勿 secret put）。\n',
  );
  console.log(
    '提示：MEDIA_TICKET_SECRET 仅 Worker B；已存在则跳过。强制轮换设 FORCE_MEDIA_TICKET_SECRET=1。\n',
  );
}

main().catch((err) => {
  console.error('[ci-put-secrets] 未捕获异常：', err?.stack || err?.message || err);
  process.exit(2);
});
