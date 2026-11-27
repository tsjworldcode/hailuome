/**
 * CI 调试 step：诊断 CLOUDFLARE_API_TOKEN / CLOUDFLARE_GLOBAL_API_KEY 的真实状态
 *
 * 目的：复现 wrangler d1 create 触发的 10000 错——到底是 token 复制不全、EMAIL
 * 与 Key 配对错、账户开了 2FA 限 Global Key、还是 CLOUDFLARE_ACCOUNT_ID 错。
 *
 * 输出（不打印任何 token / key 明文，只打 hash + 长度 + 错码）：
 *   1. token 形态诊断（authMode / length / 含 - / hash 前 8 位）
 *   2. 三个 API 探测的真实响应（按 authMode 切头）
 *      - GET /user                            （Global Key 能看到账户邮箱；Scoped Token 大多返 403/10000）
 *      - GET /accounts?per_page=50            （已有探测）
 *      - GET /accounts/:ACCOUNT_ID/d1/database（复现 wrangler d1 create 用的 endpoint）
 *   3. 错码映射（10000/9103/9109/10001/1004 → 原因 + 建议）
 *   4. 结论（OK / 哪类问题 / 下一步该做什么）
 *
 * 安全：token / key 全程只 sha256 前 8 字符出现；EMAIL 走 sha256 不打原文。
 *
 * 不写任何 Cloudflare 资源，纯 GET；可反复跑不污染状态。
 *
 * 用法：node scripts/ci-debug-cf-auth.mjs
 */

import { createHash } from 'node:crypto';

const TOKEN = process.env.CLOUDFLARE_API_TOKEN || '';
const API_KEY = process.env.CLOUDFLARE_GLOBAL_API_KEY || '';
const EMAIL = process.env.CLOUDFLARE_EMAIL || '';
const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID || '';

// 与 ci-ensure-cf-credentials.mjs 同口径：CLOUDFLARE_API_TOKEN 一律按 Scoped Token 处理
const effectiveToken = TOKEN || API_KEY;

const sha8 = (s) =>
  s ? createHash('sha256').update(s).digest('hex').slice(0, 8) : '<empty>';

/**
 * 判定 Token 类型：以「配了哪个 Secret」为准，不看字符形态。
 * 对齐 ci-ensure-cf-credentials.mjs：只要设了 CLOUDFLARE_API_TOKEN（不论有没有 '-'）
 * 就按 Scoped Token 走 Bearer；只有单独配 GLOBAL_API_KEY 才是 Global Key。
 * （2026-11-24：53 位、无中划线的新格式 Token 曾被误判成 Global Key 并刷假警告。）
 */
function detectAuthMode() {
  if (process.env.CLOUDFLARE_API_TOKEN) return 'api_token';
  if (process.env.CLOUDFLARE_GLOBAL_API_KEY) return 'global_key';
  return 'none';
}

function buildHeaders(token, email, mode) {
  if (mode === 'api_token') return { Authorization: `Bearer ${token}` };
  if (mode === 'global_key') {
    if (!email) return null; // 不可用
    return { 'X-Auth-Email': email, 'X-Auth-Key': token };
  }
  return null;
}

/** Cloudflare 错码 → 原因 + 建议（只列本场景相关的） */
function explainError(code, endpoint) {
  switch (code) {
    case 10000:
      return {
        kind: 'AUTH_OR_2FA_BLOCKED',
        cause:
          'Authentication error：Token 或 Key 本身不被 Cloudflare 接受。常见原因：(a) Global Key 账户开了 2FA → 2024 后 Cloudflare 默认拒；(b) Token 复制不全/有换行/被截断；(c) Token 已过期或被吊销。',
        action:
          '优先建 Scoped Token 替换（dash.cloudflare.com/profile/api-tokens → "Edit Cloudflare Workers" 模板，含 Workers Analytics Engine: Edit 权限）。若坚持 Global Key：确认账户未开 2FA，且到 https://dash.cloudflare.com/profile/api-tokens 重新 View Global API Key、整段复制。',
      };
    case 9103:
      return {
        kind: 'X_AUTH_HEADER_REJECTED',
        cause:
          'Unknown X-Auth-Key or X-Auth-Email：鉴权头用了 X-Auth-Email+X-Auth-Key 模式，但 (a) EMAIL 不对（不是注册邮箱）、(b) Key 字符错、(c) Key 被吊销。',
        action:
          '确认 CLOUDFLARE_EMAIL 与 Cloudflare 账户注册邮箱字面完全一致（区分大小写、去前后空格）。' +
          endpoint.includes('d1/database')
            ? '或放弃 Global Key 改用 Scoped Token 配 D1 Edit 权限。'
            : '',
      };
    case 9109:
      return {
        kind: 'BEARER_TOKEN_REJECTED',
        cause:
          'Invalid access token：用了 Authorization: Bearer 头，但 Cloudflare 不认这个 Token。' +
          '常见：(a) 值是 Global Key（Global Key 走 X-Auth-Email+X-Auth-Key，不是 Bearer）；' +
          '(b) Scoped Token 字符被截断/复制时多了换行/空格；(c) Token 已被吊销。',
        action:
          '回看 token 形态：若不含 - 或长度 < 30，它是 Global Key 错走了 Bearer 头；改用 X-Auth-Email+X-Auth-Key 头。' +
          '若长度/形态对，去 Cloudflare 重新创建 Token 并整段复制。',
      };
    case 10001:
      return {
        kind: 'ACCOUNT_NOT_FOUND',
        cause:
          'Account not found：URL 里的 CLOUDFLARE_ACCOUNT_ID 在 Cloudflare 后端找不到。' +
          '常见：Account ID 拼错、或 Token 看的不是你配置的 Account ID。',
        action: '回 dash.cloudflare.com 右侧栏拿真实 Account ID；或在 Secrets 删了 CLOUDFLARE_ACCOUNT_ID 让脚本自动探测。',
      };
    case 1004:
      return {
        kind: 'NO_PERMISSION',
        cause:
          'Token 对该资源没有权限（缺 D1 Edit / Workers Scripts Edit / KV Edit / Pages Edit 等）。',
        action:
          '重建 Scoped Token：模板选 "Edit Cloudflare Workers"（默认含 D1/KV/R2/Pages Edit）。' +
          'Account Resources 必须选 Specific account 并选对账号。',
      };
    case 403:
      return {
        kind: 'FORBIDDEN',
        cause: '权限被拒。Token 可能是 Read-only，或 IP/区域被限。',
        action: 'Token 客户端 IP 筛选留空（不要在 GitHub Actions 出口限定）；改用 "Edit Cloudflare Workers" 模板。',
      };
    default:
      return {
        kind: 'OTHER',
        cause: `未识别错码 ${code}（参考 https://developers.cloudflare.com/api-next/errors）。`,
        action: '把整段响应贴回滚本步排障。',
      };
  }
}

