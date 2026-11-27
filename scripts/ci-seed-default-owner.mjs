/**
 * CI / Workers Builds：首次部署写入默认站主凭证（对齐本地 deploy-hailuo-workers.ps1）
 *
 * 调用 apps/worker-a/scripts/seed-default-owner.mjs --production --if-empty --yes
 * 默认 admin/admin（表空才写）；可用 OWNER_SEED_USERNAME / OWNER_SEED_PASSWORD 覆盖。
 *
 * 前置：Worker A 已至少 deploy 一次；IDENTITY_DB migration 已 apply；CF env 已 prepare。
 * 运行：node scripts/ci-seed-default-owner.mjs
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareCfEnvForWrangler } from './ci-prepare-cf-env.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const seedScript = path.join(repoRoot, 'apps', 'worker-a', 'scripts', 'seed-default-owner.mjs');

function die(msg) {
  console.error(`错误：${msg}`);
  process.exit(2);
}

async function main() {
  console.log('\n════ CI：seed 默认站主凭证（--if-empty）════\n');

  try {
    prepareCfEnvForWrangler({ requireAccountId: true });
  } catch (err) {
    die(err?.message || String(err));
  }

  const args = [seedScript, '--production', '--if-empty', '--yes'];
  if (process.env.OWNER_SEED_USERNAME || process.env.OWNER_SEED_PASSWORD) {
    args.push('--from-env');
  }

  let r;
  try {
    r = spawnSync(process.execPath, args, {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...process.env, CI: 'true' },
      shell: process.platform === 'win32',
    });
  } catch (err) {
    die(`spawn seed-default-owner 异常：${err?.message || err}`);
  }

  process.stdout.write(r.stdout || '');
  if (r.stderr) process.stderr.write(r.stderr);

  if ((r.status ?? 1) !== 0) {
    console.error(
      '[ci-seed-default-owner] 失败。常见原因：IDENTITY_DB 未 migrate、Worker A 未 deploy、ACCOUNT_ID 缺失。',
    );
    die(`seed-default-owner 失败（exit ${r.status}）`);
  }

  console.log('  ✓ 默认站主凭证已处理（空表则写入 admin/admin，已有则跳过）\n');
}

main().catch((err) => {
  console.error('[ci-seed-default-owner] 未捕获异常：', err?.stack || err?.message || err);
  process.exit(2);
});
