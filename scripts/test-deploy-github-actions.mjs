/**
 * M8-12：GitHub Actions 一键部署契约自检（不调用 Cloudflare API）
 * 运行：node scripts/test-deploy-github-actions.mjs
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = dirname(__dirname);

let passed = 0;
let failed = 0;

function check(label, ok) {
  if (ok) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.log(`  ❌ ${label}`);
    failed++;
  }
}

function readText(rel) {
  return readFileSync(join(root, rel), 'utf8');
}

function readJson(rel) {
  return JSON.parse(readFileSync(join(root, rel), 'utf8'));
}

/**
 * 去掉整行 `//` 注释与块注释后再做「禁止某实现形态」的断言。
 * 依赖文件的说明注释会写旧坑原词（如 keep local id），扫全文会把门禁自己打红。
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .map((line) => (line.trimStart().startsWith('//') ? '' : line))
    .join('\n');
}

console.log('\n=== M8-12 GitHub Actions 一键部署契约 ===\n');

// ── 文件存在 ──────────────────────────────────────────────────────────────
const files = [
  '.github/workflows/deploy.yml',
  'scripts/patch-wrangler-toml.mjs',
  'scripts/ci-bootstrap-resources.mjs',
  'scripts/ci-prepare-cf-env.mjs',
  'scripts/ci-seed-default-owner.mjs',
  'scripts/ci-put-secrets.mjs',
  'scripts/ci-apply-migrations.mjs',
  'scripts/ci-finalize-urls.mjs',
  'scripts/ci-patch-pages-bindings.mjs',
  'scripts/ci-write-deploy-summary.mjs',
  'docs/deploy-github-actions.md',
];
for (const f of files) {
  check(`存在 ${f}`, existsSync(join(root, f)));
}

// ── workflow YAML 关键字段 ────────────────────────────────────────────────
const wf = readText('.github/workflows/deploy.yml');
check('workflow 名含 Deploy hailuo node', /name:\s*Deploy hailuo node/.test(wf));
check('触发 workflow_dispatch', /workflow_dispatch:/.test(wf));
check('调用 ci-bootstrap-resources', /ci-bootstrap-resources\.mjs/.test(wf));
check('调用 ci-put-secrets', /ci-put-secrets\.mjs/.test(wf));
check('调用 ci-apply-migrations', /ci-apply-migrations\.mjs/.test(wf));
check('调用 ci-finalize-urls', /ci-finalize-urls\.mjs/.test(wf));
check(
  'Redeploy 后调用 ci-verify-register-config（M-WORKFLOW-ED25519-1）',
  /ci-verify-register-config\.mjs/.test(wf),
);
check('调用 ci-patch-pages-bindings', /ci-patch-pages-bindings\.mjs/.test(wf));
check('调用 ci-prepare-cf-env（从 state 恢复 ACCOUNT_ID）', /ci-prepare-cf-env\.mjs/.test(wf));
check('调用 ci-seed-default-owner（对齐本地 seed）', /ci-seed-default-owner\.mjs/.test(wf));
check(
  'Seed 透传 OWNER_SEED_USERNAME / OWNER_SEED_PASSWORD（M-WORKFLOW-ENV-1）',
  /OWNER_SEED_USERNAME:\s*\$\{\{\s*secrets\.OWNER_SEED_USERNAME/.test(wf) &&
    /OWNER_SEED_PASSWORD:\s*\$\{\{\s*secrets\.OWNER_SEED_PASSWORD/.test(wf),
);
check('seed 在 Deploy Worker A 之后', (() => {
  // 必须用 `- name:` 前缀，避免注释里出现同名字符串误匹配（DEPLOY-SB-10143）
  const seed = wf.indexOf('- name: Seed default owner');
  const deployA = wf.indexOf('- name: Deploy Worker A');
  const deployB = wf.indexOf('- name: Deploy Worker B');
  return seed > deployA && seed < deployB && deployA >= 0 && deployB >= 0;
})());
// DEPLOY-SB-10143：空账号先 A 会 10143 → Bootstrap Worker B peer 须在 Deploy Worker A 之前
check('Bootstrap Worker B peer 在 Deploy Worker A 之前', (() => {
  const peer = wf.indexOf('- name: Bootstrap Worker B peer');
  const deployA = wf.indexOf('- name: Deploy Worker A');
  return peer >= 0 && peer < deployA && /bootstrap-worker-b-peer\.mjs/.test(wf);
})());
// M-WORKFLOW-ENV-1：Prepare 之后裸 wrangler step 不得再塞 secrets.CLOUDFLARE_ACCOUNT_ID（空串会盖掉 $GITHUB_ENV）
check(
  'Deploy Worker A/B 与 Redeploy 不重声明 secrets.CLOUDFLARE_ACCOUNT_ID',
  (() => {
    const markers = [
      'Bootstrap Worker B peer (stub if missing)\n',
      'Deploy Worker A\n',
      'Deploy Worker B\n',
      'Redeploy Worker A (after URL vars)\n',
      'Redeploy Worker B (after URL vars)\n',
      'Deploy Pages\n',
    ];
    for (const m of markers) {
      const i = wf.indexOf(m);
      if (i < 0) return false;
      const slice = wf.slice(i, i + 450);
      if (/CLOUDFLARE_ACCOUNT_ID:\s*\$\{\{\s*secrets\.CLOUDFLARE_ACCOUNT_ID/.test(slice)) return false;
    }
    return true;
  })(),
);
check(
  'Deploy Pages shell 桥接 Global Key → CLOUDFLARE_API_KEY',
  /export CLOUDFLARE_API_KEY="\$CLOUDFLARE_GLOBAL_API_KEY"/.test(wf),
);

// ── CI 门禁工作流（push / PR 自动报警，不接 Cloudflare 凭证）────────────────
const ciWfPath = '.github/workflows/ci.yml';
const ciWf = existsSync(join(root, ciWfPath)) ? readText(ciWfPath) : '';
check(`存在 ${ciWfPath}`, ciWf.length > 0);
check('CI 工作流在 push 与 pull_request 触发', /push:/.test(ciWf) && /pull_request:/.test(ciWf));
check('CI 工作流跑 test:deploy-github-actions', /npm run test:deploy-github-actions/.test(ciWf));
check('CI 工作流跑 test:deploy-workers-builds', /npm run test:deploy-workers-builds/.test(ciWf));
check('CI 工作流跑 audit:deploy-shell-hazards', /npm run audit:deploy-shell-hazards/.test(ciWf));
// 自检只读仓库文件；接凭证就会在 fork/PR 上暴露，也违背「无云端写」定位
check(
  'CI 工作流不接 Cloudflare 凭证',
  !/CLOUDFLARE_(API_TOKEN|GLOBAL_API_KEY|ACCOUNT_ID)/.test(ciWf),
);
// 洁净仓占位/组码一致性：PR 阶段就能发现真 ID 或组码写错，不必等部署 bootstrap
check('CI 工作流跑 test:deploy-config-consistency', /npm run test:deploy-config-consistency/.test(ciWf));
// GHA 弃用提示：v4 的 checkout/setup-node 走 Node 20 运行时，统一升 v5（Node 24）
check(
  'checkout / setup-node 均为 v5（消除 Node 20 action 运行时弃用）',
  !/actions\/(checkout|setup-node)@v4/.test(`${wf}\n${ciWf}`) &&
    /actions\/checkout@v5/.test(wf) &&
    /actions\/setup-node@v5/.test(wf) &&
    /actions\/checkout@v5/.test(ciWf) &&
    /actions\/setup-node@v5/.test(ciWf),
);
// M-WORKFLOW-SDH-1：洁净仓 clean + finalize 后 post-patch（禁把绝对占位断言跑在已 patch toml 上）
check(
  'GHA 含 SDH-3 clean（checkout 后）与 post-patch（finalize 后）',
  /test:deploy-config-consistency(?!:post-patch)/.test(wf) &&
    /test:deploy-config-consistency:post-patch/.test(wf) &&
    /SDH-3 clean/.test(wf) &&
    /SDH-3 post-patch/.test(wf),
);
check('put-secrets 在 Deploy Worker B 之后（Worker 须先存在）', (() => {
  const put = wf.indexOf('Put Worker secrets');
  const deployB = wf.indexOf('Deploy Worker B');
  const bootPut = wf.slice(0, wf.indexOf('deploy-workers:'));
  return put > deployB && !/Put Worker secrets/.test(bootPut);
})());
check('put-secrets / patch-pages 透传 REGISTRY_URL', /REGISTRY_URL:\s*\$\{\{\s*secrets\.REGISTRY_URL/.test(wf));

const patchPages = readText('scripts/ci-patch-pages-bindings.mjs');
check('ci-patch-pages 绑 WORKER_B（对齐本地 finalize）', /services\.WORKER_B/.test(patchPages));
check('ci-patch-pages 写 PUBLIC_REGISTRY_URL', /PUBLIC_REGISTRY_URL/.test(patchPages));
check('ci-patch-pages 注释要求 deploy 前调用', /pages deploy.*之前|之前.*pages deploy/.test(patchPages));
// M-WORKFLOW-HARDEN-1/2：PATCH 失败硬失败 + 结构化排障日志（禁 exit 0 假绿）
check(
  'ci-patch-pages PATCH 失败硬失败（禁 exit 0）',
  /function failReport/.test(patchPages) &&
    /process\.exit\(2\)/.test(patchPages) &&
    !/process\.exit\(0\)/.test(patchPages) &&
    !/不阻断/.test(patchPages),
);
check(
  'ci-patch-pages 失败日志含 kind/cf_code/action',
  /kind\s*=/.test(patchPages) &&
    /cf_code/.test(patchPages) &&
    /explainCfError/.test(patchPages) &&
    /::error::/.test(patchPages),
);
check(
  'ci-patch-pages 区分 GET project 与 PATCH bindings 步骤',
  /GET \/pages\/projects\//.test(patchPages) && /PATCH \/pages\/projects\//.test(patchPages),
);
// M-WORKFLOW-FAIL-OPEN-1：CF 8000066 — production/preview fail_open 必须相同
check(
  'ci-patch-pages 对齐 production/preview fail_open（防 8000066）',
  /resolveAlignedFailOpen/.test(patchPages) &&
    /fail_open:\s*failOpen/.test(patchPages) &&
    /preview:\s*\{/.test(patchPages) &&
    /8000066/.test(patchPages),
);
// M-WORKFLOW-IFS-1：禁止回写无值 secret_text；Pages 缺 IFS 时自愈同步 A/B
check(
  'ci-patch-pages 剥离无值 secret_text（防 PATCH 清空密钥）',
  /function stripRedactedSecretEnvVars/.test(patchPages) &&
    /secret_text/.test(patchPages) &&
    /省略该键以保留/.test(patchPages),
);
check(
  'ci-patch-pages Pages 缺 IFS 时自愈同步 Worker A/B',
  /自愈生成并同步/.test(patchPages) &&
    /putWorkerInternalForwardSecret/.test(patchPages) &&
    /apps\/worker-a/.test(patchPages) &&
    /apps\/worker-b/.test(patchPages),
);
check(
  'finalize-hailuo-deploy 同步剥离无值 secret_text',
  /secret_text/.test(readText('scripts/finalize-hailuo-deploy.mjs')) &&
    /value == null \|\| String\(value\)\.length === 0/.test(
      readText('scripts/finalize-hailuo-deploy.mjs'),
    ),
);
check(
  'finalize-hailuo-deploy 同步对齐 fail_open',
  /fail_open:\s*failOpen/.test(readText('scripts/finalize-hailuo-deploy.mjs')) &&
    /preview:\s*\{/.test(readText('scripts/finalize-hailuo-deploy.mjs')),
);
check(
  'GHA Build Web 注入 PUBLIC_REGISTRY_URL',
  /PUBLIC_REGISTRY_URL=/.test(wf) && /REGISTRY_FOR_BUILD|PUBLIC_REGISTRY_URL/.test(wf),
);
check(
  'ci-deploy-all Build 注入 PUBLIC_REGISTRY_URL',
  /PUBLIC_REGISTRY_URL\s*=\s*registryUrl/.test(readText('scripts/ci-deploy-all.mjs')),
);
check(
  'env.d.ts WORKER_B_URL 注释写 upsertTomlVar（非 secret put）',
  /upsertTomlVar/.test(readText('apps/worker-a/src/env.d.ts')) &&
    !/ci-finalize-urls\.mjs 走 wrangler secret put/.test(readText('apps/worker-a/src/env.d.ts')),
);
// M-WORKFLOW-PAGES-1：PATCH 必须在 pages deploy 之前（对齐本地 finalize→deploy）
// 注意：job 名也含「Deploy Pages」，要用 step 的 `- name:` 锚点
{
  const patchStep = wf.indexOf('- name: Patch Pages env vars (before deploy)');
  const deployStep = wf.indexOf('- name: Deploy Pages');
  check('GHA Patch Pages 在 Deploy Pages 之前', patchStep >= 0 && deployStep > patchStep);
}
{
  const deployAllSrc = readText('scripts/ci-deploy-all.mjs');
  const patchCall = deployAllSrc.indexOf('ci-patch-pages-bindings.mjs');
  const pagesDeploy =
    deployAllSrc.indexOf("'pages',\n      'deploy'") >= 0
      ? deployAllSrc.indexOf("'pages',\n      'deploy'")
      : deployAllSrc.search(/'pages'[\s\S]{0,40}'deploy'/);
  check('deploy:ci patch Pages 在 pages deploy 之前', patchCall >= 0 && pagesDeploy > patchCall);
}
check('prepare 写 GITHUB_ENV 含 API_KEY bridge', /CLOUDFLARE_API_KEY=/.test(readText('scripts/ci-prepare-cf-env.mjs')) && /GITHUB_ENV/.test(readText('scripts/ci-prepare-cf-env.mjs')));

const putSrc = readText('scripts/ci-put-secrets.mjs');
check('ci-put-secrets 注入 REGISTRY_URL', /REGISTRY_URL/.test(putSrc) && /hailuo-registry\.allovo\.eu\.org/.test(putSrc));

// M-WORKFLOW-URL-1：finalize 写 toml vars（对齐本地），禁止 secret put → Cloudflare 10053
const finalizeSrc = readText('scripts/ci-finalize-urls.mjs');
check('ci-finalize-urls 用 upsertTomlVar 回填 URL', /function upsertTomlVar/.test(finalizeSrc));
check(
  'ci-finalize-urls 写 WORKER_B_URL / WORKER_A_ORIGIN 到 toml',
  /upsertTomlVar\(tomlA,\s*key/.test(finalizeSrc) && /WORKER_B_URL/.test(finalizeSrc),
);
// 注释可提「勿 secret put」；代码路径不得再 spawn secret put
check(
  'ci-finalize-urls 无 wrangler secret put 调用',
  !/WRANGLER_PKG,\s*'secret'/.test(finalizeSrc) &&
    !/\['secret',\s*'put'/.test(finalizeSrc) &&
    !/function putSecret/.test(finalizeSrc),
);
check('GHA Finalize URL vars 步骤名', /Finalize URL vars \(toml\)/.test(wf));
check('GHA Redeploy 在 Finalize URL vars 之后', (() => {
  const fin = wf.indexOf('- name: Finalize URL vars (toml)');
  const redeployA = wf.indexOf('- name: Redeploy Worker A (after URL vars)');
  return fin >= 0 && redeployA > fin;
})());

const deployCi = readText('scripts/ci-deploy-all.mjs');
check('ci-deploy-all 钉 wrangler@3.114.17', /wrangler@3\.114\.17/.test(deployCi));
// M-WORKFLOW-PAGES-ACCOUNT-1：pages deploy 不认 --account-id（对齐本地 deploy-all.ps1）
check(
  'ci-deploy-all Pages 不传 --account-id（靠 CLOUDFLARE_ACCOUNT_ID env）',
  // 注释里可提「勿传 --account-id」；禁止作为 CLI 参数字面量
  !/['"]--account-id['"]/.test(deployCi) &&
    /CLOUDFLARE_ACCOUNT_ID\s*=\s*accountId/.test(deployCi) &&
    /'pages',\s*'deploy'/.test(deployCi),
);
check(
  'GHA Deploy Pages 不传 --account-id',
  /pages deploy dist/.test(wf) &&
    !/--account-id\s+"\$ACCOUNT_ID"/.test(wf) &&
    /export CLOUDFLARE_ACCOUNT_ID=/.test(wf),
);
// M-WORKFLOW-PAGES-FUNC-1：必须 cwd=web/ 再 deploy dist（根目录 deploy web/dist 会漏 Functions）
check(
  'GHA Deploy Pages 在 web/ 目录（cd web + deploy dist）',
  /cd web/.test(wf) &&
    /pages deploy dist/.test(wf) &&
    !/pages deploy web\/dist/.test(wf),
);
check(
  'ci-deploy-all Pages deploy 传 cwd=web/',
  /path\.join\(repoRoot,\s*'web'\)/.test(deployCi) &&
    /'pages',\s*'deploy'/.test(deployCi) &&
    /function runWrangler\(args,\s*cwd/.test(deployCi),
);
// M-WORKFLOW-SUMMARY-1：摘要用纯 Node，禁止 bash 内嵌反引号 node -e
check(
  'GHA Generate summary 调 ci-write-deploy-summary',
  /ci-write-deploy-summary\.mjs/.test(wf) && /Generate summary/.test(wf),
);
// M-WORKFLOW-SUMMARY-2：summary job 必须 checkout（artifact 不含该脚本）
{
  const summaryIdx = wf.indexOf('name: ✅ 部署摘要');
  const summarySlice = summaryIdx >= 0 ? wf.slice(summaryIdx, summaryIdx + 1200) : '';
  const checkoutIdx = summarySlice.indexOf('actions/checkout@');
  const genIdx = summarySlice.indexOf('Generate summary');
  check(
    'GHA summary job 先 checkout 再 Generate summary',
    checkoutIdx >= 0 && genIdx > checkoutIdx,
  );
}
check(
  'GHA summary 无 bash 内嵌 ANALYTICS node -e 反引号',
  !/ANALYTICS_INFO=\$\(node -e/.test(wf) && !/otel_enabled\?`/.test(wf),
);
// M-WORKFLOW-PAGES-FUNC-1：摘要落盘 + artifact，站主可反复下载
check(
  'ci-write-deploy-summary 落盘 ci-deploy-summary.md',
  /ci-deploy-summary\.md/.test(readText('scripts/ci-write-deploy-summary.mjs')) &&
    /writeFileSync\(fileOut/.test(readText('scripts/ci-write-deploy-summary.mjs')),
);
check(
  'GHA summary 上传 hailuo-deploy-summary artifact',
  /hailuo-deploy-summary/.test(wf) && /ci-deploy-summary\.md/.test(wf),
);
{
  const { analyticsLabel, buildMarkdown } = await import('./ci-write-deploy-summary.mjs');
  check(
    'summary analyticsLabel 剥离态',
    analyticsLabel({ stripped: true }) === '已剥离（OTEL 关，避免 10089）',
  );
  check(
    'summary analyticsLabel 绑定态（无反引号命令）',
    analyticsLabel({ otel_enabled: true }) === '已绑定 ANALYTICS（OTEL 开）',
  );
  const md = buildMarkdown({
    BOOTSTRAP_HANDLE: 'demo_handle',
    DEPLOY_GROUP_CODE: 'abcdef',
    HAILUO_NODE_SLOT: '1',
    WORKER_B_NAME: 'hailuo-worker-b-demo',
    PAGES_PROJECT_NAME: 'hailuo-web-demo',
    urls: { worker_b_url: 'https://b.example.com', pages_url: 'https://p.example.com' },
    analytics: { stripped: true },
  });
  check(
    'summary markdown 含表头与 Pages URL',
    /\| 项 \| 值 \|/.test(md) &&
      /\|---\|---\|/.test(md) &&
      md.includes('https://p.example.com') &&
      !md.includes('Worker A 地址在此显示'),
  );
  check(
    'summary 含身份派生自检（组码 + 槽位）',
    md.includes('身份派生') && md.includes('abcdef') && md.includes('槽位 1'),
  );
}
check('ci-deploy-all 调 seed', /ci-seed-default-owner\.mjs/.test(deployCi));
check('ci-deploy-all 调 bootstrap-worker-b-peer（DEPLOY-SB-10143）', /bootstrap-worker-b-peer\.mjs/.test(deployCi));
check('ci-deploy-all 头注释不再写 secrets→migrations 旧顺序', !/bootstrap → secrets → migrations/.test(deployCi));

// M-WORKFLOW-AE-1：OTEL 关时剥离 production ANALYTICS，避免未开通 AE 时报 10089
const bootAe = readText('scripts/ci-bootstrap-resources.mjs');
const patchAeSrc = readText('scripts/patch-wrangler-toml.mjs');
check('bootstrap 引用 stripEnvAnalyticsEngineDatasets', /stripEnvAnalyticsEngineDatasets/.test(bootAe));
check('bootstrap OTEL 关时剥离 ANALYTICS', /剥离 ANALYTICS/.test(bootAe) && /10089/.test(bootAe));
check('patch 导出 stripEnvAnalyticsEngineDatasets', /export function stripEnvAnalyticsEngineDatasets/.test(patchAeSrc));
check('patch 导出 stripEnvServiceBinding（DEPLOY-SB-10143）', /export function stripEnvServiceBinding/.test(patchAeSrc));
{
  const { stripEnvAnalyticsEngineDatasets, stripEnvServiceBinding } = await import('./patch-wrangler-toml.mjs');
  const sample = [
    '[env.production]',
    'name = "x"',
    '',
    '[[env.production.analytics_engine_datasets]]',
    'binding = "ANALYTICS"',
    'dataset = "hailuo_otel_prod"',
    '',
    '[[env.production.kv_namespaces]]',
    'binding = "STATE_KV"',
    'id = "abc"',
    '',
  ].join('\n');
  const r = stripEnvAnalyticsEngineDatasets(sample, { env: 'production' });
  check('strip AE 去掉 analytics_engine_datasets', r.removed === 1 && !/analytics_engine_datasets/.test(r.text));
  check('strip AE 保留其它 production 绑定', /STATE_KV/.test(r.text) && /\[env\.production\]/.test(r.text));

  const svcSample = [
    '[env.production]',
    'name = "hailuo-worker-b-demo"',
    '',
    '[[env.production.services]]',
    'binding = "WORKER_A"',
    'service = "hailuo-worker-a-demo"',
    '',
    '[[env.production.kv_namespaces]]',
    'binding = "STATE_KV"',
    'id = "abc"',
    '',
  ].join('\n');
  const sr = stripEnvServiceBinding(svcSample, { env: 'production', binding: 'WORKER_A' });
  check('strip service 去掉 WORKER_A 绑定', sr.removed === 1 && !/WORKER_A/.test(sr.text));
  check('strip service 保留 KV 与 name', /STATE_KV/.test(sr.text) && /hailuo-worker-b-demo/.test(sr.text));
}
check('部署 Worker A 用 wrangler deploy --env production', /wrangler(?:@[\d.]+)?\s+deploy --env production --config apps\/worker-a\/wrangler\.toml/.test(wf));
check('部署 Worker B 用 wrangler deploy --env production', /wrangler(?:@[\d.]+)?\s+deploy --env production --config apps\/worker-b\/wrangler\.toml/.test(wf));
check('读 secrets.CLOUDFLARE_API_TOKEN', /secrets\.CLOUDFLARE_API_TOKEN/.test(wf));
check('读 secrets.CLOUDFLARE_ACCOUNT_ID', /secrets\.CLOUDFLARE_ACCOUNT_ID/.test(wf));
check('Summary 不写 Worker A URL 到 GITHUB_OUTPUT', !/worker_a_url=/.test(wf));
check(
  'Summary 说明不显示 Worker A',
  /Worker A 地址\*\*不在此显示\*\*/.test(readText('scripts/ci-write-deploy-summary.mjs')),
);
check('不执行 npm run migrate:production（遗留 binding=DB）', !/npm run migrate:production/.test(wf) && !/run:.*migrate:production/.test(wf));

