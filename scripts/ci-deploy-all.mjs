/**
 * M8-13 · Workers Builds / 本地 CI 统一入口
 *
 * 顺序与 .github/workflows/deploy.yml 对齐（并参考本地 deploy-all.ps1）：
 *   ensure credentials → bootstrap → prepare → migrations
 *   → deploy A → seed owner → deploy B → put secrets → finalize URLs
 *   → redeploy A/B → patch Pages bindings → Pages deploy（Account 走 CLOUDFLARE_ACCOUNT_ID env，勿传 --account-id）
 *
 * Workers Builds 推荐 Deploy command：
 *   npm run deploy:ci
 *
 * 可选环境变量：
 *   SKIP_PAGES=1
 *   HAILUO_NODE_SLOT / CI_DEPLOY_IDENTITY_JSON / WORKER_SECRETS_JSON / FORCE_PUT_SECRETS
 *   REGISTRY_URL / OWNER_SEED_USERNAME / OWNER_SEED_PASSWORD
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureCloudflareCredentials } from './ci-ensure-cf-credentials.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const statePath =
  process.env.CI_DEPLOY_STATE_PATH ||
  path.join(repoRoot, 'scripts', '.ci-deploy-state.json');

/** 与 GHA / bootstrap runWrangler 同钉，避免 npx 拉到 wrangler 4（需 Node 22） */
const WRANGLER_PKG = 'wrangler@3.114.17';

function die(msg, code = 2) {
  console.error(`错误：${msg}`);
  process.exit(code);
}

function run(label, command, args, { env = process.env, cwd = repoRoot } = {}) {
  console.log(`\n────── ${label} ──────`);
  const bin = process.platform === 'win32' && command === 'npx' ? 'npx.cmd' : command;
  const r = spawnSync(bin, args, {
    cwd,
    encoding: 'utf8',
    env: { ...env, CI: 'true' },
    shell: process.platform === 'win32',
    stdio: 'inherit',
  });
  if ((r.status ?? 1) !== 0) die(`${label} 失败（exit ${r.status}）`);
}

function runNode(rel) {
  run(rel, process.execPath, [path.join(repoRoot, rel)]);
}

/** @param {string[]} args @param {string} [cwd]  Pages 必须传 web/，否则 functions/ 不上传 */
function runWrangler(args, cwd = repoRoot) {
  run(`wrangler ${args.join(' ')}`, 'npx', ['--yes', WRANGLER_PKG, ...args], { cwd });
}

