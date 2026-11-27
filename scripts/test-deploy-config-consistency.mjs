/**
 * SDH-3：Worker A/B wrangler 部署组码与共享资源静态一致性检查（不调用 Cloudflare API）。
 *
 * 模式（M-WORKFLOW-SDH-1）：
 *   --mode=clean       洁净仓 / CI checkout 后：KV 与 Pages 名必须是 *-prod-placeholder（默认）
 *   --mode=post-patch  bootstrap/finalize 回填真 id 后：只断言 A/B 对齐（允许真 UUID）
 *
 * 环境变量 SDH_MODE 可覆盖（clean | post-patch）。
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

let passed = 0;
let failed = 0;

function check(label, ok) {
  if (ok) {
    console.log(`  ok ${label}`);
    passed++;
  } else {
    console.log(`  fail ${label}`);
    failed++;
  }
}

function readText(rel) {
  return readFileSync(join(root, rel), 'utf8');
}

function parseMode(argv) {
  const fromArg = argv.find((a) => a.startsWith('--mode='));
  const raw = (fromArg ? fromArg.slice('--mode='.length) : process.env.SDH_MODE || 'clean')
    .trim()
    .toLowerCase();
  if (raw === 'post-patch' || raw === 'post_patch' || raw === 'patched') return 'post-patch';
  return 'clean';
}

/** 从 hailuo-worker-a|b|web-{6hex}-... 提取组码 */
function extractGroupCodeFromName(name) {
  const m = /hailuo-worker-[ab]-([a-f0-9]{6})-/i.exec(name);
  return m ? m[1].toLowerCase() : null;
}

/** 从 hailuo-worker-b|web-{6hex}-... URL 提取组码；prod-placeholder 无组码时返回 null（由调用方处理） */
function extractGroupCodeFromUrl(url) {
  const m = /hailuo-worker-b-([a-f0-9]{6})-/i.exec(url);
  if (m) return m[1].toLowerCase();
  const pages = /hailuo-web-([a-f0-9]{6})-/i.exec(url);
  return pages ? pages[1].toLowerCase() : null;
}

function pickTomlString(text, key, section = null) {
  const lines = text.split(/\r?\n/);
  let inSection = section === null;
  for (const line of lines) {
    const sec = line.match(/^\[([^\]]+)\]/);
    if (sec) {
      if (section === null) {
        inSection = !sec[1].includes('.');
      } else {
        inSection = sec[1] === section;
      }
      continue;
    }
    if (!inSection) continue;
    const m = line.match(new RegExp(`^${key}\\s*=\\s*"([^"]*)"`));
    if (m) return m[1];
  }
  return null;
}

function pickDefaultServiceName(text, binding) {
  const local = text.match(
    new RegExp(`\\[\\[services\\]\\][\\s\\S]*?binding = "${binding}"[\\s\\S]*?service = "([^"]+)"`),
  );
  return local ? local[1] : null;
}

function pickProductionServiceName(text, binding) {
  const block = text.match(
    new RegExp(
      `\\[\\[env\\.production\\.services\\]\\][\\s\\S]*?binding = "${binding}"[\\s\\S]*?service = "([^"]+)"`,
    ),
  );
  if (block) return block[1];
  return pickDefaultServiceName(text, binding);
}

/**
 * 只取「同一 [[env.production.kv_namespaces]] 表项」内的 id。
 * 旧写法用 [\s\S]*? 会从 production 表头跨到 preview 的同名 binding，
 * 导致 POSTS/IMAGE 误用 preview 的 000…04/05 假绿，而 STATE 才露出 A/B 真不一致。
 */
function pickProductionKvId(text, binding) {
  const re = new RegExp(
    `\\[\\[env\\.production\\.kv_namespaces\\]\\]\\s*\\r?\\nbinding\\s*=\\s*"${binding}"\\s*\\r?\\nid\\s*=\\s*"([^"]+)"`,
    'g',
  );
  let match;
  let last = null;
  while ((match = re.exec(text)) !== null) {
    last = match[1];
  }
  return last;
}

const mode = parseMode(process.argv.slice(2));
console.log(`\n=== SDH-3 deploy config consistency (mode=${mode}) ===\n`);

const workerA = readText('apps/worker-a/wrangler.toml');
const workerB = readText('apps/worker-b/wrangler.toml');

const aProdName = pickTomlString(workerA, 'name', 'env.production');
const bProdName = pickTomlString(workerB, 'name', 'env.production');
const aGroup = extractGroupCodeFromName(aProdName ?? '');
const bGroup = extractGroupCodeFromName(bProdName ?? '');

check('Worker A/B production name present', !!aProdName);
check('Worker B production name present', !!bProdName);
check(
  'Worker A/B production share same DEPLOY_GROUP_CODE',
  (aGroup === null && bGroup === null) || (aGroup !== null && aGroup === bGroup),
);

const aWorkerBUrl = pickTomlString(workerA, 'WORKER_B_URL', 'env.production.vars');
const aOrigin = pickTomlString(workerA, 'WORKER_A_ORIGIN', 'env.production.vars');
const bOrigin = pickTomlString(workerB, 'WORKER_A_ORIGIN', 'env.production.vars');

