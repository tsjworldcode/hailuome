#!/usr/bin/env node
/**
 * 部署后卫生：把 Worker A/B wrangler.toml 工作区真值备份到 .bak，再还原为 git HEAD 占位。
 *
 * 正式流程：仓库占位 → bootstrap/deploy 现场 patch → 部署 → 本脚本还原占位。
 * .bak 已在 .gitignore（apps/worker-* / wrangler.toml.bak），禁止 stage / commit 真值。
 * （注释勿写 worker-* / 连写，否则块注释会被 *斜杠 提前结束。）
 *
 * 用法：
 *   node scripts/restore-wrangler-placeholders.mjs           # 备份脏 toml → .bak，再 checkout HEAD
 *   node scripts/restore-wrangler-placeholders.mjs --check   # 只检查，不改文件（exit 1 = 仍有真值脏）
 */
import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const checkOnly = process.argv.includes('--check');

const targets = [
  'apps/worker-a/wrangler.toml',
  'apps/worker-b/wrangler.toml',
];

/**
 * 仅识别「部署现场真值」，勿把 preview 的 000…0N、*-prod-placeholder、local-dev-* 当成脏。
 * （曾误把 000…04 判真 → 用占位覆盖掉本机 .bak，已收紧。）
 */
const REAL_VALUE_HINTS = [
  /name\s*=\s*"hailuo-worker-[ab]-[0-9a-f]{6}-[0-9a-f]+"/i,
  /service\s*=\s*"hailuo-worker-[ab]-[0-9a-f]{6}-[0-9a-f]+"/i,
  /BOOTSTRAP_HANDLE\s*=\s*"hailuo_[a-z0-9]+"/i,
  /ED25519_PUBLIC_KEY\s*=\s*"[0-9a-f]{64}"/i,
  /WORKER_[AB]_ORIGIN\s*=\s*"https:\/\/hailuo-web-[0-9a-f]{6}-/i,
  /WORKER_B_URL\s*=\s*"https:\/\/hailuo-worker-b-[0-9a-f]{6}-/i,
  /bucket_name\s*=\s*"hailuo-node-media-[0-9a-f]{6}"/i,
  // 真 UUID；排除近零占位如 00000000-0000-0000-0000-00000000b101
  /database_id\s*=\s*"(?!0{8}-0{4}-0{4}-0{4}-)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"/i,
  // 真 KV id：32 hex 且非近零占位（000…0N）
  /(?:^|\n)\s*id\s*=\s*"(?!0{24})[0-9a-f]{32}"/im,
];

function looksPatched(content) {
  return REAL_VALUE_HINTS.some((re) => re.test(content));
}

/** 命中「真值」启发式的条数（用于比较 bak vs 工作区强弱，防误覆盖）。 */
function countRealValueHints(content) {
  let n = 0;
  for (const re of REAL_VALUE_HINTS) {
    // 每条规则全局重置 lastIndex，避免 /g 残留（当前规则无 g，仍防御）
    re.lastIndex = 0;
    if (re.test(content)) n += 1;
  }
  return n;
}

function git(...args) {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (r.status !== 0) {
    const msg = (r.stderr || r.stdout || '').trim() || `git ${args.join(' ')} failed`;
    throw new Error(msg);
  }
  return (r.stdout || '').trim();
}

let dirty = 0;
const dirtyPaths = [];

for (const rel of targets) {
  const abs = resolve(root, rel);
  if (!existsSync(abs)) {
    console.error(`✗ missing ${rel}`);
    process.exit(2);
  }
  const text = readFileSync(abs, 'utf8');
  if (looksPatched(text)) {
    dirty += 1;
    dirtyPaths.push(rel);
    console.log(`! patched values in ${rel}`);
  } else {
    console.log(`✓ placeholders ok: ${rel}`);
  }
}

if (checkOnly) {
  if (dirty === 0) {
    console.log('\ncheck: clean (safe to commit/push these toml files)\n');
    process.exit(0);
  }
  console.log(`\ncheck: ${dirty} file(s) still hold deploy-time values — do NOT commit`);
  console.log('fix: npm run restore:wrangler-placeholders\n');
  process.exit(1);
}

if (dirty === 0) {
  console.log('\nnothing to restore (already placeholders)\n');
  process.exit(0);
}

for (const rel of dirtyPaths) {
  const abs = resolve(root, rel);
  const bak = `${abs}.bak`;
  const current = readFileSync(abs, 'utf8');
  // SEC-AUDIT-2026-10-11 #7：旧分支 `!looksPatched(current)` 在 dirtyPaths 内恒假（死代码）。
  // 改为：已有真值 bak 时，内容相同跳过；或工作区真值特征弱于 bak（疑似误检）则跳过覆盖。
  if (existsSync(bak)) {
    const bakText = readFileSync(bak, 'utf8');
    if (looksPatched(bakText)) {
      if (bakText === current) {
        console.log(`→ skip backup ${rel}.bak (identical to working tree)`);
        continue;
      }
      const bakHits = countRealValueHints(bakText);
      const curHits = countRealValueHints(current);
      if (curHits < bakHits) {
        console.log(
          `→ skip backup ${rel}.bak (working tree has fewer real-value hints than .bak; refuse overwrite)`,
        );
        continue;
      }
    }
  }
  copyFileSync(abs, bak);
  console.log(`→ backed up ${rel} → ${rel}.bak`);
}

git('checkout', 'HEAD', '--', ...dirtyPaths);
console.log(`→ restored from HEAD: ${dirtyPaths.join(', ')}`);

// 还原后再扫一遍，防止 HEAD 本身已脏（历史误入）
let stillDirty = 0;
for (const rel of dirtyPaths) {
  const text = readFileSync(resolve(root, rel), 'utf8');
  if (looksPatched(text)) {
    stillDirty += 1;
    console.error(`✗ HEAD still has real values in ${rel} — do not push; fix git history / placeholders first`);
  }
}

if (stillDirty > 0) {
  process.exit(1);
}

console.log('\nok: working tree toml back to placeholders; local true values kept in *.bak (gitignored)\n');
process.exit(0);
