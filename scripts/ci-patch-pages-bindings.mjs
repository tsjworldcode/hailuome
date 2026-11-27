/**
 * M8-12 · PATCH Pages Production 绑定（硬失败 + 结构化排障日志）
 * 对齐本地 finalize-hailuo-deploy.mjs：
 *   PUBLIC_WORKER_B_URL / PUBLIC_REGISTRY_URL / INTERNAL_FORWARD_SECRET
 *   WORKER_A + WORKER_B Service Binding / STATE_KV
 *
 * M-WORKFLOW-PAGES-1：必须在 `wrangler pages deploy` **之前**调用。
 * M-WORKFLOW-HARDEN-1：失败一律 exit≠0（禁假绿）。
 * M-WORKFLOW-HARDEN-2：失败时打印 kind / cf_code / step / action（无密钥明文），
 *   便于站主对照改 Secrets 或改本脚本。
 * M-WORKFLOW-FAIL-OPEN-1：PATCH 时 production/preview 的 fail_open 必须相同（CF 8000066）。
 * M-WORKFLOW-IFS-1：PATCH 禁止回写「无 value 的 secret_text」（会清掉线上密钥）；
 *   Pages 缺 INTERNAL_FORWARD_SECRET 时自愈生成并同步 Worker A/B（不轮换 JWT/Ed25519）。
 *
 * 运行：node scripts/ci-patch-pages-bindings.mjs
 */
import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareCfEnvForWrangler } from './ci-prepare-cf-env.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const statePath =
  process.env.CI_DEPLOY_STATE_PATH ||
  path.join(repoRoot, 'scripts', '.ci-deploy-state.json');

/** 与 GHA / ci-put-secrets 同钉 */
const WRANGLER_PKG = 'wrangler@3.114.17';

function sha8(value) {
  if (!value) return '(empty)';
  return createHash('sha256').update(String(value), 'utf8').digest('hex').slice(0, 8);
}

/**
 * GET project 返回的 secret_text 通常无 value（已脱敏）。
 * 若原样塞回 PATCH，Cloudflare 可能清空该 secret → 登录 503 INTERNAL_FORWARD_SECRET_MISSING。
 * 规则：无 value 的 secret_text **省略**（服务端保留）；有 value 才写入。
 */
function stripRedactedSecretEnvVars(envVars) {
  /** @type {Record<string, { type: string, value?: string }>} */
  const out = {};
  for (const [key, raw] of Object.entries(envVars || {})) {
    if (!raw || typeof raw !== 'object') continue;
    const type = /** @type {{ type?: string, value?: unknown }} */ (raw).type;
    const value = /** @type {{ type?: string, value?: unknown }} */ (raw).value;
    if (type === 'secret_text' && (value == null || String(value).length === 0)) {
      continue;
    }
    out[key] = /** @type {{ type: string, value?: string }} */ (raw);
  }
  return out;
}

/** 仅同步 INTERNAL_FORWARD_SECRET 到已存在的 Worker（stdin 喂值，不打明文） */
function putWorkerInternalForwardSecret(workerDir, value) {
  const bin = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  console.log(`  → secret put INTERNAL_FORWARD_SECRET @ ${workerDir}（自愈，仅此键）`);
  const r = spawnSync(
    bin,
    [
      '--yes',
      WRANGLER_PKG,
      'secret',
      'put',
      'INTERNAL_FORWARD_SECRET',
      '--env',
      'production',
      '--config',
      'wrangler.toml',
    ],
    {
      cwd: path.join(repoRoot, workerDir),
      encoding: 'utf8',
      input: value,
      env: { ...process.env, CI: 'true' },
      shell: process.platform === 'win32',
    },
  );
  if ((r.status ?? 1) !== 0) {
    process.stderr.write(r.stderr || r.stdout || '');
    die(`自愈 secret put INTERNAL_FORWARD_SECRET @ ${workerDir} 失败（exit ${r.status}）`, {
      step: 'heal_put_internal_forward',
      context: { worker_dir: workerDir },
    });
  }
  console.log(`  ✓ ${workerDir} INTERNAL_FORWARD_SECRET 已同步`);
}

