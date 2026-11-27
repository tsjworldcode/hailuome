/**
 * 黑名单接口（M6-1 + M6-3 + M9-13 三链路）。
 *
 * blacklistApp 挂在 `/api/blacklist/*`，JWT 鉴权由 index.ts 的
 * `app.use('/api/blacklist/*', requireOwnerJWT())` 保障——只有站主能管理本节点黑名单。
 *
 * GET    /api/blacklist            — 查黑名单列表（D1 直读，按 created_at DESC）
 * POST   /api/blacklist            — 加黑（body: { node_url, reason? }，D1 INSERT，禁 KV.put）
 * DELETE /api/blacklist/:nodeUrl   — 解封（:nodeUrl URL-encoded，D1 DELETE，禁 KV.put）
 *
 * 【黑名单生效链路（M6-0 / M6-0a / M6-1 / M6-3 / M9-13 协同；NCF-AUDIT-OR-6 · 🟠 6 修后）】
 *   1. 本端点写 D1 `blacklist` 表（POST/DELETE），**单 binding 单步**——
 *      不再写 system_config.blacklist_dirty（dirty 标志机制已删除）
 *   2. M9-13 即时同步：调 triggerBlacklistImmediateSync → Worker B Service Binding 推 KV
 *      → 失败降级到 direct STATE_KV（dev 回退）→ 再失败等 M6-3 cron 兜底
 *   3. M6-3 Cron `syncBlacklistToKv` 每 5 分钟（isGroupExternalSlotMinute）：
 *      全量 diff D1 blacklist ⊖ STATE_KV，无需 dirty 标志
 *   4. M6-0 Worker A 内部签发端点（`POST /api/follower-tokens`）签发前先查 D1 黑名单
 *      → 命中即返 403 BLACKLISTED（即时阻断新 token 签发，0 延迟）
 *   5. M6-0 Worker B `requireFollowerToken()` 中间件查 STATE_KV `blacklist:<sub>`
 *      → 命中即返 403 BLACKLISTED（吊销已签 token，Cron 同步最长约 5 分钟延迟）
 *   5. M9-13：POST/DELETE 成功后 waitUntil 即时推送 STATE_KV（Service Binding → Worker B）；
 *      失败时 dirty 保持 true，由 M6-3 Cron 补偿。
 *
 * 【为什么不写 revoked_tokens 表】
 *   M6-0 follower token 设计：sub 字段即 follower 的 worker-b URL（node 维度），
 *   Worker B 中间件按 sub 直接查 `STATE_KV.get('blacklist:<sub>')`。因此只需把
 *   节点维度的 blacklist 同步到 KV 即可吊销该节点所有已签 token，不需要枚举
 *   单个 token_hash。revoked_tokens 表当前仅服务于站主 JWT 吊销（M2-1）。
 *
 * ⚠️ F-01 红线：本路由不允许任何 KV.put（D1 写即可）。
 */

import { Hono } from 'hono';
import { withSpan, SpanName, writeCounter } from '@hailuo/otel';
import type { Env, AppVariables } from '../env';
import { nowISO } from '@hailuo/shared-utils';
import { triggerBlacklistImmediateSync } from '../lib/blacklistImmediateSync';
import { resolveLocalPublicBaseUrl } from '../lib/localPublicBaseUrl';
import { resolveGovernanceDb, resolveIdentityDb } from '../db/bindings';

type AppEnv = { Bindings: Env; Variables: AppVariables };

export const blacklistApp = new Hono<AppEnv>();

// 黑名单条目数上限（防止单节点列表无限增长 + 后续 M6-3 KV 同步成本）。
// 命中上限时返 409 BLACKLIST_FULL，提示先解封旧条目。
const BLACKLIST_MAX_ITEMS = 1000;
// reason 字段长度上限（防止站主把超长文本灌入 D1）。
const REASON_MAX_LENGTH = 200;

// ---------------------------------------------------------------------------
// GET /api/blacklist — 查黑名单列表（D1 直读，按 created_at DESC）
// ---------------------------------------------------------------------------

