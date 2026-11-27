/**
 * SEC-6-SECRET · Worker B `MEDIA_TICKET_SECRET` 幂等注入。
 *
 * 权威：Cloudflare Worker B Secret（不进 git / 不进 D1）。
 * 首次：生成随机串并 put；同账号再次部署：`wrangler secret list` 已有则跳过。
 * 即使 CI `skip_secret_put=true`（升级保留其它钥），本函数仍会「缺则补」。
 *
 * ⚠️ 永不覆盖已存在的线上值（轮换须显式 FORCE_MEDIA_TICKET_SECRET=1）。
 */

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MEDIA_TICKET_SECRET_KEY = 'MEDIA_TICKET_SECRET';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, '..', '..');

function bytesToHex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 生成独立 HMAC 密钥（32 字节 hex）；禁止复用其它 secret。 */
export function generateMediaTicketSecret() {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
}

/**
 * @param {object} opts
 * @param {string} opts.workerDir 相对仓库根或绝对路径（默认 apps/worker-b）
 * @param {string} [opts.envName=production]
 * @param {string} [opts.wranglerPkg] 例 wrangler@3.114.17；缺省用 npx wrangler
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @returns {string[]}
 */
export function listWorkerSecretNames(opts = {}) {
  const workerDir = opts.workerDir || 'apps/worker-b';
  const cwd = path.isAbsolute(workerDir) ? workerDir : path.join(REPO_ROOT, workerDir);
  const envName = opts.envName || 'production';
  const spawnEnv = { ...(opts.env || process.env), CI: 'true' };
  const bin = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  const args = opts.wranglerPkg
    ? ['--yes', opts.wranglerPkg, 'secret', 'list', '--env', envName, '--config', 'wrangler.toml', '--format', 'json']
    : ['wrangler', 'secret', 'list', '--env', envName, '--config', 'wrangler.toml', '--format', 'json'];

  const r = spawnSync(bin, args, {
    cwd,
    encoding: 'utf8',
    env: spawnEnv,
    shell: process.platform === 'win32',
  });
  const stdout = r.stdout || '';
  const stderr = r.stderr || '';
  const combined = `${stdout}\n${stderr}`;
  if ((r.status ?? 1) !== 0) {
    const err = combined.trim();
    const e = new Error(`secret list 失败 @ ${path.basename(cwd)}：${err.slice(0, 400) || `exit ${r.status}`}`);
    e.code = 'SECRET_LIST_FAILED';
    e.stderr = err;
    throw e;
  }
  // 优先 stdout（正常 JSON）；代理 banner 也可能污染 stdout。
  // 勿把 stderr 简单拼上再 lastIndexOf(']')——WARNING/ANSI 里也有 `]`，会截坏。
  const parsed =
    parseWranglerJsonArray(stdout) ||
    parseWranglerJsonArray(stderr) ||
    parseWranglerJsonArray(combined);
  if (!Array.isArray(parsed)) {
    const snip = combined.replace(/\s+/g, ' ').trim().slice(0, 180);
    throw new Error(
      `secret list JSON 解析失败 @ ${path.basename(cwd)}${snip ? `：${snip}` : ''}`,
    );
  }
  return parsed
    .map((row) => (row && typeof row.name === 'string' ? row.name : ''))
    .filter(Boolean);
}

/**
 * 从 wrangler CLI 混杂输出中截取首个完整 JSON 数组（proxy banner / ANSI / WARNING）。
 * 用括号深度匹配，避免 lastIndexOf(']') 误吃 WARNING 里的 `]`。
 * @param {string} raw
 * @returns {unknown[] | null}
 */
