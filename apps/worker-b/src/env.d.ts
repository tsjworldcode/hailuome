import type { FollowerTokenMode } from '@hailuo/shared-types';

/** Hono context：粉丝 Token 模式（每请求从 STATE_KV 或 env 解析，M14-5 四档） */
export type { FollowerTokenMode };

export interface WorkerBVariables {
  followerTokenMode?: FollowerTokenMode;
}

export interface Env {
  POSTS_CACHE_KV: KVNamespace;
  IMAGE_KV: KVNamespace;
  STATE_KV: KVNamespace;
  /** M5-1：可选 R2 bucket，用于读取 r2:img_<uuid> 前缀的图片（F-14：主分支不硬绑） */
  HAILUO_IMAGE_R2?: R2Bucket;
  /** M5-B2：B2 公开 URL 前缀（历史方案）；当前运行时已 fail-closed，未启用私有访问前不会对外重定向 */
  B2_PUBLIC_URL?: string;
  ED25519_PUBLIC_KEY: string;
  /**
   * 部署占位 handle（与 Worker A 同值）；登记后以 D1/KV 公开资料为准。
   * Worker B 无 D1，未登记时 `/users/:handle` 仅服务此占位或 KV 快照中的 handle。
   */
  BOOTSTRAP_HANDLE: string;
  /**
   * @deprecated SEC-AUDIT-ENFORCED-FORCE-1：运行时恒强制 `following-only`（遗留名 enforced），
   * 不再读取本字段。保留可选类型仅兼容存量部署注入；新部署勿再配置。
   */
  FOLLOWER_TOKEN_MODE?: string;
  /** 注册中心公开 API 根地址；用于识别 feed 中的官方公告并让推荐页也展示。 */
  REGISTRY_URL?: string;
  /**
   * M9-23：Worker B 站主写层 owner-proxy 兼容开关。
   *
   * 默认（未设置 / 非 "compat"）关闭，避免公开 Worker B 被攻击时仍承载站主管理能力。
   * 旧部署临时迁移时可显式设为 "compat"，新部署应走 Pages Owner Gateway → Worker A。
   */
  OWNER_PROXY_MODE?: string;
  /** F-16 / M9：Worker B 允许的前端 Origin（站主 Web 主域名；enforced 时用于 CORS 白名单） */
  WORKER_A_ORIGIN?: string;
  /**
   * M6-0a：Worker A 的 Cloudflare Service Binding。
   *
   * Worker B 通过 `env.WORKER_A.fetch(new Request(...))` 转发 follower token 签发请求，
   * 不经过公网，因此 Worker A 的 `*.workers.dev` 地址永不对外暴露（§F-02）。
   *
   * 部署方式（worker-b wrangler.toml）：
   *   [[services]]
   *   binding = "WORKER_A"
   *   service = "hailuo-worker-a"        # production 时按实际 worker name 填
   *
   * 类型说明：Cloudflare Workers Service Binding 的运行时类型是 `Fetcher`（与全局
   * `fetch` 同形）。未部署 binding 时 env.WORKER_A 为 `undefined`——`POST
   * /api/follower-tokens` 路由会显式检查并返 503 `WORKER_A_BINDING_MISSING`。
   */
  WORKER_A?: Fetcher;
  /**
   * M6-0a：Worker A 内部签发端点（`POST /api/follower-tokens`）的转发共享密钥。
   *
   * 经 `env.WORKER_A.fetch(...)` 调用 Worker A 时必须携带：
   *   X-Internal-Forward: hmac-v2
   *   X-Timestamp / X-Nonce / X-Signature
   *
   * 必须与同节点 Worker A 的 `INTERNAL_FORWARD_SECRET` 设为同一值，否则 Worker A
   * 返 401 `INTERNAL_FORWARD_REJECTED`。**只存 wrangler secret**，禁止写 wrangler.toml。
   *
   * 部署方式：
   *   echo "<random32bytes>" | npx wrangler secret put INTERNAL_FORWARD_SECRET
   */
  INTERNAL_FORWARD_SECRET?: string;
  /**
   * M9-12：KV miss 时是否经 Service Binding 拉 Worker A 只读快照。默认关闭；显式 `"true"` 开启。
   */
  READ_SNAPSHOT_ON_MISS?: string;
  /**
   * M13-16：是否对 `posts:page` / `feed:page` 做 lazy KV put。
   * 默认关闭（未设置 / 非 `"true"`）；翻页仍从 `*:latest` 内存切片，不二次消耗 put。
   */
  PUBLIC_PAGE_LAZY_KV_PUT?: string;
  /**
   * ALL-AUDIT-Y-16：OpenTelemetry 总开关（默认 false；与 Worker A 同口径）
   */
  OTEL_ENABLED?: string;
  /** ALL-AUDIT-Y-16：Analytics Engine（仅 OTEL_ENABLED=true 时写） */
  ANALYTICS?: AnalyticsEngineDataset;
  /**
   * SEC-6-AUTO · 媒体票据**紧急关闸**（可选）。
   *
   * 主闸已改为跟读帖档：`token-required` / `following-only` / `mutual-only` +
   * 已配 `MEDIA_TICKET_SECRET` → 自动开；`public-read` / `owner-only` → 自动关。
   *
   * 本变量仅作覆盖：`false` / `0` / `off` = 强制关（排障用）；未设置或 `true` 不挡自动开。
   */
  MEDIA_TICKET_ENABLED?: string;
  /**
   * SEC-AUDIT-2026-10-6a · 媒体票据 HMAC 签名密钥（MEDIA-TICKET-1）。
   *
   * ⚠️ **密钥职责分离（硬约束）**：不得复用 `INTERNAL_FORWARD_SECRET` /
   * `JWT_SECRET` / `HMAC_SECRET`。票据原文出现在 URL 中，一旦复用内部转发密钥，
   * 泄露面将直接扩大到内部转发通道。只走 `wrangler secret put MEDIA_TICKET_SECRET`，
   * 禁止写入 `wrangler.toml`。
   */
  MEDIA_TICKET_SECRET?: string;
}
