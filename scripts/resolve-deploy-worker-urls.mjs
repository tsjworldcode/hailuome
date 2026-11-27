/**
 * Worker A 部署后、finalize 之前：把 token 里空的 WORKER_*_URL 按项目名解析并写回。
 *
 * 用法：node scripts/resolve-deploy-worker-urls.mjs --token-file scripts/cloudflare-api-token.json
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applyDeployUrlsToConfig,
  hasDeployUrl,
  resolveDeployUrlsFromConfig,
} from './resolve-deploy-urls.mjs';

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const opts = { tokenFile: path.join(SCRIPTS_DIR, 'cloudflare-api-token.json'), force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--token-file' && argv[i + 1]) opts.tokenFile = path.resolve(argv[++i]);
    else if (a.startsWith('--token-file=')) opts.tokenFile = path.resolve(a.slice('--token-file='.length));
    else if (a === '--force') opts.force = true;
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(opts.tokenFile)) {
    console.error(`[resolve-deploy-urls] 未找到: ${opts.tokenFile}`);
    process.exit(1);
  }

  const config = JSON.parse(fs.readFileSync(opts.tokenFile, 'utf8'));
  if (!opts.force && hasDeployUrl(config)) {
    process.stdout.write(JSON.stringify({ ok: true, skipped: true, worker_a_url: config.WORKER_A_URL }));
    return;
  }

  const urls = await resolveDeployUrlsFromConfig(config);
  applyDeployUrlsToConfig(config, urls);
  fs.writeFileSync(opts.tokenFile, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  console.log(`[resolve-deploy-urls] WORKER_A_URL=${urls.workerAUrl}`);
  process.stdout.write(JSON.stringify({ ok: true, skipped: false, ...urls }));
}

main().catch((err) => {
  console.error('[resolve-deploy-urls] 失败:', err.message ?? err);
  process.exit(1);
});
