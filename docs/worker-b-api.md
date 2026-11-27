# Worker B API 契约文档

Worker B 是外部节点、粉丝与注册中心访问本节点的公开入口，地址对外公开（注册中心登记，粉丝可访问）。Worker B 自身不持有 D1；公开读请求直接读 KV，需要 Worker A 权威能力的公开协议只走极窄白名单 Service Binding 转发（例如粉丝 Token 签发、互动）。

> **M9-23 目标边界**：站主 Web 写层通道将从 Worker B owner-proxy 迁出，改为 Web/Pages Functions（或独立 Owner Gateway）通过 Cloudflare Service Binding + HMAC 直达 Worker A。浏览器仍不暴露 Worker A 公网地址；Worker B 回归外部入口定位。

**Base URL**：`https://<username>-worker-b.workers.dev`（生产环境；本地开发 `http://localhost:8788`）

---

## 鉴权说明

带 `[Token]` 标记的接口需要粉丝 Token：

```
Authorization: Bearer <ed25519_follower_token>
```

粉丝 Token 由 **Worker B `POST /api/follower-tokens`**（M6-0a 公开入口）签发，有效期 24h TTL。被封禁（加入黑名单）的节点 Token 立即失效。

> **架构修正（M6-0a）**：M6-0 原始实现错把 token 公开端点放在 Worker A 让粉丝直连，违反 §F-02 "Worker A 地址永不对外暴露" 硬约束。M6-0a 把公开入口搬到 Worker B；Worker B 内部通过 Cloudflare Service Binding (`env.WORKER_A.fetch(...)`) 转发到 Worker A 的内部签发端点完成 D1 黑名单查 + Ed25519 签名，对外仍只暴露 Worker B 地址。

**注意**：Worker B 校验 Token 时不能直接联系 Worker A，黑名单通过 `STATE_KV` 缓存检查：
- **站主本地拉黑（M6-3）**：Worker A Cron 每 5 分钟从 D1 同步 → `blacklist:local:<sub>`；最长约 5 分钟延迟（M9-13 即时 sync 可秒级）。
- **注册中心全局封禁（M6-4）**：Worker A 整点 Cron 拉取 `GET /api/blacklist` → `blacklist:registry:<sub>`；最长约 1 小时延迟。

### `requireFollowerToken()` 中间件（M6-0 + M6-4 + **M14 五档**）

由 `follower_token_mode`（D1 → `STATE_KV` `node:follower_token_mode`，M13-1 isolate **45s TTL**；`/health` 仅用 env）gate：

| 模式 | 中间件行为 |
|---|---|
| `public-read` | **noop**，`[Token]` 端点匿名可读 |
| `token-required` / `following-only` / `mutual-only` | 验 Bearer Token + Ed25519 + 黑名单 + **`read_scope` 与当前模式匹配** |
| `owner-only` | 读端点**在验签前短路** → 403 `READ_PROTECTION_OWNER_ONLY`（**即使 Bearer 有效也拒绝**） |
| 遗留 `enforced`（读 alias） | 映射为 `following-only`（`normalizeFollowerTokenMode`） |

> ⚠️ **`enforced` 已 deprecated（仅兼容期读 alias）**：勿再写入 env/D1/KV。运营迁移步骤与字段映射见 [`MIGRATION_FROM_ENFORCED.md`](./MIGRATION_FROM_ENFORCED.md)。

protected 档校验顺序：
  1. 取 `Authorization: Bearer <token>` → 缺失返 401 `TOKEN_MISSING`
  2. 拆三段 base64url，解码 payload 查 `exp` → 已过期返 401 `TOKEN_EXPIRED`
  3. `verifyFollowerToken(token, ED25519_PUBLIC_KEY)` Ed25519 严格验签 → 失败返 401 `TOKEN_INVALID`
  4. 校验 `read_scope`（M14-1）→ 缺失或不足返 403 `TOKEN_SCOPE_INSUFFICIENT`
  5. 按顺序探测 `STATE_KV` 黑名单三前缀 → 命中 403 `BLACKLISTED`；KV **exception**（≠ miss）走 isolate stale-last-good，protected 档无缓存时 503 `MISCONFIGURED`（NCF-READ-POLICY）
  6. 通过 → `c.set('followerToken', payload)`

中间件挂在 [Token] 端点：`/posts`、`/posts/:id`、`/feed`、`/img/:key`、**`/users/:handle/friends`（M17-4-2a）**，顺序为 `edgeCache → requireFollowerToken → handler`（protected 模式下 edgeCache 旁路共享缓存；`public-read` 下中间件 noop）。`/users/:handle/friends` **不**挂 edgeCache。

### 读帖保护模式 `follower_token_mode`（M6-Pre1 + **M14 五档** + **NCF-READ-POLICY** + **SEC-AUDIT-ENFORCED-FORCE-2**）

> **SEC-AUDIT-ENFORCED-FORCE-2（现行）**：程序强制锁**关闭**。解析顺序：`STATE_KV` → env 回落；**未设置 / 空串默认 `token-required`**。
> 站主可在 Settings 改五档（含放宽到 `public-read`）。保护档下媒体票据随档自动开（须已配 `MEDIA_TICKET_SECRET`）。
> 可选再开程序锁：`FOLLOWER_TOKEN_MODE_FORCE_ENABLED=true`（届时 PATCH → 403 `MODE_PROGRAM_LOCKED`）。

**模式解析（非法 ≠ 未设置）**：
- **未设置** / 空串：默认 **`token-required`**（FORCE-2；历史曾为 `public-read`）
- **合法值**：`public-read` / `token-required` / `following-only` / `mutual-only` / `owner-only`；遗留 `enforced` → `following-only`
- **非法字符串**（拼写错等）：全站读路径 **503 `MISCONFIGURED`**（禁止静默公开）

| 模式取值 | 适用阶段 | `[Token]` 端点响应头 | edgeCache 行为 |
|---|---|---|---|
| `token-required`（**产品默认**） | 未配置或站主选定 | `Cache-Control: private, no-store` + `Vary: Authorization` | 旁路 `caches.default` |
| `public-read` | 站主显式放宽 | `Cache-Control: public, max-age=...` | 写回 `caches.default`；列表/feed **60s**；单帖 300s |
| `following-only` / `mutual-only` | M14 protected（站主可选） | 同 protected | 旁路 |
| `owner-only` | M14 仅站主（站主可选） | 403 `READ_PROTECTION_OWNER_ONLY` + `private, no-store` | 旁路 |

切换说明：
- Canonical 五值与 SSOT 见 worker-a-api.md `follower-token-mode` 与 [`m14-read-protection-plan.md`](./m14-read-protection-plan.md)。
- Settings PATCH 写入 D1 + `STATE_KV`；Worker B 约 45s 缓存 TTL 内可能仍见旧档。
- 升档后旧 Token（无 `read_scope` 或 scope 不足）→ `TOKEN_SCOPE_INSUFFICIENT`。

---

## ⚠️ DEPRECATED · 站主写层代理（M8-11，M9-23 后兼容降级）

> **⚠️ DEPRECATED since M9-23**：Worker B `owner-proxy` 已废弃。请迁到 `web/functions/[[path]].js` + Owner Gateway（Service Binding 直达 Worker A）。默认 `OWNER_PROXY_MODE=disabled` 返回 `410 OWNER_PROXY_DISABLED`；仅旧部署显式 `compat` 时保留。源码见 `apps/worker-b/src/routes/owner-proxy.ts`（`@deprecated since M9-23`）。

M9-23 之后，新生产 Web 不应再把站主登录、发帖、关注、黑名单、注册中心登记等写层请求发到 Worker B。当前推荐链路是：

```text
Web Pages → Pages Functions / Owner Gateway → env.WORKER_A.fetch(...) → Worker A
```

Worker B owner-proxy 仅作为旧部署兼容路径保留。旧 Web 前端生产环境只配置 `PUBLIC_WORKER_B_URL` 时，登录、发帖、关注、黑名单、注册中心登记等站主接口仍由 Worker A 执行业务逻辑和 D1 写入，但浏览器请求会先到 Worker B：

```text
Web Pages → Worker B → env.WORKER_A.fetch(...) → Worker A
```

> **M9-23 边界**：本节白名单只作为迁移期兼容路径保留；新部署默认应优先使用站主专用通道，避免 Worker B 被公开流量攻击时影响站主登录、发帖、关注、黑名单等管理能力。

M9-23 后 Worker B owner-proxy 默认关闭。只有显式配置 `OWNER_PROXY_MODE="compat"` 时，本节旧白名单才会继续工作；未设置或其它值均返回 `410 OWNER_PROXY_DISABLED`。这让 Worker B 被外部流量打满或被针对时，不再默认影响站主 Web 登录、发帖、关注、黑名单等管理能力。

Worker B 代理时会附加内部 HMAC 头：

- `X-Internal-Forward: hmac-v2`
- `X-Timestamp`
- `X-Nonce`
- `X-Signature`

代理白名单：

- `/auth/login-params`、`/auth/login`、`/auth/me`、`/auth/profile`、`/auth/password-params`、`/auth/change-password`
- `/api/local/email-verify-request`、`/api/local/email-verify-confirm`、`/api/local/register/complete`、`/api/local/posts`
- `/api/local/registry-official-feed-status`、`/api/local/registry-official-feed/pull`
- `/api/local/registry-recommended-users`
- `/api/local/operation-logs`、`/api/local/operation-logs/cleanup`
- `/api/lookup/:handle`
- `/api/follows`、`/api/follows/:nodeUrl`
- `/api/blacklist`、`/api/blacklist/:nodeUrl`
- `/api/posts`、`/api/posts/:id`
- `/api/images`