blacklistApp.get('/', async (c) => {
  let rows: Array<{
    node_url: string;
    reason: string;
    created_at: string;
  }>;

  const governanceDb = resolveGovernanceDb(c.env);
  try {
    const result = await governanceDb
      .prepare(
        `SELECT node_url, reason, created_at
           FROM blacklist
          ORDER BY created_at DESC`,
      )
      .all<{
        node_url: string;
        reason: string;
        created_at: string;
      }>();
    rows = result.results ?? [];
  } catch (err) {
    console.error('[blacklist] 查询黑名单失败', err);
    return c.json(
      { ok: false, error_code: 'BLACKLIST_INTERNAL', message: '查询黑名单失败，请重试' },
      500,
    );
  }

  return c.json({
    ok: true,
    data: {
      items: rows,
      total: rows.length,
    },
  });
});

// ---------------------------------------------------------------------------
// POST /api/blacklist — 加黑一个粉丝节点（D1 INSERT，禁 KV.put）
// ---------------------------------------------------------------------------

// ALL-AUDIT-Y-16-3：加黑路径挂 withSpan（属性不含 node_url，防身份关联）
blacklistApp.post('/', (c) =>
  withSpan(c, SpanName.BlacklistAdd, async (span) => {
  span.setAttribute('http.method', 'POST');
  span.setAttribute('http.route', '/api/blacklist');
  // 1. 解析请求体
  let body: { node_url?: unknown; reason?: unknown };
  try {
    body = await c.req.json() as { node_url?: unknown; reason?: unknown };
  } catch {
    return c.json(
      { ok: false, error_code: 'INVALID_BODY', message: '请求体必须为 JSON' },
      400,
    );
  }

  // 2. node_url 校验（与 follows / follower-tokens 同形）
  const nodeUrl = typeof body.node_url === 'string' ? body.node_url.trim() : '';
  if (!nodeUrl) {
    return c.json(
      { ok: false, error_code: 'NODE_URL_REQUIRED', message: 'node_url 不能为空' },
      400,
    );
  }
  if (!nodeUrl.startsWith('https://')) {
    return c.json(
      { ok: false, error_code: 'NODE_URL_INVALID', message: 'node_url 必须以 https:// 开头' },
      400,
    );
  }
  // 防止把自己加黑（与本节点公开基址相同；D1 SSOT）
  const ownWorkerB = await resolveLocalPublicBaseUrl(c.env);
  if (ownWorkerB && nodeUrl === ownWorkerB) {
    return c.json(
      { ok: false, error_code: 'CANNOT_BLACKLIST_SELF', message: '不能拉黑自己' },
      400,
    );
  }

  // 3. reason 校验（可选字段，提供则截断长度）
  let reason = '';
  if (body.reason !== undefined && body.reason !== null) {
    if (typeof body.reason !== 'string') {
      return c.json(
        { ok: false, error_code: 'REASON_INVALID', message: 'reason 必须为字符串' },
        400,
      );
    }
    reason = body.reason.trim();
    // 用 Unicode 码点统计长度，与 posts validateContent 同形
    if ([...reason].length > REASON_MAX_LENGTH) {
      return c.json(
        {
          ok: false,
          error_code: 'REASON_TOO_LONG',
          message: `reason 不能超过 ${REASON_MAX_LENGTH} 字符`,
        },
        400,
      );
    }
  }

  // 4. 行数上限检查（防止 D1 表无限增长 + M6-3 同步成本控制）
  // 用 COUNT(*) 而非 SELECT 全表，单次 D1 读、O(1) cost。
  try {
    const countRow = await resolveGovernanceDb(c.env)
      .prepare(`SELECT COUNT(*) AS n FROM blacklist`)
      .first<{ n: number }>();
    const total = countRow?.n ?? 0;
    if (total >= BLACKLIST_MAX_ITEMS) {
      return c.json(
        {
          ok: false,
          error_code: 'BLACKLIST_FULL',
          message: `黑名单已满（上限 ${BLACKLIST_MAX_ITEMS} 条），请先解封旧条目`,
        },
        409,
      );
    }
  } catch (err) {
    console.error('[blacklist] COUNT 查询失败', err);
    return c.json(
      { ok: false, error_code: 'BLACKLIST_INTERNAL', message: '加黑操作失败，请重试' },
      500,
    );
  }

  // 5. INSERT INTO blacklist（GOVERNANCE_DB）+ 触发即时同步（NCF-AUDIT-OR-6 · 🟠 6 修后）：
  //    不再写 system_config.blacklist_dirty——dirty 标志机制已删除（cron 改为每次全量 diff）。
  //    保留 INSERT 失败回滚路径（黑名单表 PRIMARY KEY 冲突 → ALREADY_BLACKLISTED）。
  //    即时同步（M9-13 triggerBlacklistImmediateSync）走 Worker B Service Binding 推 KV，
  //    失败降级到 5 分钟 cron 兜底；这两条路径都不需要 dirty 标志参与。
  const createdAt = nowISO();
  const governanceDb = resolveGovernanceDb(c.env);
  try {
    await governanceDb
      .prepare(
        `INSERT INTO blacklist (node_url, reason, created_at)
         VALUES (?, ?, ?)`,
      )
      .bind(nodeUrl, reason, createdAt)
      .run();
  } catch (err) {
    // PRIMARY KEY 冲突 → 已加黑
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('UNIQUE') || message.includes('unique') || message.includes('PRIMARY')) {
      return c.json(
        { ok: false, error_code: 'ALREADY_BLACKLISTED', message: '该节点已在黑名单中' },
        409,
      );
    }
    console.error('[blacklist] INSERT 失败', err);
    return c.json(
      { ok: false, error_code: 'BLACKLIST_INTERNAL', message: '加黑操作失败，请重试' },
      500,
    );
  }

  c.executionCtx.waitUntil(
    triggerBlacklistImmediateSync(c.env, {
      action: 'put',
      node_url: nodeUrl,
      reason,
      created_at: createdAt,
    }),
  );

  writeCounter(c.env, 'blacklist.add.success');
  return c.json({
    ok: true,
    data: { node_url: nodeUrl, reason, created_at: createdAt },
  });
  }),
);

