/**
 * 跨 binding D1 migration 编排器（NCF-AUDIT-RED-1 · 🔴 1）。
 *
 * 自动从 apps/worker-a/wrangler.toml 枚举所有 [[d1_databases]] 段，
 * 按 binding 顺序 apply。`DB` binding 已退役（A7-DB-RETIRE），
 * 严禁硬编码任何 binding 名——所有 binding 一律从 wrangler.toml 读。
 *
 * 用法：
 *   node apps/worker-a/scripts/migrate-local.mjs
 *   node apps/worker-a/scripts/migrate-local.mjs --dry-run
 *   node apps/worker-a/scripts/migrate-local.mjs --env preview
 *   node apps/worker-a/scripts/migrate-local.mjs --env production --remote
 *
 * 参数：
 *   --local          使用 --local（默认；不接 --remote）
 *   --remote         走远程 D1（必须配 --env preview|production）
 *   --env <name>     preview / production；不传 = 本地
 *   --dry-run        只列出会 apply 哪些 binding + 实际命令，不执行
 *   --binding <name> 只 apply 指定 binding（CI/排障用；可重复传多个）
 *
 * 失败行为：任一 binding 失败立即 process.exit，不继续后续 binding，
 * 避免半应用（D1 跨 binding 不可事务，靠顺序 stop 兜底）。
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const USAGE = `
用法：
  node apps/worker-a/scripts/migrate-local.mjs [options]

选项：
  --local               本地 wrangler dev（默认）
  --remote              远程 D1（必须配 --env）
  --env <name>          preview / production
  --dry-run             只列计划，不执行
  --binding <name>      只 apply 指定 binding（可重复）
  -h, --help            显示帮助

示例：
  # 本地（wrangler dev 前的 migration 准备）
  npm run migrate:local -w @hailuo/worker-a

  # 预览环境 apply
  npm run migrate:preview -w @hailuo/worker-a

  # 生产环境 apply
  npm run migrate:production -w @hailuo/worker-a

  # 排障：只 apply 一个 binding
  node apps/worker-a/scripts/migrate-local.mjs --binding IDENTITY_DB
`;

const workerADir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const wranglerTomlPath = path.join(workerADir, 'wrangler.toml');

// ── 1. 解析 CLI 参数 ────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const opts = { local: true, remote: false, env: undefined, dryRun: false, bindings: [] };

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '-h' || a === '--help') {
    console.log(USAGE);
    process.exit(0);
  } else if (a === '--local') {
    opts.local = true;
  } else if (a === '--remote') {
    opts.remote = true;
    opts.local = false;
  } else if (a === '--env') {
    opts.env = args[++i];
  } else if (a === '--dry-run') {
    opts.dryRun = true;
  } else if (a === '--binding') {
    opts.bindings.push(args[++i]);
  } else {
    console.error(`[migrate] 未知参数: ${a}\n${USAGE}`);
    process.exit(2);
  }
}

if (opts.remote && !opts.env) {
  console.error('[migrate] 错误：--remote 必须配 --env preview 或 --env production');
  process.exit(2);
}

// ── 2. 解析 wrangler.toml 提取所有 [[d1_databases]] binding 名 ──────────────
//
// 极简解析：扫表头识别当前是否在目标段；支持
//  - 顶层 [[d1_databases]]
//  - [[env.<name>.d1_databases]]
//  - [env.<name>] 段内嵌 [[d1_databases]]（wrangler 当前用前两种格式，保留第三种兼容）
const tomlText = readFileSync(wranglerTomlPath, 'utf8');
const allBindings = parseD1Bindings(tomlText, opts.env);

if (allBindings.length === 0) {
  console.error(`[migrate] wrangler.toml ${opts.env ? `[env.${opts.env}] ` : ''}未发现任何 [[d1_databases]] binding`);
  process.exit(2);
}

const targetBindings = opts.bindings.length > 0
  ? allBindings.filter(b => opts.bindings.includes(b))
  : allBindings;

if (targetBindings.length === 0) {
  console.error(`[migrate] --binding 指定了不存在的 binding（可选: ${allBindings.join(', ')}）`);
  process.exit(2);
}

// ── 3. 打印计划 ────────────────────────────────────────────────────────────
const flag = opts.remote ? '--remote' : '--local';
const envArg = opts.env ? `--env ${opts.env}` : '';
console.log(`[migrate] cwd: ${workerADir}`);
console.log(`[migrate] mode: ${flag}${envArg ? ' ' + envArg : ''}`);
console.log(`[migrate] 计划 apply ${targetBindings.length} 个 binding: ${targetBindings.join(', ')}`);

if (opts.dryRun) {
  console.log('[migrate] --dry-run：以下命令不会执行');
  for (const b of targetBindings) {
    const cmd = `npm exec -- wrangler d1 migrations apply ${b} ${flag} ${envArg} --config wrangler.toml`.trim().replace(/\s+/g, ' ');
    console.log(`  ${cmd}`);
  }
  process.exit(0);
}

// ── 4. 顺序 apply（任一失败立即 stop） ────────────────────────────────────
for (const binding of targetBindings) {
  console.log(`\n[migrate] → applying ${binding}...`);
  const cmdArgs = [
    'exec', '--', 'wrangler', 'd1', 'migrations', 'apply', binding,
    flag, '--config', 'wrangler.toml',
  ];
  if (opts.env) cmdArgs.push('--env', opts.env);
  const result = spawnSync('npm', cmdArgs, {
    cwd: workerADir,
    stdio: 'inherit',
    env: { ...process.env, CI: 'true' },
    shell: true,
  });
  if ((result.status ?? 1) !== 0) {
    console.error(`\n[migrate] ✗ ${binding} 失败（exit ${result.status ?? 'unknown'}），停止后续 binding，避免半应用`);
    process.exit(result.status ?? 1);
  }
  console.log(`[migrate] ✓ ${binding} ok`);
}

console.log(`\n[migrate] ✓ 全部 ${targetBindings.length} 个 binding apply 完成`);

// ── helpers ────────────────────────────────────────────────────────────────

/**
 * 极简 wrangler.toml 解析：返回指定 env（或顶层）的 [[d1_databases]] binding 名列表。
 *
 * 支持的段头：
 *   - [[d1_databases]]                          → 顶层
 *   - [[env.<name>.d1_databases]]               → 指定 env（wrangler 当前用法）
 *   - [env.<name>] 后跟 [[d1_databases]]        → 兼容（一般不存在）
 */
function parseD1Bindings(tomlText, envName) {
  const lines = tomlText.split(/\r?\n/);
  const result = [];
  let inD1 = false;

  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith('#') || line === '') continue;

    // 段头判定：每行按段头类型决定是否进入 d1 收集
    // 1) [[env.<name>.d1_databases]] 双段：仅在指定 envName 且匹配时进入
    const envD1Match = line.match(/^\[\[env\.([^.\]]+)\.d1_databases\]\]$/);
    if (envD1Match) {
      inD1 = !!envName && envD1Match[1] === envName;
      continue;
    }
    // 2) [[d1_databases]] 顶层：仅在未指定 envName 时进入
    if (line === '[[d1_databases]]') {
      inD1 = !envName;
      continue;
    }
    // 3) 任何其他段头：退出 d1
    if (line.startsWith('[[') || line.startsWith('[')) {
      inD1 = false;
      continue;
    }

    if (!inD1) continue;

    const m = line.match(/^binding\s*=\s*"([^"]+)"\s*(#.*)?$/);
    if (m) result.push(m[1]);
  }

  return result;
}
