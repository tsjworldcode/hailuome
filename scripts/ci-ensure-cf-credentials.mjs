/**
 * M8-13 · 确保 CI / Workers Builds 具备 Cloudflare 凭证
 *
 * 解析顺序：CLOUDFLARE_ACCOUNT_ID（环境变量）→ API /accounts 自动探测
 * 两路任意其一拿到 32hex Account ID 即视为确定；解析到的 ID 会确定性派生资源名 → 同账号复用已有资源。
 * 两路都失败 → 报错退出（非 0）。
 *
 * GitHub Actions 配置（M-WORKFLOW-DUAL-AUTH-2 修订 — 严格按环境变量来源选鉴权，不再靠字面判定）：
 * - ① Scoped API Token（推荐）：CLOUDFLARE_API_TOKEN（Edit Workers + D1 + KV + Pages），
 *   含/不含 `-`、含/不含 `cf-` 前缀都按 Scoped Token 走 `Authorization: Bearer`
 * - ② Global API Key（不推荐）：**同时** 配 CLOUDFLARE_GLOBAL_API_KEY + CLOUDFLARE_EMAIL，
 *   走 `X-Auth-Email` + `X-Auth-Key`；如果 ① 也配了，优先 ①
 * - 鉴权模式不靠 token 字面判定，按 env var 来源判定
 * - CLOUDFLARE_ACCOUNT_ID：可手动设（多账号场景消歧）；省略时强制走 API 自动探测
 *
 * 运行：node scripts/ci-ensure-cf-credentials.mjs
 */

// 旧版字面判定已废弃：Token 含不带 `-` 不再推断为 Global Key，避免把新格式 Scoped Token 错误降级。
// detectAuthMode 保留供未迁移调用方，但不再被本文件主流程使用（已删除内部调用）。

function printGlobalKeyWarning() {
  console.warn('');
  console.warn('╔══════════════════════════════════════════════════════════════════════╗');
  console.warn('║ ⚠️  检测到 Global API Key（不推荐模式）                              ║');
  console.warn('╠══════════════════════════════════════════════════════════════════════╣');
  console.warn('║ ① 泄露半径过大：一旦 GitHub Secret 泄漏，攻击者可改账号下所有资源    ║');
  console.warn('║ ② Cloudflare 正在弃用全局 Key 体系（Origin CA Key 已弃用）          ║');
  console.warn('║ ③ Global Key + 邮箱明文存在 GitHub Secrets 两个 key 里              ║');
  console.warn('║                                                                      ║');
  console.warn('║ 建议：改用 Scoped API Token                                         ║');
  console.warn('║   - dash.cloudflare.com/profile/api-tokens → Create Token           ║');
  console.warn('║   - 模板选 "Edit Cloudflare Workers" 或 Custom Token                 ║');
  console.warn('║   - 权限勾：Workers 脚本 / KV / D1 / R2 / Pages 全 "编辑"            ║');
  console.warn('║   - 客户端 IP 筛选：留空                                             ║');
  console.warn('║   - 创建后只需配 CLOUDFLARE_API_TOKEN（不再需要 CLOUDFLARE_EMAIL）   ║');
  console.warn('╚══════════════════════════════════════════════════════════════════════╝');
  console.warn('');
}

/** 通过 Cloudflare API /accounts 自动探测 Account ID；mode 由调用方显式指定 */
async function tryAccountIdFromApi(token, email, mode) {
  let headers;
  if (mode === 'api_token') {
    headers = { Authorization: `Bearer ${token}` };
  } else if (mode === 'global_key') {
    if (!email) throw new Error('Global Key 鉴权必须配 CLOUDFLARE_EMAIL');
    headers = { 'X-Auth-Email': email, 'X-Auth-Key': token };
  } else {
    throw new Error(`无法识别鉴权模式：${mode}`);
  }
  const res = await fetch('https://api.cloudflare.com/client/v4/accounts?per_page=50', { headers });
  const data = await res.json();
  if (!data.success) {
    throw new Error(`API 探测失败：${JSON.stringify(data.errors || data)}`);
  }
  const accounts = data.result || [];
  if (accounts.length === 0) throw new Error('该 API Token 看不到任何 Cloudflare 账号');
  if (accounts.length > 1) {
    const list = accounts.map((a) => `  - ${a.id}  ${a.name || ''}`).join('\n');
    throw new Error(`Token 可见多个账号，请显式设置 CLOUDFLARE_ACCOUNT_ID 消歧：\n${list}`);
  }
  return { id: accounts[0].id, name: accounts[0].name || '', authMode: mode };
}

