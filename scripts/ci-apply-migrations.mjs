/**
 * M8-12 · 按序 apply 全部 production D1 migration（A7-DB-RETIRE 后无 binding=DB）
 *
 * 顺序：DB_IMPORT → IDENTITY → GOVERNANCE → CONTENT → MESSAGING → MESSAGING_SHARD_1
 * 运行：node scripts/ci-apply-migrations.mjs
 *
 * 硬前置：必须已 prepare CLOUDFLARE_ACCOUNT_ID（否则 wrangler 打 /memberships → 10000）
 *
 * DEPLOY-MIG-RETRY-1（2026-11-24）：GitHub Actions 上出现过 apply 到一半被 SIGTERM 杀掉
 * （日志 `exit=null signal=SIGTERM`，没有任何 SQL 报错，DB_IMPORT 已成功写入 0001-0004）。
 * 对齐本地 deploy-hailuo-workers.ps1 的两点：
 *   1) 直接跑仓库内 wrangler bin，不经 npx/npm 包装层（少一层信号转发，少一次版本解析）；
 *   2) 每个 binding 最多重试 3 次（间隔 5s）：信号终止 / 网络瞬时错误都算可重试。
 *      wrangler 会把已 apply 的 migration 记进 d1_migrations，重跑从断点继续，重复执行安全。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareCfEnvForWrangler } from './ci-prepare-cf-env.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const workerA = path.join(repoRoot, 'apps', 'worker-a');

/** 与 deploy.yml / ci-bootstrap 锁同版本，避免 npx 拉到 wrangler 4（需 Node 22） */
const WRANGLER_PKG = 'wrangler@3.114.17';
/** 本地已安装的 wrangler CLI 入口（仓库依赖由 CI 的 npm ci 安装；与使用者本机是否装 wrangler 无关） */
const WRANGLER_JS = path.join(repoRoot, 'node_modules', 'wrangler', 'bin', 'wrangler.js');

/** 单 binding 最多尝试次数 / 重试间隔，对齐本地 Invoke-WranglerWithRetry -MaxAttempts 3 */
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 5000;

const BINDINGS = [
  'DB_IMPORT',
  'IDENTITY_DB',
  'GOVERNANCE_DB',
  'CONTENT_DB',
  'MESSAGING_DB',
  'MESSAGING_SHARD_1',
];

function die(msg) {
  console.error(`错误：${msg}`);
  process.exit(2);
}

/** 同步 sleep：spawnSync 流程里不能 await 定时器，用 Atomics.wait 阻塞当前线程 */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * 优先 `node node_modules/wrangler/bin/wrangler.js`；缺失时才回落 npx。
 * 本地 deploy-hailuo-workers.ps1 也是直接调 node_modules 下的 wrangler。
 */
function resolveWranglerRunner() {
  if (fs.existsSync(WRANGLER_JS)) {
    return { label: `node ${path.relative(repoRoot, WRANGLER_JS)}`, bin: process.execPath, prefix: [WRANGLER_JS], shell: false };
  }
  return {
    label: `npx --yes ${WRANGLER_PKG}`,
    bin: process.platform === 'win32' ? 'npx.cmd' : 'npx',
    prefix: ['--yes', WRANGLER_PKG],
    shell: process.platform === 'win32',
  };
}

function explainWranglerAuthFailure(out) {
  const text = String(out || '');
  if (/code:\s*10000|Authentication error/i.test(text)) {
    if (/\/memberships/i.test(text)) {
      return [
        '根因提示：wrangler 在缺 CLOUDFLARE_ACCOUNT_ID 时会调 GET /memberships，',
        'Account-scoped API Token 常在此返回 Authentication error [code: 10000]。',
        '请确认本 job 已跑 ci-prepare-cf-env.mjs，且 state.account_id / Secrets 有 Account ID。',
      ].join('\n');
    }
    return [
      '根因提示：Cloudflare 鉴权失败 [code: 10000]。',
      '常见：Token 复制不全、Global Key+2FA、EMAIL 不匹配、Token 缺 D1 权限。',
      '请看 bootstrap job 的 Debug Cloudflare auth 输出。',
    ].join('\n');
  }
  return '';
}

