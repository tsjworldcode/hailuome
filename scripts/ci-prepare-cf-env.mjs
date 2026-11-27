/**
 * M-WORKFLOW-ARTIFACT-2 · 部署 job 启动前统一准备 Cloudflare 环境
 *
 * 解决真跑踩坑：
 * 1) bootstrap 探测到的 CLOUDFLARE_ACCOUNT_ID 只在 job1 进程内；job2/3 fresh runner
 *    若 Secrets 未配 ACCOUNT_ID，wrangler 会打 GET /memberships → Scoped Token 常返 10000
 * 2) Global Key 存在 CLOUDFLARE_GLOBAL_API_KEY，但 wrangler 只认 CLOUDFLARE_API_KEY
 *
 * 用法（workflow / 其它 CI 脚本）：
 *   node scripts/ci-prepare-cf-env.mjs
 *   import { prepareCfEnvForWrangler } from './ci-prepare-cf-env.mjs'
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { adaptWranglerAuthForGlobalKey } from './ci-ensure-cf-credentials.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

function sha8(value) {
  if (!value) return '(empty)';
  return createHash('sha256').update(String(value), 'utf8').digest('hex').slice(0, 8);
}

function defaultStatePath() {
  return (
    process.env.CI_DEPLOY_STATE_PATH ||
    path.join(repoRoot, 'scripts', '.ci-deploy-state.json')
  );
}

/**
 * @param {{ statePath?: string, requireAccountId?: boolean }} [opts]
 * @returns {{
 *   mode: string,
 *   accountId: string,
 *   accountIdSource: 'env' | 'state' | 'none',
 *   statePath: string,
 *   stateLoaded: boolean,
 * }}
 */
