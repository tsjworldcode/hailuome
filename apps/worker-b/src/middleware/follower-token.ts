/**
 * 粉丝 Token 校验中间件（M6-0）。
 *
 * 设计：
 *   - 由 `FOLLOWER_TOKEN_MODE` env 双模式 gate（与 M6-Pre1 缓存策略同源）：
 *     - `"enforced"`：严格校验，所有 [Token] 端点必须携带有效 Token；
 *     - 其它值（含未设置 / `"public-read"`）：noop（M5 公开读期兼容），便于
 *       分两步部署「先落代码 → 用户在 Web 前端补 Token 流程后再翻 env」。
 *   - 校验顺序（与 03-security-checklist 一致）：
 *     1. 取 Authorization: Bearer <token>，缺失 → 401 `TOKEN_MISSING`
 *     2. 拆分 token 解码 payload → 检查 `exp`，过期 → 401 `TOKEN_EXPIRED`
 *     3. Ed25519 验签（`verifyFollowerToken`），失败 → 401 `TOKEN_INVALID`
 *     4. 查 STATE_KV 黑名单（miss ≠ exception；exception → stale / 503）
 *     5. 全部通过 → `c.set('followerToken', payload)`，next()
 *
 * STATE_KV 黑名单约定：
 *   - Key 形式：`blacklist:local:<url>`、`blacklist:registry:<url>`（M6-4）；遗留 `blacklist:<url>` 只读兼容
 *   - Value：任意非空字符串即视为命中（M6-3 同步任务约定写入 `"1"`）
 *   - Worker A Cron 每 5 分钟同步 D1 → STATE_KV，存在最长 5 分钟延迟
 *   - NCF-READ-POLICY：KV exception → stale-last-good；protected 档无缓存 → 503
 *
 * 错误码与 docs/worker-b-api.md §错误码汇总一致：
 *   - `TOKEN_MISSING`（401）
 *   - `TOKEN_INVALID`（401）  ← 包含签名无效、payload 损坏、header 非 Bearer
 *   - `TOKEN_EXPIRED`（401）
 *   - `BLACKLISTED`（403）
 *
 * 与 edgeCache 的关系：
 *   - 在 `public-read` 模式下：本中间件 noop，edgeCache 正常使用 caches.default；
 *   - 在 `enforced` 模式下：edgeCache 旁路共享缓存（M6-Pre1 已实装），本中间件
 *     在每次请求都执行 token 校验——与缓存策略正交。
 */

import type { MiddlewareHandler, Context } from 'hono';
import type { Env, WorkerBVariables } from '../env.d';
import type { FollowerTokenMode } from '@hailuo/shared-types';
import { verifyFollowerToken, decodePayloadUnchecked } from '@hailuo/shared-crypto';
import {
  nowSec,
  checkReadScopeForMode,
  isProtectedFollowerTokenMode,
  normalizeFollowerTokenMode,
} from '@hailuo/shared-utils';
import type { FollowerTokenPayload } from '@hailuo/shared-types';
import { isFollowerSubBlacklistedStrict } from '../lib/blacklistKvRead';
import type { MediaTicketVars } from './media-ticket';

async function checkFollowerBlacklist(
  stateKv: KVNamespace,
  sub: string,
  protectedMode: boolean,
): Promise<Response | null> {
  const bl = await isFollowerSubBlacklistedStrict(stateKv, sub, { protectedMode });
  if (!bl.ok) {
    return new Response(
      JSON.stringify({
        ok: false,
        error_code: bl.error_code,
        message: bl.message,
      }),
      { status: 503, headers: { 'Content-Type': 'application/json' } },
    );
  }
  if (bl.blacklisted) {
    return new Response(
      JSON.stringify({
        ok: false,
        error_code: 'BLACKLISTED',
        message: '该节点已被封禁',
      }),
      { status: 403, headers: { 'Content-Type': 'application/json' } },
    );
  }
  return null;
}

export interface FollowerTokenVars {
  followerToken: FollowerTokenPayload;
}

/** Authorization header 解析结果 */
interface BearerExtraction {
  ok: boolean;
  token?: string;
}

/** 提取 `Authorization: Bearer <token>`；缺失或格式不对返回 `{ ok: false }`。 */
function extractBearer(headerValue: string | undefined): BearerExtraction {
  if (!headerValue) return { ok: false };
  const trimmed = headerValue.trim();
  // 大小写不敏感地匹配 "Bearer " 前缀
  if (trimmed.length < 8 || trimmed.slice(0, 7).toLowerCase() !== 'bearer ') {
    return { ok: false };
  }
  const token = trimmed.slice(7).trim();
  if (!token) return { ok: false };
  return { ok: true, token };
}

/**
 * 创建粉丝 Token 校验中间件。
 *
 * 用法：
 * ```ts
 * app.use('/posts', requireFollowerToken());
 * app.get('/posts', handler);
 * ```
 */