/** 瞬时失败判定：被信号杀掉 / spawn 超时或缓冲超限 / 网络抖动 / CF 7500 */
function isTransientFailure(out, r) {
  if (r.signal) return true;
  const code = r.error?.code;
  if (code === 'ETIMEDOUT' || code === 'ENOBUFS') return true;
  if (r.status === 137) return true; // 被 SIGKILL（OOM / runner 回收）
  return /fetch failed|ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN|socket hang up|timed out|internal error|code:\s*7500|service unavailable|rate limit|Too Many Requests|HTTP\s*429/i.test(
    String(out || ''),
  );
}

function runApplyOnce(runner, binding) {
  return spawnSync(
    runner.bin,
    [...runner.prefix, 'd1', 'migrations', 'apply', binding, '--remote', '--env', 'production', '--config', 'wrangler.toml'],
    {
      cwd: workerA,
      encoding: 'utf8',
      env: { ...process.env, CI: 'true' },
      shell: runner.shell,
      // 迁移不需要交互（CI=true 时 wrangler 自动确认）；显式 ignore stdin 防 prompt 卡住
      stdio: ['ignore', 'pipe', 'pipe'],
      // 大表重绘输出可能较多；给足缓冲，避免 ENOBUFS 被当成普通失败
      maxBuffer: 32 * 1024 * 1024,
    },
  );
}

/**
 * 数据保护（DEPLOY-REPEAT-SAFE-1）：重复部署只允许「补未应用的 migration」。
 *
 * 若库里已有业务表、却没有 d1_migrations 表，说明它不是按本流程迁移出来的
 *（或迁移记录被清空）。继续 apply 会从 0001 重放，其中 0042 是 DROP TABLE IF EXISTS
 *、部分 006x 是 DELETE FROM —— 在已有数据的库上就是删数据。
 * 这种情况直接停，要求人工确认，而不是赌。
 *
 * 读不到表结构（权限/网络）时只 warn 放行：这是额外保险，不阻断正常部署。
 */
