/**
 * 粉丝 Token 签发接口（M6-0 + M6-0a）。
 *
 * 【架构定位（M6-0a 重要修正）】
 *   本接口是 **Worker A 内部专属签发端点**，仅接受 Worker B 通过 Cloudflare
 *   Service Binding (`env.WORKER_A.fetch(...)`) 转发过来的请求，不对任何公众暴露。
 *
 *   M6-0 原始实现误把本接口放在 Worker A 公开层让粉丝直连，违反
 *   §F-02 "Worker A 地址永不对外暴露" 硬约束（见 AGENTS.md / 03-security-checklist）。
 *   M6-0a 把公开端点搬到 Worker B，本端点转为内部专属 + 头守卫。
 *
 * 【调用链路】
 *   follower → Worker B `POST /api/follower-tokens`（公开，CORS 允许）
 *           → `env.WORKER_A.fetch(...)`（Cloudflare Service Binding，不走公网）
 *           → Worker A `POST /api/follower-tokens`（本接口）
 *
 * 【头守卫】
 *   请求必须携带 `X-Internal-Forward: hmac-v2` 与
 *   `X-Timestamp` / `X-Nonce` / `X-Signature` 三头。Worker A 使用
 *   INTERNAL_FORWARD_SECRET 对 method/path/body 验 HMAC，缺失、不符或 Worker A
 *   未配置 secret 都返 401 `INTERNAL_FORWARD_REJECTED`。
 *
 * 【路由】
 *   POST /api/follower-tokens   — body: { follower_node_url } → { token, expires_at }
 *
 * 【错误码】
 *   - `INTERNAL_FORWARD_REJECTED`（401）：X-Internal-Forward 头缺失 / 不符 / 
 *     Worker A 未配置 INTERNAL_FORWARD_SECRET
 *   - `INVALID_BODY`（400）：请求体非 JSON
 *   - `NODE_URL_REQUIRED`（400）：follower_node_url 缺失
 *   - `NODE_URL_INVALID`（400）：follower_node_url 不以 https:// 开头
 *   - `BLACKLISTED`（403）：该 follower_node_url 已在本节点 D1 黑名单
 *   - `FOLLOWER_NOT_ALLOWED`（403，M14-2）：`following-only` 下不在 follows 表
 *   - `NOT_MUTUAL_FOLLOW`（403，M14-3）：`mutual-only` 下互粉未满足
 *   - `READ_TOKEN_ISSUANCE_DISABLED`（503，M14-4）：`owner-only` 下拒绝签发
 *   - `RATE_LIMITED`（429，SDH-5）：follower_node_url 每小时申领次数超限
 *   - `INTERNAL_ERROR`（500）：D1 查询或签名失败
 *
 * ⚠️ 安全说明：
 *   - INTERNAL_FORWARD_SECRET 只存 wrangler secret，不进 wrangler.toml。
 *   - 内部转发不再把 secret 原样作为 bearer 口令发送；签名绑定 method/path/body。
 *   - SDH-5：已接入 D1 每小时限频（见 followerTokenRateLimit.ts）。
 */

import { Hono } from 'hono';
import type { Env, AppVariables } from '../env';
import type { FollowerReadScope } from '@hailuo/shared-types';
import { signFollowerToken, verifyRequest } from '@hailuo/shared-crypto';
import {
  isFollowedNode,
  normalizeWorkerBOrigin,
  resolveReadProtectionMode,
} from '../lib/readProtectionMode';
import { verifyMutualReadProofForTokenIssue } from '../lib/readMutualProofGate';
import { checkAndIncrementFollowerTokenRate } from '../lib/followerTokenRateLimit';
import { resolveGovernanceDb } from '../db/bindings';
import { resolveLocalPublicBaseUrl } from '../lib/localPublicBaseUrl';
import { HANDLE_LOCAL_RE_LEGACY } from '@hailuo/shared-utils';

type AppEnv = { Bindings: Env; Variables: AppVariables };

export const followerTokensApp = new Hono<AppEnv>();

/** 粉丝 Token TTL：24 小时（秒），与 shared-crypto.signFollowerToken 默认值一致 */
const FOLLOWER_TOKEN_TTL_SEC = 86400;

