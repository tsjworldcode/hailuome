/**
 * M8-14-1 · 部署期可选 R2：先 list 探测，能建则幂等建桶并临时绑 HAILUO_IMAGE_R2
 *
 * 失败一律 skip（不 throw / 不 process.exit 非 0），由调用方继续 D1/KV/A/B/Pages。
 *
 * 用法：
 *   node scripts/ci-optional-r2.mjs --group <DEPLOY_GROUP_CODE>
 *   # 或读 CI_DEPLOY_IDENTITY_JSON / 环境变量 DEPLOY_GROUP_CODE
 *
 * 环境变量：
 *   SKIP_R2=1       完全跳过
 *   SKIP_CREATE=1   只 reuse，不 create；没有则 skip
 *
 * 运行：可被 ci-bootstrap 后续步骤 import；本文件可独立 CLI。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { ensureR2BucketBinding } from './patch-wrangler-toml.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

/** 与 GHA / ci-deploy-all / ci-bootstrap 同钉；勿裸 `wrangler`——npx 会拉 4.x，Node 20 CI 直接崩 */
const WRANGLER_PKG = 'wrangler@3.114.17';

export const R2_BINDING = 'HAILUO_IMAGE_R2';

/** @param {string} groupCode */
export function r2BucketNameFromGroup(groupCode) {
  const g = String(groupCode || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '');
  if (!g) throw new Error('DEPLOY_GROUP_CODE 无效');
  return `hailuo-node-media-${g}`;
}

/**
 * 从 wrangler r2 bucket list 输出解析桶名（兼容表格 / JSON 片段）。
 * @param {string} out
 * @returns {string[]}
 */
export function parseR2BucketNames(out) {
  const names = new Set();
  if (!out || typeof out !== 'string') return [];
  // JSON 数组
  try {
    const start = out.indexOf('[');
    const end = out.lastIndexOf(']');
    if (start >= 0 && end > start) {
      const arr = JSON.parse(out.slice(start, end + 1));
      if (Array.isArray(arr)) {
        for (const row of arr) {
          const n = row?.name || row?.Name || row?.id;
          if (typeof n === 'string' && n) names.add(n);
        }
      }
    }
  } catch {
    /* 非 JSON，继续行解析 */
  }
  for (const m of out.matchAll(/(?:^|\n)\s*(?:name|Name)\s*[:=]\s*"?([a-z0-9][a-z0-9._-]*)"?/gim)) {
    names.add(m[1]);
  }
  // 海螺稳定前缀直认
  for (const m of out.matchAll(/\b(hailuo-node-media-[a-z0-9-]+)\b/g)) {
    names.add(m[1]);
  }
  return [...names];
}

/**
 * @typedef {{ status: number, out: string }} RunResult
 * @typedef {{
 *   runWrangler?: (args: string[]) => RunResult,
 *   skipR2?: boolean,
 *   skipCreate?: boolean,
 *   groupCode: string,
 *   tomlPaths?: string[],
 *   binding?: string,
 *   writeToml?: boolean,
 * }} EnsureOptionalR2Options
 */

/**
 * @param {EnsureOptionalR2Options} opts
 * @returns {{
 *   status: 'bound' | 'skipped',
 *   reason?: string,
 *   bucketName?: string,
 *   binding?: string,
 *   created?: boolean,
 *   reused?: boolean,
 *   patched?: string[],
 * }}
 */