function assertMigrationHistorySafe(runner, binding) {
  const r = spawnSync(
    runner.bin,
    [
      ...runner.prefix,
      'd1',
      'execute',
      binding,
      '--remote',
      '--env',
      'production',
      '--config',
      'wrangler.toml',
      '--json',
      '--command',
      "SELECT name FROM sqlite_master WHERE type = 'table'",
    ],
    {
      cwd: workerA,
      encoding: 'utf8',
      env: { ...process.env, CI: 'true' },
      shell: runner.shell,
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  if ((r.status ?? 1) !== 0 || r.signal) {
    console.warn(
      `  ⚠ 无法读取 ${binding} 表结构（exit=${r.status} signal=${r.signal || '-'}），跳过迁移前数据保护检查`,
    );
    return;
  }

  /** @type {string[]|null} */
  let names = null;
  try {
    const start = out.indexOf('[');
    const end = out.lastIndexOf(']');
    if (start >= 0 && end > start) {
      const parsed = JSON.parse(out.slice(start, end + 1));
      // wrangler 3 --json 输出：[{ results: [{ name }], success: true, meta }]
      const rows = Array.isArray(parsed) ? parsed[0]?.results ?? parsed : parsed?.results ?? [];
      names = rows.map((x) => x?.name).filter(Boolean);
    }
  } catch {
    names = null;
  }
  if (!names) {
    console.warn(`  ⚠ ${binding} 表结构输出无法解析，跳过迁移前数据保护检查`);
    return;
  }

  const userTables = names.filter((n) => !/^sqlite_/i.test(n) && n !== '_cf_KV');
  if (userTables.length > 0 && !names.includes('d1_migrations')) {
    die(
      `${binding} 已有 ${userTables.length} 张表但没有 d1_migrations 记录` +
        `（例如 ${userTables.slice(0, 3).join(', ')}）。\n` +
        '继续 apply 会从 0001 重放，其中有 DROP TABLE / DELETE FROM 语句，可能清掉现有数据；已停止部署。\n' +
        '请确认该库是否应该被 reuse（检查同名 D1 是否被手工删除/改名，或迁移记录是否被清空），处理后再重跑。',
    );
  }
}

async function main() {
  console.log('\n════ CI：apply D1 migrations (production) ════\n');

  let prepared;
  try {
    prepared = prepareCfEnvForWrangler({ requireAccountId: true });
  } catch (err) {
    console.error('[ci-apply-migrations] prepare env 失败：', err?.message || err);
    die(err?.message || String(err));
  }

  console.log(
    `  prepare ok：mode=${prepared.mode} accountSource=${prepared.accountIdSource} stateLoaded=${prepared.stateLoaded}`,
  );

  const runner = resolveWranglerRunner();
  console.log(`  wrangler runner：${runner.label}（最多 ${MAX_ATTEMPTS} 次/库）`);

  for (const binding of BINDINGS) {
    console.log(`  → ${binding}`);
    // 先做数据保护检查：已有表但无 d1_migrations → 拒跑，避免重放 DROP/DELETE
    assertMigrationHistorySafe(runner, binding);
    let last = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      if (attempt > 1) {
        console.log(`  ... retry ${attempt}/${MAX_ATTEMPTS}：${binding}（${RETRY_DELAY_MS / 1000}s 后重跑，已 apply 的会跳过）`);
        sleepSync(RETRY_DELAY_MS);
      }

      let r;
      try {
        r = runApplyOnce(runner, binding);
      } catch (err) {
        console.error(`[ci-apply-migrations] spawn wrangler 异常（${binding}）：`, err?.message || err);
        die(`${binding} migrations apply 异常：${err?.message || err}`);
      }

      process.stdout.write(r.stdout || '');
      if (r.stderr) process.stderr.write(r.stderr);

      if ((r.status ?? 1) === 0 && !r.signal) {
        console.log(`  ✓ ${binding}\n`);
        last = null;
        break;
      }

      last = r;
      const combined = `${r.stdout || ''}${r.stderr || ''}`;
      const transient = isTransientFailure(combined, r);
      console.warn(
        `  [warn] ${binding} 第 ${attempt} 次失败` +
          `（exit=${r.status} signal=${r.signal || '-'}${r.error?.code ? ` error=${r.error.code}` : ''}）` +
          `${transient ? '，按瞬时错误处理' : '，非瞬时错误'}`,
      );
      if (!transient) break;
    }

    if (last) {
      const combined = `${last.stdout || ''}${last.stderr || ''}`;
      const hint = explainWranglerAuthFailure(combined);
      if (hint) console.error(`\n${hint}\n`);
      if (last.signal) {
        console.error(
          `根因提示：wrangler 进程被 ${last.signal} 终止（不是 SQL 报错，也不是鉴权失败）。` +
            `常见于 runner/npm 包装层回收进程；已自动重试 ${MAX_ATTEMPTS} 次。` +
            `若是全新账号首次建库、单库 migration 很多，可直接重跑 Deploy 工作流——已 apply 的会跳过。`,
        );
      }
      console.error(
        `[ci-apply-migrations] binding=${binding} exit=${last.status} signal=${last.signal || ''}` +
          ` error=${last.error?.code || '-'} accountSource=${prepared.accountIdSource}`,
      );
      die(`${binding} migrations apply 失败（已尝试 ${MAX_ATTEMPTS} 次）`);
    }
  }

  console.log('════ CI：migrations 全部完成 ════\n');
}

main().catch((err) => {
  console.error('[ci-apply-migrations] 未捕获异常：', err?.stack || err?.message || err);
  process.exit(2);
});