/**
 * 内部转发守卫：验证 HMAC 转发头。
 * - 未配置 INTERNAL_FORWARD_SECRET / HMAC 三头缺失 / 签名不符 → 401 INTERNAL_FORWARD_REJECTED
 * - secret 未配置是部署错误，但从响应上不提供部署状态提示（避免泄露部署信息）
 */
followerTokensApp.use('/', async (c, next) => {
  const configured = c.env.INTERNAL_FORWARD_SECRET;
  const marker = c.req.header('X-Internal-Forward') ?? '';
  const timestamp = c.req.header('X-Timestamp') ?? '';
  const nonce = c.req.header('X-Nonce') ?? '';
  const signature = c.req.header('X-Signature') ?? '';
  if (!configured) {
    console.error('[follower-tokens] INTERNAL_FORWARD_SECRET 未配置，Worker A 签发接口临时关闭');
    return c.json(
      { ok: false, error_code: 'INTERNAL_FORWARD_REJECTED', message: '内部转发头验证失败' },
      401,
    );
  }
  if (marker !== 'hmac-v2' || !timestamp || !nonce || !signature) {
    return c.json(
      { ok: false, error_code: 'INTERNAL_FORWARD_REJECTED', message: '内部转发头验证失败' },
      401,
    );
  }
  const rawBody = await c.req.text();
  const ok = await verifyRequest(
    { method: 'POST', path: '/api/follower-tokens' },
    rawBody,
    { timestamp, nonce, signature },
    configured,
  );
  if (!ok) {
    return c.json(
      { ok: false, error_code: 'INTERNAL_FORWARD_REJECTED', message: '内部转发头验证失败' },
      401,
    );
  }
  // Hono 请求体只能读一次；验签后把文本缓存给 handler 复用。
  c.set('internalForwardBody', rawBody);
  await next();
});