未在白名单内的 `/auth/*` / `/api/*` 写层代理请求返回 `OWNER_PROXY_PATH_NOT_ALLOWED`。Worker A 生产环境可设置 `workers_dev = false`，保持仅通过 Service Binding 被调用。

---

## 公开接口

---

### GET /api/public/registry-endpoints（M9-3-5）

公开读取节点已配置的注册中心列表（脱敏，无 token）。

**鉴权**：无

**响应** `200`：

```json
{
  "ok": true,
  "data": {
    "proto_version": "1.0",
    "items": [
      {
        "registry_id": "reg1",
        "registry_url": "https://registry.example",
        "trust_pubkey": "<base64>",
        "status": "active",
        "added_at": "2026-06-21T00:00:00.000Z",
        "fail_streak": 0
      }
    ]
  }
}
```

**说明**：读 `STATE_KV` 键 `node:registry_endpoints`（Worker A 每 5 分钟与登记/ directive 变更后同步）。KV 未就绪时返回 `items: []`。

---

### GET /health

公开探活。响应：`{ "ok": true, "service": "worker-b", "version": "…" }`。

> **M7-30f-2**：若 STATE_KV 存在宽限期内的 `node:url-moved` 声明，响应头附加 `X-Hailuo-Node-Moved: <new_node_url>`（正文仍 200，不硬断粉）。`/posts`、`/posts/:id`、`/feed` 同理。

### GET /.well-known/hailuo-node-moved（M7-30f-2 · M7-30h-6 链式）

公开。换域 confirm 成功后，Worker A 向 STATE_KV 写入签名迁址声明。

**Query**

| 参数 | 必填 | 说明 |
|------|------|------|
| `old_url` | 否 | 旧址完整 origin（https，无尾斜杠）。**有**则按链式 entry 查 `node:url-moved:entry:<hash>`；**无**则按请求 `Origin` 匹配 index，再回落 legacy `node:url-moved` |

**KV 结构（M7-30h-6）**

| Key | 说明 |
|-----|------|
| `node:url-moved` | legacy：最新一跳声明（兼容旧读路径） |
| `node:url-moved:index` | 宽限期内多跳元数据列表（最多 12 条） |
| `node:url-moved:entry:<16hex>` | 单跳 `old → new` 完整签名声明 |

每次 confirm **追加** entry，不覆盖其它旧址声明。粉丝 Cron 链式解析：`URL_MOVE_CHAIN_MAX_HOPS = 5`，防环。

**宽限期内**返回：

```json
{
  "ok": true,
  "data": {
    "old_node_url": "https://old.example.com",
    "new_node_url": "https://new.example.com",
    "changed_at": "2026-08-19T00:00:00.000Z",
    "grace_until": "2026-09-02T00:00:00.000Z",
    "handle": "alice",
    "sig": "<Ed25519 hex over HAILUO_NODE_MOVED_V1 canonical>"
  }
}
```

`sig` 原文（UTF-8，换行分隔）：

```text
HAILUO_NODE_MOVED_V1
<old_node_url>
<new_node_url>
<changed_at>
<grace_until>
<handle>
```

用本节点 `GET /users/:handle` 的 `pubkey` 验签。过期或未换域 → `404 NODE_MOVED_NOT_FOUND`。

响应头 `X-Hailuo-Node-Moved`：值为**该跳** `new_node_url`（非链终点）；链终点由粉丝侧 `followUrlMigrate` 解析。

宽限期默认 **14 天**（`system_config.url_move_grace_days`，夹取 7～30）。站主宽限期内勿关闭旧路由。粉丝侧 Cron 自动改 `follows`：**M7-30f-3 ✅**（`followUrlMigrate` + `feedFetch`）。已知联系人主动推送：**M7-30f-4 ✅**（`POST /api/node/events`）。

---

### POST /api/node/events（M7-30f-4 公开入口）

对端节点投递 signed `node_url_changed` 事件。Worker B **仅转发**；验签与 `follows` 更新在 Worker A。

**调用链路**：
```
peer Worker A Cron → POST {本站}/api/node/events
                  → env.WORKER_A.fetch（Service Binding + HMAC）
                  → Worker A POST /api/node/events（验签 + UPDATE follows）
```

**请求体**见 `docs/worker-a-api.md` `POST /api/node/events`。body 上限 16KB。

**本层错误码**：`WORKER_A_BINDING_MISSING` / `INTERNAL_FORWARD_SECRET_MISSING`（503）、`INVALID_BODY`（400）、`UPSTREAM_ERROR`（502）；其余透传 Worker A。

---

### POST /api/follower-tokens（M6-0a 公开入口）

为请求粉丝 Token 的节点签发 Ed25519 Token（24h TTL）。**Worker B 是粉丝唯一公开入口**（§F-02）；本端点内部通过 Cloudflare Service Binding 转发到 Worker A 的内部签发端点完成签名，对外不暴露 Worker A 地址。

**调用链路**：
```
follower → Worker B `POST /api/follower-tokens`（本端点，CORS 允许）
        → env.WORKER_A.fetch(new Request(...))（Cloudflare Service Binding，不经公网）
        → Worker A `POST /api/follower-tokens`（内部专属，HMAC 转发头守卫）
        → D1 黑名单查 + Ed25519 签名
        ↓ 原路返回
```

**内部转发头**（Worker B → Worker A，M6-0a + M9 安全审查）：
- Worker B 使用 `INTERNAL_FORWARD_SECRET` 对 `POST /api/follower-tokens` + 请求体做 HMAC-SHA256 签名（`@hailuo/shared-crypto` `signRequest`），**不把 secret 原样作为 bearer 口令发送**
- 转发时必须携带：`X-Internal-Forward: hmac-v2`、`X-Timestamp`、`X-Nonce`、`X-Signature`
- Worker A 用同 secret 验签（`verifyRequest`），绑定 method/path/body，5 分钟时间窗防重放
- 缺失、签名不符或 Worker A 未配置 secret → 401 `INTERNAL_FORWARD_REJECTED`

**请求**：
```http
POST /api/follower-tokens HTTP/1.1
Content-Type: application/json

{ "follower_node_url": "https://bob-worker-b.workers.dev", "follower_handle": "bob", "read_mutual_proof": { "...": "M14-3 mutual-only 时必填，见 worker-a-api.md" } }
```
- `follower_handle` 可选；见 worker-a-api.md Token `fan` 字段说明。
- `read_mutual_proof`（M14-3/M14-9）：目标节点为 `mutual-only` 时必填。Web `ensureFollowerToken` 与 Worker A Cron `feedFetch` 在收到 `403 NOT_MUTUAL_FOLLOW` 时会自动经读者 Worker A 生成 proof 并重试。

**响应**（200，由 Worker A 透传）：
```json
{
  "ok": true,
  "data": {
    "token": "<ed25519_jwt_three_segments>",
    "expires_at": "2026-01-02T00:00:00.000Z"
  }
}
```

Token 结构与 Worker A 端定义完全一致（见 worker-a-api.md `POST /api/follower-tokens`）。

**错误码**：

Worker B 本层独有：
- `WORKER_A_BINDING_MISSING`（503）：worker-b `wrangler.toml` 未配置 `[[services]] binding = "WORKER_A"`，或运行时 `env.WORKER_A` 为 undefined
- `INTERNAL_FORWARD_SECRET_MISSING`（503）：worker-b 未通过 `wrangler secret put INTERNAL_FORWARD_SECRET` 注入共享密钥
- `UPSTREAM_ERROR`（502）：Service Binding 调用 Worker A 时抛 fetch 异常

透传自 Worker A：
- `INVALID_BODY`（400）：请求体非 JSON
- `NODE_URL_REQUIRED`（400）：`follower_node_url` 缺失或为空
- `NODE_URL_INVALID`（400）：`follower_node_url` 不以 `https://` 开头
- `FOLLOWER_HANDLE_INVALID`（400）：`follower_handle` 格式不合法
- `BLACKLISTED`（403）：该节点 URL 已在本地 D1 黑名单和/或注册中心全局黑名单（STATE_KV `blacklist:local:` / `blacklist:registry:`）中
- `INTERNAL_FORWARD_REJECTED`（401）：内部转发 HMAC 验签失败，或两端 `INTERNAL_FORWARD_SECRET` 不一致（部署错误，正常情况不应出现）
- `INTERNAL_ERROR`（500）：Worker A D1 查询失败或 Ed25519 签名失败

**部署要点（按序执行）**：
1. **Worker A 注入 secret**：`echo "<random32bytes>" | npx wrangler secret put INTERNAL_FORWARD_SECRET`（建议 32 字节 base64url）
2. **Worker B 注入同值 secret**：在 worker-b 目录执行同样的命令，secret 值必须与 Worker A 完全一致（Worker B 用其生成 HMAC 签名头，Worker A 用其验签）
3. **Worker B `wrangler.toml` 开启 Service Binding**：取消 `[[services]] binding = "WORKER_A"` 段的注释，按部署环境填 `service`（dev/production 用 `hailuo-worker-a`，preview 用 `hailuo-worker-a-preview`）
4. `wrangler deploy`（两个 worker 都重新部署一次）

**速率限制**：M6-0 不接入；后续 M6-X 再加（按 `follower_node_url` 维度 D1 计数）。

---

### POST /api/media/tickets（SEC-AUDIT-2026-10-6a · MEDIA-TICKET-1）

为**本节点自己的**媒体签发短 TTL 票据，使浏览器 `<img src>` 能直连受保护档下的图片。

**为什么需要**：浏览器 `<img>` 标签发不出 `Authorization` 头。若节点处于 protected 档（`following-only` / `mutual-only`），`GET /img/:key` 必须带粉丝 Token，纯 `<img>` 直连会被 401 拒绝，前端只能 JS fetch → Blob（内存与 CPU 代价大，且易白屏）。票据提供了「URL 自带授权」的替代路径。