async function verifyFollowerTokenStrict(
  c: Context<{ Bindings: Env; Variables: FollowerTokenVars }>,
  next: () => Promise<void>,
): Promise<Response | void> {
  const bearer = extractBearer(c.req.header('Authorization'));
  if (!bearer.ok || !bearer.token) {
    return c.json(
      { ok: false, error_code: 'TOKEN_MISSING', message: '缺少粉丝 Token' },
      401,
    );
  }
  const token = bearer.token;
  const peeked = decodePayloadUnchecked(token);
  if (peeked && peeked.exp < nowSec()) {
    return c.json(
      { ok: false, error_code: 'TOKEN_EXPIRED', message: 'Token 已过期，请重新获取' },
      401,
    );
  }
  const payload = await verifyFollowerToken(token, c.env.ED25519_PUBLIC_KEY);
  if (!payload) {
    return c.json(
      { ok: false, error_code: 'TOKEN_INVALID', message: 'Token 签名无效' },
      401,
    );
  }
  const denied = await checkFollowerBlacklist(c.env.STATE_KV, payload.sub, true);
  if (denied) return denied;
  c.set('followerToken', payload);
  await next();
}

/** M9-18：互动写入口必须有 actor 身份，即使公开读仍处于 public-read 模式也强制 Token。 */
export function requireFollowerTokenStrict(): MiddlewareHandler<{
  Bindings: Env;
  Variables: FollowerTokenVars;
}> {
  return verifyFollowerTokenStrict;
}

function resolveFollowerTokenModeFromContext(c: {
  env: Env;
  get: (key: keyof WorkerBVariables) => WorkerBVariables[keyof WorkerBVariables] | undefined;
}): FollowerTokenMode {
  const fromKv = c.get('followerTokenMode');
  if (fromKv) return normalizeFollowerTokenMode(fromKv);
  return normalizeFollowerTokenMode(c.env.FOLLOWER_TOKEN_MODE);
}

export function requireFollowerToken(): MiddlewareHandler<{
  Bindings: Env;
  Variables: FollowerTokenVars & WorkerBVariables & MediaTicketVars;
}> {
  return async (c, next) => {
    const mode = resolveFollowerTokenModeFromContext(c);

    // ---- 0. public-read：中间件 noop ----
    if (!isProtectedFollowerTokenMode(mode)) {
      await next();
      return;
    }

    // ---- 0b. owner-only：拒绝一切 follower token（M14-5）----
    if (mode === 'owner-only') {
      return c.json(
        {
          ok: false,
          error_code: 'READ_PROTECTION_OWNER_ONLY',
          message: '当前节点为仅站主可读模式，不接受粉丝读帖 Token',
        },
        403,
      );
    }

    // ---- 0c. 媒体票据已授权（SEC-AUDIT-2026-10-6a）----
    // `requireMediaTicketOrFallthrough` 已校验过票据（绑定单 key + TTL + 签名），
    // 此处跳过 Authorization 校验，避免票据路径被二次拒绝。
    // ⚠️ 该标记只能由票据中间件设置，外部请求无法伪造（不在 query / header 中）。
    if (c.get('mediaTicketAuthorized')) {
      await next();
      return;
    }

    // ---- 1. 取 Bearer Token ----
    const bearer = extractBearer(c.req.header('Authorization'));
    if (!bearer.ok || !bearer.token) {
      return c.json(
        { ok: false, error_code: 'TOKEN_MISSING', message: '缺少粉丝 Token' },
        401,
      );
    }
    const token = bearer.token;

    // ---- 2. 提前解码 payload 以区分 TOKEN_EXPIRED vs TOKEN_INVALID ----
    // 这里只看 payload 的 exp；签名是否有效在第 3 步严格校验。
    // 若 payload 段损坏 / 字段缺失 → 归为 TOKEN_INVALID（unchecked 返回 null）。
    const peeked = decodePayloadUnchecked(token);
    if (peeked && peeked.exp < nowSec()) {
      return c.json(
        { ok: false, error_code: 'TOKEN_EXPIRED', message: 'Token 已过期，请重新获取' },
        401,
      );
    }

    // ---- 3. Ed25519 严格验签（含一次 exp 复查，shared-crypto 内置）----
    const payload = await verifyFollowerToken(token, c.env.ED25519_PUBLIC_KEY);
    if (!payload) {
      return c.json(
        { ok: false, error_code: 'TOKEN_INVALID', message: 'Token 签名无效' },
        401,
      );
    }

    // ---- 3b. read_scope 与当前档位（M14-5）----
    const scopeCheck = checkReadScopeForMode(mode, payload.read_scope);
    if (!scopeCheck.ok) {
      return c.json(
        {
          ok: false,
          error_code: scopeCheck.error_code,
          message: 'Token 读帖权限不足，请重新申领',
        },
        403,
      );
    }

    // ---- 4. STATE_KV 黑名单检查（protected 档 KV 异常无缓存 → 503）----
    const denied = await checkFollowerBlacklist(c.env.STATE_KV, payload.sub, true);
    if (denied) return denied;

    // ---- 5. 通过：把 payload 注入 context 供 handler 使用 ----
    c.set('followerToken', payload);
    await next();
  };
}
