/**
 * 向当前 wrangler.toml 中的 Worker 脚本写入 secret（新建 Worker 名后必跑）。
 *
 * 批量：node scripts/put-worker-secrets.mjs
 * 单条（bootstrap 用，stdin 传值）：echo secret | node scripts/put-worker-secrets.mjs --one --worker-dir apps/worker-a --key JWT_SECRET
 *
 * DEPLOY-SECRET-RETRY：`wrangler secret put` 走代理时可能抛 `TypeError: fetch failed`
 * （PUT /workers/scripts/<name>/secrets 无响应）。单条失败不再直接判整批失败：
 *   1) 瞬时错误自动重试（默认 3 次，间隔 3s）；
 *   2) 全批写完后 `wrangler secret list` 校验线上实际是否存在，只对**真缺**的键补写一次；
 *   3) 仍缺才 exit 1，并打印缺失键名（避免把 GROUP_OWNER_KEY_WRAP_SECRET 失败误报成缺 JWT_SECRET）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ensureMediaTicketSecret, listWorkerSecretNames } from './lib/ensure-media-ticket-secret.mjs';

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPTS_DIR, '..');
const tokenPath = path.join(SCRIPTS_DIR, 'cloudflare-api-token.json');

// 瞬时网络/网关错误的判定（对齐 deploy-network.ps1 Invoke-WranglerWithRetry）
const RETRYABLE_PATTERN =
  /fetch failed|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up|timed out|internal error|7500|502 Bad Gateway|503 Service|504 Gateway/i;

const DEFAULT_MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 3000;

function sleepSync(ms) {
  // Node 无同步 sleep；SharedArrayBuffer + Atomics.wait 可阻塞当前线程
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function readStdinUtf8() {
  if (process.stdin.isTTY) return '';
  // PowerShell `$Value | node` 会在末尾附加 CRLF，hex secret 须去掉
  return fs.readFileSync(0, 'utf8').replace(/\r?\n$/, '');
}

function readSecretValue() {
  const fromEnv = process.env.HAILUO_SECRET_PUT_VALUE;
  if (fromEnv != null && fromEnv !== '') return fromEnv;
  return readStdinUtf8();
}

function parseArgs(argv) {
  const one = argv.includes('--one');
  let workerDir = '';
  let key = '';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--worker-dir' && argv[i + 1]) workerDir = argv[++i];
    if (argv[i] === '--key' && argv[i + 1]) key = argv[++i];
  }
  return { one, workerDir, key };
}

function loadTokenConfig() {
  return JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
}

function buildEnv(config) {
  const proxy = config.HTTP_PROXY || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '';
  const { HAILUO_SECRET_PUT_VALUE: _drop, ...rest } = process.env;
  return {
    ...rest,
    CI: 'true',
    CLOUDFLARE_API_TOKEN: config.CLOUDFLARE_API_TOKEN,
    CLOUDFLARE_ACCOUNT_ID: config.CLOUDFLARE_ACCOUNT_ID,
    ...(proxy ? { HTTPS_PROXY: proxy, HTTP_PROXY: proxy } : {}),
  };
}

const wranglerBin = process.platform === 'win32' ? 'npx.cmd' : 'npx';

/**
 * 单次 wrangler secret put（不做重试）。
 * @returns {{ status: number|null, output: string }}
 */
function putSecretOnce(cwd, key, value, env) {
  // 禁止 cmd `type file | wrangler secret put`：Windows 下路径/管道易失败，wrangler 仍报 success 但写入空 secret
  const r = spawnSync(
    wranglerBin,
    ['wrangler', 'secret', 'put', key, '--env', 'production', '--config', 'wrangler.toml'],
    {
      cwd,
      input: value,
      encoding: 'utf8',
      env,
      shell: process.platform === 'win32',
    },
  );
  return { status: r.status, output: `${r.stdout || ''}\n${r.stderr || ''}`.trim() };
}

/**
 * 写一条 secret，瞬时网络错误自动重试。
 * @param {string} workerDir 绝对或相对仓库根的路径
 * @param {string} key
 * @param {string} value
 * @param {NodeJS.ProcessEnv} env
 * @param {{ maxAttempts?: number }} [opts]
 */