async function main() {
  console.log('\n╔══════════════════════════════════════╗');
  console.log('║  hailuo deploy:ci（Workers Builds）  ║');
  console.log('╚══════════════════════════════════════╝\n');

  if (process.env.WORKERS_CI) {
    console.log('检测到 WORKERS_CI=1（Cloudflare Workers Builds）');
  }

  try {
    await ensureCloudflareCredentials();
  } catch (err) {
    die(err.message || String(err));
  }

  runNode('scripts/ci-bootstrap-resources.mjs');
  // 先 migrate + deploy，再 secret put（Worker 必须先存在）
  runNode('scripts/ci-prepare-cf-env.mjs');
  runNode('scripts/ci-apply-migrations.mjs');

  // DEPLOY-SB-10143：空账号先 A 会 10143（B 尚不存在）；缺 B 时 stub 部署（无 WORKER_A 绑定）
  runNode('scripts/bootstrap-worker-b-peer.mjs');
  runWrangler(['deploy', '--env', 'production', '--config', 'apps/worker-a/wrangler.toml']);
  // 对齐本地 deploy-hailuo-workers：A deploy 后立刻 seed 站主
  runNode('scripts/ci-seed-default-owner.mjs');
  runWrangler(['deploy', '--env', 'production', '--config', 'apps/worker-b/wrangler.toml']);

  runNode('scripts/ci-put-secrets.mjs');
  runNode('scripts/ci-finalize-urls.mjs');

  runWrangler(['deploy', '--env', 'production', '--config', 'apps/worker-a/wrangler.toml']);
  runWrangler(['deploy', '--env', 'production', '--config', 'apps/worker-b/wrangler.toml']);

  // M-WORKFLOW-ED25519-1：Redeploy 后硬校验公钥/私钥/WORKER_B_URL，避免假绿后登记 MISCONFIGURED
  runNode('scripts/ci-verify-register-config.mjs');

  // M-WORKFLOW-SDH-1：finalize 后 toml 已回填真 id → post-patch（对齐本地 deploy-all Phase 3.5）
  run('SDH-3 post-patch', 'npm', ['run', 'test:deploy-config-consistency:post-patch']);

  if (process.env.SKIP_PAGES === '1') {
    console.log('\nSKIP_PAGES=1 → 跳过 Pages\n');
  } else {
    if (!fs.existsSync(statePath)) die(`缺少状态文件 ${statePath}`);
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    const pagesName = state.PAGES_PROJECT_NAME;
    const workerBUrl = state.urls?.worker_b_url;
    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID || state.account_id || '';
    if (!pagesName || !workerBUrl) die('状态文件缺少 PAGES_PROJECT_NAME 或 urls.worker_b_url');
    // 对齐本地 deploy-all.ps1：只设 env CLOUDFLARE_ACCOUNT_ID；
    // wrangler@3.x `pages deploy` **不认** `--account-id`（会报 Unknown arguments: account-id, accountId）
    if (!accountId) die('缺少 CLOUDFLARE_ACCOUNT_ID（Pages deploy 靠环境变量，勿传 --account-id）');
    process.env.CLOUDFLARE_ACCOUNT_ID = accountId;

    process.env.PUBLIC_WORKER_B_URL = workerBUrl;
    // 对齐本地 deploy-all Deploy-Pages：构建期注入注册中心（Turnstile / deploy-env.json）
    const registryUrl = (
      process.env.REGISTRY_URL ||
      state.REGISTRY_URL ||
      'https://hailuo-registry.allovo.eu.org'
    )
      .trim()
      .replace(/\/+$/, '');
    process.env.PUBLIC_REGISTRY_URL = registryUrl;
    process.env.HAILUO_DEPLOY_STRICT = process.env.HAILUO_DEPLOY_STRICT || '1';

    run('build web', 'npm', ['run', 'build', '--workspace=web']);

    const list = spawnSync('npx', ['--yes', WRANGLER_PKG, 'pages', 'project', 'list'], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...process.env, CI: 'true' },
      shell: process.platform === 'win32',
    });
    const listed = `${list.stdout || ''}${list.stderr || ''}`;
    if (!listed.includes(pagesName)) {
      runWrangler(['pages', 'project', 'create', pagesName, '--production-branch', 'main']);
    }

    // 对齐本地 deploy-all：先 PATCH Production 绑定，再 pages deploy
    // （CF Pages 的 Service Binding / KV / secret 只作用于新部署；先 deploy 后 PATCH 会导致 Owner Gateway 缺 WORKER_A）
    runNode('scripts/ci-patch-pages-bindings.mjs');

    // 必须 cwd=web/ 部署 dist（与本地 deploy-all.ps1 一致）；从仓库根 deploy web/dist 会漏 Functions
    runWrangler(
      [
        'pages',
        'deploy',
        'dist',
        '--project-name',
        pagesName,
        '--branch',
        'main',
        '--commit-dirty=true',
        '--commit-message',
        'hailuo-ci-deploy',
      ],
      path.join(repoRoot, 'web'),
    );
  }

  const state = fs.existsSync(statePath)
    ? JSON.parse(fs.readFileSync(statePath, 'utf8'))
    : null;

  // P1-4 / TOML-BAK：部署成功后自动备份真值到 *.bak 并还原 git 占位（防误 commit 泄漏指纹）
  // 注意：不可走 run()/die()——还原失败不应让已成功的部署以非 0 退出
  {
    console.log('\n────── restore wrangler placeholders ──────');
    const bin = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const r = spawnSync(bin, ['run', 'restore:wrangler-placeholders'], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...process.env, CI: 'true' },
      shell: process.platform === 'win32',
      stdio: 'inherit',
    });
    if ((r.status ?? 1) !== 0) {
      console.warn(
        '\n⚠ 自动还原 wrangler.toml 占位失败（Cloudflare 侧已部署成功）。请立刻手动：npm run restore:wrangler-placeholders\n',
      );
    }
  }

  console.log('\n════ 部署摘要 ════');
  if (state) {
    console.log(`  占位 handle : ${state.BOOTSTRAP_HANDLE}`);
    console.log(`  Worker B    : ${state.urls?.worker_b_url || '(见 finalize 日志)'}`);
    console.log(`  Pages       : ${state.urls?.pages_url || '(见 Pages 部署日志)'}`);
    console.log(`  Worker B 名 : ${state.WORKER_B_NAME}`);
    console.log(`  Pages 项目  : ${state.PAGES_PROJECT_NAME}`);
    if (state.r2?.status === 'bound') {
      console.log(`  图片对象库  : 已绑定 ${state.r2.binding || 'HAILUO_IMAGE_R2'} → ${state.r2.bucket_name || ''}`);
    } else {
      console.log(`  图片对象库  : 未绑定，图片继续走 KV（${state.r2?.reason || '未执行'}）`);
    }
    console.log('  （Worker A 地址不打印 — 私密写层）');
  }
  console.log('\n下一步：打开 Pages → 登录（首次通常 admin / admin）→ 设置里登记注册中心\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