**开关（SEC-6-AUTO）**：主闸 = 读帖档位（`token-required` / `following-only` / `mutual-only` 自动开；`public-read` / `owner-only` 自动关）+ 必配 `MEDIA_TICKET_SECRET`。`MEDIA_TICKET_ENABLED=false` 仅紧急关闸。
- 关闭时：本端点返回 503 `MEDIA_TICKET_DISABLED`，`GET /img/:key` 走 Authorization / 公开缓存（视档位）。
- **SEC-AUDIT-ENFORCED-FORCE-1** 后生产档恒 `token-required` → 票据主闸默认开（仍须 `MEDIA_TICKET_SECRET`）。

**鉴权**：必须携带粉丝 Token `Authorization: Bearer <follower_token>`（`requireFollowerTokenStrict`）。
- 缺失 → 401 `TOKEN_MISSING`
- 签名无效 → 401 `TOKEN_INVALID`；过期 → 401 `TOKEN_EXPIRED`
- `read_scope` 不足 → 403 `TOKEN_SCOPE_INSUFFICIENT`
- 已封禁 → 403 `BLACKLISTED`

> ⚠️ `public-read` 档下也**强制**要 Token：票据本质是「读本节点媒体的授权」，不能让匿名者凭空拿到图。

**请求**：
```http
POST /api/media/tickets HTTP/1.1
Content-Type: application/json
Authorization: Bearer <follower_token>

{ "storage_key": "kv:img_abc123" }
```

`storage_key` 必须是本节点已上传的媒体 key，前缀白名单：`kv:` / `r2:` / `b2:` / `filebase:`。

**批量请求（SEC-AUDIT-2026-10-6b）**：一次最多 **32** 个 key，避免浏览器渲染多张图时 N 次请求：
```http
POST /api/media/tickets HTTP/1.1
Content-Type: application/json
Authorization: Bearer <follower_token>

{ "storage_keys": ["kv:img_a", "kv:img_b", "r2:img_c"] }
```
- `storage_keys` 必须是**非空**字符串数组，长度 **1..32**（超出 → 400 `TOO_MANY_STORAGE_KEYS`）。
- 重复 key 自动去重（保持请求顺序）。
- **整单语义**：任一 key 不合法 → 整单 400 `MEDIA_TICKET_KEY_INVALID`（不返回「半成功」票据，避免调用方误判）。
- 零写入：批量与单 key 同为纯 HMAC 计算。

**响应**：
```json
{
  "ok": true,
  "data": {
    "tickets": [
      { "storage_key": "kv:img_abc123", "ticket": "<payloadB64url>.<sigB64url>", "expires_at": "2026-01-01T00:01:00.000Z", "ttl_sec": 60 }
    ],
    "ticket": "<payloadB64url>.<sigB64url>",
    "storage_key": "kv:img_abc123",
    "expires_at": "2026-01-01T00:01:00.000Z",
    "ttl_sec": 60
  }
}
```
- `data.tickets` 是**权威数组**（批量与单 key 都有）。
- 顶层扁平字段（`ticket` / `storage_key` / `expires_at` / `ttl_sec`）**仅在只签发一张票时**出现，用于兼容 SEC-AUDIT-2026-10-6a 的旧客户端（零改动可用）。

**响应头**：`Referrer-Policy: no-referrer` + `Cache-Control: private, no-store`（票据在 URL 里，禁止经 Referer 外泄；响应本身不得被共享缓存留存）。

**错误码**：
- `MEDIA_TICKET_DISABLED`（503）：当前档不需要票据、或 `MEDIA_TICKET_SECRET` 未配置、或 `MEDIA_TICKET_ENABLED` 紧急关闸
- `STORAGE_KEY_REQUIRED`（400）：`storage_key` 缺失，或 `storage_keys` 为空数组 / 含空串
- `MEDIA_TICKET_KEY_INVALID`（400）：`storage_key`（或 `storage_keys` 中任一元素）不在媒体前缀白名单内
- `TOO_MANY_STORAGE_KEYS`（400）：`storage_keys` 长度超过 32（SEC-AUDIT-2026-10-6b）
- `INVALID_BODY`（400）：请求体非 JSON / 不是对象 / 超过 8 KB
- `TOKEN_MISSING` / `TOKEN_INVALID` / `TOKEN_EXPIRED`（401）、`TOKEN_SCOPE_INSUFFICIENT` / `BLACKLISTED`（403）

**票据结构**：
```
ticket = base64url(payloadJson) + "." + base64url(HMAC-SHA256(MEDIA_TICKET_SECRET, "MEDIA_TICKET_V1\n" + payloadB64url))
payload = { "v": 1, "k": "<storage_key>", "s": "<requester_sub>", "exp": <unix_sec>, "jti": "<random>" }
```

**⚠️ 密钥职责分离（硬约束）**：`MEDIA_TICKET_SECRET` 必须**独立于** `INTERNAL_FORWARD_SECRET` / `JWT_SECRET` / `HMAC_SECRET`。票据原文出现在 URL 中，一旦复用内部转发密钥，泄露面将直接扩大到内部转发通道。只走 `wrangler secret put MEDIA_TICKET_SECRET`，禁止写入 `wrangler.toml`。

**⚠️ 已知边界（不可回避）**：票据**不绑定浏览器会话**——`<img>` 直连场景无法验证调用者身份。因此票据只解决「能不能加载图」，**不解决「是不是同一个粉丝」**。请求者级隔离仍依赖 protected 档下的 `Authorization` 路径。

**零写入**：签发是纯 HMAC 计算，**不产生任何 KV/D1 写入**，不触碰 Free Tier 写额度。

**CORS（SEC-AUDIT-2026-10-6b）**：本端点 `Access-Control-Allow-Methods: POST, OPTIONS`（批量取票必须走 POST body）。protected 档下 `Access-Control-Allow-Origin` 仍只回显站主 Web Origin（不放 `*`），与既有口径一致。

**Web 前端接线（SEC-AUDIT-2026-10-6b）**：
- `web/src/lib/mediaTickets.ts`：批量取票（≤32 key）+ 并发合并窗口（25ms，把一波挂载的多张图合成一次请求）+ 票据内存缓存（剩余寿命 ≤10s 即视为过期）+ `?ticket=` URL 拼装 + 失效重取 + JS fetch → Blob 降级。
- `web/src/components/MediaImage.tsx`：渲染降级阶梯 **裸 URL → 票据 URL → 换新票重试一次 → Bearer fetch Blob → 中性占位块**（任何一步失败都不白屏）。
- `PostCard`（帖图 + 转发原帖图 + 作者头像）/ `Profile`（头像）/ `ImageLightbox`（灯箱大图）均改用 `MediaImage`；owner-only 档的 `/api/images/:key` 仍委派 `OwnerJwtImage`（JWT + Blob）。
- **按 origin 隔离的会话学习**：某 origin 的票据 URL 加载成功后，仅该 origin 记为 protected 档（本站 protected 不会牵连仍是 public-read 的远端节点）；票据端点 503 时同样按 origin 记住，避免反复打服务端。
- Pages 同源代理：`/api/media/tickets` 已进 `owner-gateway-allowlist.json` 的 `publicWorkerBPrefixes`（浏览器同源 POST 不会被 `OWNER_GATEWAY_PATH_DENIED` 拦下）。
- 票据**只存内存**，不落 localStorage / sessionStorage；票据值不进日志。

---

### GET /lookup-assist/:handle（M-OPT-8b / 8c）

互粉 / FoF 协助：其它节点在本地 L1 miss 后，可向**已关注联系人**的本端点询问「你是否知道 `@handle`？」。

- Worker B **无 D1**：经 Service Binding + `INTERNAL_FORWARD_SECRET` 转发至 Worker A `GET /internal/lookup-assist/:handle`（`?fof=1` 时带内部头 `X-Hailuo-Assist-Mode: fof`）。
- **默认 L1 模式**：Worker A 只查本机 L1（`follows` → `cache_entries`），**绝不**回源注册中心。
- **`?fof=1`（M-OPT-8c）**：对端需 `LOOKUP_L3_FOF_ENABLED=true`；先 L1，未命中再向其联系人问一层 L1（禁止再 FoF）。未开 → `404 LOOKUP_ASSIST_FOF_DISABLED`。
- 需 `LOOKUP_L2_MUTUAL_ASSIST_ENABLED` 开启（海螺节点默认开）；未开启 → `404 LOOKUP_ASSIST_DISABLED`。
- 入站配额：L1 模式 `l2_assist_in_day`（默认 200）；FoF 模式 `l3_fof_in_day`（默认 100）。超限 → `429 LOOKUP_ASSIST_RATE_LIMITED`。
- 不认识 → `404 LOOKUP_ASSIST_NOT_FOUND`。
- 成功响应 `Cache-Control: private, no-store`；**不要求**粉丝 Token。

**成功 200**：
```json
{
  "ok": true,
  "data": {
    "user_id": "",
    "handle": "carol",
    "node_url": "https://carol-b.example",
    "worker_b_url": "https://carol-b.example",
    "registry_status": null,
    "health_status": null,
    "pubkey_fingerprint": "",
    "resolve_source": "l1_local"
  }
}
```

---

### GET /users/:handle

获取用户公开信息（供其他节点验证帖子签名，也供个人主页展示昵称、简介、头像等公开资料）。数据来自 Worker A 低频同步到 `STATE_KV` 的公开资料快照；旧部署缺少快照时会回落到 handle / pubkey / worker_b_url。

**M7-29-P0**：响应**不包含** `birth_date` / `gender`（登记合规字段，即使旧 KV 快照中仍有值也会在响应层剥离）。

