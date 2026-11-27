/**
 * M8-12/13 · CI / Workers Builds 一键部署 · 资源创建 + wrangler.toml 回填
 *
 * 在 CI 中：
 * 1. 解析稳定部署身份（同账号同槽位 → 同组码 / Worker / Pages 名；避免重复建库）
 * 2. 生成密钥（或读 WORKER_SECRETS_JSON；升级且 Worker 已存在则跳过覆盖）
 * 3. 幂等创建 6 个 D1 + 3 个 KV
 * 4. 回填 A/B wrangler.toml 的 [env.production]（name / database_id / id / service / vars）
 * 4b. 可选 R2：探测/创建 hailuo-node-media-* 并临时绑 HAILUO_IMAGE_R2；失败只记 state.r2，不中断
 * 5. 写出 .ci-deploy-state.json（供后续步骤读；含密钥，勿入库）
 *
 * 前置环境变量：
 *   CLOUDFLARE_API_TOKEN
 *   CLOUDFLARE_ACCOUNT_ID（可省略，由 ci-ensure-cf-credentials 探测）
 *
 * 可选：
 *   WORKER_SECRETS_JSON / CI_DEPLOY_IDENTITY_JSON / HAILUO_NODE_SLOT
 *   CI_DEPLOY_STATE_PATH / SKIP_CREATE / FORCE_PUT_SECRETS
 *
 * 运行：node scripts/ci-bootstrap-resources.mjs
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureCloudflareCredentials, adaptWranglerAuthForGlobalKey } from './ci-ensure-cf-credentials.mjs';
import { r2DeployState, safeEnsureOptionalR2 } from './ci-optional-r2.mjs';
import { resolveCiIdentity } from './ci-stable-identity.mjs';
import { stripEnvAnalyticsEngineDatasets } from './patch-wrangler-toml.mjs';
import { assertEd25519KeyPairConsistent } from './lib/ed25519-key-consistency.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// wrangler-鉴权适配：详见 ci-ensure-cf-credentials.mjs 的 adaptWranglerAuthForGlobalKey
adaptWranglerAuthForGlobalKey();
const repoRoot = path.resolve(__dirname, '..');
const statePath =
  process.env.CI_DEPLOY_STATE_PATH ||
  path.join(repoRoot, 'scripts', '.ci-deploy-state.json');

function die(msg, code = 2) {
  const err = new Error(msg);
  err.exitCode = code;
  throw err;
}

function runNode(scriptRel) {
  const r = spawnSync(process.execPath, [path.join(repoRoot, scriptRel)], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: process.env,
  });
  if (r.status !== 0) {
    die(`${scriptRel} 失败：${r.stderr || r.stdout || `exit ${r.status}`}`);
  }
  return (r.stdout || '').trim();
}

function runWrangler(args, { cwd = repoRoot } = {}) {
  const bin = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  // 关键：必须显式锁 wrangler@3.114.17 —— wrangler 4.x 要求 Node.js >= 22，
  // CI runner 是 Node 20（actions/setup-node@v5 node-version:'20'），
  // 装 wrangler@latest（4.x）会直接报 "Wrangler requires at least Node.js v22.0.0"
  // 并把任何 API 调用降级为 7003 "Could not route to /accounts//pages/projects"。
  const r = spawnSync(bin, ['--yes', 'wrangler@3.114.17', ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, CI: 'true' },
    shell: process.platform === 'win32',
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  return { status: r.status ?? 1, out };
}

function parseD1Id(out) {
  const m =
    out.match(/database_id\s*=\s*"([0-9a-f-]{36})"/i) ||
    out.match(/"database_id"\s*:\s*"([0-9a-f-]{36})"/i) ||
    out.match(/\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i);
  return m ? m[1] : null;
}

function parseKvId(out) {
  const m =
    out.match(/id\s*=\s*"([0-9a-f]{32})"/i) ||
    out.match(/"id"\s*:\s*"([0-9a-f]{32})"/i);
  return m ? m[1] : null;
}

/**
 * 失败即停：返回 [] 会被 findOrCreateD1 当成「账号里没有这个库」→ 误建新空库。
 * 重复部署绝不能让节点悄悄切到空库，所以列不出来就中止部署。
 */
function listD1() {
  const r = runWrangler(['d1', 'list', '--json'], {
    cwd: path.join(repoRoot, 'apps', 'worker-a'),
  });
  if (r.status !== 0) {
    die(
      `列举 D1 失败（wrangler exit=${r.status}）：${r.out.slice(0, 400)}\n` +
        '为避免在已有节点上误建空库，已停止部署；请确认 Token 有 D1:Read 权限后重跑。',
    );
  }
  try {
    const start = r.out.indexOf('[');
    const end = r.out.lastIndexOf(']');
    if (start < 0 || end < start) {
      die(`列举 D1 输出无法解析（找不到 JSON 数组）：${r.out.slice(0, 400)}`);
    }
    return JSON.parse(r.out.slice(start, end + 1));
  } catch (e) {
    die(`列举 D1 JSON 解析失败：${e.message?.slice(0, 200)} output=${r.out.slice(0, 300)}`);
  }
}

function listKv() {
  // 优先 Cloudflare API v4 + curl（跨 wrangler 版本稳定）。
  // 只有 API 明确失败时才兜底 wrangler；两条都失败就停——绝不在「不知道有没有旧 KV」时创建，
  // 否则重复部署可能新建一个同名空 KV 并切过去，看起来就是数据丢了。
  const api = listKvSync();
  if (api.ok) return api.items;

  console.log('  [listKv] API 列举失败 → 兜底 wrangler kv namespace list --json');
  const r = runWrangler(['kv', 'namespace', 'list', '--json'], {
    cwd: path.join(repoRoot, 'apps', 'worker-a'),
  });
  console.log(`  [listKv] wrangler list exit=${r.status} out_len=${r.out.length}`);
  if (r.status !== 0) {
    die(
      `列举 KV 失败（API + wrangler 均失败）：${(r.stderr || r.out || '').slice(0, 400)}\n` +
        '为避免在已有节点上误建空 KV，已停止部署；请确认 Token 有 Workers KV Storage:Read 权限后重跑。',
    );
  }
  try {
    const start = r.out.indexOf('[');
    const end = r.out.lastIndexOf(']');
    if (start < 0 || end < start) {
      die(`列举 KV 输出无法解析（找不到 JSON 数组）：${r.out.slice(0, 300)}`);
    }
    return JSON.parse(r.out.slice(start, end + 1));
  } catch (e) {
    die(`列举 KV JSON 解析失败：${e.message?.slice(0, 200)}`);
  }
}

/**
 * 同步列 KV namespaces：用 curl + 适配后的鉴权头。
 * 返回 { ok, items }：ok=true 表示「云端明确回答」（items 可能为空数组）；
 * ok=false 表示查询失败，调用方不得据此创建新资源。
 */