export function prepareCfEnvForWrangler(opts = {}) {
  const statePath = opts.statePath || defaultStatePath();
  const requireAccountId = opts.requireAccountId !== false;

  console.log('\n════ CI：prepare Cloudflare env（鉴权 + Account ID）════\n');

  let auth;
  try {
    auth = adaptWranglerAuthForGlobalKey();
  } catch (err) {
    console.error('[prepare-cf-env] 鉴权适配失败：', err?.message || err);
    throw err;
  }

  let state = null;
  let stateLoaded = false;
  if (fs.existsSync(statePath)) {
    try {
      // Windows PowerShell 写文件可能带 UTF-8 BOM，JSON.parse 会炸
      const raw = fs.readFileSync(statePath, 'utf8').replace(/^\uFEFF/, '');
      state = JSON.parse(raw);
      stateLoaded = true;
      console.log(`  ✓ 已读 state：${path.relative(repoRoot, statePath)}`);
      if (state._error) {
        console.warn(`  ⚠ state._error = ${String(state._error).slice(0, 200)}`);
      }
    } catch (err) {
      console.error(`[prepare-cf-env] 解析 state 失败：${err?.message || err}`);
      throw new Error(`无法解析 ${statePath}：${err?.message || err}`);
    }
  } else {
    console.warn(`  ⚠ 无 state 文件：${statePath}`);
  }

  let accountIdSource = 'none';
  let accountId = (process.env.CLOUDFLARE_ACCOUNT_ID || '').trim();
  if (accountId) {
    accountIdSource = 'env';
    console.log(`  ✓ CLOUDFLARE_ACCOUNT_ID 来自环境变量 sha8=${sha8(accountId)}`);
  } else if (state?.account_id) {
    accountId = String(state.account_id).trim();
    process.env.CLOUDFLARE_ACCOUNT_ID = accountId;
    accountIdSource = 'state';
    console.log(
      `  ✓ CLOUDFLARE_ACCOUNT_ID 从 state.account_id 恢复 sha8=${sha8(accountId)}（避免 wrangler 打 /memberships）`,
    );
  } else {
    console.error('  ✗ 环境变量与 state 都没有 CLOUDFLARE_ACCOUNT_ID');
  }

  // 写回 GITHUB_ENV，让同 job 后续 shell / wrangler 步骤也能拿到
  if (process.env.GITHUB_ENV) {
    try {
      const lines = [];
      if (accountId) lines.push(`CLOUDFLARE_ACCOUNT_ID=${accountId}`);
      // Global Key 桥接只发生在本进程；须写入 GITHUB_ENV，否则下一 step 的 wrangler 仍看不到 CLOUDFLARE_API_KEY
      if (process.env.CLOUDFLARE_API_KEY && !process.env.CLOUDFLARE_API_TOKEN) {
        lines.push(`CLOUDFLARE_API_KEY=${process.env.CLOUDFLARE_API_KEY}`);
      }
      if (lines.length > 0) {
        fs.appendFileSync(process.env.GITHUB_ENV, `${lines.join('\n')}\n`, 'utf8');
        console.log('  ✓ 已写入 $GITHUB_ENV（ACCOUNT_ID' + (lines.length > 1 ? '+API_KEY bridge' : '') + '）');
      }
    } catch (err) {
      console.warn(`  ⚠ 写 GITHUB_ENV 失败：${err?.message || err}`);
    }
  }

  const hasToken = Boolean(process.env.CLOUDFLARE_API_TOKEN);
  const hasGlobal = Boolean(process.env.CLOUDFLARE_GLOBAL_API_KEY);
  const hasApiKeyBridge = Boolean(process.env.CLOUDFLARE_API_KEY);
  const hasEmail = Boolean(process.env.CLOUDFLARE_EMAIL);

  console.log('  ── 凭证摘要（无明文）──');
  console.log(`  mode              = ${auth?.mode || 'unknown'}`);
  console.log(`  API_TOKEN         = ${hasToken ? `present sha8=${sha8(process.env.CLOUDFLARE_API_TOKEN)} len=${process.env.CLOUDFLARE_API_TOKEN.length}` : 'absent'}`);
  console.log(`  GLOBAL_API_KEY    = ${hasGlobal ? `present sha8=${sha8(process.env.CLOUDFLARE_GLOBAL_API_KEY)}` : 'absent'}`);
  console.log(`  API_KEY(bridge)   = ${hasApiKeyBridge ? `present sha8=${sha8(process.env.CLOUDFLARE_API_KEY)}` : 'absent'}`);
  console.log(`  EMAIL             = ${hasEmail ? 'present' : 'absent'}`);
  console.log(`  ACCOUNT_ID source = ${accountIdSource}`);
  console.log(`  ACCOUNT_ID sha8   = ${sha8(accountId)}`);

  if (!hasToken && !hasGlobal) {
    throw new Error(
      '缺少 Cloudflare 凭证：请配 CLOUDFLARE_API_TOKEN（推荐）或 CLOUDFLARE_GLOBAL_API_KEY + CLOUDFLARE_EMAIL',
    );
  }

  if (requireAccountId && !accountId) {
    throw new Error(
      [
        '缺少 CLOUDFLARE_ACCOUNT_ID。',
        'Scoped Token 通常不能调 /memberships；必须显式 Account ID，否则 wrangler 报 Authentication error [code: 10000]。',
        '修法：① GitHub Secrets 配 CLOUDFLARE_ACCOUNT_ID；或 ② 确保 bootstrap 已写出 state.account_id 且本 job 已下载 artifact。',
      ].join('\n'),
    );
  }

  console.log('\n════ CI：prepare Cloudflare env 完成 ════\n');
  return {
    mode: auth?.mode || 'unknown',
    accountId,
    accountIdSource,
    statePath,
    stateLoaded,
  };
}

const isMain =
  process.argv[1] &&
  (process.argv[1].endsWith('ci-prepare-cf-env.mjs') ||
    process.argv[1].includes('ci-prepare-cf-env'));

if (isMain) {
  try {
    prepareCfEnvForWrangler({ requireAccountId: true });
  } catch (err) {
    console.error(`错误：${err?.message || err}`);
    process.exit(2);
  }
}