**M7-30g-4**：`worker_b_url` 优先 `STATE_KV` `public:canonical_worker_b_url`，再回落公开资料快照，最后才用请求 `Origin`；**禁止**把请求 hostname 当作换域后的权威。本地帖 `/posts` 的 `image_urls` 基址同样走该解析。

**响应**：
```json
{
  "ok": true,
  "data": {
    "handle": "alice",
    "display_name": "Alice",
    "bio": "...",
    "pubkey": "<ed25519_public_key_hex>",
    "dm_pubkey": "<x25519_public_key_hex>",
    "worker_b_url": "https://alice-worker-b.workers.dev",
    "avatar_key": "kv:img_xxx",
    "contact_email": "alice@example.com",
    "created_at": "...",
    "updated_at": "..."
  }
}
```

---

### GET /users/:handle/friends（M17-4-2a · 互粉投影）

供他站 Cron / FoF 采样拉取本节点**互粉好友**的脱敏名单（「好友的好友」数据面）。**不是**站主右栏直读入口。消费方（他站 M17-4-2b）落库并展示时 **每次最多 5 条** FoF，见 `docs/m17-4-plan.md`。

**鉴权**：与读帖保护同档——`requireFollowerToken()`：
- `public-read`：可匿名 GET
- `following-only` / `mutual-only`：须 `Authorization: Bearer <粉丝 Token>`
- `owner-only`：`403 READ_PROTECTION_OWNER_ONLY`

**查询参数**：

| 参数 | 默认 | 说明 |
|------|------|------|
| `limit` | `20` | 1～20；超出截断为 20 |

**行为**：
- Worker B 无 D1：Service Binding + HMAC v2 转发 Worker A `GET /internal/users/:handle/friends`
- `limit` 经内部头 `X-Hailuo-Friends-Limit` 传递（不进 HMAC 签名 pathname）
- `:handle` 必须等于本站站主 handle，否则 `404 USER_NOT_FOUND`
- 仅返回互粉投影三字段；**禁止** pubkey / email / avatar_key / request_id / IP
- 响应头：`Cache-Control: private, no-store` + `Vary: Authorization`（即使 public-read 也不进共享缓存）

**成功 200**：
```json
{
  "ok": true,
  "data": {
    "handle": "bob",
    "items": [
      { "handle": "carol", "node_url": "https://carol.example", "display_name": "Carol" }
    ],
    "limit": 20
  }
}
```

**错误码**：
- `TOKEN_MISSING` / `TOKEN_INVALID` / `TOKEN_EXPIRED` / `TOKEN_SCOPE_INSUFFICIENT` / `BLACKLISTED`（protected 档）
- `READ_PROTECTION_OWNER_ONLY`（403）
- `USER_NOT_FOUND`（404）
- `FRIENDS_UPSTREAM`（503）：Service Binding 失败
- `WORKER_A_BINDING_MISSING` / `INTERNAL_FORWARD_SECRET_MISSING`（503）
- `INTERNAL_FORWARD_REJECTED`（401，透传）

---

### POST /dm/inbox（M10-2 公开私信投递入口 · MSG-FIX-1）

**收件节点**公开入口：发送方浏览器必须把密文 envelope `POST` 到**收件人**的 Worker B `/dm/inbox`（按 `recipient_worker_b_url`），**禁止**误投到发送方本机 Worker B（本机 `recipient_handle !== 本站主` 会在 Worker A 拒绝）。

接收其它节点投递的 E2EE 私信密文 envelope。Worker B 只做轻量外形校验和 64KB body 限制，然后通过 `WORKER_A` Service Binding 转发到 Worker A 内部 `POST /dm/inbox`；转发时使用 `INTERNAL_FORWARD_SECRET` 生成 `X-Internal-Forward: hmac-v2`、`X-Timestamp`、`X-Nonce`、`X-Signature`。Worker B 不解密、不落库、不写 KV/D1。

**请求**：
```json
{
  "envelope": {
    "v": 1,
    "conversation_id": "conv_...",
    "message_id": "dm_...",
    "sender_handle": "alice",
    "sender_worker_b_url": "https://alice-worker-b.workers.dev",
    "recipient_handle": "bob",
    "created_at": "2026-06-22T00:00:00.000Z",
    "nonce": "<32-byte-random-hex>",
    "key_epoch": 1,
    "ephemeral_pubkey": "<x25519-ephemeral-pubkey-hex>",
    "ciphertext": "<base64-aes-gcm-ciphertext>",
    "aad_version": 1,
    "send_ticket": {
      "sender_handle": "alice",
      "recipient_handle": "bob",
      "recipient_worker_b_url": "https://bob-worker-b.workers.dev",
      "exp": 1780000000,
      "nonce": "<ticket-nonce-hex>",
      "sig": "<ed25519-signature-hex>"
    },
    "sig": "<ed25519-envelope-signature-hex>"
  }
}
```

**成功响应**：透传 Worker A：
```json
{ "ok": true, "data": { "message_id": "dm_..." } }
```

**Worker B 本层错误码**：
- `INVALID_BODY`（400）：请求体不可读或不是 JSON
- `DM_ENVELOPE_INVALID`（400）：缺少 `envelope` 或基础字段类型不正确
- `DM_ENVELOPE_TOO_LARGE`（413）：请求体超过 64KB
- `WORKER_A_BINDING_MISSING`（503）：未配置 `WORKER_A` Service Binding
- `INTERNAL_FORWARD_SECRET_MISSING`（503）：未配置内部转发 HMAC secret

**Worker A 透传错误码**：`INTERNAL_FORWARD_REJECTED`、`DM_TICKET_INVALID`、`DM_NOT_MUTUAL`、`BLACKLISTED`、`DM_NONCE_REPLAY`、`DM_ENVELOPE_INVALID` 等，详见 `worker-a-api.md` M10-2。

---

### POST /groups/invite-accept（M16-1c / M16-INVITE-SHORT 群邀请 accept ingress）

成员节点 accept 时 fetch 群主 Worker B；本端点只做 JSON 外形校验（16KB）+ Service Binding HMAC 转发至 Worker A 内部 `POST /groups/invite-accept`。Worker B 无 D1、不解密。

**请求**（`group_id` 可选；短码入群时省略）：
```json
{
  "invite_token": "K7M2Q9XP",
  "member_worker_b_url": "https://member-b.workers.dev",
  "member_handle": "bob",
  "member_pubkey": "<64-hex>",
  "wrapped_key_json": "{...}"
}
```

`invite_token` 可为 8 位短码或旧 `ginv_…`；若带 `group_id` 则须为 `grp_…`。

**成功**：透传 Worker A `{ "ok": true, "data": { "group_id", "epoch", "tree_id", "name", "owner_worker_b_url" } }`

**Worker B 本层错误码**：`INVALID_BODY`（400）、`GROUP_ENVELOPE_INVALID`（400）、`GROUP_ENVELOPE_TOO_LARGE`（413）、`WORKER_A_BINDING_MISSING`（503）

---

### POST /groups/join（M16-JOIN-POLICY-2 按群号加入 ingress）

成员节点按固定 `group_id` 加入时 fetch 群主 Worker B；本端点只做 JSON 外形校验（16KB）+ Service Binding HMAC 转发至 Worker A 内部 `POST /groups/join`。Worker B 无 D1。

**请求**：
```json
{
  "group_id": "grp_ABCDEFGH",
  "member_worker_b_url": "https://member-b.workers.dev",
  "member_handle": "bob",
  "member_pubkey": "<64-hex>",
  "wrapped_key_json": "{...}"
}
```

**成功 / 错误**：透传 Worker A（含 `GROUP_JOIN_CLOSED` / `membership_status` / `join_policy`）。Worker A 写库前对 `member_worker_b_url` 做 SSRF 门禁（`http`/私网/非白名单端口 → `GROUP_ENVELOPE_INVALID`）。详见 `worker-a-api.md` `POST /api/groups/join`。

**Worker B 本层错误码**：同 `/groups/invite-accept`

---

### POST /groups/admin-join-requests（REL-FIX-6 跨节点管理员代理待审批 ingress）

跨节点管理员节点向**群主**节点请求待审批入群列表 / 代为审批。成员 Worker A 发起；本端点只做 JSON 外形校验（16KB）+ Service Binding HMAC 转发至 Worker A 内部 `POST /groups/admin-join-requests`。Worker B 无 D1、不验签、不查库。

**请求**：
```json
{
  "v": 1,
  "kind": "GROUP_ADMIN_JOIN_REQUEST_V1",
  "action": "list",
  "group_id": "grp_ABCDEFGH",
  "requester_worker_b_url": "https://admin-b.example.com",
  "requester_handle": "alice",
  "target_member_worker_b_url": "",
  "timestamp": "2026-10-29T08:00:00.000Z",
  "nonce": "<32+ hex>",
  "sig": "<128 hex Ed25519>"
}
```

`action`：`list`（列出待审批）/ `approve` / `reject`（代为审批；此时 `target_member_worker_b_url` 必填）。

签名输入（换行，顺序固定）：`GROUP_ADMIN_JOIN_REQUEST_V1` / `action` / `group_id` / `requester_worker_b_url` / `requester_handle` / `target_member_worker_b_url` / `timestamp` / `nonce`。权威用**群主库** `group_members.member_pubkey` 验签，并**权威判定**请求方 `is_admin=1`（不采信自证）。

**成功 / 错误**：透传 Worker A（`items` 列表或审批结果）。Worker B 本层错误码：`INVALID_BODY`（400）、`GROUP_ENVELOPE_INVALID`（400）、`GROUP_ENVELOPE_TOO_LARGE`（413）、`WORKER_A_BINDING_MISSING` / `INTERNAL_FORWARD_SECRET_MISSING`（503）。

---

### POST /groups/join-decision（REL-FIX-7 审批结果回推 ingress）

