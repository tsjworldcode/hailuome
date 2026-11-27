/**
 * 扫描 GHA / CI 部署脚本的已知 shell/YAML 坑（只读审计，exit 0=无高危）。
 * 用法：node scripts/audit-deploy-shell-hazards.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const issues = [];

function add(sev, kind, where, detail) {
  issues.push({ sev, kind, where, detail });
}

const ymlPath = path.join(root, '.github/workflows/deploy.yml');
const yml = fs.readFileSync(ymlPath, 'utf8');

// 1) bash node -e 双引号内含反引号
for (const m of yml.matchAll(/node -e "([^"]*)"/g)) {
  if (m[1].includes('`')) {
    add('high', 'backtick-in-node-e', 'deploy.yml', m[1].slice(0, 140));
  }
}

// 2) pages deploy 命令行仍传 --account-id（注释里提到不算）
{
  const deployCmd = yml.match(
    /npm exec -- wrangler@[^\n]*pages deploy[\s\S]{0,280}?(?=\n\S|\n#|\n  [a-z]|$)/,
  );
  if (deployCmd && /--account-id/.test(deployCmd[0])) {
    add('high', 'account-id-on-pages-deploy', 'deploy.yml', 'pages deploy 命令仍含 --account-id');
  }
}

// 3) echo 同行未闭合双引号
for (const [i, line] of yml.split(/\n/).entries()) {
  const t = line.trim();
  if (!t.startsWith('echo "')) continue;
  const quotes = (t.match(/"/g) || []).length;
  if (quotes % 2 === 1) {
    add('high', 'unclosed-echo-quote', `deploy.yml:${i + 1}`, t.slice(0, 120));
  }
}

// 4) summary 调 ci-write-deploy-summary 但 artifact/checkout 是否带脚本
const hasSummaryScript = /ci-write-deploy-summary\.mjs/.test(yml);
const summaryJob = yml.split(/summary:\s*\n/)[1] || '';
const summaryHasCheckout = /actions\/checkout@/.test(summaryJob.split(/\n  [a-z]/)[0] || summaryJob);
const finalUpload = yml.match(/name:\s*ci-deploy-final[\s\S]{0,400}?path:\s*\|\n([\s\S]*?)(?:include-hidden|retention)/);
const finalPaths = finalUpload ? finalUpload[1] : '';
const finalIncludesSummaryScript = /ci-write-deploy-summary/.test(finalPaths);
if (hasSummaryScript && !summaryHasCheckout && !finalIncludesSummaryScript) {
  add(
    'high',
    'summary-script-missing-on-runner',
    'deploy.yml summary job',
    'Generate summary 调 ci-write-deploy-summary.mjs，但 summary 无 checkout 且 ci-deploy-final artifact 未包含该脚本 → ENOENT',
  );
}

// 5) 残留 ANALYTICS_INFO 内联
if (/ANALYTICS_INFO=\$\(node -e/.test(yml)) {
  add('high', 'legacy-analytics-inline', 'deploy.yml', '仍有 ANALYTICS_INFO node -e 内联');
}

// 扫描其它 workflow
for (const f of fs.readdirSync(path.join(root, '.github/workflows'))) {
  if (!f.endsWith('.yml') && !f.endsWith('.yaml')) continue;
  if (f === 'deploy.yml') continue;
  const text = fs.readFileSync(path.join(root, '.github/workflows', f), 'utf8');
  for (const m of text.matchAll(/node -e "([^"]*)"/g)) {
    if (m[1].includes('`')) {
      add('high', 'backtick-in-node-e', f, m[1].slice(0, 140));
    }
  }
}

const high = issues.filter((x) => x.sev === 'high');
const med = issues.filter((x) => x.sev === 'medium');

console.log('=== 部署 shell/YAML 坑审计 ===\n');
if (!issues.length) {
  console.log('  ✅ 未发现高危同类坑\n');
} else {
  for (const x of issues) {
    console.log(`  [${x.sev}] ${x.kind}`);
    console.log(`    @ ${x.where}`);
    console.log(`    ${x.detail}\n`);
  }
}
console.log(`合计：high=${high.length} medium=${med.length}`);
process.exit(high.length ? 1 : 0);
