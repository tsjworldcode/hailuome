/**
 * 首次部署站主凭证注入（PBKDF2-SHA256 100k，Workers Free 10ms CPU 兼容）。
 *
 * 默认（无参数）：admin/admin（本地开发）；M8-8 部署传 --username / --password 或环境变量。
 * 仅在 owner_credentials 表为空时写入（--if-empty），并置 owner_must_change_credentials='true'。
 * 写入目标：IDENTITY_DB（M-OPT-SPLIT；登录 /auth 读库，勿再写主库 DB）。
 *
 * 用法：
 *   node apps/worker-a/scripts/seed-default-owner.mjs --production --if-empty --yes
 *   node apps/worker-a/scripts/seed-default-owner.mjs --production --if-empty --yes --username=login_xxx --password='...'
 *   $env:OWNER_SEED_USERNAME='login_xxx'; $env:OWNER_SEED_PASSWORD='...'; node ... --from-env --yes
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { webcrypto } from 'node:crypto';

if (!globalThis.crypto) globalThis.crypto = webcrypto;

const FALLBACK_USERNAME = 'admin';
const FALLBACK_PASSWORD = 'admin';

const PBKDF2_ITERATIONS = 100_000;
const SALT_BYTES = 16;
const HASH_BITS = 256;

function encodeText(s) {
  return new TextEncoder().encode(s);
}
function bytesToHex(b) {
  return Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('');
}

async function hashPassword(password) {
  const salt = new Uint8Array(SALT_BYTES);
  crypto.getRandomValues(salt);
  const km = await crypto.subtle.importKey(
    'raw',
    encodeText(password),
    { name: 'PBKDF2' },
    false,
    ['deriveBits'],
  );
  const buf = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    km,
    HASH_BITS,
  );
  return {
    full: `v1:PBKDF2:${PBKDF2_ITERATIONS}:SHA256:${bytesToHex(salt)}:${bytesToHex(new Uint8Array(buf))}`,
    saltHex: bytesToHex(salt),
    iterations: PBKDF2_ITERATIONS,
  };
}

function parseArgs(argv) {
  const opts = {
    target: 'local',
    ifEmpty: false,
    force: false,
    yes: false,
    dryRun: false,
    username: '',
    password: '',
    fromEnv: false,
  };
  for (const a of argv) {
    if (a === '--local') opts.target = 'local';
    else if (a === '--preview') opts.target = 'preview';
    else if (a === '--production' || a === '--remote') opts.target = 'production';
    else if (a === '--if-empty') opts.ifEmpty = true;
    else if (a === '--force') opts.force = true;
    else if (a === '--yes' || a === '-y') opts.yes = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--from-env') opts.fromEnv = true;
    else if (a.startsWith('--username=')) opts.username = a.slice('--username='.length);
    else if (a.startsWith('--password=')) opts.password = a.slice('--password='.length);
    else if (a === '--help' || a === '-h') {
      console.log(`用法：node seed-default-owner.mjs [--local|--production] [--if-empty] [--yes]
  --username= --password=  或  --from-env（读 OWNER_SEED_USERNAME / OWNER_SEED_PASSWORD）`);
      process.exit(0);
    } else {
      console.error(`未知参数：${a}`);
      process.exit(2);
    }
  }
  if (opts.fromEnv) {
    opts.username = process.env.OWNER_SEED_USERNAME ?? opts.username;
    opts.password = process.env.OWNER_SEED_PASSWORD ?? opts.password;
  }
  return opts;
}

/** M-OPT-SPLIT：owner_credentials / system_config 在 IDENTITY_DB，登录读库不再是主库 DB。 */
const SEED_D1_BINDING = 'IDENTITY_DB';

function wranglerArgs(target) {
  const args = ['d1', 'execute', SEED_D1_BINDING, '--config', 'wrangler.toml'];
  if (target === 'local') args.push('--local');
  else if (target === 'preview') args.push('--env', 'preview', '--remote');
  else args.push('--env', 'production', '--remote');
  return args;
}

/**
 * 向上查找已安装的 wrangler CLI 入口；npm workspaces 会把依赖提升到仓库根。
 * 用 `node wrangler.js` 直连，避免 Windows 下 `npm exec` + shell 把 SQL 按空格拆成多个参数。
 */