/**
 * wrangler-鉴权适配（M-WORKFLOW-DUAL-AUTH-2 修订）：**永不**主动把
 * `CLOUDFLARE_API_TOKEN` 降级为 Global Key。
 *
 * 历史行为（已废弃）：检测到 `CLOUDFLARE_API_TOKEN` 字面不含 `-` 且不 `cf-` 开头，
 * 就搬到 `CLOUDFLARE_GLOBAL_API_KEY` 并要求 EMAIL——这会让"形似但实为 Scoped Token"
 * 的值被错误降级，回过头来强制 README 的"不要填 EMAIL"前提被打破。
 *
 * 新约定（与 README §第 1 步对齐）：
 * - `CLOUDFLARE_API_TOKEN`（含/不含 `-`，含/不含 `cf-` 前缀都算）→ 一律当 Scoped Token 走 Bearer
 * - `CLOUDFLARE_GLOBAL_API_KEY` **且** `CLOUDFLARE_EMAIL` 同时被**显式**配齐 → 才认 Global Key
 *   - 若只有 `CLOUDFLARE_GLOBAL_API_KEY` 没 `CLOUDFLARE_EMAIL`：直接报错（不再回头读 API_TOKEN）
 *   - 若两者齐备但 `CLOUDFLARE_API_TOKEN` 也在 → **优先** Scoped Token（Bearer），warn 一次"忽略 GLOBAL_KEY"
 *
 * 应在**所有 CI 脚本 spawnSync('wrangler', ...) 之前**调用此函数。幂等。
 */
export function adaptWranglerAuthForGlobalKey() {
  const token = process.env.CLOUDFLARE_API_TOKEN || '';
  const apiKey = process.env.CLOUDFLARE_GLOBAL_API_KEY || '';
  const email = process.env.CLOUDFLARE_EMAIL || '';

  if (!token && !apiKey) {
    console.log('[wrangler-鉴权适配] 无任何 Cloudflare 凭证（请到 GitHub Secrets 配 CLOUDFLARE_API_TOKEN）');
    return { adapted: false, mode: 'none' };
  }

  if (token) {
    // 用户有意提供 Scoped Token 名字的变量 —— 一律优先走 Bearer，不再"按字面猜"。
    if (apiKey) {
      console.warn(
        '[wrangler-鉴权适配] 检测到 CLOUDFLARE_API_TOKEN 与 CLOUDFLARE_GLOBAL_API_KEY 同时存在 → 优先用 Scoped Token（Bearer），忽略 GLOBAL_KEY',
      );
    } else {
      console.log('[wrangler-鉴权适配] CLOUDFLARE_API_TOKEN 存在 → 走 Scoped Token（Bearer）');
    }
    return { adapted: false, mode: 'api_token' };
  }

  // 只有 API_KEY 时，必须同时配 EMAIL，否则不要回头读 token（避免与 README 推荐路径冲突）。
  if (apiKey && !email) {
    throw new Error(
      '检测到 CLOUDFLARE_GLOBAL_API_KEY 但缺少 CLOUDFLARE_EMAIL（Global Key 鉴权必须配账号邮箱）。\n' +
        '两种修法任选：\n' +
        '① 在 GitHub Secrets 增加 CLOUDFLARE_EMAIL；\n' +
        '② **推荐**：5 分钟建 Scoped API Token，删 EMAIL，只留 CLOUDFLARE_API_TOKEN（详见 README §第 1 步）。',
    );
  }
  // wrangler CLI 只认 CLOUDFLARE_API_KEY（+ EMAIL），不认自研名 CLOUDFLARE_GLOBAL_API_KEY
  process.env.CLOUDFLARE_API_KEY = apiKey;
  console.log(
    '[wrangler-鉴权适配] 只配了 CLOUDFLARE_GLOBAL_API_KEY + CLOUDFLARE_EMAIL → 桥接为 CLOUDFLARE_API_KEY 供 wrangler',
  );
  console.warn('╭─ ⚠️  你当前走的是 Global API Key（账户级根密钥）');
  console.warn('│ ① 泄露半径大：一旦 GitHub Secret 泄漏，攻击者可改账号下所有 Worker / D1 / KV / 域名 / DNS');
  console.warn('│ ② Cloudflare 官方在弃用全局 Key 体系');
  console.warn('│ ③ Email 明文多暴露一份，反追查风险升高（参 .cursor/rules/12-anti-deanonymization.mdc）');
  console.warn('╰─ 5 分钟切到 Scoped Token → 删 EMAIL，只留 CLOUDFLARE_API_TOKEN');
  return { adapted: true, mode: 'global_key', explicit: true };
}