function listKvSync() {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  const apiKey = process.env.CLOUDFLARE_GLOBAL_API_KEY;
  const email = process.env.CLOUDFLARE_EMAIL;
  if (!accountId) {
    console.log('  [listKvSync] CLOUDFLARE_ACCOUNT_ID 未设，跳过');
    return { ok: false, items: [] };
  }
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces?per_page=100`;
  let headerArgs = [];
  let authMode = 'none';
  if (apiToken) {
    authMode = 'bearer';
    headerArgs = ['-H', `Authorization: Bearer ${apiToken}`];
  } else if (apiKey && email) {
    authMode = 'global_key';
    headerArgs = ['-H', `X-Auth-Email: ${email}`, '-H', `X-Auth-Key: ${apiKey}`];
  } else {
    console.log('  [listKvSync] 无可用鉴权（TOKEN / KEY+EMAIL 均空），跳过');
    return { ok: false, items: [] };
  }
  const curlArgs = ['-sS', '-w', '\n%{http_code}', '-H', 'Content-Type: application/json', ...headerArgs, url];
  console.log(`  [listKvSync] auth=${authMode} GET ${url.replace(accountId, '***')}`);
  const r = spawnSync('curl', curlArgs, {
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  // 关键：Node spawnSync 无 .out 字段，必须显式合并 stdout + stderr
  // 之前直接读 r.out 在 Linux runner 上 100% TypeError：Cannot read properties of undefined
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  if (r.status !== 0) {
    console.log(`  [listKvSync] curl exit=${r.status} stderr=${(r.stderr || '').slice(0, 300)}`);
    return { ok: false, items: [] };
  }
  // curl -w 末尾会追加 HTTP status code（用 \n 分隔）
  const lastNewline = out.lastIndexOf('\n');
  const body = lastNewline > 0 ? out.slice(0, lastNewline) : out;
  const statusLine = (lastNewline > 0 ? out.slice(lastNewline + 1) : '').trim();
  console.log(`  [listKvSync] HTTP ${statusLine} body_len=${body.length}`);
  try {
    const parsed = JSON.parse(body);
    if (!parsed.success || !Array.isArray(parsed.result)) {
      console.log(`  [listKvSync] API 返回 success=false 或 result 非数组：${body.slice(0, 300)}`);
      return { ok: false, items: [] };
    }
    console.log(`  [listKvSync] 解析成功，${parsed.result.length} 个 KV namespace`);
    if (parsed.result.length > 0) {
      console.log(`  [listKvSync] 前 3 个 title：${parsed.result.slice(0, 3).map((k) => k.title).join(' | ')}`);
    }
    return { ok: true, items: parsed.result.map((k) => ({ id: k.id, title: k.title })) };
  } catch (e) {
    console.log(`  [listKvSync] JSON.parse 失败：${e.message.slice(0, 200)} body[:300]=${body.slice(0, 300)}`);
    return { ok: false, items: [] };
  }
}

function findOrCreateD1(name) {
  const existing = listD1().find((d) => d.name === name || d.database_name === name);
  if (existing?.uuid || existing?.id) {
    const id = existing.uuid || existing.id;
    console.log(`  reuse D1  ${name} → ${id}`);
    return id;
  }
  if (process.env.SKIP_CREATE === '1') {
    die(`D1 ${name} 不存在且 SKIP_CREATE=1`);
  }
  console.log(`  create D1 ${name} …`);
  const r = runWrangler(['d1', 'create', name], {
    cwd: path.join(repoRoot, 'apps', 'worker-a'),
  });
  const id = parseD1Id(r.out);
  if (!id) {
    die(`创建 D1 ${name} 失败，无法解析 database_id：\n${r.out.slice(0, 800)}`);
  }
  console.log(`  ✓ D1     ${name} → ${id}`);
  return id;
}

/**
 * 直走 Cloudflare API 创建 KV（title 原样，不拼 Worker 名）。
 *
 * 踩坑：在 apps/worker-a 下 `wrangler kv namespace create X` 会读当时 toml 的
 * `name`（bootstrap 早期还是 hailuo-worker-a-prod-placeholder），拼成
 * `hailuo-worker-a-prod-placeholder-X`。Dashboard 显示难看且**不可改名**；
 * 重部署只会 reuse ID，不会改 title。
 */
function createKvViaApi(title) {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  const apiKey = process.env.CLOUDFLARE_GLOBAL_API_KEY;
  const email = process.env.CLOUDFLARE_EMAIL;
  if (!accountId) return null;

  /** @type {string[]} */
  let headerArgs = [];
  if (apiToken) {
    headerArgs = ['-H', `Authorization: Bearer ${apiToken}`];
  } else if (apiKey && email) {
    headerArgs = ['-H', `X-Auth-Email: ${email}`, '-H', `X-Auth-Key: ${apiKey}`];
  } else {
    return null;
  }

  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces`;
  const body = JSON.stringify({ title });
  const curlArgs = [
    '-sS',
    '-w',
    '\n%{http_code}',
    '-X',
    'POST',
    '-H',
    'Content-Type: application/json',
    ...headerArgs,
    '--data',
    body,
    url,
  ];
  console.log(`  [createKvViaApi] POST title=${title}`);
  const r = spawnSync('curl', curlArgs, {
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  if (r.status !== 0) {
    console.log(`  [createKvViaApi] curl exit=${r.status} ${(r.stderr || '').slice(0, 200)}`);
    return null;
  }
  const lastNewline = out.lastIndexOf('\n');
  const respBody = lastNewline > 0 ? out.slice(0, lastNewline) : out;
  const statusLine = (lastNewline > 0 ? out.slice(lastNewline + 1) : '').trim();
  try {
    const parsed = JSON.parse(respBody);
    if (!parsed.success || !parsed.result?.id) {
      console.log(
        `  [createKvViaApi] HTTP ${statusLine} success=false：${respBody.slice(0, 400)}`,
      );
      return null;
    }
    return String(parsed.result.id);
  } catch (e) {
    console.log(
      `  [createKvViaApi] JSON 失败：${e.message?.slice(0, 120)} body=${respBody.slice(0, 200)}`,
    );
    return null;
  }
}

/**
 * @param {string} title 规范名（新建用）
 * @param {string[]} [aliases] 历史同义名（只 reuse，不新建）——CF 不可改名
 */
function findOrCreateKv(title, aliases = []) {
  // 只信云端 list（按 title/alias），**禁止**盲 reuse state/token 里的旧 uuid。
  // 本地 bootstrap 曾「cloud list miss, keep local id」→ Worker deploy 10041（KV not found）；
  // CI 路径必须永远 list-first；找不到就 create（或 SKIP_CREATE=1 时 die）。
  // 匹配规则（优先级从高到低）：
  // 1. 精确匹配规范名
  // 2. 精确匹配 aliases（如 posts-cache → posts-cache-kv 改名后的旧短名）
  // 3. endsWith 匹配：容忍历史 wrangler 拼的 prod-placeholder 长前缀
  const all = listKv();
  const names = [title, ...aliases].filter(Boolean);
  const exactCanonical = all.find((k) => k.title === title || k.name === title);
  const exactAlias = all.find((k) =>
    aliases.some((a) => a && (k.title === a || k.name === a)),
  );
  const prefixMatched = all.find(
    (k) => k.title && names.some((n) => k.title === n || k.title.endsWith(`-${n}`)),
  );
  const existing = exactCanonical || exactAlias || prefixMatched;
  if (existing?.id) {
    const matchedTitle = existing.title || existing.name;
    if (matchedTitle !== title) {
      console.log(
        `  reuse KV  ${title} → ${existing.id}（Dashboard 名仍是：${matchedTitle}）`,
      );
      console.log(
        '    说明：Cloudflare KV namespace 创建后不可改名；重部署只复用 ID。' +
          '若只要规范短名，需手工删掉旧名 KV 再跑 Bootstrap（会丢该 KV 数据）。',
      );
    } else {
      console.log(`  reuse KV  ${title} → ${existing.id}`);
    }
    return existing.id;
  }
  if (process.env.SKIP_CREATE === '1') {
    die(`KV ${title} 不存在且 SKIP_CREATE=1`);
  }
  console.log(`  create KV ${title} …（直走 API，避免 wrangler 拼 prod-placeholder 前缀）`);
  let id = createKvViaApi(title);
  if (!id) {
    console.warn('  ⚠ API 创建失败，回落 wrangler（可能仍带 worker 名前缀）');
    const r = runWrangler(['kv', 'namespace', 'create', title], {
      cwd: path.join(repoRoot, 'apps', 'worker-a'),
    });
    id = parseKvId(r.out);
    if (!id) {
      die(`创建 KV ${title} 失败，无法解析 id：\n${r.out.slice(0, 800)}`);
    }
  }
  console.log(`  ✓ KV     ${title} → ${id}`);
  return id;
}

/**
 * 列 Pages projects：用 Cloudflare API v4 直查（同 listKvSync 风格，跨 wrangler 版本稳定）
 * 返回 [{id, name, ...}] 形态，find 时按 .name 比对。
 */
function listPagesProjects() {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  const apiKey = process.env.CLOUDFLARE_GLOBAL_API_KEY;
  const email = process.env.CLOUDFLARE_EMAIL;
  if (!accountId) return [];
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/pages/projects?per_page=100`;
  let headerArgs = [];
  if (apiToken) {
    headerArgs = ['-H', `Authorization: Bearer ${apiToken}`];
  } else if (apiKey && email) {
    headerArgs = ['-H', `X-Auth-Email: ${email}`, '-H', `X-Auth-Key: ${apiKey}`];
  } else {
    return [];
  }
  const curlArgs = ['-sS', '-w', '\n%{http_code}', '-H', 'Content-Type: application/json', ...headerArgs, url];
  const r = spawnSync('curl', curlArgs, {
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  // 关键：spawnSync 无 .out 字段，必须显式合并 stdout + stderr
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  if (r.status !== 0) return [];
  const lastNewline = out.lastIndexOf('\n');
  const body = lastNewline > 0 ? out.slice(0, lastNewline) : out;
  try {
    const parsed = JSON.parse(body);
    if (!parsed.success || !Array.isArray(parsed.result)) return [];
    return parsed.result;
  } catch {
    return [];
  }
}

/**
 * 创建 Pages project：直接走 Cloudflare REST API（绕过 wrangler CLI）。
 * 原因：wrangler `pages project create` 在 Global Key 鉴权模式下，
 *       CI runner 上会因 ~/.wrangler/config/default.toml 无 account_id
 *       而报 code 7003 "/accounts//pages/projects"。改用 curl 直走 API
 *       后，与 listKv/listPages 同一鉴权路径，跨 wrangler 版本稳定。
 *
 * 返回值：
 *   { ok: true, existed: boolean, id?: string }
 *   { ok: false, error: string } —— 不 throw，让 findOrCreatePagesProject 走回捞
 */
function createPagesProjectByApi(name, productionBranch) {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  const apiKey = process.env.CLOUDFLARE_GLOBAL_API_KEY;
  const email = process.env.CLOUDFLARE_EMAIL;
  if (!accountId) return { ok: false, error: 'CLOUDFLARE_ACCOUNT_ID 未设置' };

  let headerArgs = [];
  if (apiToken) {
    headerArgs = ['-H', `Authorization: Bearer ${apiToken}`];
  } else if (apiKey && email) {
    headerArgs = ['-H', `X-Auth-Email: ${email}`, '-H', `X-Auth-Key: ${apiKey}`];
  } else {
    return { ok: false, error: '无鉴权凭证' };
  }
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/pages/projects`;
  const body = JSON.stringify({ name, production_branch: productionBranch });
  const curlArgs = [
    '-sS', '-w', '\n%{http_code}',
    '-X', 'POST',
    '-H', 'Content-Type: application/json',
    ...headerArgs,
    '-d', body,
    url,
  ];
  console.log(`  [createPagesApi] POST ${url.replace(accountId, '***')} name=${name}`);
  const r = spawnSync('curl', curlArgs, {
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  if (r.status !== 0) {
    return { ok: false, error: `curl exit ${r.status}: ${(r.stderr || '').slice(0, 300)}` };
  }
  const lastNewline = out.lastIndexOf('\n');
  const respBody = lastNewline > 0 ? out.slice(0, lastNewline) : out;
  const httpStatus = (lastNewline > 0 ? out.slice(lastNewline + 1) : '').trim();
  console.log(`  [createPagesApi] HTTP ${httpStatus} body_len=${respBody.length}`);
  let parsed;
  try {
    parsed = JSON.parse(respBody);
  } catch (e) {
    return { ok: false, error: `响应非 JSON：${respBody.slice(0, 300)}` };
  }
  if (parsed.success) {
    return { ok: true, existed: false, id: parsed.result?.id };
  }
  const firstErr = parsed.errors?.[0] ?? {};
  const code = firstErr.code;
  const msg = firstErr.message ?? 'unknown';
  // 已知"项目已存在"：Cloudflare 返回 8000021 / "Project already exists" 类
  // 注意：409 duplicate 响应里 parsed.result 可能是 null，所以 id 取空
  // findOrCreatePagesProject 会在 existed=true 时直接 GET /pages/projects/{name} 捞 id
  const isDuplicate = code === 8000021 || /already\s*exists|already\s*created/i.test(msg);
  if (isDuplicate) {
    return { ok: true, existed: true, id: null };
  }
  return { ok: false, error: `API ${httpStatus} code ${code}: ${msg}` };
}

/**
 * 直接按 name GET 单个 Pages project（不走 list + filter 兜底）。
 * 当 create 返回 409 duplicate 时调这个，绕 listPagesProjects 的权限/pagination 问题。
 */
function getPagesProjectByName(name) {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  const apiKey = process.env.CLOUDFLARE_GLOBAL_API_KEY;
  const email = process.env.CLOUDFLARE_EMAIL;
  if (!accountId) return null;
  let headerArgs = [];
  if (apiToken) {
    headerArgs = ['-H', `Authorization: Bearer ${apiToken}`];
  } else if (apiKey && email) {
    headerArgs = ['-H', `X-Auth-Email: ${email}`, '-H', `X-Auth-Key: ${apiKey}`];
  } else {
    return null;
  }
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/pages/projects/${name}`;
  const curlArgs = ['-sS', '-w', '\n%{http_code}', ...headerArgs, url];
  const r = spawnSync('curl', curlArgs, { encoding: 'utf8', shell: process.platform === 'win32' });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  if (r.status !== 0) return null;
  const lastNewline = out.lastIndexOf('\n');
  const body = lastNewline > 0 ? out.slice(0, lastNewline) : out;
  try {
    const p = JSON.parse(body);
    if (p.success && p.result) return p.result;
  } catch {}
  return null;
}

/**
 * 查找或创建 Pages project。
 * 顺序：
 *  1. listPagesProjects() 精确命中 → 复用
 *  2. createPagesProjectByApi()（直走 CF REST）→ 成功 / 已存在 → 走 ID 回捞
 *  3. 兜底 wrangler `pages project create`（兼容老 wrangler 版本无 API 路径时的回退）
 *  4. 三路解析 ID
 *  5. 全部失败 → 回退 name 字符串
 */
function findOrCreatePagesProject(name, productionBranch = 'main') {
  // 步骤 1：先查一次（避免重复创建 + 兼容"项目已存在"分支）
  const existing = listPagesProjects().find((p) => p.name === name);
  if (existing?.id) {
    console.log(`  reuse Pages ${name} → ${existing.id}`);
    return existing.id;
  }
  if (process.env.SKIP_CREATE === '1') {
    die(`Pages project ${name} 不存在且 SKIP_CREATE=1`);
  }

  // 步骤 2：直接调 Cloudflare REST API 创建（首选，鉴权路径稳定）
  console.log(`  create Pages ${name} …`);
  const apiResult = createPagesProjectByApi(name, productionBranch);
  if (apiResult.ok) {
    if (apiResult.id) {
      console.log(`  ✓ Pages  ${name} → ${apiResult.id}（API 返回 id）`);
      return apiResult.id;
    }
    if (apiResult.existed) {
      // 409 duplicate → 直接按 name GET 绕 list 权限问题
      const proj = getPagesProjectByName(name);
      if (proj?.id) {
        console.log(`  ✓ Pages  ${name} → ${proj.id}（duplicate 响应后直接 GET 命中）`);
        return proj.id;
      }
      console.log(`  Pages ${name} 已存在，GET 未命中，继续回捞 …`);
    } else {
      console.log(`  Pages ${name} 创建成功，尝试捞 ID …`);
    }
  } else {
    console.warn(`  ⚠ REST API create Pages 失败：${apiResult.error} → 兜底 wrangler CLI`);
    // 步骤 3：兜底 wrangler CLI（老 wrangler 版本或 API 缺权限时走这条）
    const r = runWrangler(['pages', 'project', 'create', name, '--production-branch', productionBranch]);
    const rawOut = `${r.stdout || ''}${r.stderr || ''}`;
    if (r.status === 0) {
      console.log(`  Pages ${name} 创建响应：${rawOut.slice(0, 200).replace(/\n/g, ' ')}`);
    } else {
      const isAlreadyExists = /8000021|10014|already\s*exists|already\s*created|conflict/i.test(rawOut) || r.status === 2;
      if (isAlreadyExists) {
        console.log(`  Pages ${name} wrangler 已存在分支，尝试捞 ID …`);
      } else {
        console.warn(`  ⚠ wrangler exit ${r.status}，原始输出：${rawOut.slice(0, 500)}`);
      }
    }
  }

  // 步骤 3：三路解析 ID（全部失败 → 回退 name string，deploy 用 --project-name 不依赖 ID）
  // 3a：先查一次 API
  {
    const apiHit = listPagesProjects().find((p) => p.name === name);
    if (apiHit?.id) {
      console.log(`  ✓ Pages  ${name} → ${apiHit.id}（API 查到）`);
      return apiHit.id;
    }
  }
  // 3b：wrangler pages project list（CLI 走不同 API 路径，可能绕过缓存）
  //     注：兜底用，可能同样撞 7003；listPagesProjects 已足够，但保留以防 list API 偶发缓存
  {
    const wrList = runWrangler(['pages', 'project', 'list']);
    const wrMatch = wrList.out.match(
      new RegExp(
        `\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b[\\s\\S]{0,300}?id\\s*[:=]\\s*["']?([a-f0-9]{32})`,
        'i',
      ),
    );
    if (wrMatch?.[1]) {
      console.log(`  ✓ Pages  ${name} → ${wrMatch[1]}（wrangler list 查到）`);
      return wrMatch[1];
    }
  }
  // 3c：等待 3 次重试（每次 2s）
  for (let retry = 1; retry <= 3; retry++) {
    const after = listPagesProjects().find((p) => p.name === name);
    if (after?.id) {
      console.log(`  ✓ Pages  ${name} → ${after.id}（重试 ${retry}/3 后 API 查到）`);
      return after.id;
    }
    console.log(`  [重试 ${retry}/3] 仍查不到 ID，等 2s …`);
    if (retry < 3) {
      const until = Date.now() + 2000;
      while (Date.now() < until) {} // busy wait
    }
  }

  // 步骤 4：所有方式都失败——wrangler 已说 created 或 already exists，项目确实存在
  // 回退：返回 name 字符串而非 ID。下游 ci-patch-pages-bindings.mjs / deploy-pages 用
  // --project-name "$PAGES_NAME" 不依赖 ID；wrangler deploy 内部会按名称查找已有 project。
  console.log(`  ⚠ Pages  ${name} 已存在但无法取 ID → 回退 name（deploy 用 --project-name 兜底）`);
  return name;
}

/** 回填 [env.production] 段内简单键（name / vars 下的 BOOTSTRAP_HANDLE 等） */
function patchSimpleKey(tomlPath, sectionKey, key, value) {
  let text = fs.readFileSync(tomlPath, 'utf8');
  const sectionEsc = sectionKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // 找 [env.production] 或 [env.production.vars]
  const re = new RegExp(
    `((?:^|\\n)[ \\t]*\\[${sectionEsc}\\][ \\t]*\\n)([\\s\\S]*?)(?=\\n[ \\t]*\\[|$)`,
  );
  const m = re.exec(text);
  if (!m) die(`TOML 段 [${sectionKey}] 不存在：${tomlPath}`);
  const body = m[2];
  const keyRe = new RegExp(`(^|\\n)([ \\t]*${key}[ \\t]*=[ \\t]*)"[^"]*"([ \\t]*)(?=\\n|$)`);
  const km = keyRe.exec(body);
  if (!km) die(`段 [${sectionKey}] 内找不到 ${key}=：${tomlPath}`);
  const newBody =
    body.slice(0, km.index + km[1].length) +
    `${km[2]}"${value}"${km[3]}` +
    body.slice(km.index + km[0].length);
  text = text.slice(0, m.index + m[1].length) + newBody + text.slice(m.index + m[0].length);
  fs.writeFileSync(tomlPath, text, 'utf8');
  console.log(`  set    [${sectionKey}] ${key} = "${value}"`);
}

function patchBinding(tomlRel, binding, value, { service = false } = {}) {
  const args = [
    path.join(repoRoot, 'scripts', 'patch-wrangler-toml.mjs'),
    '--toml',
    tomlRel,
    '--binding',
    binding,
    '--no-backup',
    '--force',
  ];
  if (service) args.push('--service', value);
  else args.push('--id', value);
  const r = spawnSync(process.execPath, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    env: process.env,
  });
  process.stdout.write(r.stdout || '');
  if (r.status !== 0) {
    process.stderr.write(r.stderr || '');
    die(`patch ${tomlRel} ${binding} 失败`);
  }
}

// ── main ────────────────────────────────────────────────────────────────────
let exitCode = 0;
let finalState = null; // 即使中途失败也要写出 state 供 artifact upload

async function main() {
try {
  const cf = await ensureCloudflareCredentials();
  process.env.CLOUDFLARE_ACCOUNT_ID = cf.accountId;
} catch (err) {
  die(err.message || String(err));
}

console.log('\n════ CI Bootstrap：解析稳定身份 ════\n');
let identity;
try {
  identity = resolveCiIdentity({
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
    slot: process.env.HAILUO_NODE_SLOT || '1',
    identityJson: process.env.CI_DEPLOY_IDENTITY_JSON || null,
  });
} catch (err) {
  die(err.message || String(err));
}
console.log(`  source = ${identity.identity_source}`);
console.log(`  slot   = ${identity.HAILUO_NODE_SLOT || process.env.HAILUO_NODE_SLOT || '1'}`);
console.log(`  group  = ${identity.DEPLOY_GROUP_CODE}`);
console.log(`  A name = ${identity.WORKER_A_NAME}`);
console.log(`  B name = ${identity.WORKER_B_NAME}`);
console.log(`  Pages  = ${identity.PAGES_PROJECT_NAME}`);
console.log(`  handle = ${identity.BOOTSTRAP_HANDLE}`);

/** CF API 鉴权头：Scoped Token 或 Global Key（与 ci-patch-pages 同口径） */
function cfAuthHeaders() {
  const token = (process.env.CLOUDFLARE_API_TOKEN || '').trim();
  if (token) return { Authorization: `Bearer ${token}` };
  const email = (process.env.CLOUDFLARE_EMAIL || '').trim();
  const key = (
    process.env.CLOUDFLARE_API_KEY ||
    process.env.CLOUDFLARE_GLOBAL_API_KEY ||
    ''
  ).trim();
  if (email && key) return { 'X-Auth-Email': email, 'X-Auth-Key': key };
  return null;
}

/**
 * 公开仓首次部署：全新 Cloudflare 账号通常还没有 workers.dev 子域。
 * wrangler 3 deploy 遇到 CF 10007 时在 CI 里会走 confirm(fallbackValue=false) → 直接 UserError 退出，
 * 所以 bootstrap 必须先确保子域存在，否则「填个 Token 就能部署」在空账号上走不通。
 * 名称不写进日志（Worker A 地址不公开，子域可反推 A 的 host 后缀）。
 */
function ensureWorkersDevSubdomain(groupCode) {
  const accountId = (process.env.CLOUDFLARE_ACCOUNT_ID || '').trim();
  const headers = cfAuthHeaders();
  if (!accountId || !headers) return;

  const baseUrl = `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers`;
  const call = (method, url, body) => {
    /** @type {string[]} */
    const headerArgs = [];
    for (const [k, v] of Object.entries(headers)) headerArgs.push('-H', `${k}: ${v}`);
    const args = [
      '-sS',
      '-w',
      '\n%{http_code}',
      '-X',
      method,
      '-H',
      'Content-Type: application/json',
      ...headerArgs,
    ];
    if (body !== undefined) args.push('--data', JSON.stringify(body));
    args.push(url);
    const r = spawnSync('curl', args, { encoding: 'utf8', shell: process.platform === 'win32' });
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    const lastNewline = out.lastIndexOf('\n');
    const respBody = lastNewline > 0 ? out.slice(0, lastNewline) : out;
    const statusLine = (lastNewline > 0 ? out.slice(lastNewline + 1) : '').trim();
    let parsed = null;
    try {
      parsed = JSON.parse(respBody);
    } catch {
      // 非 JSON 响应：保留 raw 供排障
    }
    return { curlExit: r.status, statusLine, parsed, raw: respBody };
  };

  const probe = call('GET', `${baseUrl}/subdomain`);
  if (probe.parsed?.success && probe.parsed.result?.subdomain) {
    console.log('  ✓ workers.dev 子域已存在（名称不打印）');
    return;
  }
  const probeCode = probe.parsed?.errors?.[0]?.code;
  if (probe.curlExit !== 0 || probeCode !== 10007) {
    // 不是明确的「未注册」：可能是权限/网络问题，也可能账号已有子域只是读不到。
    // 这里不阻断，交给 wrangler deploy 自己报准确错误（避免误杀本来能部署的账号）。
    console.log(
      `  ⚠ 无法确认 workers.dev 子域（HTTP ${probe.statusLine || '?'} / CF code=${probeCode ?? 'n/a'}）：${probe.raw.slice(0, 200)}`,
    );
    console.log('    → 跳过自动注册，交给 wrangler deploy 判断');
    return;
  }

  // 10007 = 该账号尚未注册；用稳定组码做候选名，被占用再换后缀
  const base = `hailuo-${String(groupCode || '')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '') || 'node'}`.slice(0, 50);
  const candidates = [base, `${base}-node`, `${base}-${Math.random().toString(36).slice(2, 6)}`];
  for (const name of candidates) {
    const res = call('PUT', `${baseUrl}/subdomain`, { subdomain: name });
    if (res.parsed?.success && res.parsed.result?.subdomain) {
      console.log('  ✓ 已为账号注册 workers.dev 子域（名称不打印）');
      return;
    }
    const code = res.parsed?.errors?.[0]?.code;
    if (code === 10031) continue; // 子域已被占用，换下一个候选
    die(
      `注册 workers.dev 子域失败（CF code=${code ?? 'n/a'}，HTTP ${res.statusLine || '?'}）：` +
        `${res.raw.slice(0, 240)}\n` +
        'Token 需要 Workers Scripts:Edit（含 subdomains）权限；也可先在 Cloudflare Dashboard → Workers 里注册 workers.dev 子域后重跑。',
    );
  }
  die('注册 workers.dev 子域失败：候选名都被占用，请先在 Cloudflare Dashboard 注册后重跑。');
}

/**
 * CLI 辅证：必须带 --config（仓库根无 wrangler.toml）。
 * @returns {'present'|'absent'|'error'}
 */
function workerAlreadyDeployedViaCli(workerName) {
  const workerADir = path.join(repoRoot, 'apps', 'worker-a');
  const configPath = path.join(workerADir, 'wrangler.toml');
  // M-WORKFLOW-EXIST-1：根目录跑 deployments list 常非 0；旧逻辑把非 0 当成「首次」会毁钥
  const r = runWrangler(
    ['deployments', 'list', '--name', workerName, '--json', '--config', configPath],
    { cwd: workerADir },
  );
  if (r.status !== 0) {
    return 'error';
  }
  try {
    const parsed = JSON.parse(r.out.trim().split('\n').pop() || '[]');
    const present = Array.isArray(parsed) ? parsed.length > 0 : Boolean(parsed);
    return present ? 'present' : 'absent';
  } catch {
    return /Created:|Version ID|Deployment/i.test(r.out) ? 'present' : 'error';
  }
}

/**
 * 读线上 Worker A production bindings。
 * M-WORKFLOW-ED25519-1 / EXIST-1：区分 missing（可首次）vs error（禁止当首次）。
 * @returns {Promise<
 *   | { kind: 'ok', hasPrivBinding: boolean, pubkeyHex: string, pubkeyOk: boolean, workerBUrlOk: boolean, needsEd25519: boolean }
 *   | { kind: 'missing' }
 *   | { kind: 'error', detail: string }
 * >}
 */
async function probeWorkerARegisterConfig(workerName) {
  const accountId = (process.env.CLOUDFLARE_ACCOUNT_ID || '').trim();
  const headers = cfAuthHeaders();
  if (!accountId || !headers) {
    return { kind: 'error', detail: '缺少 CLOUDFLARE_ACCOUNT_ID 或鉴权（Token / Global Key+Email）' };
  }
  try {
    const url =
      `https://api.cloudflare.com/client/v4/accounts/${accountId}` +
      `/workers/services/${encodeURIComponent(workerName)}/environments/production/bindings`;
    const res = await fetch(url, { headers });
    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    const errCode = body?.errors?.[0]?.code;
    const errMsg = String(body?.errors?.[0]?.message || '');
    // 10007 / 404：Worker 不存在 → 允许走首次生成
    if (
      res.status === 404 ||
      errCode === 10007 ||
      /not found|does not exist/i.test(errMsg)
    ) {
      return { kind: 'missing' };
    }
    if (!res.ok || !body?.success) {
      return {
        kind: 'error',
        detail: `HTTP ${res.status} cf_code=${errCode ?? '?'} ${errMsg.slice(0, 120)}`,
      };
    }
    const list = Array.isArray(body.result)
      ? body.result
      : body.result?.bindings || [];
    const byName = Object.fromEntries(list.map((b) => [b.name, b]));
    const pub = String(byName.ED25519_PUBLIC_KEY?.text ?? '').trim();
    const wb = String(byName.WORKER_B_URL?.text ?? '').trim();
    const hasPriv = Boolean(byName.ED25519_PRIVATE_KEY);
    const pubOk = /^[0-9a-fA-F]{64}$/.test(pub);
    const wbOk = /^https:\/\//i.test(wb) && !/placeholder|changeme/i.test(wb);
    return {
      kind: 'ok',
      hasPrivBinding: hasPriv,
      pubkeyHex: pubOk ? pub : '',
      pubkeyOk: pubOk,
      workerBUrlOk: wbOk,
      /** 缺私钥 binding 或公钥非 64hex → 视为空壳，须重新注入 */
      needsEd25519: !hasPriv || !pubOk,
    };
  } catch (err) {
    return { kind: 'error', detail: err?.message || String(err) };
  }
}

/**
 * 判定 Worker A 是否已存在：API 优先，CLI 仅辅证；unknown 禁止当首次。
 * @returns {Promise<{ status: 'present'|'absent'|'unknown', live: object|null, via: string, detail?: string }>}
 */
async function resolveWorkerADeployState(workerName) {
  const probed = await probeWorkerARegisterConfig(workerName);
  if (probed.kind === 'ok') {
    return { status: 'present', live: probed, via: 'api-bindings' };
  }
  if (probed.kind === 'missing') {
    return { status: 'absent', live: null, via: 'api-missing' };
  }

  // API 不确定时才问 CLI（并带 --config，避免根目录假失败）
  const cli = workerAlreadyDeployedViaCli(workerName);
  if (cli === 'present') {
    return {
      status: 'present',
      live: null,
      via: 'cli-deployments-list',
      detail: probed.detail,
    };
  }
  if (cli === 'absent') {
    // API error + CLI 明确无部署记录：仍偏 unknown（鉴权/账号错时 CLI 也可能空）
    // 保守：当作 unknown，逼站主确认；空账号首次可 FORCE_PUT_SECRETS=1
    return {
      status: 'unknown',
      live: null,
      via: 'api-error+cli-absent',
      detail: probed.detail,
    };
  }
  return {
    status: 'unknown',
    live: null,
    via: 'api-error+cli-error',
    detail: probed.detail,
  };
}

const forceSecrets =
  process.env.FORCE_PUT_SECRETS === '1' || Boolean(process.env.WORKER_SECRETS_JSON);
const deployState = await resolveWorkerADeployState(identity.WORKER_A_NAME);
console.log(
  `  Worker A 存在性：status=${deployState.status} via=${deployState.via}` +
    (deployState.detail ? ` detail=${deployState.detail}` : ''),
);

console.log('\n════ CI Bootstrap：生成 / 读取密钥 ════\n');
let secrets;
let secretsMode = 'generate';
let skipSecretPut = false;
/** @type {null | Awaited<ReturnType<typeof probeWorkerARegisterConfig>> & { kind: 'ok' }} */
let liveRegister = null;

if (process.env.WORKER_SECRETS_JSON) {
  try {
    secrets = JSON.parse(process.env.WORKER_SECRETS_JSON);
  } catch (err) {
    die(`WORKER_SECRETS_JSON 不是合法 JSON：${err.message}`);
  }
  secretsMode = 'from_env';
  console.log('  使用环境变量 WORKER_SECRETS_JSON');
} else if (!forceSecrets && deployState.status === 'unknown') {
  // M-WORKFLOW-EXIST-1：探测失败不得静默「当首次」生成新钥覆盖线上
  die(
    '无法确认 Worker A 是否已部署（API/CLI 均不确定）。' +
      '拒绝生成新密钥，以免升级时覆盖线上 Ed25519/JWT 导致登记 MISCONFIGURED。' +
      ` via=${deployState.via}` +
      (deployState.detail ? ` detail=${deployState.detail}` : '') +
      '。请检查 Token Workers 读权限与 ACCOUNT_ID；确认空账号首次部署时可设 FORCE_PUT_SECRETS=1。',
  );
} else if (!forceSecrets && deployState.status === 'present') {
  liveRegister =
    deployState.live?.kind === 'ok'
      ? deployState.live
      : await probeWorkerARegisterConfig(identity.WORKER_A_NAME).then((p) =>
          p.kind === 'ok' ? p : null,
        );
  if (!liveRegister) {
    die(
      '已有 Worker A，但无法读取 production bindings（检查 Token 是否含 Workers 读权限 / ACCOUNT_ID）。' +
        '拒绝继续：若用仓库占位 ED25519_PUBLIC_KEY=auto-generated-at-deploy 去 deploy，会覆盖线上真公钥导致登记 MISCONFIGURED。' +
        '确认要轮换时可设 FORCE_PUT_SECRETS=1。',
    );
  }
  if (liveRegister.needsEd25519) {
    // 中文注释：Retry 空壳（首次 deploy 成功但 secret put 失败）→ 必须当首次注入，禁止 skip
    secrets = JSON.parse(runNode('scripts/generate-deploy-secrets.mjs'));
    secretsMode = 'heal_incomplete_shell';
    skipSecretPut = false;
    console.log(
      '  ⚠ 已有 Worker A 但缺 ED25519_PRIVATE_KEY 或公钥非 64hex → 视为空壳，重新生成并注入（修复 GitHub Retry 假绿）',
    );
  } else {
    secretsMode = 'preserve_existing';
    skipSecretPut = true;
    // 关键：必须把线上真公钥写回 toml，否则后续 redeploy 会用占位串覆盖
    secrets = {
      JWT_SECRET: '',
      INTERNAL_FORWARD_SECRET: '',
      TOTP_WRAP_SECRET: '',
      NODE_API_TOKEN_WRAP_SECRET: '',
      GROUP_OWNER_KEY_WRAP_SECRET: '',
      ED25519_PRIVATE_KEY: '',
      MEDIA_TICKET_SECRET: '',
      ED25519_PUBLIC_KEY:
        liveRegister.pubkeyHex || (process.env.ED25519_PUBLIC_KEY || '').trim(),
    };
    if (!/^[0-9a-fA-F]{64}$/.test(secrets.ED25519_PUBLIC_KEY || '')) {
      die(
        '升级保留密钥：线上公钥探测异常且环境未提供 ED25519_PUBLIC_KEY（64 hex）。拒绝用占位公钥 deploy。',
      );
    }
    console.log(
      '  检测到已有 Worker A 且 Ed25519 齐全 → 保留线上 Secrets；已回填线上公钥到 toml（防占位覆盖）',
    );
    console.log('  若需轮换密钥：设 FORCE_PUT_SECRETS=1 或提供 WORKER_SECRETS_JSON');
    if (!liveRegister.workerBUrlOk) {
      console.log(
        '  提示：线上 WORKER_B_URL 仍像占位；本轮 ci-finalize-urls + Redeploy 会回填真实 URL',
      );
    }
  }
} else {
  // absent 或 FORCE_PUT_SECRETS：生成新密钥
  secrets = JSON.parse(runNode('scripts/generate-deploy-secrets.mjs'));
  secretsMode = 'generate';
  skipSecretPut = false;
  console.log(
    '  已新生成 JWT_SECRET / INTERNAL_FORWARD_SECRET / TOTP_WRAP_SECRET / NODE_API_TOKEN_WRAP_SECRET / GROUP_OWNER_KEY_WRAP_SECRET / MEDIA_TICKET_SECRET / Ed25519',
  );
}

const requiredSecrets = [
  'JWT_SECRET',
  'INTERNAL_FORWARD_SECRET',
  'TOTP_WRAP_SECRET',
  'NODE_API_TOKEN_WRAP_SECRET',
  'GROUP_OWNER_KEY_WRAP_SECRET',
  'ED25519_PRIVATE_KEY',
  'ED25519_PUBLIC_KEY',
];
if (secretsMode !== 'preserve_existing') {
  for (const k of requiredSecrets) {
    if (!secrets[k]) die(`密钥缺少字段 ${k}`);
  }
}

// 部署密钥门禁：私钥必须能推导出公钥；否则签名会与 D1/注册中心声明的公钥对不上。
if (secrets.ED25519_PRIVATE_KEY) {
  try {
    assertEd25519KeyPairConsistent({
      privateKeyHex: secrets.ED25519_PRIVATE_KEY,
      publicKey: secrets.ED25519_PUBLIC_KEY,
      label: 'ED25519',
    });
    console.log('  ✓ ED25519 私钥/公钥成对校验通过');
  } catch (err) {
    die(
      `ED25519 密钥对不一致：${err.message}。` +
        '请提供匹配的 ED25519_PRIVATE_KEY / ED25519_PUBLIC_KEY，或显式轮换并同步 D1/注册中心。',
    );
  }
} else if (secretsMode !== 'preserve_existing') {
  die('缺少 ED25519_PRIVATE_KEY，无法校验密钥对');
} else {
  console.log(
    '  ⚠ 升级保留线上密钥：未提供 ED25519_PRIVATE_KEY，无法校验私钥/公钥成对；' +
      '请用轮换 workflow 或 WORKER_SECRETS_JSON 提供私钥。',
  );
}

const g = identity.DEPLOY_GROUP_CODE;
const d1Names = {
  IDENTITY_DB: `hailuo-node-db-${g}-identity`,
  GOVERNANCE_DB: `hailuo-node-db-${g}-governance`,
  CONTENT_DB: `hailuo-node-db-${g}-content`,
  DB_IMPORT: `hailuo-node-db-${g}-import`,
  MESSAGING_DB:     `hailuo-node-db-${g}-messaging`,
  MESSAGING_SHARD_1: `hailuo-node-db-${g}-messaging-shard-1`,
};
// KV title：hailuo-node-{group}-{suffix}。必须 createKvViaApi（见 findOrCreateKv）。
// 禁止在未 patch name 的 worker-a 目录下 wrangler create——会拼 prod-placeholder 前缀且不可改名。
// POSTS_CACHE：规范后缀 posts-cache-kv（与 image-kv / state-kv 一致）；旧名 posts-cache 只作 alias reuse。
const kvTitles = {
  POSTS_CACHE_KV: `hailuo-node-${g}-posts-cache-kv`,
  IMAGE_KV: `hailuo-node-${g}-image-kv`,
  STATE_KV: `hailuo-node-${g}-state-kv`,
};
/** @type {Record<string, string[]>} */
const kvAliases = {
  POSTS_CACHE_KV: [`hailuo-node-${g}-posts-cache`],
};

console.log('\n════ CI Bootstrap：workers.dev 子域 ════\n');
ensureWorkersDevSubdomain(identity.DEPLOY_GROUP_CODE);

console.log('\n════ CI Bootstrap：创建 D1 / KV ════\n');
const d1Ids = {};
for (const [binding, name] of Object.entries(d1Names)) {
  d1Ids[binding] = findOrCreateD1(name);
}
const kvIds = {};
for (const [binding, title] of Object.entries(kvTitles)) {
  kvIds[binding] = findOrCreateKv(title, kvAliases[binding] || []);
}

// Pages project：wrangler 4.0 不再在 deploy 时自动建，必须先显式 create
console.log('\n════ CI Bootstrap：创建 Pages project ════\n');
const pagesProjectId = findOrCreatePagesProject(identity.PAGES_PROJECT_NAME, 'main');

console.log('\n════ CI Bootstrap：回填 wrangler.toml ════\n');
const tomlA = path.join(repoRoot, 'apps', 'worker-a', 'wrangler.toml');
const tomlB = path.join(repoRoot, 'apps', 'worker-b', 'wrangler.toml');

// Worker 名（[env.production] + 顶层）
patchSimpleKey(tomlA, 'env.production', 'name', identity.WORKER_A_NAME);
patchSimpleKey(tomlB, 'env.production', 'name', identity.WORKER_B_NAME);
// 顶层 name 也同步（部分 wrangler 命令读顶层）
function patchTopLevelName(tomlPath, value) {
  let text = fs.readFileSync(tomlPath, 'utf8');
  const re = /^(name\s*=\s*")[^"]*(")/m;
  if (!re.test(text)) die(`顶层 name= 不存在：${tomlPath}`);
  text = text.replace(re, `$1${value}$2`);
  fs.writeFileSync(tomlPath, text, 'utf8');
  console.log(`  set    [top] name = "${value}"`);
}
patchTopLevelName(tomlA, identity.WORKER_A_NAME);
patchTopLevelName(tomlB, identity.WORKER_B_NAME);

// vars
patchSimpleKey(tomlA, 'env.production.vars', 'BOOTSTRAP_HANDLE', identity.BOOTSTRAP_HANDLE);
patchSimpleKey(tomlB, 'env.production.vars', 'BOOTSTRAP_HANDLE', identity.BOOTSTRAP_HANDLE);
// 中文注释：任何路径都必须把 64hex 公钥写进 toml；禁止带着 auto-generated-at-deploy 去 deploy
if (/^[0-9a-fA-F]{64}$/.test(String(secrets.ED25519_PUBLIC_KEY || '').trim())) {
  patchSimpleKey(tomlA, 'env.production.vars', 'ED25519_PUBLIC_KEY', secrets.ED25519_PUBLIC_KEY.trim());
  patchSimpleKey(tomlB, 'env.production.vars', 'ED25519_PUBLIC_KEY', secrets.ED25519_PUBLIC_KEY.trim());
} else {
  die(
    'ED25519_PUBLIC_KEY 不是 64 位 hex，拒绝回填 toml（避免 deploy 用 auto-generated-at-deploy 覆盖线上公钥）',
  );
}

// D1 / KV / Service Binding
for (const [binding, id] of Object.entries(d1Ids)) {
  patchBinding('apps/worker-a/wrangler.toml', binding, id);
}
for (const [binding, id] of Object.entries(kvIds)) {
  patchBinding('apps/worker-a/wrangler.toml', binding, id);
  patchBinding('apps/worker-b/wrangler.toml', binding, id);
}
patchBinding('apps/worker-a/wrangler.toml', 'WORKER_B', identity.WORKER_B_NAME, { service: true });
patchBinding('apps/worker-b/wrangler.toml', 'WORKER_A', identity.WORKER_A_NAME, { service: true });

// 可选 R2：放在其它 toml 回填之后，避免后续 patch 冲掉刚插入的 r2_buckets。
// 失败不阻断（C1）：safeEnsureOptionalR2 内部吞异常；这里也不 die。
console.log('\n════ CI Bootstrap：可选 R2（失败不阻断） ════\n');
const r2Result = safeEnsureOptionalR2({ groupCode: g, writeToml: true });
const r2 = r2DeployState(r2Result);

// Workers Analytics Engine（M-WORKFLOW-AE-1）
// 未开通 AE 的账号：toml 里只要有 ANALYTICS binding，deploy 就会 10089——与 OTEL_ENABLED 无关。
// 默认（OTEL 关）从 production 剥离绑定；仅 OTEL_ENABLED=true 时保留，并提示须先开 Dashboard。
console.log('\n════ CI Bootstrap：Workers Analytics Engine ════\n');
const rawOtel = (process.env.OTEL_ENABLED || '').trim().toLowerCase();
const isOtelOn = rawOtel === 'true' || rawOtel === '1' || rawOtel === 'yes' || rawOtel === 'on';
/** @type {{ binding?: string, worker_a_dataset?: string, worker_b_dataset?: string, otel_enabled: boolean, stripped: boolean, removed_a?: number, removed_b?: number }} */
let analyticsMeta;
if (isOtelOn) {
  patchSimpleKey(tomlA, 'env.production.vars', 'OTEL_ENABLED', 'true');
  patchSimpleKey(tomlB, 'env.production.vars', 'OTEL_ENABLED', 'true');
  console.log('  ✓ 保留 ANALYTICS 绑定 (hailuo_otel_prod / hailuo_otel_b_prod)，OTEL_ENABLED=true');
  console.log('    若 deploy 报 code 10089：先到 Cloudflare Dashboard → Workers → Analytics Engine 开通后再重跑');
  analyticsMeta = {
    binding: 'ANALYTICS',
    worker_a_dataset: 'hailuo_otel_prod',
    worker_b_dataset: 'hailuo_otel_b_prod',
    otel_enabled: true,
    stripped: false,
  };
} else {
  const stripOne = (absPath) => {
    const before = fs.readFileSync(absPath, 'utf8');
    const { text, removed } = stripEnvAnalyticsEngineDatasets(before, { env: 'production' });
    if (removed > 0) fs.writeFileSync(absPath, text, 'utf8');
    return removed;
  };
  const removedA = stripOne(tomlA);
  const removedB = stripOne(tomlB);
  console.log(
    `  ✓ OTEL 默认关：已从 production 剥离 ANALYTICS（A:${removedA} B:${removedB}），避免未开通 Analytics Engine 时 deploy 报 10089`,
  );
  console.log('    需要指标时：仓库 Variable/Secret OTEL_ENABLED=true，并先在 Dashboard 开通 Analytics Engine');
  analyticsMeta = {
    otel_enabled: false,
    stripped: true,
    removed_a: removedA,
    removed_b: removedB,
  };
}
if (r2.status === 'bound') {
  const how = r2.created ? '新建' : '复用';
  console.log(`  ✓ R2 ${r2.binding} → ${r2.bucket_name}（${how}）`);
} else {
  console.log(`  skip R2：${r2.reason || 'skipped'}（继续用 IMAGE_KV）`);
}

const state = {
  ...identity,
  account_id: process.env.CLOUDFLARE_ACCOUNT_ID,
  secrets: {
    JWT_SECRET: secrets.JWT_SECRET,
    INTERNAL_FORWARD_SECRET: secrets.INTERNAL_FORWARD_SECRET,
    TOTP_WRAP_SECRET: secrets.TOTP_WRAP_SECRET,
    NODE_API_TOKEN_WRAP_SECRET: secrets.NODE_API_TOKEN_WRAP_SECRET,
    GROUP_OWNER_KEY_WRAP_SECRET: secrets.GROUP_OWNER_KEY_WRAP_SECRET || '',
    ED25519_PRIVATE_KEY: secrets.ED25519_PRIVATE_KEY,
    ED25519_PUBLIC_KEY: secrets.ED25519_PUBLIC_KEY,
    // SEC-6-SECRET：仅供首次 put；升级 skip 时 ci-put 仍会「缺则补」且不覆盖线上
    MEDIA_TICKET_SECRET: secrets.MEDIA_TICKET_SECRET || '',
  },
  secrets_mode: secretsMode,
  skip_secret_put: skipSecretPut,
  d1: d1Ids,
  d1_names: d1Names,
  kv: kvIds,
  kv_titles: kvTitles,
  pages_project_id: pagesProjectId,
  analytics: analyticsMeta,
  r2,
  created_at: new Date().toISOString(),
};
finalState = state; // 捕获成功状态（即便后续 throw，也能写出）

fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');
console.log(`\n  ✓ 状态写入 ${path.relative(repoRoot, statePath)}（含密钥，已在 .gitignore）\n`);

// 给 GitHub Actions 写 GITHUB_OUTPUT（若存在）
if (process.env.GITHUB_OUTPUT) {
  const lines = [
    `group_code=${identity.DEPLOY_GROUP_CODE}`,
    `worker_a_name=${identity.WORKER_A_NAME}`,
    `worker_b_name=${identity.WORKER_B_NAME}`,
    `pages_project_name=${identity.PAGES_PROJECT_NAME}`,
    `bootstrap_handle=${identity.BOOTSTRAP_HANDLE}`,
    `state_kv_id=${kvIds.STATE_KV}`,
    `state_path=${statePath}`,
    `skip_secret_put=${skipSecretPut ? '1' : '0'}`,
    `r2_status=${r2.status}`,
    `account_id=${process.env.CLOUDFLARE_ACCOUNT_ID || ''}`,
  ];
  fs.appendFileSync(process.env.GITHUB_OUTPUT, lines.join('\n') + '\n', 'utf8');
}

// 同 job 后续 step（Ensure Pages）需要 Account ID；Secrets 省略时从探测结果写回
if (process.env.GITHUB_ENV && process.env.CLOUDFLARE_ACCOUNT_ID) {
  try {
    fs.appendFileSync(
      process.env.GITHUB_ENV,
      `CLOUDFLARE_ACCOUNT_ID=${process.env.CLOUDFLARE_ACCOUNT_ID}\n`,
      'utf8',
    );
    console.log('  ✓ 已把 CLOUDFLARE_ACCOUNT_ID 写入 $GITHUB_ENV（同 job 后续 step）');
  } catch (err) {
    console.warn(`  ⚠ 写 GITHUB_ENV 失败：${err?.message || err}`);
  }
}

console.log('════ CI Bootstrap 完成 ════\n');
} // end main

main().catch((err) => {
  console.error(err.message || err);
  exitCode = err.exitCode ?? 1;
  // 即使中途失败也写出 state 文件（供 artifact upload），带上 error 信息便于下游诊断
  if (finalState) {
    finalState._error = err.message || String(err);
    fs.writeFileSync(statePath, JSON.stringify(finalState, null, 2), 'utf8');
    console.log(`\n  ⚠ 错误状态写入 ${path.relative(repoRoot, statePath)}（含 error 字段，供 artifact 上传）\n`);
  }
  process.exit(exitCode);
});