function resolveWranglerCli(startDir) {
  let dir = startDir;
  for (let i = 0; i < 6; i += 1) {
    const candidate = path.join(dir, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function spawnWrangler(workerADir, cliArgs, spawnOpts) {
  const cliEntry = resolveWranglerCli(workerADir);
  if (cliEntry) {
    // 参数以数组直传，不经过 cmd/PowerShell 二次解析 → `--command` 里的空格与引号原样保留。
    return spawnSync(process.execPath, [cliEntry, ...cliArgs], spawnOpts);
  }
  if (process.platform === 'win32') {
    throw new Error(
      '未找到 wrangler CLI（node_modules/wrangler/bin/wrangler.js）。请先在仓库根执行 npm install 后重试。',
    );
  }
  return spawnSync('npm', ['exec', '--', 'wrangler', ...cliArgs], spawnOpts);
}

function runWrangler(workerADir, target, sqlOrOpts) {
  const env = { ...process.env, CI: 'true' };
  const sql = typeof sqlOrOpts === 'string' ? sqlOrOpts : sqlOrOpts.sql;
  const json = typeof sqlOrOpts === 'object' && sqlOrOpts.json;
  // 单条 INSERT 必须走 --command（/query 接口），不要用 --file（/import 接口）。
  // /import 在代理/网络不稳时容易 10s 超时 → `fetch failed`，SQL 实际没执行。
  // 多行压成单行，避免部分 wrangler 版本把多行命令判成 SQLITE incomplete input。
  const oneLineSql = sql.replace(/\s+/g, ' ').trim();
  const args = [...wranglerArgs(target), '--command', oneLineSql];
  if (json) args.push('--json');
  const spawnOpts = { cwd: workerADir, env, shell: false };
  if (json) {
    spawnOpts.encoding = 'utf8';
  } else {
    spawnOpts.stdio = 'inherit';
  }
  return spawnWrangler(workerADir, args, spawnOpts);
}

/** 查询 owner_credentials 首行用户名；失败返回 null（wrangler 远程可能较慢） */
function queryOwnerUsername(workerADir, target) {
  const sql = 'SELECT username FROM owner_credentials LIMIT 1;';
  const env = { ...process.env, CI: 'true' };
  // 必须用 --command：按文件导入时，--json 只回导入统计
  //（Total queries executed / Rows written），读不到 SELECT 的行 → 永远误判「表为空」。
  const args = [...wranglerArgs(target), '--json', '--command', sql];
  const spawnOpts = { cwd: workerADir, env, shell: false, encoding: 'utf8' };
  let res;
  try {
    res = spawnWrangler(workerADir, args, spawnOpts);
  } catch (err) {
    // 预查询失败不阻塞主流程：CLI 缺失等错误留给真正写入时明确抛出
    console.warn(`⚠ 预查询跳过：${err?.message || err}`);
    return null;
  }
  if (res.status !== 0) return null;
  const out = res.stdout || '';
  // 远程 --json 也会先打印「🌀 Executing on remote database …」等行，
  // 直接 JSON.parse(全文) 会失败 → 被误判成「表为空」并把默认站主再插一次。
  // 从首个 '[' 到最后一个 ']' 截取 JSON 数组。
  const start = out.indexOf('[');
  const end = out.lastIndexOf(']');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(out.slice(start, end + 1));
    const row = parsed?.[0]?.results?.[0];
    return typeof row?.username === 'string' ? row.username : null;
  } catch {
    return null;
  }
}

/** --force 时清空旧站主，避免多行 owner_credentials 导致登录名/密码不一致 */
function buildForceSeedSql(seedUsername, passwordHash, saltHex, iterations, esc) {
  return `DELETE FROM owner_credentials;
-- OWNER-RESET-GUARD：换 salt 后旧会话应立即失效，避免旧 JWT 继续可用
DELETE FROM owner_sessions;
INSERT INTO owner_credentials (username, password_hash, algo, iterations, salt)
VALUES ('${esc(seedUsername)}', '${esc(passwordHash)}', 'PBKDF2-SHA256', ${iterations}, '${esc(saltHex)}');`;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const workerADir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

  const seedUsername = opts.username || FALLBACK_USERNAME;
  const seedPassword = opts.password || FALLBACK_PASSWORD;

  console.log('============================================');
  console.log('  站主凭证注入（owner_credentials）');
  console.log('============================================');
  console.log(`目标：${opts.target} / binding=${SEED_D1_BINDING}`);
  console.log(`登录用户名：${seedUsername}`);
  console.log(`仅表为空时写入：${opts.ifEmpty && !opts.force ? '是' : '否'}`);
  if (opts.force) console.log('（--force：清空 owner_credentials 后写入卡片凭证）');
  console.log('');

  // --force 跳过远程 D1 预查询（wrangler 远程 execute 常需 1–3 分钟，易被误认为卡死）
  if (!opts.force) {
    console.log('查询 D1 当前站主（远程可能需 1–3 分钟，请耐心等待）…');
    const beforeUser = queryOwnerUsername(workerADir, opts.target);
    if (beforeUser) {
      console.log(`D1 当前站主用户名：${beforeUser}`);
      if (opts.ifEmpty && beforeUser !== seedUsername) {
        console.warn(
          `⚠ owner_credentials 已有用户「${beforeUser}」，--if-empty 不会写入卡片上的「${seedUsername}」。` +
            ' 这不是故障：你之前改过的站主密码保持不变。' +
            ' 只有确实忘记密码、确认要覆盖时，才显式运行 scripts/reset-owner-login.ps1（会换 salt，旧保险箱需在设置页重建）。',
        );
      }
    } else if (opts.ifEmpty) {
      console.log('D1 owner_credentials 当前为空，将写入新站主');
    }
  }

  if (opts.ifEmpty && !opts.force) {
    console.log('（--if-empty：owner_credentials 已有行则跳过 INSERT，不覆盖现有站主）');
  }

  console.log('正在生成密码哈希（PBKDF2 100k，约 1–5 秒）…');
  const { full: passwordHash, saltHex, iterations } = await hashPassword(seedPassword);
  const esc = (s) => s.replace(/'/g, "''");

  const insertCred = opts.force
    ? buildForceSeedSql(seedUsername, passwordHash, saltHex, iterations, esc)
    : opts.ifEmpty
    ? `INSERT INTO owner_credentials (username, password_hash, algo, iterations, salt)
       SELECT '${esc(seedUsername)}', '${esc(passwordHash)}', 'PBKDF2-SHA256', ${iterations}, '${esc(saltHex)}'
       WHERE (SELECT COUNT(*) FROM owner_credentials) = 0;`
    : `INSERT OR REPLACE INTO owner_credentials (username, password_hash, algo, iterations, salt)
       VALUES ('${esc(seedUsername)}', '${esc(passwordHash)}', 'PBKDF2-SHA256', ${iterations}, '${esc(saltHex)}');`;

  const setFlag = opts.force
    ? `-- --force：凭证已重置，必须重新改密（覆盖历史 false）
       INSERT OR REPLACE INTO system_config (key, value, updated_at)
       VALUES ('owner_must_change_credentials', 'true', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));`
    : `INSERT OR REPLACE INTO system_config (key, value, updated_at)
       SELECT 'owner_must_change_credentials', 'true', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE (SELECT COUNT(*) FROM owner_credentials) = 1
         AND (SELECT username FROM owner_credentials LIMIT 1) = '${esc(seedUsername)}'
         AND NOT EXISTS (
           SELECT 1 FROM system_config
           WHERE key = 'owner_must_change_credentials' AND value = 'false'
         );`;

  const seedSql = `${insertCred}\n${setFlag}`;

  console.log('即将执行的 SQL（不含密码明文）：');
  console.log(seedSql.slice(0, 200) + '…');

  if (opts.dryRun) {
    console.log('\n--dry-run：未写入 D1');
    process.exit(0);
  }

  if (!opts.yes) {
    console.error('请加 --yes 确认写入（生产部署脚本会自动带上）');
    process.exit(1);
  }

  console.log('正在写入 D1（远程 wrangler 可能需 1–3 分钟，请勿中断）…');
  const res = runWrangler(workerADir, opts.target, seedSql);
  if (res.status !== 0) {
    console.error(`wrangler d1 execute 失败（exit ${res.status}）`);
    if (res.stderr) console.error(res.stderr);
    process.exit(res.status ?? 1);
  }
  if (res.stdout) process.stdout.write(res.stdout);

  console.log('\n完成：站主凭证已写入 D1');
  console.log(`登录：POST /auth/login { "username": "${seedUsername}", "password": "<见 deploy-login-card.txt>" }`);
  console.log('建议接着运行：node scripts/verify-owner-login.mjs --token-file scripts/cloudflare-api-token.json');
  console.log('============================================');
}

main().catch((err) => {
  console.error('seed-default-owner 失败：', err);
  process.exit(1);
});
