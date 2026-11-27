/**
 * M8-4：从仓库根按顺序部署 Worker A → Worker B（production）
 * M8-14-3：部署前走与 CI 相同的可选 R2（失败不阻断，图片继续用 KV）
 * 用法：node scripts/deploy-all.mjs
 * 说明：站主主路径仍是 GitHub Deploy 按钮；本脚本供整仓 fork 后本地/CI 使用。
 * 进阶 PowerShell 版见 M8-6 deploy-all.ps1。
 */
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { r2DeployState, safeEnsureOptionalR2 } from './ci-optional-r2.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function run(label, cmd) {
  console.log(`\n════ ${label} ════\n`);
  execSync(cmd, { cwd: root, stdio: 'inherit', env: { ...process.env, CI: 'true' } });
}

function readLocalGroupCode() {
  if (process.env.DEPLOY_GROUP_CODE) return process.env.DEPLOY_GROUP_CODE;
  const tokenPath = join(root, 'scripts', 'cloudflare-api-token.json');
  if (!existsSync(tokenPath)) return '';
  try {
    const parsed = JSON.parse(readFileSync(tokenPath, 'utf8'));
    return typeof parsed.DEPLOY_GROUP_CODE === 'string' ? parsed.DEPLOY_GROUP_CODE : '';
  } catch {
    return '';
  }
}

console.log('海螺节点 monorepo 部署：可选 R2 → Worker A（含 D1 migration）→ Worker B\n');

const r2 = r2DeployState(safeEnsureOptionalR2({
  groupCode: readLocalGroupCode(),
  writeToml: true,
}));
if (r2.status === 'bound') {
  console.log(`图片对象库：已绑定 ${r2.binding} → ${r2.bucket_name}`);
} else {
  console.log(`图片对象库：未绑定，继续用 KV（${r2.reason || '跳过'}）`);
}

run('1/2 Worker A', 'npm run deploy --workspace=@hailuo/worker-a');
run('2/2 Worker B', 'npm run deploy --workspace=@hailuo/worker-b');

// P1-4 / TOML-BAK：部署成功后自动备份真值到 *.bak 并还原 git 占位
try {
  run('restore wrangler placeholders', 'npm run restore:wrangler-placeholders');
} catch (err) {
  console.warn(
    '\n⚠ 自动还原 wrangler.toml 占位失败（Workers 已部署成功）。请立刻手动：npm run restore:wrangler-placeholders\n',
    err?.message || err,
  );
}

console.log('\n✅ deploy-all 完成。请回填 WORKER_B_URL / PUBLIC_WORKER_B_URL / WORKER_A_ORIGIN（若尚未配置）。\n');