// ---------------------------------------------------------------------------
// DELETE /api/blacklist/:nodeUrl — 解封（:nodeUrl URL-encoded，D1 DELETE）
// ---------------------------------------------------------------------------

// ALL-AUDIT-Y-16-3：解封路径挂 withSpan（属性不含 node_url）
blacklistApp.delete('/:nodeUrl{.+}', (c) =>
  withSpan(c, SpanName.BlacklistRemove, async (span) => {
  span.setAttribute('http.method', 'DELETE');
  span.setAttribute('http.route', '/api/blacklist/:nodeUrl');
  // 与 follows DELETE 同模式：Hono 的 :nodeUrl{.+} 通配符可匹配含斜杠的路径段；
  // 路径参数可能已被 Hono 部分解码，先 decodeURIComponent 确保完整解码。
  const encoded = c.req.param('nodeUrl');
  let nodeUrl: string;
  try {
    nodeUrl = decodeURIComponent(encoded);
  } catch {
    nodeUrl = encoded;
  }

  // 顺序单步（NCF-AUDIT-OR-6 · 🟠 6 修后）：
  //   - DELETE blacklist（GOVERNANCE_DB）→ 拿 changes，单 binding 无跨 binding 风险
  //   - 删 dirty 标志机制（cron 改为每次全量 diff，不需要 dirty 标）
  //   - M9-13 立即同步在 c.executionCtx.waitUntil 触发；失败降级到 5 分钟 cron 兜底
  let changes = 0;
  const now = nowISO();
  const governanceDb = resolveGovernanceDb(c.env);
  try {
    const result = await governanceDb
      .prepare(`DELETE FROM blacklist WHERE node_url = ?`)
      .bind(nodeUrl)
      .run();
    changes = result.meta?.changes ?? 0;
  } catch (err) {
    console.error('[blacklist] DELETE 失败', err);
    return c.json(
      { ok: false, error_code: 'BLACKLIST_INTERNAL', message: '解封操作失败，请重试' },
      500,
    );
  }
  if (changes === 0) {
    return c.json(
      {
        ok: false,
        error_code: 'BLACKLIST_NOT_FOUND',
        message: '该节点不在黑名单中或已被移除',
      },
      404,
    );
  }

  c.executionCtx.waitUntil(
    triggerBlacklistImmediateSync(c.env, { action: 'delete', node_url: nodeUrl }),
  );

  writeCounter(c.env, 'blacklist.remove.success');
  return c.json({ ok: true });
  }),
);