// ── 跨 job artifact 交接（隐藏文件 + patched toml + finalize urls）────────
check('bootstrap 上传 ci-deploy-bootstrap artifact', /name:\s*ci-deploy-bootstrap/.test(wf));
check('workers 上传 ci-deploy-final artifact（含 finalize 后 urls）', /name:\s*ci-deploy-final/.test(wf));
check('upload-artifact 开启 include-hidden-files（.ci-deploy-state.json）', /include-hidden-files:\s*true/.test(wf));
check('bootstrap artifact 含 patched worker-a wrangler.toml', /ci-deploy-bootstrap[\s\S]*?apps\/worker-a\/wrangler\.toml/.test(wf));
check('bootstrap artifact 含 patched worker-b wrangler.toml', /ci-deploy-bootstrap[\s\S]*?apps\/worker-b\/wrangler\.toml/.test(wf));
check('deploy-workers 校验 patched toml（对照 state 真 ID）', /Verify patched wrangler\.toml restored/.test(wf) && /IDENTITY_DB/.test(wf) && /include-hidden-files/.test(wf));
check('deploy-pages 下载 ci-deploy-final（不用 bootstrap 旧 state）', /Download CI final artifact[\s\S]*?name:\s*ci-deploy-final/.test(wf));
check('Build Web 拒空 urls.worker_b_url', /urls\.worker_b_url 为空/.test(wf) && /HAILUO_DEPLOY_STRICT/.test(wf));