/**
 * @param {{ quiet?: boolean }} [opts] quiet=true 时人话日志走 stderr，便于 --json 只从 stdout 取结果
 */
export async function ensureCloudflareCredentials(opts = {}) {
  const quiet = !!opts.quiet;
  const log = (...args) => {
    if (quiet) console.error(...args);
    else console.log(...args);
  };
  const warn = (...args) => console.warn(...args);

  const token = process.env.CLOUDFLARE_API_TOKEN || '';
  const apiKey = process.env.CLOUDFLARE_GLOBAL_API_KEY || '';
  const email = process.env.CLOUDFLARE_EMAIL || '';
  const effectiveToken = token || apiKey;

  if (!effectiveToken) {
    throw new Error(
      '缺少 Cloudflare 凭证。\n' +
        '请在 GitHub Secrets / 本地 cloudflare-api-token.json 配置：\n' +
        '① Scoped API Token（推荐）：CLOUDFLARE_API_TOKEN\n' +
        '② Global API Key（不推荐）：CLOUDFLARE_GLOBAL_API_KEY + CLOUDFLARE_EMAIL',
    );
  }

  // M-WORKFLOW-DUAL-AUTH-2 修订：effectiveToken 来源决定鉴权模式，
  // 不再用 "含不带 -" 字面推定。
  const authMode = token ? 'api_token' : apiKey ? 'global_key' : 'none';

  if (authMode === 'global_key') {
    if (!email) {
      throw new Error(
        '检测到 CLOUDFLARE_GLOBAL_API_KEY，但缺少 CLOUDFLARE_EMAIL。\n' +
          'Global Key 模式必须配账号邮箱；或改用 Scoped Token（推荐路径，README §第 1 步）。',
      );
    }
    printGlobalKeyWarning();
  }

  // Account ID 解析顺序：env → API（两路，都没有则报错）
  // 路径 1：env 直接给定（多账号消歧时手动设）
  const envAcct = process.env.CLOUDFLARE_ACCOUNT_ID || '';
  if (envAcct) {
    log(`  ✓ Account ID = ${envAcct}（来自环境变量）`);
    log(`  ✓ 鉴权模式 = ${authMode === 'api_token' ? 'Scoped API Token（推荐）' : 'Global API Key（不推荐）'}`);
    return { token: effectiveToken, accountId: envAcct, accountIdSource: 'env', authMode };
  }

  // 路径 2：API /accounts 自动探测
  try {
    const acct = await tryAccountIdFromApi(effectiveToken, email, authMode === 'api_token' ? 'api_token' : 'global_key');
    process.env.CLOUDFLARE_ACCOUNT_ID = acct.id;
    log(`  ✓ 自动探测 CLOUDFLARE_ACCOUNT_ID = ${acct.id}（${acct.name}）`);
    log(`  ✓ 鉴权模式 = ${acct.authMode === 'api_token' ? 'Scoped API Token（推荐）' : 'Global API Key（不推荐）'}`);
    return { token: effectiveToken, accountId: acct.id, accountIdSource: 'api', authMode };
  } catch (apiErr) {
    warn(`  ⚠️  API 探测 Account ID 失败：${apiErr.message || apiErr}`);
    throw new Error(
      [
        '无法确定 CLOUDFLARE_ACCOUNT_ID，两条解析路径都未成功：',
        '1）环境变量 / token 文件未设置 CLOUDFLARE_ACCOUNT_ID',
        '2）CLOUDFLARE_API_TOKEN / CLOUDFLARE_GLOBAL_API_KEY 的 API /accounts 探测失败（见上方 ⚠️）',
        '请检查 Token 是否有效；多账号时请显式填写 CLOUDFLARE_ACCOUNT_ID 消歧。',
      ].join('\n'),
    );
  }
}

const isMain =
  process.argv[1] &&
  (process.argv[1].endsWith('ci-ensure-cf-credentials.mjs') ||
    process.argv[1].includes('ci-ensure-cf-credentials'));

if (isMain) {
  const jsonOnly = process.argv.includes('--json');
  ensureCloudflareCredentials({ quiet: jsonOnly })
    .then((r) => {
      const payload = {
        ok: true,
        accountId: r.accountId,
        accountIdSource: r.accountIdSource,
        authMode: r.authMode,
      };
      // --json：仅 stdout 一行 JSON，供本地 bootstrap / deploy-all PowerShell 解析
      process.stdout.write(`${JSON.stringify(payload)}\n`);
    })
    .catch((err) => {
      console.error(`错误：${err.message || err}`);
      process.exit(2);
    });
}
