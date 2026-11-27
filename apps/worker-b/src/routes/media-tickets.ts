/**
 * SEC-AUDIT-2026-10-6a · Worker B 媒体票据签发路由（MEDIA-TICKET-1）。
 *
 * 【端点】`POST /api/media/tickets`
 * 【目的】浏览器 `<img src>` 无法携带 `Authorization` 头；protected 档下
 *   站主 Web / 粉丝前端需要一条「带票据的 `<img>` 直连」路径，否则只能
 *   JS fetch → Blob（内存与 CPU 代价大，且易白屏）。
 *
 * 【鉴权】
 *   - 需携带粉丝 Token：`Authorization: Bearer <follower_token>`；
 *   - 未携带 / 无效 / 被封禁 → 401 / 403（复用 `requireFollowerTokenStrict`）。
 *   - protected 档下同样校验 `read_scope`；public-read 档下 token 仍然必需
 *     （票据本身是「读本节点媒体的授权」，不能让匿名者凭空拿到图）。
 *
 * 【⚠️ 关键安全说明】
 *   票据绑定**单个 storage key** + 短 TTL（60s），但**不绑定浏览器会话**。
 *   一旦票据出现在 URL 里，它就可能被复制转发（Referer 泄漏、剪贴板、日志）。
 *   因此：
 *   1. 响应头必须带 `Referrer-Policy: no-referrer`，避免票据随 Referer 外泄；
 *   2. 票据**不得**写入任何日志（只记摘要）；
 *   3. 票据只对**本节点自己的媒体**签发（`storage_key` 必须是本节点已上传的 key），
 *      不能借票据去读别的节点；
 *   4. TTL 很短，无法囤积成长期凭证。
 *
 * 【开关 · SEC-6-AUTO】随读帖档自动：保护三档 + 已配 secret → 开；
 *   `public-read` / `owner-only` → 关。`MEDIA_TICKET_ENABLED=false` 紧急关闸。
 */

import { Hono } from 'hono';
import type { Env, WorkerBVariables } from '../env.d';
import { requireFollowerTokenStrict, type FollowerTokenVars } from '../middleware/follower-token';
import { resolveTokenMode } from '../middleware/read-cache';
import {
  isMediaTicketUsable,
  issueMediaTicket,
  parseMediaTicketRequestBody,
} from '../lib/mediaTicket';

type AppEnv = { Bindings: Env; Variables: WorkerBVariables & FollowerTokenVars };

export const mediaTicketsApp = new Hono<AppEnv>();

/** 票据签发 JSON body 上限 */
const MAX_TICKET_BODY_BYTES = 8 * 1024;

// 粉丝 Token 校验（public-read 档也强制：票据 = 读媒体的授权，不允许匿名签发）
mediaTicketsApp.use('/', requireFollowerTokenStrict());

mediaTicketsApp.post('/', async (c) => {
  // 档位不需要 / secret 未配 / 紧急关闸 → 明确关闭（不静默降级为公开）
  const mode = resolveTokenMode(c);
  if (!isMediaTicketUsable(c.env, mode)) {
    return c.json(
      {
        ok: false,
        error_code: 'MEDIA_TICKET_DISABLED',
        message: '媒体票据能力未启用（当前读帖档不需要票据，或未配置密钥 / 已紧急关闭）',
      },
      503,
    );
  }

  let raw: string;
  try {
    raw = await c.req.text();
  } catch {
    return c.json(
      { ok: false, error_code: 'INVALID_BODY', message: '请求体读取失败' },
      400,
    );
  }
  if (new TextEncoder().encode(raw).byteLength > MAX_TICKET_BODY_BYTES) {
    return c.json(
      { ok: false, error_code: 'INVALID_BODY', message: '请求体超过大小限制' },
      400,
    );
  }

  const parsed = parseMediaTicketRequestBody(raw);
  if (!parsed.ok) {
    return c.json(
      { ok: false, error_code: parsed.error_code, message: parsed.message },
      400,
    );
  }

  const requesterSub = c.get('followerToken')?.sub ?? '';
  const nowSec = Math.floor(Date.now() / 1000);

  // SEC-AUDIT-2026-10-6b：批量签发。
  // 逐个 key 独立签发（任一 key 非法 → 整单失败，避免「半成功」语义歧义）。
  const issuedList: Array<{
    storage_key: string;
    ticket: string;
    expires_at: string;
    ttl_sec: number;
  }> = [];

  for (const storageKey of parsed.storageKeys) {
    const issued = await issueMediaTicket(c.env, { storageKey, requesterSub });
    if (!issued.ok) {
      return c.json(
        { ok: false, error_code: issued.error_code, message: issued.message },
        400,
      );
    }
    issuedList.push({
      storage_key: issued.payload.k,
      ticket: issued.ticket,
      expires_at: new Date(issued.payload.exp * 1000).toISOString(),
      ttl_sec: issued.payload.exp - nowSec,
    });
  }

  // ⚠️ 日志只记摘要，绝不记票据原文（只打数量与 key）
  console.log(
    `[worker-b/media-tickets] 签发票据 n=${issuedList.length} keys=${issuedList.map((i) => i.storage_key).join(',')}`,
  );

  // 单 key 时同时保留扁平字段（SEC-AUDIT-2026-10-6a 旧客户端向后兼容）；
  // 批量时以 `tickets` 数组为准。
  const single = issuedList.length === 1 ? issuedList[0] : null;

  return c.json(
    {
      ok: true,
      data: {
        tickets: issuedList,
        ...(single
          ? {
              ticket: single.ticket,
              storage_key: single.storage_key,
              expires_at: single.expires_at,
              ttl_sec: single.ttl_sec,
            }
          : {}),
      },
    },
    200,
    {
      // 票据在 URL 里：禁止经 Referer 外泄
      'Referrer-Policy': 'no-referrer',
      // 响应本身不得被共享缓存留存
      'Cache-Control': 'private, no-store',
    },
  );
});