function putSecret(workerDir, key, value, env, opts = {}) {
  if (!value) {
    console.warn(`[skip] ${key} 为空`);
    return false;
  }
  const cwd = path.isAbsolute(workerDir) ? workerDir : path.join(REPO_ROOT, workerDir);
  const label = `${key} @ ${path.basename(cwd)}`;
  const maxAttempts = Math.max(1, opts.maxAttempts || DEFAULT_MAX_ATTEMPTS);
  let lastOutput = '';
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (attempt === 1) console.log(`  … put ${label} (len=${value.length})`);
    else console.log(`  … retry ${attempt}/${maxAttempts} ${label}`);
    const { status, output } = putSecretOnce(cwd, key, value, env);
    if (status === 0) {
      console.log(`[ok] ${key} @ ${path.basename(cwd)} (len=${value.length})`);
      return true;
    }
    lastOutput = output;
    const retryable = RETRYABLE_PATTERN.test(output);
    if (!retryable) break;
    if (attempt < maxAttempts) sleepSync(RETRY_DELAY_MS);
  }
  // 只回显失败尾巴，避免整段 wrangler banner/代理提示淹没真正的错误
  const tail = lastOutput.split(/\r?\n/).filter(Boolean).slice(-6).join('\n');
  console.error(`[fail] ${label}${tail ? `\n${tail}` : ''}`);
  return false;
}

/**
 * 用 `wrangler secret list` 校验线上实际状态（写请求失败不代表没落盘，反之亦然）。
 * @returns {string[]|null} 缺失的键；list 本身失败时返回 null（不阻塞部署）
 */
function findMissingSecrets(workerDir, expectedKeys, env) {
  if (expectedKeys.length === 0) return [];
  try {
    const names = listWorkerSecretNames({ workerDir: path.isAbsolute(workerDir) ? workerDir : path.join(REPO_ROOT, workerDir), env });
    return expectedKeys.filter((k) => !names.includes(k));
  } catch (err) {
    console.warn(`[verify] secret list 失败（跳过校验）：${err?.message || err}`);
    return null;
  }
}

const { one, workerDir, key } = parseArgs(process.argv.slice(2));

if (one) {
  if (!workerDir || !key) {
    console.error('用法: node put-worker-secrets.mjs --one --worker-dir <dir> --key <NAME>  （secret 值从 stdin 读取）');
    process.exit(2);
  }
  const config = loadTokenConfig();
  const value = readSecretValue();
  process.exit(putSecret(workerDir, key, value, buildEnv(config)) ? 0 : 1);
}

const config = loadTokenConfig();
const env = buildEnv(config);
const workerA = path.join(REPO_ROOT, 'apps', 'worker-a');
const workerB = path.join(REPO_ROOT, 'apps', 'worker-b');
/** @type {Array<{ workerDir: string, key: string, value: string }>} */
const planned = [];

for (const k of ['JWT_SECRET', 'INTERNAL_FORWARD_SECRET', 'TOTP_WRAP_SECRET', 'NODE_API_TOKEN_WRAP_SECRET', 'GROUP_OWNER_KEY_WRAP_SECRET', 'ED25519_PRIVATE_KEY', 'HMAC_SECRET']) {
  const val = config[k];
  if (!val) continue;
  planned.push({ workerDir: workerA, key: k, value: String(val) });
}
if (config.INTERNAL_FORWARD_SECRET) {
  planned.push({ workerDir: workerB, key: 'INTERNAL_FORWARD_SECRET', value: String(config.INTERNAL_FORWARD_SECRET) });
}
const registryUrl = config.REGISTRY_URL && String(config.REGISTRY_URL).trim();
if (registryUrl) {
  planned.push({ workerDir: workerA, key: 'REGISTRY_URL', value: registryUrl });
  planned.push({ workerDir: workerB, key: 'REGISTRY_URL', value: registryUrl });
}

/** @type {Array<{ workerDir: string, key: string }>} */
const putFailed = [];
for (const item of planned) {
  if (!putSecret(item.workerDir, item.key, item.value, env)) {
    putFailed.push({ workerDir: item.workerDir, key: item.key });
  }
}