/** Cloudflare 常见错码 → kind / cause / action（不打明文） */
function explainCfError(code) {
  const n = Number(code);
  switch (n) {
    case 10000:
      return {
        kind: 'AUTH_OR_2FA_BLOCKED',
        cause: 'Authentication error：Token/Key 不被接受（截断、吊销、或 Global Key+2FA）。',
        action:
          '建 Scoped Token（Edit Cloudflare Workers + Pages Edit）替换 CLOUDFLARE_API_TOKEN；或重跑 Debug Cloudflare auth step。',
      };
    case 9103:
      return {
        kind: 'X_AUTH_HEADER_REJECTED',
        cause: 'X-Auth-Email / X-Auth-Key 被拒（EMAIL 与注册邮箱不一致或 Key 错）。',
        action: '核对 CLOUDFLARE_EMAIL；或改用 Scoped Token。',
      };
    case 9109:
      return {
        kind: 'BEARER_TOKEN_REJECTED',
        cause: 'Bearer Token 无效（Global Key 误走 Bearer，或 Scoped Token 被截断）。',
        action: '整段重粘 CLOUDFLARE_API_TOKEN；Global Key 须配 EMAIL 走 X-Auth 头。',
      };
    case 10001:
      return {
        kind: 'ACCOUNT_NOT_FOUND',
        cause: 'Account ID 在 Cloudflare 找不到或不属于该 Token。',
        action: '核对 CLOUDFLARE_ACCOUNT_ID；或清空 Secret 让 bootstrap 写回 state.account_id。',
      };
    case 1004:
    case 7003:
      return {
        kind: 'NO_PERMISSION_OR_ROUTE',
        cause: '无 Pages Edit 权限，或 Account ID 空导致路由 /accounts//pages/...。',
        action: 'Token 加 Account → Cloudflare Pages → Edit；确认 prepare 已恢复 ACCOUNT_ID。',
      };
    case 8000007:
      return {
        kind: 'PAGES_PROJECT_NOT_FOUND',
        cause: 'Pages 项目名不存在（bootstrap 建项目失败或名字不一致）。',
        action: '核对 state.PAGES_PROJECT_NAME 与控制台项目名；重跑 Bootstrap job。',
      };
    case 8000066:
      return {
        kind: 'PAGES_FAIL_OPEN_MISMATCH',
        cause:
          'production 与 preview 的 fail_open 必须相同（Cloudflare Pages API 硬约束）。',
        action:
          '本脚本应已对齐两端；若仍失败，核对 Dashboard → Pages → Settings 里 placement/fail_open，或贴完整 FAIL 日志。',
      };
    default:
      return {
        kind: code != null && code !== '' ? `CF_${code}` : 'UNKNOWN',
        cause: 'Cloudflare API 返回失败（见下方 raw errors）。',
        action: '把本段日志（含 step / cf_code / http_status）贴给协作者改脚本或查 Dashboard。',
      };
  }
}

/**
 * 结构化失败报告 → stderr + ::error::（GHA 注解）
 * @param {{
 *   step: string,
 *   message: string,
 *   httpStatus?: number | null,
 *   cfCode?: string | number | null,
 *   cfErrors?: unknown,
 *   context?: Record<string, string | boolean | number | undefined | null>,
 * }} info
 */
