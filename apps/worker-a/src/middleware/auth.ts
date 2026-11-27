/**
 * 所有者 JWT 鉴权中间件（M2-1）。
 *
 * requireOwnerJWT() 保护需要站主登录态的路由（/api/lookup、/api/posts 等）。
 *
 * 验证流程：
 *   1. 提取 Authorization: Bearer <token> 请求头；缺失 → 401 UNAUTHORIZED
 *   2. 调 verifyOwnerJWT(token, env.JWT_SECRET)：签名错误/过期 → 401 UNAUTHORIZED
 *   3. 计算 SHA-256(token)，查 D1 revoked_tokens；命中 → 401 UNAUTHORIZED
 *   4. 通过：c.set('ownerJwt', payload)，调 next()
 *
 * 注意：
 *   - revoked_tokens 表主要用于粉丝 Token 吊销（M4+）；
 *     所有者 JWT 24h 自然过期，吊销场景暂为 fail-soft（查失败不阻断）。
 *   - OPTIONS 预检请求由 CORS 中间件提前拦截，不会到达此处。
 */

import type { MiddlewareHandler } from 'hono';
import type { Env, AppVariables } from '../env';
import { verifyOwnerJWT } from '@hailuo/shared-crypto';
import { resolveGovernanceDb } from '../db/bindings';

type AppEnv = { Bindings: Env; Variables: AppVariables };

/** 计算 token 的 SHA-256 hex，用于 revoked_tokens 黑名单比对。 */
async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// ---------------------------------------------------------------------------
// M5-P3：revoked_tokens 内存缓存（"未吊销"白名单，60s TTL）
//
// 背景：
//   - 所有者 JWT 24h 自然过期，主动吊销几乎不发生（仅在密码泄露后手动操作）。
//   - 每个受保护请求都查 D1 revoked_tokens 多花 ~10–30ms RTT，是发帖、删帖、
//     关注、lookup 等所有写操作的共同热路径开销。
//
// 设计：
//   - 缓存的是"已确认未吊销"的 token_hash → 过期时间戳（毫秒）。
//   - TTL 60s：吊销操作生效最多延迟 60s，对所有者场景完全可接受。
//   - 仅缓存"未吊销"判定。一旦在 D1 中查到吊销记录，直接拒绝并不写缓存
//     （也不写"已吊销"反向缓存，因为吊销记录会持久存在，下次仍会被 D1 查到）。
//   - module-level Map 在同 isolate 生命周期内有效；冷启动时清空，无需主动清理
//     （Cloudflare Workers isolate 通常存活几分钟到几小时）。
//   - 容量保护：节点所有者数量恒为 1（BOOTSTRAP_HANDLE 单一），合法 token 序列
//     最多对应同一用户多次登录的累积值，量级极小（几个到几十个）；为防异常
//     Map 膨胀加 200 上限的简单清理。
// ---------------------------------------------------------------------------

const REVOKED_CACHE_TTL_MS = 60_000;
const REVOKED_CACHE_MAX_ENTRIES = 200;

/** key: token_hash, value: 缓存条目过期的绝对毫秒时间戳 */
const notRevokedCache = new Map<string, number>();

/**
 * 查询 token_hash 是否在内存"未吊销"白名单中（且未过期）。
 * 命中 → 跳过 D1 查询；未命中 → 走 D1 走慢路径。
 */
function isCachedNotRevoked(tokenHash: string): boolean {
  const exp = notRevokedCache.get(tokenHash);
  if (exp === undefined) return false;
  if (exp <= Date.now()) {
    notRevokedCache.delete(tokenHash);
    return false;
  }
  return true;
}

/** 将 token_hash 标记为"未吊销"，TTL 60s。 */
function rememberNotRevoked(tokenHash: string): void {
  // 简单容量保护：超出上限时清理已过期项；若仍超限则丢弃最旧条目。
  if (notRevokedCache.size >= REVOKED_CACHE_MAX_ENTRIES) {
    const now = Date.now();
    for (const [k, v] of notRevokedCache) {
      if (v <= now) notRevokedCache.delete(k);
    }
    if (notRevokedCache.size >= REVOKED_CACHE_MAX_ENTRIES) {
      const firstKey = notRevokedCache.keys().next().value;
      if (firstKey !== undefined) notRevokedCache.delete(firstKey);
    }
  }
  notRevokedCache.set(tokenHash, Date.now() + REVOKED_CACHE_TTL_MS);
}

/** M34-4：主动吊销后立刻踢出「未吊销」白名单，避免最多 60s 延迟。 */
export function forgetNotRevoked(tokenHash: string): void {
  notRevokedCache.delete(tokenHash);
}

/**
 * 所有者 JWT 鉴权中间件。
 * 挂在需要鉴权的路由或路由组之前（app.use(path, requireOwnerJWT())）。
 */
export function requireOwnerJWT(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    // 步骤 1：提取 Bearer token
    const authHeader = c.req.header('Authorization') ?? '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!token) {
      return c.json(
        { ok: false, error_code: 'UNAUTHORIZED', message: '缺少 Authorization 请求头' },
        401,
      );
    }

    // 步骤 2：验签 + 过期检查
    const payload = await verifyOwnerJWT(token, c.env.JWT_SECRET);
    if (!payload) {
      return c.json(
        { ok: false, error_code: 'UNAUTHORIZED', message: 'JWT 无效或已过期' },
        401,
      );
    }

    // 步骤 3：revoked_tokens 黑名单检查（fail-soft：查询失败不阻断请求）
    //
    // M5-P3：先查 module-level 内存"未吊销"缓存，命中直接跳过 D1（节省 1 次 RTT）；
    // 未命中才走 D1 慢路径，结果写入缓存（TTL 60s）。吊销生效延迟最多 60s。
    try {
      const hash = await sha256Hex(token);

      if (isCachedNotRevoked(hash)) {
        // 缓存命中，直接放行——本步是热路径优化的核心收益
      } else {
        // M-OPT-SPLIT-A7-1：revoked_tokens → GOVERNANCE_DB（migration-governance）
        const revoked = await resolveGovernanceDb(c.env)
          .prepare('SELECT 1 FROM revoked_tokens WHERE token_hash = ? LIMIT 1')
          .bind(hash)
          .first<{ 1: number }>();
        if (revoked !== null) {
          // 已吊销：直接拒绝，且不写缓存（吊销记录会持久存在 D1，下次仍走慢路径但仍会拒）
          return c.json(
            { ok: false, error_code: 'UNAUTHORIZED', message: 'JWT 已吊销' },
            401,
          );
        }
        // 未吊销：写入内存缓存，下次同一 token 在 60s 内的请求免查 D1
        rememberNotRevoked(hash);
      }
    } catch (err) {
      // D1 查询失败：fail-soft，继续处理（所有者 JWT 自然过期，吊销非关键路径）
      console.error('[auth] revoked_tokens 查询失败，跳过吊销检查', err);
    }

    // 步骤 4：注入 payload 到 context，供下游处理器使用
    c.set('ownerJwt', payload);
    await next();
  };
}