群主节点在管理员同意/拒绝入群申请后，向**申请人节点**回推审批结果。群主 Worker A 发起；本端点只做 JSON 外形校验（16KB）+ Service Binding HMAC 转发至 Worker A 内部 `POST /groups/join-decision`。Worker B 无 D1、不验签、不查库。

**请求**：
```json
{
  "kind": "GROUP_JOIN_DECISION_V1",
  "group_id": "grp_ABCDEFGH",
  "decision": "approved",
  "group_name": "群名",
  "owner_worker_b_url": "https://owner-b.example.com",
  "owner_handle": "alice",
  "owner_pubkey": "<64 hex>",
  "member_worker_b_url": "https://member-b.example.com",
  "timestamp": "2026-10-29T08:00:00.000Z",
  "nonce": "<32+ hex>",
  "sig": "<128 hex Ed25519>"
}
```

`decision`：`approved` / `rejected`。签名输入（换行，顺序固定）：`GROUP_JOIN_DECISION_V1` / `group_id` / `decision` / `group_name` / `owner_worker_b_url` / `owner_handle` / `owner_pubkey` / `member_worker_b_url` / `timestamp` / `nonce`。权威用**申请人本机 `group_members` 中 `role='owner' AND status='active'` 的 pin 公钥**验签（**不采信信封里的 `owner_pubkey`**），时间窗 ±5min，nonce 落 `group_nonces` 防重放。

**成功 / 错误**：透传 Worker A（`GROUP_ENVELOPE_INVALID` / `GROUP_NOT_MEMBER` / `GROUP_NOT_FOUND` / `GROUP_NONCE_REPLAY` / `USER_NOT_REGISTERED`）。Worker B 本层错误码：`INVALID_BODY`（400）、`GROUP_ENVELOPE_INVALID`（400）、`GROUP_ENVELOPE_TOO_LARGE`（413）、`WORKER_A_BINDING_MISSING` / `INTERNAL_FORWARD_SECRET_MISSING`（503）。

---

### POST /groups/fetch-wrapped-key（SEC-5 / EPOCH NET-2）

成员节点向群主获取**自己的**包裹群密钥，不使用粉丝 Token、不依赖 enforced 模式。Worker B 限制请求体 16KB，校验签名信封外形和 ±5min 时间窗后，原文 HMAC 转发给 Worker A；B 不绑定 D1、不查公钥、不做权威验签。

```json
{
  "group_id": "grp_ABCDEFGH",
  "member_worker_b_url": "https://member-b.example.com",
  "epoch": 2,
  "timestamp": "2026-10-30T08:00:00.000Z",
  "nonce": "<32-64 lowercase hex>",
  "sig": "<128 hex Ed25519>"
}
```

签名字节为以下六行，无末尾换行：
`GROUP_FETCH_WRAPPED_KEY_V1` / `group_id` / `member_worker_b_url` / 十进制 `epoch` / `timestamp` / `nonce`（共六行，含固定域标签）。
URL 须为去首尾空白、去尾斜杠的 http(s) URL，不得含控制字符、凭证、query 或 hash；timestamp 为 `toISOString()` 格式，epoch 为正安全整数。签名者和取包对象共用唯一的 `member_worker_b_url` 字段，A 只使用该成员入群时固定的公钥，不信任请求自带公钥。仅 `status='active'` 可取包（缺钥状态不影响）。

上述 URL 是签名身份字段的外形要求，不放宽出站规则：发往群主仍走 `fetchOutboundPeer` 的 HTTPS 公网门禁（本地私网联调仅显式开关例外），禁跟随重定向。

**成功**：`{ "ok": true, "data": { "group_id": "...", "epoch": 2, "member_worker_b_url": "...", "wrapped_key_json": "..." } }`。

**错误码**：`INVALID_BODY`（400，非 JSON）、`GROUP_ENVELOPE_TOO_LARGE`（413）、`GROUP_WRAP_FORBIDDEN`（403，缺签名/过期/验签失败/非活跃成员/非本机群主/群不存在或已解散，统一文案）、`GROUP_NONCE_REPLAY`（409，**重放不扣小时额度**）、`GROUP_WRAP_RATE_LIMITED`（429，每群每成员 UTC 整点小时 30 次，不能换 epoch 绕过；此时 nonce 已占用，须换新 nonce）、`GROUP_KEY_PENDING`（404，仅通过鉴权后缺包）、`GROUP_WRAP_UNAVAILABLE`（503，权威存储不可用）；缺 binding/secret 仍为 503。

所有响应 `Cache-Control: private, no-store`。旧版无签名请求拒绝，无兼容回退。pin 不等同于 URL 外部所有权证明；此改动阻止第三方冒用已固定成员身份取包。

权威侧顺序为 nonce → 频控（SEC-5b）；频控/nonce 仅存 A 的既有 D1；过期小时桶复用群 GC 每批清理最多 100 行，不占 B 存储。资源预算与保留期见 Epoch 计划「NET-2 落地」及 Worker A 同名接口。

---

### POST /groups/member-left（EPOCH SEC-1 退群权威 ingress）

成员本机已 left 后，异步通知群主权威。本端点只做 JSON 外形校验（须含 `timestamp` / `nonce` / `sig`）+ HMAC 转发至 Worker A 内部 `POST /groups/member-left`。Worker B 无 D1、不验签。

**请求**：
```json
{
  "group_id": "grp_ABCDEFGH",
  "member_worker_b_url": "https://member-b.example.com",
  "member_handle": "bob",
  "timestamp": "2026-10-27T08:00:00.000Z",
  "nonce": "<32+ hex>",
  "sig": "<128 hex Ed25519>"
}
```

签名输入（换行）：`GROUP_MEMBER_LEFT_V1` / `group_id` / `member_worker_b_url` / `timestamp` / `nonce`。权威用 `group_members.member_pubkey` 验签。

**成功 / 错误**：透传 Worker A。

---

### POST /groups/inbound（M16-2 远程成员发信 ingress）

成员 Worker A 投递群消息至群主；本端点只做 JSON 外形校验（64KB）+ `GROUP_MESSAGE` envelope 粗校验 + Service Binding HMAC 转发至 Worker A 内部 `POST /groups/inbound`。

**请求**：
```json
{ "envelope": { "v": 1, "kind": "GROUP_MESSAGE", "...": "..." } }
```

**成功**：透传 Worker A `{ "ok": true, "data": { "message_id": "gmsg_...", "duplicate": false, "owner_receipt?": "…" } }`（`owner_receipt` 见 Worker A GRP-RELAY-AUTH；B 不验签、不签发）

**Worker B 本层错误码**：`INVALID_BODY`（400）、`GROUP_ENVELOPE_INVALID`（400）、`GROUP_ENVELOPE_TOO_LARGE`（413）、`WORKER_A_BINDING_MISSING`（503）

---

### POST /groups/relay（M16-2 树内正向 gossip ingress）

树内节点收到群主/上游 relay 后转发；本端点只做 relay 载荷粗校验 + HMAC 转发至 Worker A 内部 `POST /groups/relay`。

**请求**：
```json
{ "envelope": { "...": "GROUP_MESSAGE" }, "hop_count": 0, "owner_receipt?": { "...": "OwnerReceiptV1" } }
```

Worker B **透传**可选 `owner_receipt`（及 piggyback 字段）；**不**校验副签。强制验签 / 缺回执拒收 / 篡改密文拒收等权威口径在 Worker A（见 `worker-a-api.md` 内部 `/groups/relay` · GRP-RELAY-AUTH）。

**成功**：透传 Worker A `{ "ok": true, "data": { "message_id": "gmsg_...", "duplicate": false } }`

**Worker B 本层错误码**：同 `/groups/inbound`；Worker A 可能回传 `GROUP_RECEIPT_REQUIRED` / `GROUP_RECEIPT_INVALID`（透传，不由 B 发明）

---

### POST /groups/sync-with-parent（M16-3 反向 sync ingress）

子节点 Cron/Worker A 向父节点（seed 的父=群主 Worker B）发起 sync；本端点只做 `GROUP_SYNC` 粗校验（64KB）+ HMAC 转发至 Worker A 内部 `POST /groups/sync-with-parent`。

**请求**：`GROUP_SYNC_V1` 签名 JSON（`cursor`、`acks[]`、`heartbeat?`、`epoch`、`nonce`、`expires_at`、`sig`）

**成功**：透传 Worker A `{ "ok": true, "data": GroupSyncDown }`

**Worker B 本层错误码**：`INVALID_BODY`（400）、`GROUP_ENVELOPE_INVALID`（400）、`GROUP_ENVELOPE_TOO_LARGE`（413）、`WORKER_A_BINDING_MISSING`（503）

---

## Messaging Media（M16-0j · 私有 ticket 读路径）

> SSOT：[`m10-p2-dm-media-plan.md`](./m10-p2-dm-media-plan.md) v1.3。  
> **不复用** `GET /img/:key`（公开帖明文）。浏览器 **不得**直连本段；须经对端 Worker A `/api/messaging/media/proxy`。

### GET /dm/media/:storage_key

接收其它节点持 **`DM_MEDIA_FETCH_TICKET_V1`** 的密文 blob 读取请求。

**Query**：`ticket`（必填，URL 编码）

**Worker B 职责**：

1. 验 ticket 外形 + `exp`（粗校验）
2. Service Binding → 本节点 Worker A 验签 ticket + nonce + registry/message 交叉校验
3. 流式返回 `application/octet-stream` 密文

**响应头**：`Cache-Control: private, no-store`

**错误码**：`DM_MEDIA_TICKET_INVALID`（403）、`DM_MEDIA_NOT_FOUND`（404）、`DM_MEDIA_FORBIDDEN`（403）

### GET /groups/media/:storage_key