export function ensureOptionalR2(opts) {
  const binding = opts.binding || R2_BINDING;
  if (opts.skipR2 || process.env.SKIP_R2 === '1') {
    return { status: 'skipped', reason: 'SKIP_R2=1' };
  }

  let bucketName;
  try {
    bucketName = r2BucketNameFromGroup(opts.groupCode);
  } catch (err) {
    return { status: 'skipped', reason: err instanceof Error ? err.message : String(err) };
  }

  const runWrangler =
    opts.runWrangler ||
    ((args) => {
      const bin = process.platform === 'win32' ? 'npx.cmd' : 'npx';
      const r = spawnSync(bin, ['--yes', WRANGLER_PKG, ...args], {
        cwd: path.join(repoRoot, 'apps', 'worker-a'),
        encoding: 'utf8',
        env: { ...process.env, CI: 'true' },
        shell: process.platform === 'win32',
      });
      return { status: r.status ?? 1, out: `${r.stdout || ''}${r.stderr || ''}` };
    });

  const list = runWrangler(['r2', 'bucket', 'list']);
  if (list.status !== 0) {
    return {
      status: 'skipped',
      reason: `r2 bucket list 失败（无权限或未开通 R2）：exit ${list.status}`,
      bucketName,
      binding,
    };
  }

  const existing = parseR2BucketNames(list.out);
  const has = existing.includes(bucketName);
  let created = false;
  let reused = false;

  if (has) {
    reused = true;
  } else if (opts.skipCreate || process.env.SKIP_CREATE === '1') {
    return {
      status: 'skipped',
      reason: '桶不存在且 SKIP_CREATE=1',
      bucketName,
      binding,
    };
  } else {
    const create = runWrangler(['r2', 'bucket', 'create', bucketName]);
    if (create.status !== 0) {
      return {
        status: 'skipped',
        reason: `r2 bucket create 失败：exit ${create.status}`,
        bucketName,
        binding,
      };
    }
    created = true;
  }

  const tomlPaths = opts.tomlPaths || [
    path.join(repoRoot, 'apps', 'worker-a', 'wrangler.toml'),
    path.join(repoRoot, 'apps', 'worker-b', 'wrangler.toml'),
  ];
  const writeToml = opts.writeToml !== false;
  /** @type {string[]} */
  const patched = [];

  for (const tomlPath of tomlPaths) {
    if (!fs.existsSync(tomlPath)) {
      return {
        status: 'skipped',
        reason: `TOML 不存在：${tomlPath}`,
        bucketName,
        binding,
      };
    }
    const original = fs.readFileSync(tomlPath, 'utf8');
    const result = ensureR2BucketBinding(original, {
      section: 'env.production',
      binding,
      bucketName,
      force: true,
    });
    if (result.applied && writeToml) {
      fs.writeFileSync(tomlPath, result.text, 'utf8');
      patched.push(path.relative(repoRoot, tomlPath));
    } else if (result.applied) {
      patched.push(path.relative(repoRoot, tomlPath) + ' (dry)');
    } else if (result.skipped && result.reason === '值未变') {
      patched.push(path.relative(repoRoot, tomlPath) + ' (unchanged)');
    } else {
      return {
        status: 'skipped',
        reason: `patch ${path.relative(repoRoot, tomlPath)} 失败：${result.reason}`,
        bucketName,
        binding,
      };
    }
  }

  return {
    status: 'bound',
    bucketName,
    binding,
    created,
    reused,
    patched,
  };
}

/**
 * 部署接入用：任何异常都变成 skipped，调用方不得因此中断 D1/KV/Workers。
 * @param {EnsureOptionalR2Options} opts
 */
export function safeEnsureOptionalR2(opts) {
  try {
    return ensureOptionalR2(opts);
  } catch (err) {
    return {
      status: 'skipped',
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * 写入 .ci-deploy-state.json 的稳定字段（不含本地 toml 路径）。
 * @param {{ status?: string, reason?: string, binding?: string, bucketName?: string, created?: boolean, reused?: boolean } | null | undefined} result
 */
export function r2DeployState(result) {
  const r = result && typeof result === 'object' ? result : { status: 'skipped', reason: '无结果' };
  return {
    status: r.status === 'bound' ? 'bound' : 'skipped',
    reason: typeof r.reason === 'string' ? r.reason : '',
    binding: r.binding || R2_BINDING,
    bucket_name: typeof r.bucketName === 'string' ? r.bucketName : '',
    created: Boolean(r.created),
    reused: Boolean(r.reused),
  };
}

function parseCli(argv) {
  /** @type {{ group?: string, dryRun?: boolean }} */
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--group') out.group = argv[++i];
    else if (argv[i] === '--dry-run') out.dryRun = true;
  }
  return out;
}

function resolveGroupCode(cliGroup) {
  if (cliGroup) return cliGroup;
  if (process.env.DEPLOY_GROUP_CODE) return process.env.DEPLOY_GROUP_CODE;
  const raw = process.env.CI_DEPLOY_IDENTITY_JSON;
  if (raw) {
    try {
      const j = JSON.parse(raw);
      if (j.DEPLOY_GROUP_CODE) return j.DEPLOY_GROUP_CODE;
    } catch {
      /* ignore */
    }
  }
  return '';
}

const isDirectRun =
  process.argv[1] &&
  (process.argv[1].endsWith('ci-optional-r2.mjs') || process.argv[1].includes('ci-optional-r2'));

if (isDirectRun) {
  const cli = parseCli(process.argv.slice(2));
  const groupCode = resolveGroupCode(cli.group);
  const result = ensureOptionalR2({
    groupCode,
    writeToml: !cli.dryRun,
  });
  console.log(JSON.stringify(result, null, 2));
  // C1：永远 exit 0（可选能力）
  process.exit(0);
}