followerTokensApp.post('/', async (c) => {
  // ---- 1. 解析请求体 -----------------------------------------------
  let body: {
    follower_node_url?: unknown;
    follower_handle?: unknown;
    read_mutual_proof?: unknown;
  };
  try {
    const rawBody = c.get('internalForwardBody') as string | undefined;
    body = JSON.parse(rawBody ?? '{}') as {
      follower_node_url?: unknown;
      follower_handle?: unknown;
      read_mutual_proof?: unknown;
    };
  } catch {
    return c.json(
      { ok: false, error_code: 'INVALID_BODY', message: '请求体必须为 JSON' },
      400,
    );
  }

  const followerNodeUrlRaw =
    typeof body.follower_node_url === 'string' ? body.follower_node_url.trim() : '';
  if (!followerNodeUrlRaw) {
    return c.json(
      { ok: false, error_code: 'NODE_URL_REQUIRED', message: 'follower_node_url 不能为空' },
      400,
    );
  }
  if (!followerNodeUrlRaw.startsWith('https://')) {
    return c.json(
      { ok: false, error_code: 'NODE_URL_INVALID', message: 'follower_node_url 必须以 https:// 开头' },
      400,
    );
  }
  const followerNodeUrl = normalizeWorkerBOrigin(followerNodeUrlRaw);

  // ---- 1b. 签发限频（D1 按 follower_node_url 每小时计数）-----------
  if (!(await checkAndIncrementFollowerTokenRate(c.env, followerNodeUrl))) {
    return c.json(
      { ok: false, error_code: 'RATE_LIMITED', message: 'Token 申领过于频繁，请稍后再试' },
      429,
    );
  }

  let followerHandle = '';
  if (typeof body.follower_handle === 'string' && body.follower_handle.trim()) {
    followerHandle = body.follower_handle.trim().toLowerCase().replace(/_/g, '-').replace(/^@+/, '');
    // 中文注释：粉丝 handle 走 LEGACY，兼容登记规则收紧前的存量短名
    if (!HANDLE_LOCAL_RE_LEGACY.test(followerHandle)) {
      return c.json(
        { ok: false, error_code: 'FOLLOWER_HANDLE_INVALID', message: 'follower_handle 格式不合法' },
        400,
      );
    }
  }

  // ---- 2. 黑名单检查（D1 GOVERNANCE_DB，权威存储；KV 由 Cron/即时同步）-------
  // 命中即拒发；M6-1/M6-3 实装黑名单写接口与 STATE_KV 同步后，本路径即与 Worker B
  // 端的黑名单检查形成双重保护（A 端 D1 兜底，B 端 STATE_KV 快速短路）。
  //
  // ⚠️ 本路径必须 fail-closed（D1 异常 → 500 拒签）：Token 签发后 24h 无法回收。
  // 因此不走 blacklistLookup 的 fail-soft helper（那是 DM/群/加好友门控口径）。
  try {
    const hit = await resolveGovernanceDb(c.env)
      .prepare('SELECT 1 FROM blacklist WHERE node_url = ? LIMIT 1')
      .bind(followerNodeUrl)
      .first<{ 1: number }>();
    if (hit !== null) {
      return c.json(
        { ok: false, error_code: 'BLACKLISTED', message: '该节点已被封禁' },
        403,
      );
    }
  } catch (err) {
    // D1 查询失败属于服务异常 — 安全侧宁愿不签发；签发后无法事后回收 24h 内的 Token
    console.error('[follower-tokens] 黑名单查询失败', err);
    return c.json(
      { ok: false, error_code: 'INTERNAL_ERROR', message: '黑名单检查失败，请重试' },
      500,
    );
  }

  // ---- 2b. 读帖保护档位门控（M14-2+）--------------------------------
  let readScope: FollowerReadScope | undefined;
  try {
    const mode = await resolveReadProtectionMode(c.env);
    if (mode === 'owner-only') {
      return c.json(
        {
          ok: false,
          error_code: 'READ_TOKEN_ISSUANCE_DISABLED',
          message: '当前为仅站主可读模式，不对外签发读帖 Token',
        },
        503,
      );
    }
    if (mode === 'mutual-only') {
      const localOwnerUrl = normalizeWorkerBOrigin(await resolveLocalPublicBaseUrl(c.env));
      const mutualCheck = await verifyMutualReadProofForTokenIssue({
        env: c.env,
        followerNodeUrl,
        ownerWorkerBUrl: localOwnerUrl,
        followerHandle,
        proofRaw: body.read_mutual_proof,
      });
      if (!mutualCheck.ok) {
        return c.json(
          {
            ok: false,
            error_code: mutualCheck.error_code,
            message: mutualCheck.message,
          },
          mutualCheck.error_code === 'INVALID_BODY' ? 400 : 403,
        );
      }
      readScope = 'mutual-only';
    } else if (mode === 'following-only') {
      if (!(await isFollowedNode(c.env, followerNodeUrl))) {
        return c.json(
          {
            ok: false,
            error_code: 'FOLLOWER_NOT_ALLOWED',
            message: '该节点不在已关注列表，无法申领读帖 Token',
          },
          403,
        );
      }
      readScope = 'following-only';
    } else if (mode === 'token-required') {
      // M14-TOKEN-REQUIRED：读帖必须 Token，但签发不查关注表（仅挡路人；仍查黑名单/限频）。
      // scope 用 token-required，防止这把「松钥匙」拿到 following-only 节点上用。
      readScope = 'token-required';
    }
  } catch (err) {
    console.error('[follower-tokens] 读帖保护门控失败', err);
    return c.json(
      { ok: false, error_code: 'INTERNAL_ERROR', message: '读帖保护检查失败，请重试' },
      500,
    );
  }

  // ---- 3. Ed25519 签发 ----------------------------------------------
  // payload: { sub, iss, fan?, read_scope?, iat, exp }
  let token: string;
  try {
    token = await signFollowerToken(
      followerNodeUrl,
      c.env.BOOTSTRAP_HANDLE,
      c.env.ED25519_PRIVATE_KEY,
      FOLLOWER_TOKEN_TTL_SEC,
      followerHandle || undefined,
      readScope,
    );
  } catch (err) {
    console.error('[follower-tokens] Ed25519 签名失败', err);
    return c.json(
      { ok: false, error_code: 'INTERNAL_ERROR', message: 'Token 签发失败，请重试' },
      500,
    );
  }

  const expiresAt = new Date(Date.now() + FOLLOWER_TOKEN_TTL_SEC * 1000).toISOString();
  return c.json({ ok: true, data: { token, expires_at: expiresAt } });
});