async function probe(name, url, headers) {
  console.log(`\n[Probe] ${name}`);
  console.log(`  URL     : ${url}`);
  console.log(`  Headers : ${Object.keys(headers).join(', ')}`);
  const t0 = Date.now();
  const res = await fetch(url, { headers });
  const ms = Date.now() - t0;
  let body;
  try {
    body = await res.json();
  } catch {
    body = await res.text();
  }
  const ok = body && typeof body === 'object' && body.success === true;
  const errs = (body && body.errors) || [];
  console.log(`  HTTP    : ${res.status} ${res.statusText}  (${ms} ms)`);
  console.log(`  success : ${ok}`);
  if (errs.length > 0) {
    for (const e of errs) {
      const ex = explainError(e.code, url);
      console.log(`  error   : code=${e.code}  message=${e.message}`);
      console.log(`           → kind   : ${ex.kind}`);
      console.log(`           → cause  : ${ex.cause}`);
      console.log(`           → action : ${ex.action}`);
    }
  } else if (ok && Array.isArray(body.result)) {
    console.log(`  result  : ${body.result.length} item(s)`);
    for (const a of body.result.slice(0, 5)) {
      console.log(`           - id=${a.id}  name=${a.name || ''}`);
    }
  } else if (ok && body.result) {
    console.log(`  result  : ${JSON.stringify(body.result).slice(0, 200)}`);
  }
  return { ok, errs, status: res.status };
}