// 写后校验：以线上 `secret list` 为准，只对真缺的键补写一次
/** @type {Map<string, string[]>} 需要计入失败的缺失键 */
const stillMissing = new Map();
/** @type {Set<string>} list 失败、只能信任 put 结果的目录 */
const unverifiedDirs = new Set();
for (const dir of [workerA, workerB]) {
  const items = planned.filter((i) => i.workerDir === dir);
  if (items.length === 0) continue;
  let missing = findMissingSecrets(dir, items.map((i) => i.key), env);
  if (missing === null) {
    unverifiedDirs.add(dir);
    continue;
  }
  if (missing.length > 0) {
    console.log(`  … ${path.basename(dir)} 校验缺键，补写：${missing.join(', ')}`);
    for (const keyName of missing) {
      const item = items.find((i) => i.key === keyName);
      if (item) putSecret(dir, keyName, item.value, env, { maxAttempts: 2 });
    }
    missing = findMissingSecrets(dir, missing, env);
    if (missing === null) {
      unverifiedDirs.add(dir);
      continue;
    }
  }
  if (missing.length > 0) {
    console.error(`[verify] ${path.basename(dir)} 仍缺：${missing.join(', ')}`);
    stillMissing.set(dir, missing);
  } else {
    console.log(`[verify] ${path.basename(dir)} secrets OK（${items.length} 条）`);
  }
}

// 校验成功时以 list 为准（PUT 报错但实际已落盘属正常）；list 不可用时才退回 put exit code
const unresolved = putFailed.filter((f) => unverifiedDirs.has(f.workerDir));
/** @type {string[]} 线上确认缺失的键 */
const missingKeys = [...stillMissing.values()].flat().concat(unresolved.map((f) => f.key));
// 核心键缺失才算部署失败（登录/网关/签名/注册直接不可用）；其余能力各自 fail-closed，
// 只告警不中断——避免一把可选密钥把后续 Pages 部署整段跳过。
const CORE_KEYS = new Set(['JWT_SECRET', 'INTERNAL_FORWARD_SECRET', 'ED25519_PRIVATE_KEY', 'REGISTRY_URL']);
const missingCore = missingKeys.filter((k) => CORE_KEYS.has(k));
const missingOptional = missingKeys.filter((k) => !CORE_KEYS.has(k));
if (missingOptional.length > 0) {
  console.warn(`[warn] 非核心密钥缺失（对应能力 fail-closed，登录不受影响）：${[...new Set(missingOptional)].join(', ')}`);
}
let ok = missingCore.length === 0;
if (missingCore.length > 0) {
  console.error(`[fail] 核心密钥缺失：${[...new Set(missingCore)].join(', ')}`);
}
// token 文件本身缺核心键（bootstrap 应已生成）：直接判失败，否则登录必然 500
const plannedKeys = new Set(planned.map((p) => p.key));
const absentRequired = ['JWT_SECRET', 'INTERNAL_FORWARD_SECRET', 'ED25519_PRIVATE_KEY'].filter(
  (k) => !plannedKeys.has(k),
);
if (absentRequired.length > 0) {
  console.error(`[fail] token 文件缺少核心密钥：${absentRequired.join(', ')}（重跑 bootstrap 生成）`);
  ok = false;
}
if (!plannedKeys.has('REGISTRY_URL')) {
  console.warn('[warn] token 文件没有 REGISTRY_URL，节点不会自动登记到注册中心');
}

// SEC-6-SECRET：Worker B 媒体票据钥幂等（已有跳过；缺则用 token 值或新生成）
try {
  ensureMediaTicketSecret({
    workerDir: workerB,
    preferredValue: config.MEDIA_TICKET_SECRET || '',
    env,
  });
} catch (err) {
  // 非核心：只影响受保护读图票据，不挡登录/发帖
  console.warn(`[warn] MEDIA_TICKET_SECRET 注入失败（受保护读图将不可用）：${err?.message || err}`);
}
process.exit(ok ? 0 : 1);