同上，ticket 种类为 **`GROUP_MEDIA_FETCH_TICKET_V1`**；Worker A 额外校验 `group_id` + membership。

**错误码**：`GROUP_MEDIA_TICKET_INVALID`（403）、`GROUP_MEDIA_NOT_FOUND`（404）

---

## 加好友公开 ingress（M17-1）

> Worker B 是跨节点「加好友」公开入口 — **极窄转发**，完全复刻 `dm.ts` / `groups.ts` 模板：8 KB body 上限 + `assertWorkerABinding` + `forwardRawBodyToWorkerA`（Service Binding + HMAC v2）。Worker B 不验签、不查 D1、不写 KV；权威验签 + 黑名单门控 + 频控 + `friend_requests` 落库 + `local_notifications` 由 Worker A（M17-1c lib）处理。本节 envelope 字段定义与权威实现见 [`m17-add-friend-plan.md`](./m17-add-friend-plan.md) §五.2 / §五.3。

### POST /friend-requests/inbox

> 接收方（target 节点）公开 ingress — origin 节点 Worker A 在 `c.executionCtx.waitUntil(POST https://<target_b>/friend-requests/inbox)` 投递。Worker B 仅做外形校验 → Service Binding + HMAC 转发到本节点 Worker A 内部 `POST /friend-requests/inbox`。

**请求**（envelope body 直接带 origin pubkey；不再走 `GET /users/{handle}` KV 缓存）：
```json
{
  "request_id": "fr_01HZX8KQ5M5Y8N0Y1A2B3C4D5E",
  "origin": {
    "node_url": "https://alice-worker-b.workers.dev",
    "handle": "alice",
    "display_name": "Alice",
    "avatar_key": "avatar_abc",
    "pubkey": "<ed25519-pubkey-hex-64>"
  },
  "target": {
    "node_url": "https://bob-worker-b.workers.dev",
    "handle": "bob"
  },
  "message": "hi, from X",
  "nonce": "<16-byte-random-hex>",
  "sig": "<ed25519-signature-hex-128>",
  "ts": "1730000000"
}
```

**envelope 签名输入**（UTF-8，换行分隔；plan §5.4）：
```text
HAILUO_FRIEND_REQUEST_V1
POST
/friend-requests/inbox
{ts}
{nonce}
{body_sha256_hex}
```

**成功响应**：透传 Worker A：
```json
{ "ok": true, "data": { "id": "fr_...", "created_at": "2026-...", "mode": "inserted" } }
```

**Worker B 本层错误码**：
- `INVALID_BODY`（400）：请求体不可读或不是 JSON
- `FRIEND_REQUEST_ENVELOPE_INVALID`（400）：envelope 字段缺失或类型不符（含 `origin.pubkey` 非 64 hex / `request_id` 缺失等）
- `FRIEND_REQUEST_ENVELOPE_TOO_LARGE`（413）：请求体超过 8 KB
- `WORKER_A_BINDING_MISSING`（503）：未配置 `WORKER_A` Service Binding
- `INTERNAL_FORWARD_SECRET_MISSING`（503）：未配置内部转发 HMAC secret

**Worker A 透传错误码**：`FRIEND_REQUEST_INVALID_PARAMS` / `FRIEND_REQUEST_INVALID_SIG` / `FRIEND_REQUEST_SIGNATURE_EXPIRED` / `FRIEND_REQUEST_REPLAY` / `BLACKLISTED` / `INCOMING_DISABLED` / `RATE_LIMITED` / `INTERNAL_ERROR`，详见 `worker-a-api.md` M17-1。

### POST /friend-requests/outbox

> 回报方（origin 节点）公开 ingress — target 节点 Worker A 接受 / 拒绝 后在 `c.executionCtx.waitUntil(POST https://<origin_b>/friend-requests/outbox)` 回写。Worker B 仅做外形校验 → Service Binding + HMAC 转发到本节点 Worker A 内部 `POST /friend-requests/outbox`。

**请求**（envelope body 直接带 actor pubkey）：
```json
{
  "request_id": "fr_01HZX8KQ5M5Y8N0Y1A2B3C4D5E",
  "status": "accepted",
  "actor": {
    "node_url": "https://bob-worker-b.workers.dev",
    "handle": "bob",
    "pubkey": "<ed25519-pubkey-hex-64>"
  },
  "nonce": "<16-byte-random-hex>",
  "sig": "<ed25519-signature-hex-128>",
  "ts": "1730000000"
}
```

`status` ∈ `{"accepted", "rejected"}`。

**envelope 签名输入**（与 inbox 同前缀不同 path）：
```text
HAILUO_FRIEND_REQUEST_V1
POST
/friend-requests/outbox
{ts}
{nonce}
{body_sha256_hex}
```

**成功响应**：透传 Worker A：
```json
{ "ok": true, "data": { "id": "fr_...", "status": "accepted", "mode": "applied", "followed_at": "2026-..." } }
```

`mode` ∈ `{"applied", "idempotent"}`；`followed_at` 仅 accepted 时为 ISO 字符串，rejected 时为 `null`。

**Worker B 本层错误码**：与 `POST /friend-requests/inbox` 同（`INVALID_BODY` / `FRIEND_REQUEST_ENVELOPE_INVALID` / `FRIEND_REQUEST_ENVELOPE_TOO_LARGE` / `WORKER_A_BINDING_MISSING` / `INTERNAL_FORWARD_SECRET_MISSING`）。

**Worker A 透传错误码**：`FRIEND_REQUEST_INVALID_PARAMS` / `FRIEND_REQUEST_INVALID_SIG` / `FRIEND_REQUEST_SIGNATURE_EXPIRED` / `FRIEND_REQUEST_NOT_FOUND` / `NOT_ORIGIN` / `ALREADY_RESOLVED` / `INTERNAL_ERROR`，详见 `worker-a-api.md` M17-1。

**CORS**：Worker B 对两个端点 OPTIONS preflight 返回 `Access-Control-Allow-Methods: POST, DELETE, OPTIONS`（`corsPolicy.ts` `CROSS_NODE_INGRESS_PREFIXES` 已加 `'/friend-requests'`）；实际请求是 Worker→Worker Service Binding 不经浏览器，CORS 仅作未来浏览器直连 / 调试 preflight 用。

**跨节点联调（M17-3）**：站主写层 smoke 见 `npm run smoke:m17-3` / [`deploy.md`](./deploy.md)「加好友 friend-requests（M17-3）」；本层只做外形校验 + HMAC 转发。

---

## 需粉丝 Token 的接口

### GET /posts `[Token]`

获取推荐页帖子列表（分页）。数据来自本节点 `POSTS_CACHE_KV['posts:latest']`，并只读合并 `POSTS_CACHE_KV['feed:latest']` 中来源为注册中心 `REGISTRY_URL` 的官方公告；普通关注节点仍只出现在 `/feed`。

**Query 参数**：
- `cursor`（可选）：上一批最后一条帖子的 `id`，用于游标分页
- `limit`（可选）：每页条数，默认 20，最大 50
- `scope`（可选）：`merged`（默认，推荐页 = 本节点帖 + 注册中心官方公告）或 `local`（仅本节点原创帖；供其它节点 Cron 拉取关注对象，不含官方公告）

**响应**：
```json
{
  "ok": true,
  "data": {
    "proto_version": "1.0",
    "items": [
      {
        "id": "post_xxx",
        "content": "帖子内容",
        "sig": "<ed25519签名>",
        "image_urls": ["https://alice-worker-b.workers.dev/img/abc"],
        "created_at": "2026-01-01T00:00:00.000Z"
      },
      {
        "id": "https://hailuo-registry.allovo.eu.org#official_xxx",
        "node_url": "https://hailuo-registry.allovo.eu.org",
        "post_id": "official_xxx",
        "source_type": "official",
        "content": "官方公告内容",
        "sig": "<ed25519签名>",
        "image_urls": [],
        "created_at": "2026-01-01T00:00:00.000Z"
      }
    ],
    "has_more": true,
    "cursor": "post_yyy",
    "generated_at": "2026-01-01T00:05:00.000Z",
    "stale": false
  }
}
```

**M9-12 韧性字段**（v2.6 R-1；**M13-3** envelope 合并 meta）：
- **M9-6**：`data.proto_version` 固定 `"1.0"`，仅在外层分页 envelope 出现；`items[]` 内各帖 DTO **不含** `proto_version`
- `generated_at`：Worker A 最近一次写入 KV 的时间（M13-3 起在 `posts:latest` / `feed:latest` envelope 的 `meta` 内；legacy 回落仍读 `:meta` 键）；KV miss 时为 `null`
- `stale`：`true` 表示 KV 未命中（返回空列表）或元信息显示陈旧；**不回源 Worker A 公网地址**
- 可选：`READ_SNAPSHOT_ON_MISS=true` 时 Worker B 经 Service Binding 拉 Worker A `/internal/cache-snapshot/*`（默认关闭）

**M34-OPT-2 翻页 KV 缓存优化**：
- 有 `cursor` 的翻页请求，Worker B 优先读 `POSTS_CACHE_KV['posts:page:{generated_at}:{scope}:{cursor}:{limit}']`（KV 页缓存）
- miss 时从 `posts:latest` 全量计算并 lazy populate 回写该 KV key，TTL=60s（与边缘缓存对齐）
- `generated_at` 作为 version：Worker A 发新帖后 `posts:latest` 版本变化，旧缓存自然失效，无需主动 invalidate
- `scope=local` 与 `scope=merged` 缓存分开（official posts 参与合并排序，结果不同）

**错误码**：
- `TOKEN_MISSING`（401）：未携带 Token
- `TOKEN_INVALID`（401）：Token 签名无效
- `TOKEN_EXPIRED`（401）：Token 已过期
- `BLACKLISTED`（403）：已被封禁