function failReport(info) {
  const explained = explainCfError(info.cfCode);
  const lines = [
    '',
    '════ CI FAIL · ci-patch-pages-bindings ════',
    `  step        = ${info.step}`,
    `  message     = ${info.message}`,
    `  http_status = ${info.httpStatus ?? '(n/a)'}`,
    `  cf_code     = ${info.cfCode ?? '(n/a)'}`,
    `  kind        = ${explained.kind}`,
    `  cause       = ${explained.cause}`,
    `  action      = ${explained.action}`,
  ];
  if (info.context && Object.keys(info.context).length) {
    lines.push('  ── context（无密钥明文）──');
    for (const [k, v] of Object.entries(info.context)) {
      if (v === undefined || v === null || v === '') continue;
      lines.push(`  ${k.padEnd(14)} = ${v}`);
    }
  }
  if (info.cfErrors != null) {
    let raw = '';
    try {
      raw = JSON.stringify(info.cfErrors);
    } catch {
      raw = String(info.cfErrors);
    }
    // 截断防刷屏；仍足够定位 code/message
    lines.push(`  raw_errors  = ${raw.slice(0, 800)}`);
  }
  lines.push('════ end FAIL ════');
  lines.push('');
  const block = lines.join('\n');
  console.error(block);
  // GitHub Actions 注解：摘要一行，详情在上方 block
  const summary = `[ci-patch-pages] ${explained.kind} step=${info.step} cf_code=${info.cfCode ?? 'n/a'} http=${info.httpStatus ?? 'n/a'} — ${explained.action}`;
  console.error(`::error::${summary}`);
  process.exit(2);
}

function die(msg, extra = {}) {
  failReport({
    step: extra.step || 'preflight',
    message: msg,
    httpStatus: extra.httpStatus ?? null,
    cfCode: extra.cfCode ?? null,
    cfErrors: extra.cfErrors,
    context: extra.context,
  });
}