check('A WORKER_B_URL group matches A name group', (aWorkerBUrl ?? '').includes('prod-placeholder') || extractGroupCodeFromUrl(aWorkerBUrl ?? '') === aGroup);
check('A WORKER_B_URL host matches B production worker name', ((aWorkerBUrl ?? '').includes('prod-placeholder') || (aWorkerBUrl ?? '').includes(bProdName ?? '___')));
check('A/B WORKER_A_ORIGIN share same group code', extractGroupCodeFromUrl(aOrigin ?? '') === extractGroupCodeFromUrl(bOrigin ?? ''));

const aWorkerBService = pickProductionServiceName(workerA, 'WORKER_B');
const bWorkerAService = pickProductionServiceName(workerB, 'WORKER_A');

check('A production WORKER_B service name matches B production name', (aWorkerBService ?? '').includes('prod-placeholder') || aWorkerBService === bProdName);

const aDefaultWorkerBService = pickDefaultServiceName(workerA, 'WORKER_B');
check(
  'A default WORKER_B binding is local placeholder (not production group code)',
  aDefaultWorkerBService === 'hailuo-worker-b-local-placeholder',
);
check('B production WORKER_A service name matches A production name', (bWorkerAService ?? '').includes('prod-placeholder') || bWorkerAService === aProdName);

const aBootstrap = pickTomlString(workerA, 'BOOTSTRAP_HANDLE', 'env.production.vars');
const bBootstrap = pickTomlString(workerB, 'BOOTSTRAP_HANDLE', 'env.production.vars');
const aPubkey = pickTomlString(workerA, 'ED25519_PUBLIC_KEY', 'env.production.vars');
const bPubkey = pickTomlString(workerB, 'ED25519_PUBLIC_KEY', 'env.production.vars');

check('A/B production BOOTSTRAP_HANDLE match', aBootstrap === bBootstrap && !!aBootstrap);
check('A/B production ED25519_PUBLIC_KEY match', aPubkey === bPubkey && !!aPubkey);

for (const binding of ['POSTS_CACHE_KV', 'IMAGE_KV', 'STATE_KV']) {
  const aId = pickProductionKvId(workerA, binding);
  const bId = pickProductionKvId(workerB, binding);
  check(`A/B production ${binding} id match`, aId === bId && !!aId);
  if (mode === 'clean') {
    // 仅洁净仓：必须是命名占位（patch 后真 UUID 会失败，改跑 --mode=post-patch）
    check(
      `A/B production ${binding} id is *-prod-placeholder`,
      aId === `${binding}-prod-placeholder` && bId === `${binding}-prod-placeholder`,
    );
  } else {
    // post-patch：禁止仍留命名占位（说明 bootstrap 没回填）
    check(
      `A/B production ${binding} id is patched (not *-prod-placeholder)`,
      !!aId &&
        aId === bId &&
        aId !== `${binding}-prod-placeholder` &&
        !/-prod-placeholder$/i.test(aId),
    );
  }
}

check('A production LOGIN_DIAG is false or unset', !/LOGIN_DIAG\s*=\s*"true"/.test(workerA));
check('A production has no LOGIN_DIAG_EXPECT_* vars', !workerA.includes('LOGIN_DIAG_EXPECT_'));

// Pages project_name：仓库洁净态必须占位；post-patch 通常仍占位（真名走 --project-name）
const webToml = readText('web/wrangler.toml');
const pagesNameMatch = webToml.match(/project_name\s*=\s*"([^"]+)"/);
const pagesProjectName = pagesNameMatch ? pagesNameMatch[1] : null;
check(
  'web Pages project_name has no real hailuo-web-{6hex}-… token',
  !/hailuo-web-[a-f0-9]{6}-[a-f0-9]{20,}/i.test(webToml),
);
if (mode === 'clean') {
  check(
    'web Pages project_name is hailuo-web-prod-placeholder',
    pagesProjectName === 'hailuo-web-prod-placeholder',
  );
}

const pkg = readText('package.json');
check('package.json registers test:deploy-config-consistency', pkg.includes('"test:deploy-config-consistency"'));
check(
  'package.json registers test:deploy-config-consistency:post-patch',
  pkg.includes('"test:deploy-config-consistency:post-patch"'),
);

// MIGRATION-COVERAGE：拆库门禁 —— 代码引用的表/列必须出现在该 binding 的 migrations 目录。
// 2026-11-26 真机事故就是「代码换了库、migration 没跟着换」，TypeScript 与字符串测试都发现不了。
let coverageOk = true;
let coverageOut = '';
try {
  coverageOut = execFileSync(process.execPath, [join(root, 'scripts/check-migration-coverage.mjs')], {
    encoding: 'utf8',
  });
} catch (err) {
  coverageOk = false;
  coverageOut = String(err.stdout || err.stderr || err.message || '');
}
check('migration coverage（表/列都在对应 migrations 目录）', coverageOk);
if (!coverageOk) console.log(coverageOut.slice(0, 2000));
check('package.json registers test:migration-coverage', pkg.includes('"test:migration-coverage"'));

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