**缓存头**（M6-Pre1 模式感知）：公开读期 `Cache-Control: public, max-age=60`（`edgeCache` 边缘 60s TTL，R-AUDIT-V3 P2-3）；`FOLLOWER_TOKEN_MODE="enforced"` 后切为 `private, no-store` + `Vary: Authorization`。

**跨节点访问策略（M14 四档，原 M9-23）**：
- 作者节点读帖保护 canonical 五档：`public-read` / `token-required` / `following-only` / `mutual-only` / `owner-only`（遗留 env `enforced` 读作 `following-only`）。`public-read` 允许匿名读；protected 档要求有效粉丝 Token（含 `read_scope` claim）。
- `mutual-only` 申领 Token 须携带读者 Worker A 签发的 `read_mutual_proof`（Web/Cron 自动重试，见 [`m14-read-protection-plan.md`](./m14-read-protection-plan.md) M14-9）。
- 其它节点拉取关注对象时以对方 Worker B 为目标，不得直连对方 Worker A；protected 模式下请求须带 `Authorization: Bearer <ed25519_follower_token>`。
- Worker B 在 protected 模式下校验 Token exp、Ed25519 签名、`read_scope` 与当前档位、以及 `STATE_KV` 三前缀黑名单；M9-19 写操作还要求客户端携带经写层签名的 `envelope`。

---

### GET /posts/:id `[Token]`

获取单条帖子详情。

**响应**：
```json
{
  "ok": true,
  "data": {
    "id": "post_xxx",
    "content": "帖子内容",
    "sig": "<ed25519签名>",
    "image_urls": [...],
    "created_at": "...",
    "post_kind": "original",
    "repost_of": null
  }
}
```

**M9-1 扩展（已实现）**：`post_kind` 为 `original` | `repost`；转发帖 `content` 为空、`image_urls` 为空，通过 `repost_of` 引用原帖：

```json
"post_kind": "repost",
"repost_of": {
  "node_url": "https://bob-worker-b.example.workers.dev",
  "post_id": "post_01HXXX",
  "author_handle": "bob"
}
```

> 详见 [`m9-1-repost-plan.md`](./m9-1-repost-plan.md) §2.2。Worker B **不**服务端拉取原帖正文。

**错误码**：
- `POST_NOT_FOUND`（404）：帖子不存在或已删除

**缓存头**（M6-Pre1 模式感知）：公开读期 `Cache-Control: public, max-age=300`（`edgeCache` 边缘 5 分钟 TTL，M34-OPT-2）；`FOLLOWER_TOKEN_MODE="enforced"` 后切为 `private, no-store` + `Vary: Authorization`。

---

### GET /img/:key `[Token]`

读取媒体二进制（KV / R2 / B2 私有代理）。

key 格式：`kv:img_<hex>` / `r2:img_<hex>` / `b2:img_<hex>` / `filebase:img_<hex>`。

- `kv:`：键须为 `kv:img_` 加 32 位小写十六进制，否则 404 且不读 `IMAGE_KV`
- `r2:`：读 `HAILUO_IMAGE_R2` binding
- `b2:`：读 `STATE_KV` 键 `node:media_b2_config` 取得 B2 凭证，对私有桶签名 `GET` 后**流式代理**返回；不 302、不暴露 B2 URL 或 bucket 路径
- `filebase:`（M5-FB）：读 `STATE_KV` 键 `node:media_filebase_config`，对 Filebase 私有桶签名 `GET` 后**流式代理**返回；region 默认 `auto`

**响应**：二进制数据；`Content-Type` / `Content-Length` / `ETag` 来自上游安全子集。403/404 统一映射为 `IMAGE_NOT_FOUND`。

**缓存头**（M6-Pre1 模式感知，见上文 §缓存模式开关）：
- `FOLLOWER_TOKEN_MODE="public-read"`（默认）：`Cache-Control: public, max-age=31536000, immutable`（1 年 PoP 缓存）
- `FOLLOWER_TOKEN_MODE="enforced"`：`Cache-Control: private, no-store` + `Vary: Authorization`，避免边缘把图片钉到 PoP 后绕过 token / 黑名单

**媒体票据路径（SEC-AUDIT-2026-10-6a · MEDIA-TICKET-1）**：

Query 参数 `ticket`（可选）——protected 档下的**替代授权路径**，供浏览器 `<img src>` 直连（`<img>` 发不出 `Authorization` 头）：

- 票据由本节点 `POST /api/media/tickets` 签发，绑定**单个** `storage_key`，TTL 60s。
- 鉴权顺序：**票据 → Authorization**。合法票据 → 放行；**票据存在但非法**（过期 / 签名错 / 换 key / 版本不符）→ **403 `MEDIA_TICKET_INVALID`，且不回落 Authorization 路径**（避免「坏票据 + 有效 Bearer」被静默放行造成语义歧义）。
- 票据路径响应头：`Cache-Control: private, max-age=60` + `Referrer-Policy: no-referrer`（无 `Vary: Authorization`——票据路径不按 Authorization 区分响应）。
- `owner-only` 档**不接受**票据 → 403 `READ_PROTECTION_OWNER_ONLY`。
- 票据能力未启用（公开读档 / secret 未配 / 紧急关闸）→ `/img` 走 Authorization 或公开读路径，与改造前一致。
- ⚠️ 票据**不绑定浏览器会话**，只解决「能不能加载图」，不解决「是不是同一个粉丝」。

**错误码**：
- `IMAGE_NOT_FOUND`（404）：图片不存在、key 非法或 B2 运行态未配置（不暴露「B2 未配置」）
- `MEDIA_TICKET_INVALID`（403）：票据过期 / 签名无效 / 与当前 key 不匹配（仅在票据能力启用时出现）

---

### GET /feed（M4 后可用）

获取本节点聚合的关注 Feed（由本节点 Worker A Cron 每 5 分钟从关注节点拉取并写入 `POSTS_CACHE_KV['feed:latest']`）。

**Query 参数**：
- `cursor`（可选）：上一批最后一条条目的 `id`（`<node_url>#<post_id>` 格式），游标分页
- `limit`（可选）：每页条数，默认 20，最大 50

**响应**：
```json
{
  "ok": true,
  "data": {
    "proto_version": "1.0",
    "items": [
      {
        "id": "https://bob-worker-b.workers.dev#post_xxx",
        "node_url": "https://bob-worker-b.workers.dev",
        "post_id": "post_xxx",
        "author_handle": "hailuo-bob",
        "content": "帖子内容",
        "sig": "<ed25519签名>",
        "image_urls": ["https://bob-worker-b.workers.dev/img/kv:img_yyy"],
        "created_at": "2026-01-01T00:00:00.000Z",
        "post_kind": "original",
        "repost_of": null
      }
    ],
    "has_more": false,
    "cursor": null,
    "generated_at": "2026-01-01T00:05:00.000Z",
    "stale": false,
    "partial_failed_count": 0
  }
}
```