async function main() {
  console.log('=== CI Cloudflare 鉴权诊断 ===');
  console.log('本脚本不打任何 token / key 明文；token / email 仅以 sha256 前 8 位 + 长度出现。\n');

  // 1. 形态诊断
  const mode = detectAuthMode();
  console.log('[诊断] Token 形态');
  console.log(`  CLOUDFLARE_API_TOKEN     : ${TOKEN ? `present (length=${TOKEN.length}, sha8=${sha8(TOKEN)})` : 'absent'}`);
  console.log(`  CLOUDFLARE_GLOBAL_API_KEY       : ${API_KEY ? `present (length=${API_KEY.length}, sha8=${sha8(API_KEY)})` : 'absent'}`);
  console.log(`  effectiveToken (用哪个)  : ${effectiveToken ? `length=${effectiveToken.length}, sha8=${sha8(effectiveToken)}` : 'NONE'}`);
  console.log(`  含 - (仅参考，不参与判定)   : ${effectiveToken ? effectiveToken.includes('-') : 'n/a'}`);
  console.log(`  CLOUDFLARE_EMAIL         : ${EMAIL ? `present (sha8=${sha8(EMAIL)})` : 'absent'}`);
  console.log(`  CLOUDFLARE_ACCOUNT_ID    : ${ACCOUNT_ID ? `${ACCOUNT_ID} (sha8=${sha8(ACCOUNT_ID)})` : 'absent'}`);
  console.log(`  → 判定 authMode           : ${mode}`);

  if (mode === 'api_token') {
    console.log('  备注: 已配 CLOUDFLARE_API_TOKEN → 按 Scoped Token 走 Authorization: Bearer（新格式 Token 可能不含 -）。');
  } else if (mode === 'global_key') {
    if (!EMAIL) {
      console.log('  ❌ Global Key 模式但缺 CLOUDFLARE_EMAIL——后面探测会全失败。');
    } else {
      console.log('  备注: 只配了 CLOUDFLARE_GLOBAL_API_KEY → 走 X-Auth-Email + X-Auth-Key 鉴权。');
    }
  } else {
    console.log('  ❌ 有效 token 为空；探测会跳过。');
  }

  if (!effectiveToken) {
    console.log('\n[结论] 无可鉴权 token——本步无法继续。');
    process.exit(2);
  }
  const headers = buildHeaders(effectiveToken, EMAIL, mode);
  if (!headers) {
    console.log('\n[结论] Global Key 模式但缺 EMAIL——探测跳过。');
    process.exit(2);
  }

  // 2. 三段探测
  const r1 = await probe('GET /user（账户身份）', 'https://api.cloudflare.com/client/v4/user', headers);
  const r2 = await probe(
    'GET /accounts（账号列表，自动探测 Account ID 路径）',
    'https://api.cloudflare.com/client/v4/accounts?per_page=50',
    headers,
  );

  // 3. 若有 ACCOUNT_ID，再打 d1 database（复现 wrangler d1 create 用的同 endpoint）
  let r3 = null;
  let resolvedAccountId = ACCOUNT_ID;
  if (!resolvedAccountId && r2.ok && Array.isArray(r2.result)) {
    // 直接读上面已经打印的——重发一次拿原始
    const res = await fetch('https://api.cloudflare.com/client/v4/accounts?per_page=50', { headers });
    const body = await res.json();
    if (body.success && body.result.length === 1) resolvedAccountId = body.result[0].id;
  }

  // 自动回写 Account ID：若 Secrets 没配 + 探测到唯一账号 → 写 $GITHUB_ENV 供后续 step 用
  if (!ACCOUNT_ID && resolvedAccountId && process.env.GITHUB_ENV) {
    try {
      const fs = await import('node:fs');
      fs.appendFileSync(process.env.GITHUB_ENV, `CLOUDFLARE_ACCOUNT_ID=${resolvedAccountId}\n`);
      console.log(`\n[自动回写] Secrets 缺 CLOUDFLARE_ACCOUNT_ID，已探测到唯一账号 → 写到 $GITHUB_ENV`);
      console.log(`             CLOUDFLARE_ACCOUNT_ID=${resolvedAccountId}  sha8=${sha8(resolvedAccountId)}`);
      console.log(`             → 后续 wrangler d1 create / wrangler pages 都会自动拿到此 ID`);
    } catch (e) {
      console.log(`\n[自动回写] 失败（非 GitHub Actions 环境？）：${e.message}`);
    }
  } else if (!ACCOUNT_ID && resolvedAccountId) {
    console.log(`\n[自动回写] 已探测到 Account ID=${resolvedAccountId}，但本环境无 $GITHUB_ENV（仅 console 打印）。`);
  }
  if (resolvedAccountId) {
    r3 = await probe(
      'GET /accounts/:id/d1/database（复现 wrangler d1 create 的同 endpoint）',
      `https://api.cloudflare.com/client/v4/accounts/${resolvedAccountId}/d1/database`,
      headers,
    );
  } else {
    console.log('\n[Probe] 跳过 /d1/database 探测：无 Account ID 可用。');
  }

  // 4. 结论
  console.log('\n=== 结论 ===');
  if (r3 && r3.ok) {
    console.log('  ✅ 三段探测都 success：Token / EMAIL / Account ID 均正确；10000 错不是鉴权/账户问题。');
    console.log('     若是仍 10000，复查 wrangler 版本 / endpoint 路径是否一致；本步鉴权层 OK。');
  } else if (r1.ok && r2.ok && r3 && !r3.ok) {
    console.log('  ⚠️  Token 鉴权 OK（/user + /accounts 都 success），但 /d1/database 失败。');
    console.log('     → Account ID 错（kind=ACCOUNT_NOT_FOUND / code 10001）或 Token 缺 D1 Edit 权限（kind=NO_PERMISSION / code 1004）。');
  } else if (!r1.ok && mode === 'api_token') {
    console.log('  ⚠️  Scoped Token 连 /user 都返 9109 / 10000：Token 字符错或被截断。');
    console.log('     → 回 Cloudflare 重新创建，整段复制（不要只选中间一段）。');
  } else if (mode === 'global_key' && !r1.ok) {
    const code = r1.errs?.[0]?.code;
    if (code === 9103) console.log('  ⚠️  Global Key + EMAIL 配对错：核对 EMAIL 字面与注册邮箱一致。');
    else if (code === 10000) console.log('  ⚠️  Global Key 被拒：账户可能开了 2FA（2024 后 Cloudflare 默认拒 2FA 账户的 Global Key）。');
    else console.log(`  ⚠️  Global Key 鉴权失败 code=${code}，看上面 kind/cause/action。`);
  } else {
    console.log('  ⚠️  上面探测有非 success 项，按 kind 行动。');
  }
  console.log('\n诊断完毕。');
}

main().catch((e) => {
  console.error(`[错误] ${e.message || e}`);
  process.exit(2);
});