async function main() {
  try {
    prepareCfEnvForWrangler({ requireAccountId: true });
  } catch (err) {
    die(`prepare env 失败：${err?.message || err}`, {
      step: 'prepareCfEnvForWrangler',
      context: { state_path: path.relative(repoRoot, statePath) },
    });
  }

  if (!fs.existsSync(statePath)) {
    die(`状态文件不存在：${statePath}`, { step: 'read_state' });
  }
  let state;
  try {
    state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch (err) {
    die(`解析 state 失败：${err?.message || err}`, { step: 'parse_state' });
  }

  const accountId = (process.env.CLOUDFLARE_ACCOUNT_ID || state.account_id || '').trim();
  const token = process.env.CLOUDFLARE_API_TOKEN || '';
  const apiKey = process.env.CLOUDFLARE_API_KEY || process.env.CLOUDFLARE_GLOBAL_API_KEY || '';
  const email = process.env.CLOUDFLARE_EMAIL || '';

  const authMode = token ? 'api_token' : apiKey && email ? 'global_key' : 'none';
  const baseCtx = {
    auth_mode: authMode,
    account_sha8: sha8(accountId),
    token_sha8: token ? sha8(token) : '(absent)',
    api_key: apiKey ? `present sha8=${sha8(apiKey)}` : 'absent',
    email: email ? `present sha8=${sha8(email)}` : 'absent',
    pages_project: state.PAGES_PROJECT_NAME || '(missing)',
    worker_a: state.WORKER_A_NAME || '(missing)',
    worker_b: state.WORKER_B_NAME || '(missing)',
    has_worker_b_url: Boolean(state.urls?.worker_b_url),
    state_kv: state.kv?.STATE_KV ? `present sha8=${sha8(state.kv.STATE_KV)}` : 'missing',
    has_ifs: Boolean(state.secrets?.INTERNAL_FORWARD_SECRET),
    skip_secret_put: Boolean(state.skip_secret_put),
  };

  if (!accountId) {
    die('缺少 CLOUDFLARE_ACCOUNT_ID / state.account_id，无法 PATCH Pages 绑定', {
      step: 'preflight_account_id',
      context: baseCtx,
    });
  }

  /** @type {Record<string, string>} */
  let authHeaders;
  if (token) {
    authHeaders = { Authorization: `Bearer ${token}` };
  } else if (apiKey && email) {
    authHeaders = { 'X-Auth-Email': email, 'X-Auth-Key': apiKey };
  } else {
    die('缺少鉴权：需 CLOUDFLARE_API_TOKEN，或 CLOUDFLARE_GLOBAL_API_KEY + CLOUDFLARE_EMAIL', {
      step: 'preflight_auth',
      context: baseCtx,
    });
  }

  const projectName = state.PAGES_PROJECT_NAME;
  const workerBUrl = state.urls?.worker_b_url;
  const workerAName = state.WORKER_A_NAME;
  const workerBName = state.WORKER_B_NAME;
  const stateKvId = state.kv?.STATE_KV;
  const internalForwardSecret = state.secrets?.INTERNAL_FORWARD_SECRET;
  const registryUrl = (
    process.env.REGISTRY_URL ||
    state.REGISTRY_URL ||
    'https://hailuo-registry.allovo.eu.org'
  )
    .trim()
    .replace(/\/+$/, '');
  const preserveSecrets = state.skip_secret_put || state.secrets_mode === 'preserve_existing';

  if (!projectName || !workerBUrl || !workerAName || !stateKvId) {
    die('状态文件缺少 Pages 绑定所需字段（urls / kv / WORKER_A_NAME）', {
      step: 'preflight_state_fields',
      context: {
        ...baseCtx,
        missing: [
          !projectName && 'PAGES_PROJECT_NAME',
          !workerBUrl && 'urls.worker_b_url',
          !workerAName && 'WORKER_A_NAME',
          !stateKvId && 'kv.STATE_KV',
        ]
          .filter(Boolean)
          .join(','),
      },
    });
  }
  if (!preserveSecrets && !internalForwardSecret) {
    die('状态文件缺少 INTERNAL_FORWARD_SECRET（首次部署必须有）', {
      step: 'preflight_internal_forward_secret',
      context: baseCtx,
    });
  }

  /**
   * @param {string} apiPath
   * @param {RequestInit} [init]
   * @param {string} stepLabel
   */
  async function cf(apiPath, init = {}, stepLabel = apiPath) {
    let res;
    try {
      res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}${apiPath}`, {
        ...init,
        headers: {
          ...authHeaders,
          'Content-Type': 'application/json',
          ...(init.headers || {}),
        },
      });
    } catch (err) {
      die(`fetch 网络异常：${err?.message || err}`, {
        step: stepLabel,
        context: { ...baseCtx, api_path: apiPath },
      });
    }

    let data;
    try {
      data = await res.json();
    } catch (err) {
      die(`响应非 JSON（HTTP ${res.status}）：${err?.message || err}`, {
        step: stepLabel,
        httpStatus: res.status,
        context: { ...baseCtx, api_path: apiPath },
      });
    }

    if (!data.success) {
      const first = Array.isArray(data.errors) && data.errors[0] ? data.errors[0] : null;
      const cfCode = first?.code ?? data.errors?.[0]?.code ?? null;
      die(first?.message || `Cloudflare API 失败 HTTP ${res.status}`, {
        step: stepLabel,
        httpStatus: res.status,
        cfCode,
        cfErrors: data.errors || data,
        context: { ...baseCtx, api_path: apiPath, method: init.method || 'GET' },
      });
    }
    return data.result;
  }

  console.log(`  → PATCH Pages project=${projectName}`);
  console.log(
    `  · auth=${authMode} account_sha8=${sha8(accountId)} worker_a=${workerAName} state_kv=sha8=${sha8(stateKvId)}`,
  );

  const getStep = `GET /pages/projects/${projectName}`;
  const project = await cf(
    `/pages/projects/${encodeURIComponent(projectName)}`,
    {},
    getStep,
  );
  const prod = project.deployment_configs?.production ?? {};
  const preview = project.deployment_configs?.preview ?? {};
  // 先剥掉无 value 的 secret_text，避免 PATCH 把线上密钥清空
  const envVars = stripRedactedSecretEnvVars(prod.env_vars ?? {});
  const services = { ...(prod.services ?? {}) };
  const kvNamespaces = { ...(prod.kv_namespaces ?? {}) };
  const pagesHasIfs = Boolean(prod.env_vars?.INTERNAL_FORWARD_SECRET);

  // CF 8000066：production / preview 的 fail_open 必须字面相等；只 PATCH production 会踩坑
  const failOpen = resolveAlignedFailOpen(prod, preview);

  envVars.PUBLIC_WORKER_B_URL = { type: 'plain_text', value: workerBUrl };
  delete envVars.PUBLIC_HAILUO_ENDPOINT;

  const ifsFromState =
    typeof internalForwardSecret === 'string' && internalForwardSecret.trim()
      ? internalForwardSecret.trim()
      : '';

  if (ifsFromState) {
    envVars.INTERNAL_FORWARD_SECRET = { type: 'secret_text', value: ifsFromState };
    console.log(`  · 写入 INTERNAL_FORWARD_SECRET（来自 state）sha8=${sha8(ifsFromState)}`);
  } else if (pagesHasIfs) {
    // 键已存在于线上；已从 envVars 剥离脱敏 stub，省略即保留
    console.log(
      '升级模式：Pages 已有 INTERNAL_FORWARD_SECRET；PATCH 省略该键以保留（勿回写无值 secret_text）',
    );
  } else {
    // 升级 skip_secret_put 且 Pages 从未写入 IFS → 登录必 503；仅自愈此键，不轮换 JWT/Ed25519
    const healed = randomBytes(32).toString('hex');
    console.log(
      `  · Pages 缺 INTERNAL_FORWARD_SECRET → 自愈生成并同步 Worker A/B/Pages sha8=${sha8(healed)}`,
    );
    putWorkerInternalForwardSecret('apps/worker-a', healed);
    putWorkerInternalForwardSecret('apps/worker-b', healed);
    envVars.INTERNAL_FORWARD_SECRET = { type: 'secret_text', value: healed };
    try {
      if (!state.secrets || typeof state.secrets !== 'object') state.secrets = {};
      state.secrets.INTERNAL_FORWARD_SECRET = healed;
      fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');
    } catch (err) {
      console.warn(
        `[ci-patch-pages] 写回 state.secrets.INTERNAL_FORWARD_SECRET 失败（继续）：${err?.message || err}`,
      );
    }
  }

  if (registryUrl) {
    envVars.PUBLIC_REGISTRY_URL = { type: 'secret_text', value: registryUrl };
  }
  services.WORKER_A = { service: workerAName, environment: 'production' };
  if (workerBName) {
    services.WORKER_B = { service: workerBName, environment: 'production' };
  }
  kvNamespaces.STATE_KV = { namespace_id: stateKvId };

  console.log(`  · fail_open 对齐 production=preview=${failOpen}`);

  const patchStep = `PATCH /pages/projects/${projectName} (bindings)`;
  await cf(
    `/pages/projects/${encodeURIComponent(projectName)}`,
    {
      method: 'PATCH',
      body: JSON.stringify({
        deployment_configs: {
          // 保留既有 preview 等其它配置；两端显式写同一 fail_open（修 CF 8000066）
          ...project.deployment_configs,
          production: {
            ...prod,
            env_vars: envVars,
            services,
            kv_namespaces: kvNamespaces,
            fail_open: failOpen,
          },
          preview: {
            ...preview,
            fail_open: failOpen,
          },
        },
      }),
    },
    patchStep,
  );

  console.log(
    'Pages Production 绑定 PATCH 成功（PUBLIC_WORKER_B_URL / PUBLIC_REGISTRY_URL / WORKER_A / WORKER_B / STATE_KV）',
  );
  console.log(
    `  · 将写入：WORKER_A=${workerAName} WORKER_B=${workerBName || '(skip)'} STATE_KV=sha8=${sha8(stateKvId)} registry=${registryUrl}`,
  );
}

/**
 * Cloudflare Pages：fail_open 在 production / preview 必须相同（error 8000066）。
 * 优先沿用已有布尔；都没有则 false（配置无法应用时 fail-closed，更安全）。
 * @param {{ fail_open?: unknown }} prod
 * @param {{ fail_open?: unknown }} preview
 */
function resolveAlignedFailOpen(prod, preview) {
  if (typeof prod?.fail_open === 'boolean') return prod.fail_open;
  if (typeof preview?.fail_open === 'boolean') return preview.fail_open;
  return false;
}

main().catch((err) => {
  failReport({
    step: 'uncaught',
    message: err?.message || String(err),
    cfErrors: err?.stack ? { stack: String(err.stack).slice(0, 600) } : undefined,
  });
});