export function parseWranglerJsonArray(raw) {
  const text = String(raw || '');
  const start = text.indexOf('[');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === '\\') {
        escape = true;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) {
        try {
          const parsed = JSON.parse(text.slice(start, i + 1));
          return Array.isArray(parsed) ? parsed : null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/**
 * @param {object} opts
 * @param {string} [opts.preferredValue] 优先使用的值（首次从 generate/state）；线上已有则忽略
 * @param {boolean} [opts.forceRotate] FORCE_MEDIA_TICKET_SECRET=1 时覆盖
 * @returns {{ action: 'skipped'|'created'|'rotated'; name: string }}
 */
export function ensureMediaTicketSecret(opts = {}) {
  const workerDir = opts.workerDir || 'apps/worker-b';
  const cwd = path.isAbsolute(workerDir) ? workerDir : path.join(REPO_ROOT, workerDir);
  const envName = opts.envName || 'production';
  const spawnEnv = { ...(opts.env || process.env), CI: 'true' };
  const forceRotate =
    opts.forceRotate === true ||
    process.env.FORCE_MEDIA_TICKET_SECRET === '1' ||
    process.env.FORCE_MEDIA_TICKET_SECRET === 'true';

  let names = [];
  try {
    names = listWorkerSecretNames({
      workerDir: cwd,
      envName,
      wranglerPkg: opts.wranglerPkg,
      env: spawnEnv,
    });
  } catch (err) {
    // Worker 尚不存在时 list 会失败；调用方应在首次 deploy 之后再跑
    throw err;
  }

  const exists = names.includes(MEDIA_TICKET_SECRET_KEY);
  if (exists && !forceRotate) {
    console.log(`  ↷ skip ${MEDIA_TICKET_SECRET_KEY} @ worker-b（线上已有，保留首次密钥）`);
    return { action: 'skipped', name: MEDIA_TICKET_SECRET_KEY };
  }

  const value =
    (typeof opts.preferredValue === 'string' && opts.preferredValue.trim()) ||
    generateMediaTicketSecret();
  if (value.length < 16) {
    throw new Error(`${MEDIA_TICKET_SECRET_KEY} 过短（≥16）`);
  }

  const bin = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  const args = opts.wranglerPkg
    ? ['--yes', opts.wranglerPkg, 'secret', 'put', MEDIA_TICKET_SECRET_KEY, '--env', envName, '--config', 'wrangler.toml']
    : ['wrangler', 'secret', 'put', MEDIA_TICKET_SECRET_KEY, '--env', envName, '--config', 'wrangler.toml'];

  console.log(
    `  → ${forceRotate && exists ? 'rotate' : 'put'} ${MEDIA_TICKET_SECRET_KEY} @ worker-b (len=${value.length})`,
  );
  const r = spawnSync(bin, args, {
    cwd,
    input: value,
    encoding: 'utf8',
    env: spawnEnv,
    shell: process.platform === 'win32',
  });
  if ((r.status ?? 1) !== 0) {
    process.stderr.write(r.stderr || r.stdout || '');
    throw new Error(`secret put ${MEDIA_TICKET_SECRET_KEY} 失败（exit ${r.status}）`);
  }
  console.log(`  ✓ worker-b  ${MEDIA_TICKET_SECRET_KEY}`);
  return {
    action: forceRotate && exists ? 'rotated' : 'created',
    name: MEDIA_TICKET_SECRET_KEY,
  };
}

/** CLI：node scripts/lib/ensure-media-ticket-secret.mjs */
function mainCli() {
  const tokenPath = path.join(REPO_ROOT, 'scripts', 'cloudflare-api-token.json');
  let preferred = process.env.HAILUO_SECRET_PUT_VALUE || '';
  const env = { ...process.env, CI: 'true' };
  if (fs.existsSync(tokenPath)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
      if (cfg.CLOUDFLARE_API_TOKEN) env.CLOUDFLARE_API_TOKEN = cfg.CLOUDFLARE_API_TOKEN;
      if (cfg.CLOUDFLARE_ACCOUNT_ID) env.CLOUDFLARE_ACCOUNT_ID = cfg.CLOUDFLARE_ACCOUNT_ID;
      if (!preferred && cfg.MEDIA_TICKET_SECRET) preferred = String(cfg.MEDIA_TICKET_SECRET);
      const proxy = cfg.HTTP_PROXY || env.HTTPS_PROXY || env.HTTP_PROXY || '';
      if (proxy) {
        env.HTTPS_PROXY = proxy;
        env.HTTP_PROXY = proxy;
      }
    } catch {
      /* ignore */
    }
  }
  try {
    ensureMediaTicketSecret({ preferredValue: preferred, env });
    process.exit(0);
  } catch (err) {
    console.error(`[ensure-media-ticket-secret] ${err?.message || err}`);
    process.exit(1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  mainCli();
}