**说明**：
- Feed 内容来自 `POSTS_CACHE_KV['feed:latest']`，由 Worker A Cron 聚合写入（M4-4），最多 50 条，按 `created_at DESC` 排序
- **M9-1-4**：关注节点 `scope=local` 若含 `post_kind=repost`，item 带 `repost_of`（原帖懒加载，不在服务端拉正文）
- Feed 为空时返回 `items: []`，不报错
- **M9-6**：`data.proto_version` 固定 `"1.0"`（外层 envelope，不污染 `items[]` 内 DTO）
- **M9-14 元信息**：`generated_at` / `stale` / `partial_failed_count` 来自 `feed:latest:meta`；关注数 >40 时 Cron 分批拉取，`partial_failed_count>0` 表示上一轮 batch 有节点拉取失败
- Token 鉴权在 M6 后补充，当前无需 Token
- **M34-OPT-4**：有 `cursor` 时优先读 `POSTS_CACHE_KV['feed:page:{generated_at}:{cursor}:{limit}']；miss 时 lazy populate 并回写（TTL 60s）；`generated_at` 作为 version，feed 刷新后版本变化旧缓存自然失效；feed D1 有 `LIMIT 50` 硬上限，分页缓存每天 KV 写最多 864 次（3 页 × 288 次/天），远在 Free Tier 1K/天限额内

**缓存头**（M6-Pre1 模式感知）：同 GET /posts，公开读期 60s 边缘缓存（R-AUDIT-V3 P2-3）；enforced 下不进共享缓存。

---

## 公开互动接口（M9-18）

公开互动入口位于原帖所属节点的 Worker B。Worker B 只做极窄代理：强制校验粉丝 Token，写操作校验 envelope actor 的 `node_url` 与 token `sub` 一致、`handle` 与 token `fan`（存在时）一致，再通过 Service Binding + HMAC 转发给本节点 Worker A；Worker B 不写 D1/KV。Worker A 独立要求并验证签名 envelope，内部转发不能绕过验签（SEC-AUDIT-2026-10-4）。

这些接口即使 `FOLLOWER_TOKEN_MODE="public-read"` 也必须携带粉丝 Token，因为点赞/回复需要明确 actor 身份。

### POST /interactions/posts/:postId/summary `[Token]`

读取当前粉丝视角的互动摘要。

**响应**：
```json
{
  "ok": true,
  "data": {
    "post_id": "post_xxx",
    "like_count": 3,
    "reply_count": 2,
    "liked_by_me": true
  }
}
```

### POST /interactions/posts/:postId/like `[Token]`

点赞原帖；同一个 `actor_node_url` 对同一帖子重复点赞会被去重。

**M9-19 请求**（须先经写层 `POST /api/interactions/sign-envelope` 获取 envelope）：
```json
{
  "envelope": {
    "type": "like",
    "post_id": "post_xxx",
    "actor": {
      "handle": "bob",
      "node_url": "https://bob-worker-b.workers.dev",
      "pubkey": "<64 hex>"
    },
    "created_at": "2026-06-21T12:00:00.000Z",
    "nonce": "<32 hex>",
    "body_hash": "",
    "sig": "<128 hex>"
  }
}
```

缺失 `envelope` 返回 `400 ENVELOPE_REQUIRED`。

**响应**：同 summary。

### DELETE /interactions/posts/:postId/like `[Token]`

取消点赞。请求为 `{ "envelope": ... }`，结构同点赞示例，但须重新获取 `type: "unlike"` 的 envelope；缺失返回 `400 ENVELOPE_REQUIRED`。

**响应**：同 summary。

### POST /interactions/posts/:postId/replies `[Token]`

回复原帖，内容最多 300 字符。

**请求**：
```json
{
  "envelope": {
    "type": "reply",
    "post_id": "post_xxx",
    "actor": {
      "handle": "bob",
      "node_url": "https://bob-worker-b.workers.dev",
      "pubkey": "<64 hex>"
    },
    "created_at": "<当前 ISO 8601 时间>",
    "nonce": "<32 hex>",
    "body_hash": "<trim 后回复内容的 SHA-256 hex>",
    "sig": "<128 hex>"
  },
  "content": "回复内容"
}
```

须使用同一份 trim 后内容签发 envelope；只发送 `content` 或顶层 `actor` / `sig` 已不受支持。当前 Web 已采用签名流程；旧客户端须升级，不提供未验签兼容开关。

**响应**：
```json
{
  "ok": true,
  "data": {
    "reply": {
      "id": "reply_xxx",
      "post_id": "post_xxx",
      "actor_handle": "bob",
      "actor_node_url": "https://bob-worker-b.workers.dev",
      "content": "回复内容",
      "created_at": "2026-06-19T00:00:00.000Z"
    },
    "summary": {
      "post_id": "post_xxx",
      "like_count": 3,
      "reply_count": 2,
      "liked_by_me": true
    }
  }
}
```

### GET /interactions/posts/:postId/replies `[Token]`

读取最近回复。

**Query 参数**：
- `limit`（可选）：默认 20，最大 50

**响应**：
```json
{
  "ok": true,
  "data": {
    "proto_version": "1.0",
    "items": [
      {
        "id": "reply_xxx",
        "post_id": "post_xxx",
        "actor_handle": "bob",
        "actor_node_url": "https://bob-worker-b.workers.dev",
        "content": "回复内容",
        "created_at": "2026-06-19T00:00:00.000Z"
      }
    ]
  }
}
```

**错误码**：
- `ACTOR_INVALID`（400）：Token payload 无法构造互动身份
- `POST_NOT_FOUND`（404）：帖子不存在或已删除
- `REPLY_CONTENT_REQUIRED`（400）：回复内容为空
- `REPLY_CONTENT_TOO_LONG`（400）：回复超过 300 字符
- `WORKER_A_BINDING_MISSING`（503）：Worker B 未配置 `WORKER_A` Service Binding
- `INTERNAL_FORWARD_SECRET_MISSING`（503）：Worker B 未注入 `INTERNAL_FORWARD_SECRET`

---

## 帖子签名验证说明

客户端可使用以下方式验证帖子签名：

1. 用 `GET /users/:handle` 获取发布者的 `pubkey`
2. 对帖子的 `content + created_at + id` 拼接字符串进行 Ed25519 验签
3. 验签通过则内容真实，未被篡改

---

## 错误码汇总

| 错误码 | HTTP 状态 | 含义 |
|---|---|---|
| `TOKEN_MISSING` | 401 | 未携带粉丝 Token |
| `TOKEN_INVALID` | 401 | Token 签名无效 |
| `TOKEN_EXPIRED` | 401 | Token 已过期 |
| `TOKEN_SCOPE_INSUFFICIENT` | 403 | Token `read_scope` 低于当前节点读帖保护档位（M14-1） |
| `READ_PROTECTION_OWNER_ONLY` | 403 | `owner-only` 下 Worker B 读端点拒绝一切 follower token（M14-4/5） |
| `TOKEN_REVOKED` | 401 | Token 已被吊销（黑名单） |
| `BLACKLISTED` | 403 | 请求者已被封禁 |
| `MISCONFIGURED` | 503 | 读帖保护模式非法，或 protected 档黑名单 STATE_KV 异常且无 stale 缓存（NCF-READ-POLICY） |
| `ACTOR_INVALID` | 400 | 互动身份无效 |
| `REPLY_CONTENT_REQUIRED` | 400 | 回复内容为空 |
| `REPLY_CONTENT_TOO_LONG` | 400 | 回复超过 300 字符 |
| `POST_NOT_FOUND` | 404 | 帖子不存在 |
| `IMAGE_NOT_FOUND` | 404 | 图片不存在 |
| `INTERNAL_ERROR` | 500 | 服务器内部错误 |
| `INVALID_BODY` | 400 | `POST /api/follower-tokens` 请求体非 JSON（M6-0a） |
| `NODE_URL_REQUIRED` | 400 | `POST /api/follower-tokens` `follower_node_url` 缺失（M6-0a） |
| `NODE_URL_INVALID` | 400 | `POST /api/follower-tokens` `follower_node_url` 不以 `https://` 开头（M6-0a） |
| `INTERNAL_FORWARD_REJECTED` | 401 | `POST /api/follower-tokens` 转发到 Worker A 时两端 secret 不一致（部署错误，M6-0a） |
| `WORKER_A_BINDING_MISSING` | 503 | `POST /api/follower-tokens` Worker B 未配置 `[[services]] WORKER_A` Service Binding（M6-0a） |
| `INTERNAL_FORWARD_SECRET_MISSING` | 503 | `POST /api/follower-tokens` Worker B 未注入 `INTERNAL_FORWARD_SECRET` secret（M6-0a） |
| `UPSTREAM_ERROR` | 502 | `POST /api/follower-tokens` Service Binding 调用 Worker A 异常（M6-0a） |
| `MEDIA_TICKET_DISABLED` | 503 | `POST /api/media/tickets` 未启用（当前档不需要 / secret 未配 / `MEDIA_TICKET_ENABLED` 紧急关闸）· SEC-6-AUTO |
| `STORAGE_KEY_REQUIRED` | 400 | `POST /api/media/tickets` `storage_key` 缺失 · SEC-AUDIT-2026-10-6a |
| `MEDIA_TICKET_KEY_INVALID` | 400 | `POST /api/media/tickets` `storage_key` 不在媒体前缀白名单（批量形态下任一元素非法即整单拒绝）· SEC-AUDIT-2026-10-6a |
| `TOO_MANY_STORAGE_KEYS` | 400 | `POST /api/media/tickets` `storage_keys` 长度超过 32 · SEC-AUDIT-2026-10-6b |
| `MEDIA_TICKET_INVALID` | 403 | `GET /img/:key` 票据过期 / 签名无效 / 与当前 key 不匹配 · SEC-AUDIT-2026-10-6a |


### POST /groups/moderation（EPOCH-MOD-1）

跨节点管理员踢人公开入口，不使用粉丝 Token。B 限请求体 16KB，校验信封外形与时间，通过 Service Binding + HMAC 原文转发权威处理；不持有 D1、不以 HMAC 替代管理员签名。全部响应 `Cache-Control: private, no-store`。

wire 字段：`kind=GROUP_MODERATION_KICK`、`group_id`、`owner_worker_b_url`、`actor_worker_b_url`、`target_member_worker_b_url`、`expected_epoch`、`timestamp`、`nonce`、`sig`。签名输入按此顺序取前八字段，每项一行、无末尾换行，epoch 为正安全整数的十进制表示。签名 Ed25519 hex；nonce 为 32～64 位小写 hex；timestamp 为规范 ISO UTC，允许 ±5min。URL 不允许空白、尾斜杠、凭据、query 或 hash；签名前后不得 trim。固定 kind 防跨协议签名挪用；群主 URL、管理员、目标与 epoch 均受签名保护。

权威必须是本机群主且群未解散，使用成员表 pin 公钥验证 active 且 is_admin=1 的管理员；不信任请求自带公钥或本地镜像。验签后原子消费 D1 nonce，重放不扣额度；每群每管理员 UTC 小时 30 次，与补钥额度隔离。复用 `group_nonces` / `group_rate_buckets`，桶前缀 `fast-pull|moderation|` 纳入现有有界 GC，零 KV 写、无新 Cron/schema/binding。

成功：`{ "ok": true, "data": { "group_id": "grp_example1", "member_worker_b_url": "https://member.example.com", "status": "kicked", "new_epoch": 1, "rekey_scheduled": true } }`。本步先隔绝并 force 摘树边，删除目标 wraps/pending，不推进 epoch 或置其他成员 pending。完整换钥等待 REKEY，旧钥仍可能解密旧密文。

失败：400 `GROUP_ENVELOPE_INVALID`/`INVALID_BODY`；413 `GROUP_ENVELOPE_TOO_LARGE`；403 `GROUP_MODERATION_FORBIDDEN` 或 `GROUP_NOT_MEMBER`；404 `GROUP_NOT_MEMBER`/`GROUP_NOT_FOUND`；409 `GROUP_NONCE_REPLAY`/`EPOCH_CONFLICT`/`KICK_FAILED`；429 `GROUP_RATE_LIMITED`；503 `GROUP_MODERATION_UNAVAILABLE`（含隔绝已生效但 force 建树失败；配置缺失沿用 ingress 配置错误码）。对已 `kicked` 目标换新 nonce 重试可幂等收尾（再建树 + 缺 system 则补发）。存储/网络失败关闭，不回显原始异常或节点地址。pin 本身不证明 URL 外部所有权；此步不新增 URL 所有权协议。