// ── patch-wrangler-toml 关键能力 ──────────────────────────────────────────
const patch = readText('scripts/patch-wrangler-toml.mjs');
check('patch 支持 --toml', /--toml/.test(patch));
check('patch 支持 --binding', /--binding/.test(patch));
check('patch 支持 --force', /--force/.test(patch));
check('patch 支持 --dry-run', /--dry-run/.test(patch));
check('patch 识别 database_id（D1）', /database_id/.test(patch));
check('patch 识别 service（Service Binding）', /fieldHint|services/.test(patch) && /service/.test(patch));
check('patch 幂等跳过已有真值', /已有真值/.test(patch) || /isLikelyReal/.test(patch));

// ── bootstrap 资源清单 ────────────────────────────────────────────────────
const boot = readText('scripts/ci-bootstrap-resources.mjs');
check('bootstrap 创建 IDENTITY_DB', /IDENTITY_DB/.test(boot));
check('bootstrap 创建 GOVERNANCE_DB', /GOVERNANCE_DB/.test(boot));
check('bootstrap 创建 CONTENT_DB', /CONTENT_DB/.test(boot));
check('bootstrap 创建 DB_IMPORT', /DB_IMPORT/.test(boot));
check('bootstrap 创建 MESSAGING_DB', /MESSAGING_DB/.test(boot));
check('bootstrap 创建 MESSAGING_SHARD_1', /MESSAGING_SHARD_1/.test(boot));
check('bootstrap 创建三 KV', /POSTS_CACHE_KV/.test(boot) && /IMAGE_KV/.test(boot) && /STATE_KV/.test(boot));
// M-WORKFLOW-KV-1：新建 KV 走 API（title 原样），避免 wrangler 拼 prod-placeholder
check('bootstrap 用 createKvViaApi 建 KV', /function createKvViaApi/.test(boot) && /createKvViaApi\(title\)/.test(boot));
// 2026-10-24：CI 必须 list-first（与本地「cloud list miss 沿用旧 uuid」旧坑对照）；禁止盲 reuse state uuid
// 2026-11-24：先剥注释再断言——同文件的说明注释会写旧坑原词，扫全文会自伤（门禁从引入起即假红）
const bootCode = stripComments(boot);
check(
  'CI findOrCreateKv list-first（禁盲 reuse 旧 uuid，防 10041）',
  /function findOrCreateKv/.test(bootCode) &&
    /const all = listKv\(\)/.test(bootCode) &&
    !/keep local id/.test(bootCode),
);
check(
  'bootstrap 注释声明禁盲 reuse state/token 旧 uuid',
  /禁止.*盲 reuse state\/token/.test(boot),
);
check(
  'bootstrap 注释说明不可改名 / reuse 长名',
  /不可改名/.test(boot) && /prod-placeholder/.test(boot),
);
// M-WORKFLOW-KV-2：posts-cache 与 image-kv/state-kv 统一 -kv 后缀；旧名只 alias reuse
check(
  'bootstrap POSTS_CACHE 规范名为 posts-cache-kv',
  /POSTS_CACHE_KV:\s*`hailuo-node-\$\{g\}-posts-cache-kv`/.test(boot),
);
check(
  'bootstrap POSTS_CACHE 兼容旧短名 posts-cache alias',
  /kvAliases/.test(boot) && /hailuo-node-\$\{g\}-posts-cache`/.test(boot),
);
check('bootstrap 使用稳定身份（不再每次随机 generate-deploy-identity）', /resolveCiIdentity|ci-stable-identity/.test(boot));
check('bootstrap 调 generate-deploy-secrets', /generate-deploy-secrets/.test(boot));
check('bootstrap 写 .ci-deploy-state.json', /\.ci-deploy-state\.json/.test(boot));

// ── migrations 顺序（A7-DB-RETIRE）───────────────────────────────────────
const mig = readText('scripts/ci-apply-migrations.mjs');
check('migrations 含 DB_IMPORT', /DB_IMPORT/.test(mig));
check('migrations 含 IDENTITY_DB', /IDENTITY_DB/.test(mig));
check('migrations 含 GOVERNANCE_DB', /GOVERNANCE_DB/.test(mig));
check('migrations 含 CONTENT_DB', /CONTENT_DB/.test(mig));
check('migrations 含 MESSAGING_DB', /MESSAGING_DB/.test(mig));
check('migrations 含 MESSAGING_SHARD_1', /MESSAGING_SHARD_1/.test(mig));
check('migrations 不含遗留 binding=DB 字面量 apply', !/apply',\s*'DB'/.test(mig) && !/"DB"/.test(mig));
// DEPLOY-MIG-RETRY-1：对齐本地 Invoke-WranglerWithRetry —— 直跑本地 wrangler + 信号/瞬时错误重试
check(
  'migrations 直跑本地 wrangler bin（不经 npx 包装层）',
  /'node_modules',\s*'wrangler',\s*'bin',\s*'wrangler\.js'/.test(mig) && /process\.execPath/.test(mig),
);
check(
  'migrations 每个库最多 3 次重试且识别 SIGTERM',
  /MAX_ATTEMPTS\s*=\s*3/.test(mig) && /function isTransientFailure/.test(mig) && /r\.signal/.test(mig),
);
check('migrations 显式 ignore stdin（防 confirm 卡住）', /stdio:\s*\['ignore',\s*'pipe',\s*'pipe'\]/.test(mig));
check('migrations 失败提示区分被信号终止', /last\.signal/.test(mig) && /被 \$\{last\.signal\} 终止/.test(mig));
// DEPLOY-REPEAT-SAFE-1：重复部署不能删既有数据
check(
  'migrations 拒绝在「有表但无 d1_migrations」的库上重放',
  /function assertMigrationHistorySafe/.test(mig) &&
    /d1_migrations/.test(mig) &&
    /assertMigrationHistorySafe\(runner, binding\)/.test(mig),
);
check(
  'bootstrap 列举失败即停（不误建空 D1 / 空 KV）',
  /为避免在已有节点上误建空库/.test(boot) && /为避免在已有节点上误建空 KV/.test(boot),
);
const seedOwner = readText('apps/worker-a/scripts/seed-default-owner.mjs');
check(
  'seed 远程 JSON 从首个 [ 解析（不被 🌀 日志误判空表）',
  /indexOf\('\['\)/.test(seedOwner) && /lastIndexOf\('\]'\)/.test(seedOwner),
);
const seedQueryStart = seedOwner.indexOf('function queryOwnerUsername');
const seedQueryEnd = seedOwner.indexOf('function ', seedQueryStart + 10);
const seedQueryFn = seedOwner.slice(
  seedQueryStart,
  seedQueryEnd > seedQueryStart ? seedQueryEnd : seedQueryStart + 1500,
);
check(
  'seed 预查询用 --command（--file 只回导入统计，读不到 SELECT 行）',
  /--command/.test(seedQueryFn) && !/--file/.test(seedQueryFn),
);
check(
  'seed 直跑 wrangler.js（Windows shell:true 会把 SQL 按空格拆成 Unknown arguments）',
  /resolveWranglerCli/.test(seedOwner) &&
    /spawnSync\(process\.execPath, \[cliEntry, \.\.\.cliArgs\]/.test(seedOwner) &&
    !/shell:\s*isWindows/.test(seedOwner),
);
const deployScriptsForDeleteAudit = [
  'scripts/ci-bootstrap-resources.mjs',
  'scripts/ci-apply-migrations.mjs',
  'scripts/ci-put-secrets.mjs',
  'scripts/ci-seed-default-owner.mjs',
  'scripts/ci-finalize-urls.mjs',
  'scripts/bootstrap-worker-b-peer.mjs',
];
check(
  '部署脚本不含删库 / 删 KV / 删 Pages / 删 R2 调用',
  deployScriptsForDeleteAudit.every(
    (f) =>
      !/\b(d1\s+delete|kv\s+namespace\s+delete|pages\s+project\s+delete|r2\s+bucket\s+delete)\b/.test(
        readText(f),
      ),
  ),
);

// 2026-11-24：53 位无中划线的新格式 Token 曾被 debug 脚本误判成 Global Key 并刷假警告
const dbgAuth = readText('scripts/ci-debug-cf-auth.mjs');
check(
  'debug auth 按配了哪个 Secret 判定，不看字符形态',
  /function detectAuthMode\(\)/.test(dbgAuth) &&
    /process\.env\.CLOUDFLARE_API_TOKEN/.test(dbgAuth) &&
    !/token\.includes\('-'\)\s*&&\s*token\.length/.test(dbgAuth),
);


// ── 文档 / README ─────────────────────────────────────────────────────────
const doc = readText('docs/deploy-github-actions.md');
check('手册写 CLOUDFLARE_API_TOKEN', /CLOUDFLARE_API_TOKEN/.test(doc));
check('手册写 CLOUDFLARE_ACCOUNT_ID', /CLOUDFLARE_ACCOUNT_ID/.test(doc));
check('手册说明官方按钮不能建 D1/KV', /不能.*D1|不会.*创建.*D1|不能自动创建/.test(doc));
check('手册不写真实 Worker A 生产 URL 字面量示例', !/hailuo-worker-a-\w+\.\w+\.workers\.dev/.test(doc));

const readme = readText('README.md');
// 公开仓不发布 Workers Builds 门禁脚本，README 只保留 GitHub Actions；
// 私有仓仍保留该脚本与 Deploy 按钮，所以这两条断言只在脚本存在时生效。
if (existsSync(join(root, 'scripts/test-deploy-workers-builds.mjs'))) {
  check('README 推荐 Workers Builds（主）并保留 Actions 文档链', /Workers Builds/.test(readme) && /deploy-workers-builds\.md/.test(readme) && /deploy-github-actions\.md/.test(readme));
  // 公开仓允许换账号/换仓名（如 hailuome），这里只校验 Deploy 按钮的 URL 形态
  check('README 仍保留 Deploy 按钮 URL（legacy）', /deploy\.workers\.cloudflare\.com\/\?url=https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+&subdir=apps\/worker-a/.test(readme));
}

// ── gitignore / package.json ──────────────────────────────────────────────
const gi = readText('.gitignore');
check('.gitignore 忽略 .ci-deploy-state.json', /\.ci-deploy-state\.json/.test(gi));

const pkg = readJson('package.json');
check('package.json 含 test:deploy-github-actions', typeof pkg.scripts?.['test:deploy-github-actions'] === 'string');
check('package.json 含 deploy:ci', typeof pkg.scripts?.['deploy:ci'] === 'string');

const actionsDoc = readText('docs/deploy-github-actions.md');
check('Actions 手册标明首次部署推荐路径', /推荐|首次部署/.test(actionsDoc));
check('bootstrap 使用稳定身份', /resolveCiIdentity|ci-stable-identity/.test(boot));
// 公开仓原则：任何空账号填 Token 就能部署——workers.dev 子域必须先存在，否则首次 deploy 10007 直接失败
check(
  'bootstrap 确保 workers.dev 子域（全新账号首次部署必需）',
  /function ensureWorkersDevSubdomain/.test(boot) &&
    /ensureWorkersDevSubdomain\(identity\.DEPLOY_GROUP_CODE\)/.test(boot) &&
    /accounts\/\$\{accountId\}\/workers/.test(boot) &&
    /\/subdomain/.test(boot),
);

// ── patch 脚本 dry-run 冒烟（不改文件）───────────────────────────────────
const dry = spawnSync(
  process.execPath,
  [
    join(root, 'scripts', 'patch-wrangler-toml.mjs'),
    '--toml',
    'apps/worker-a/wrangler.toml',
    '--binding',
    'IDENTITY_DB',
    '--id',
    // 用中性假 UUID 做 dry-run 示例，避免公开仓出现真实 D1 ID
    '11111111-1111-1111-1111-111111111111',
    '--dry-run',
  ],
  // ⚠️ 对 process.execPath 禁止 shell:true：Windows 下 Node 常在 `C:\Program Files\...`，
  // shell 会按空格拆成 `'C:\Program'` → 假失败（M-WORKFLOW-SHELL-1 证伪外部审查建议）。
  { cwd: root, encoding: 'utf8' },
);
// P1-4 后 git 内 production 段是 *-prod-placeholder；dry-run 应对占位执行「计划修改」，不是 skip
check(
  'patch dry-run 对占位 database_id 计划写入（exit 0）',
  dry.status === 0 &&
    (/\[dry-run\].*计划修改/.test(`${dry.stdout}${dry.stderr}`) ||
      /skip|值未变|已有真值/.test(`${dry.stdout}${dry.stderr}`)),
);
// 门禁：dry-run options 对象不得含 shell（防 Program Files 路径被拆）
check(
  'patch dry-run spawn 未对 execPath 开 shell',
  /\{\s*cwd:\s*root,\s*encoding:\s*'utf8'\s*\}/.test(readText('scripts/test-deploy-github-actions.mjs')),
);

console.log(`\n结果：${passed} 通过，${failed} 失败\n`);
if (failed > 0) process.exit(1);
