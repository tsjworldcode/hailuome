# Worker A API 契约文档

> **v2.5 对齐**（M1-0）：补充「注册接口」「站主直读接口」「注册中心上游契约」三节；
> 对齐注册中心实际路由（登记 **必填** `email`、precheck **不要求** `email_verify_token`；
> **方案 B**：仅 `email_status='verified'` 的邮箱参与登记冲突；验证码仅事后 `/certify`）。
> 权威：[`hailuo-registry/docs/m33-expert-review-followup-plan.md`](../../hailuo-registry/docs/m33-expert-review-followup-plan.md)。
> `/api/register/challenge/verify`、`/lookup/:handle` 无 `/api` 前缀。

Worker A 是私密写层，地址永不对外暴露。只有节点所有者本人（通过 JWT）可以调用写接口。

**Base URL**：`https://<worker-a-route>.<zone>.workers.dev`（生产环境由 `wrangler.toml` 配置；本地开发 `http://localhost:8787`）

> ⚠️ Worker A 地址**不写入任何公开文档、不配置为 CORS 域名**（§8 F-02）。
>
> **M9-23 目标边界**：站主 Web 生产写层请求不再经 Worker B owner-proxy，而是由 Pages Functions 或独立 Owner Gateway 通过 Cloudflare Service Binding + HMAC 转发到 Worker A。浏览器只访问 Pages/网关同源地址；Worker A 仍保持私有，不登记到注册中心、不通告给粉丝、不作为公开 CORS 目标。

---

## 认证

### 站主 JWT（站主自用接口）

除 `/health`、`/auth/login`、`/auth/login-params`、`/.well-known/hailuo-proof` 外，所有接口需要携带：

```
Authorization: Bearer <jwt>
```

JWT 通过 `POST /auth/login` 获取，有效期 24h（可配置）。M12-1 计划引入 TOTP 后，已启用二次验证的站主必须在密码正确后同时提交 TOTP code 或恢复码，Worker A 才会签发 JWT；未启用 TOTP 的节点保持现有登录行为。

生产部署中，站主 Web 的 JWT 请求应走站主专用内部通道：`Web Pages → Pages Functions / Owner Gateway → Worker A`。Pages 网关通过 `WORKER_A` Service Binding 转发，并附加：

| 头 | 说明 |
|----|------|
| `X-Hailuo-Pages-Proxy: owner-gateway` | Pages 站主通道标记 |
| `X-Hailuo-Client-Ip` | Cloudflare 边缘注入的客户端 IP（**须**在 HMAC v3 签名材料内） |
| `X-Internal-Forward: hmac-v2` | 内部转发协议版本 |
| `X-Timestamp` / `X-Nonce` / `X-Signature` | HMAC v3：`METHOD path\nTS:NONCE:BODY:CLIENT_IP` |

迁移期旧部署经 **Worker B owner-proxy**（`OWNER_PROXY_MODE=compat`）时，B 侧附加 `X-Hailuo-Owner-Proxy: compat` + 同样的 v3 IP 头；Worker A `resolveTrustedClientIp` 对两路径等价处理。新设计不得把站主登录、发帖、关注、黑名单等管理能力继续依赖 Worker B 的公开入口可用性。

**站主通道客户端 IP（M7-30h-4 / M7-30i-1）**：登录与换域 step-up 的 `login_attempts` 频控依赖可信客户端 IP。Service Binding 会丢失浏览器原始 IP，因此：

| 路径 | 代理标记 | 签名 | 客户端 IP 头 |
|------|----------|------|--------------|
| Pages Owner Gateway | `X-Hailuo-Pages-Proxy: owner-gateway` | HMAC **v3**（材料含 `clientIp`） | `X-Hailuo-Client-Ip`（来自 `CF-Connecting-IP`） |
| Worker B compat（`OWNER_PROXY_MODE=compat`） | `X-Hailuo-Owner-Proxy: compat` | 同上 v3 | 同上 |

Worker A 仅在 HMAC v3 验签通过后信任 `X-Hailuo-Client-Ip`；不得盲信浏览器提交的 `X-Forwarded-For`。

### 注册中心鉴权头 + 节点 Ed25519 请求签名（Worker A 作为客户端时）

Worker A 调用注册中心所有接口（precheck 阶段除外）统一通过内部 `registryFetch()` 帮助函数注入身份头 + 签名三头（**NCF-HS** 起为身份**三头** + 签名三头）：

```
# 身份（NCF-HS：User-Id + Handle + Bearer）
X-Hailuo-Node-User-Id: <owner_user_id>
X-Hailuo-Node-Handle: <encodeURIComponent(normalize(handle_local))>
Authorization: Bearer <node_api_token>

# M22-5 节点签名三头：防重放 + 防篡改
X-Timestamp: <unix_sec>
X-Nonce: <random_hex_16>
X-Signature: <ed25519_signature_hex>
```

**身份头**：`owner_user_id` / `node_api_token` 从 D1 `system_config` 读取；`X-Hailuo-Node-Handle` 为规范化本地段后再 **`encodeURIComponent`**（保留 `_`；中文安全）。手写脚本应走 `scripts/lib/registry-auth-headers.mjs`，勿裸写未编码 handle。

**M22-5 节点 Ed25519 签名三头（v2 签名材料）**：

- 算法：`Ed25519.sign(env.ED25519_PRIVATE_KEY, "<METHOD> <path>\n<unix_sec>:<nonce_hex>:<body>")`，签名结果为 64 字节 hex（128 hex chars）
- 输入：
  - `<METHOD>` 取 `(opts.method ?? 'GET').toUpperCase()`（大写化防 GET/get 不一致）
  - `<path>` 取调用 `registryFetch(env, path, opts)` 时传入的 `path`，**包含 query string 字面量**（如 `/api/posts/feed?since=2026-05-24T06:00:00Z`），不重排 query、不剥 query
  - `<body>` 取 `opts.body ?? ''`，GET 请求 body 为空串
- 防护：
  - **防篡改**：body 进签名输入，注册中心收到后用该节点注册公钥验签
  - **防重放（时戳 + nonce）**：5 分钟窗口 + nonce 在窗口内唯一（注册中心 D1 `hmac_nonces` 表继续作为 nonce 去重表，实际 key 为 `<user_id>:<nonce>`，5min 窗口内同一节点复用 nonce 返 429 + `Retry-After: 0`）
  - **防跨端点重放**：v2 签名材料含 method+path+query，同一签名对不同端点 / 不同动词 / 不同 query 不可互重放
- 与 `node_api_token` 解耦：`node_api_token` 只用于定位注册节点；请求完整性由该节点自己的 `ED25519_PRIVATE_KEY` 证明，注册中心用 `users.pubkey` 验签，不再需要全网共享 `HMAC_SECRET`
- 路径分工：
  - `registryDailySync.ts` Cron **`POST /api/node/daily-sync`**（M-DS-1 起替代独立 health Cron）：✅ 签名
  - `lookup.ts` 缓存回源 `GET /lookup/:handle`：✅ 签名
  - `register.ts` 注册前流程（email-verify-request / email-verify-confirm / precheck）：❌ 不走 `registryFetch`（节点尚未拿到 `node_api_token`，靠 Turnstile + 邮箱验证 + challenge 签名保护）
  - `.well-known/hailuo-proof`：❌ 不签名（入站端点，不是出站请求）

**部署提示**：节点侧不需要配置 `HMAC_SECRET`。生产只需要保证注册中心已执行 `0021_user_pubkey.sql`，把历史注册成功的 `challenges.pubkey` 回填到 `users.pubkey`；新注册节点会在 verify 成功时直接写入 `users.pubkey`。因此已注册节点通常不需要重新注册，重新部署 Worker A 后即可用现有 Ed25519 私钥签名请求。

---

## 公开接口

### GET /health

节点健康探活。

**响应**：
```json
{ "ok": true, "service": "worker-a", "version": "0.1.0" }
```

---

### GET /auth/login-params

登录前获取 PBKDF2 参数（**浏览器 derive 用**；Worker 边缘不跑 PBKDF2）。

**Query**：`username=<站主用户名>`（必填）

**响应**：
```json
{
  "ok": true,
  "data": {
    "kdf_version": "v1",
    "kdf_algo": "PBKDF2",
    "iterations": 100000,
    "hash_name": "SHA256",
    "salt_hex": "<32 hex chars>"
  }
}
```

- 用户名不存在时仍返回 dummy salt（与 `DUMMY_PASSWORD_HASH` 一致），防枚举；客户端 derive 后 POST `/auth/login` 仍得 `AUTH_INVALID`。
- `owner_credentials` 表为空时返 `404 NO_CREDENTIALS`（须先 seed / owner-bootstrap）。

---

### POST /auth/login

登录，获取 JWT。

> **M2-1b 起**：站主凭证由 D1 `owner_credentials` 表管理（PBKDF2-SHA256，迭代次数写在 hash 字符串内）。**PBKDF2 在浏览器完成**（或部署脚本 seed 时一次性计算）；Worker 仅做 `password_hash` 常数时间字符串比对，避免 Workers Free 10ms CPU 上限。
>
> **推荐流程**：`GET /auth/login-params?username=` → 浏览器 `derivePasswordHash` → `POST /auth/login` 传 `password_hash`。
>
> **失败频控**：同 IP 在 **15 分钟内累计 5 次失败** 自动锁定 **5 分钟**，期间任何登录请求（含正确凭证）一律返 `LOGIN_LOCKED`。客户端 IP 优先级 `CF-Connecting-IP > X-Forwarded-For 首段 > 'unknown'`。
>
> **M34-1**：成功登录额外写入 D1 `owner_sessions` / `owner_login_events`（IP 仅存 hash，禁止明文回显），并返回 `session_id`；Web 用其做心跳。

**请求体（正式路径，推荐）**：
```json
{
  "username": "<站主用户名>",
  "password_hash": "v1:PBKDF2:<iterations>:SHA256:<saltHex>:<hashHex>"
}
```

`password_hash` 为客户端用 `login-params` 返回的 `salt_hex` + `iterations` 对明文密码 PBKDF2 后的**完整 v1 字符串**（与 D1 存值格式一致）。**勿再传明文 `password`**（Worker 正式路径已弃用）。

**M12-1 TOTP 扩展（已实施）**：启用站主 TOTP 后，第二步登录继续复用本接口，前端重新提交同一 `username + password_hash`，并附带 `totp_code` 或 `recovery_code`。Worker A 在密码正确后校验二次因子，成功才签 JWT。

```json
{
  "username": "<站主用户名>",
  "password_hash": "v1:PBKDF2:<iterations>:SHA256:<saltHex>:<hashHex>",
  "totp_code": "123456",
  "recovery_code": "ABCD-EFGH"
}
```

字段规则：
- `totp_code` 与 `recovery_code` 二选一；两者同时存在时服务端只按 `totp_code` 校验，TOTP 失败后不再回退校验恢复码。
- TOTP 未启用时忽略二次因子字段，行为与现有登录一致。
- TOTP 已启用且未传二次因子时，返回 `TOTP_REQUIRED`，不签发 JWT，不计入失败频控。
- 登录路径二次因子错误码：`totp_code` 校验失败 → `TOTP_INVALID`；`recovery_code` 校验失败 → `RECOVERY_CODE_INVALID`。均计入 `login_attempts` IP 失败频控；不在各自类别内再细分过期、重放、格式错等子原因。
- 同一 TOTP counter 不可重复使用；恢复码用于登录、禁用 TOTP、刷新恢复码时均只能使用一次。
- `TOTP_REQUIRED` 会暴露“一因子已通过且该账号启用 TOTP”，这是 M12-1 无 challenge 表设计接受的 tradeoff；靠 IP 频控、6 位动态码、恢复码一次性使用缓解风险。

**请求体（老 secret 兼容回落，仅在节点尚未运行 `scripts/owner-bootstrap.mjs` 写入 `owner_credentials` 时启用）**：
```json
{ "secret": "<旧 JWT_SECRET>" }
```

老路径下服务端会以 `console.warn` 记录"未配置 owner_credentials，回落使用 JWT_SECRET"，并在响应里返 `legacy_mode: true` 标记。前端应据此引导用户走 `POST /auth/change-password` 一次性迁移到新路径。

**响应**：
```json
{
  "ok": true,
  "data": {
    "token": "<jwt>",
    "expires_at": "2026-01-02T00:00:00.000Z",
    "legacy_mode": true,
    "session_id": "oss_…"
  }
}
```

字段：
- `token`：HS256 JWT，24h 有效期；保存在 `Authorization: Bearer <token>` 头中
- `expires_at`：ISO 8601 过期时间
- `legacy_mode?: boolean`：仅老 secret 回落路径下为 true，正式路径不出现该字段
- `must_change_credentials?: boolean`：M8-7 命令行部署注入默认 `admin`/`admin` 后为 true；前端应引导用户走 `change-password` 更换用户名与密码
- `session_id?: string`：**M34-1** 浏览器会话 ID；Web 心跳 / 登出携带；审计失败时可能省略

**错误码**：
- `AUTH_INVALID`（401）：**用户名不存在 / 密码错误 / 缺字段 一律返此码**，响应内容完全一致以防用户名枚举
- `LOGIN_LOCKED`（429）：IP 触发频控锁定，5 分钟后自动解锁
- `TOTP_REQUIRED`（401，M12-1 计划）：密码正确但账号已启用 TOTP，需继续提交 `totp_code` 或 `recovery_code`
- `TOTP_INVALID`（401，M12-1 计划）：**登录 / 管理**接口中 `totp_code` 校验失败（不正确、过期或重放；不分子原因）
- `RECOVERY_CODE_INVALID`（401，M12-1 计划）：**登录 / 管理**接口中 `recovery_code` 校验失败（不存在、已使用或格式无效）

### POST /auth/session/heartbeat

**JWT 鉴权**。**M34-1 / M34-5**：更新 `owner_sessions.last_seen_at`，并写 `system_config.owner_engagement=active` / `owner_last_seen_at`。心跳窗口默认 300s（`OWNER_SESSION_TTL_SEC`）。

**请求体**（可空对象）：
```json
{ "session_id": "oss_…" }
```

无 `session_id` 时按 JWT 指纹续开或复用最近未结束会话。

**M34-5**：若携带的 `session_id` 已超时 / 已结束 / 指纹不符，但 **JWT 仍有效**，服务端**自动结束旧行并重开会话**，返回新的 `session_id` 与 `owner_engagement=active`，**不再**因旧会话卡死返回 `SESSION_EXPIRED` / `SESSION_NOT_FOUND`（避免「浏览器还登录着、Cron 却永久 dormant」）。

**成功**：
```json
{
  "ok": true,
  "data": {
    "session_id": "oss_…",
    "owner_engagement": "active",
    "last_seen_at": "2026-08-29T08:00:00.000Z"
  }
}
```

**错误码**：`UNAUTHORIZED`（401，缺/无效 JWT）。响应**不含**明文 IP。（历史 `SESSION_NOT_FOUND` / `SESSION_EXPIRED` 仅兼容旧客户端；当前实现在 JWT 有效时不返回。）

### POST /auth/logout

**JWT 鉴权**。**M34-1**：结束当前 `session_id`（或该 JWT 最近开会话）；若无其它窗口内活跃会话则 `owner_engagement=dormant`。

**请求体**（可空）：`{ "session_id": "oss_…" }`

**成功**：
```json
{
  "ok": true,
  "data": { "ended": true, "owner_engagement": "dormant" }
}
```

`TOTP_REQUIRED` 响应示例：

```json
{
  "ok": false,
  "error_code": "TOTP_REQUIRED",
  "message": "请输入二次验证码",
  "data": { "totp_required": true }
}
```

---

### M12-1 TOTP 管理接口（已实施）

> 详细计划见 [`m12-1-totp-login-plan.md`](./m12-1-totp-login-plan.md)。实现时必须同步 `packages/shared-utils/owner-gateway-allowlist.json`，保证 Pages Owner Gateway、Worker B compat 白名单、Worker A 路由与 Web client 四处一致。

TOTP 管理接口均需站主 JWT。启用、禁用、刷新恢复码还必须做当前密码二次校验；密码 PBKDF2 仍在浏览器完成，Worker 只比较 `password_hash`。

通用规则：
- legacy secret 回落路径不支持 TOTP；必须先完成 `owner_credentials` 迁移。
- `must_change_credentials=true` 时禁止 setup / enable TOTP，站主必须先修改默认用户名和密码。
- TOTP 固定 `period=30` 秒、`digits=6`、`algorithm=SHA1`，校验窗口为当前 counter `±1`。
- 恢复码一次生成 10 个，展示格式 `XXXX-XXXX`；服务端校验前 trim、转大写、移除空格并归一化连字符。
- Worker A 缺少 `TOTP_WRAP_SECRET` 时，setup / enable / disable / rotate 返回 503 `TOTP_WRAP_SECRET_MISSING`。
- 改用户名时必须同事务迁移 `owner_totp_settings`、`owner_totp_pending`、`owner_totp_recovery_codes` 的 `username`；若实现无法保证同事务迁移，应禁止已启用 TOTP 的账号改用户名。

#### GET /auth/totp/status

读取当前登录用户名的 TOTP 状态。

**鉴权**：`Authorization: Bearer <jwt>`

**响应**：
未启用：
```json
{
  "ok": true,
  "data": {
    "enabled": false,
    "enabled_at": null,
    "recovery_codes_remaining": 0
  }
}
```

已启用：
```json
{
  "ok": true,
  "data": {
    "enabled": true,
    "enabled_at": "2026-06-27T00:00:00.000Z",
    "recovery_codes_remaining": 8
  }
}
```

#### POST /auth/totp/setup

创建 10 分钟有效的 pending TOTP secret。响应里的 `secret_base32` / `otpauth_url` 只用于本次启用展示，D1 只保存包裹后的 secret。

**请求**：
```json
{
  "password_hash": "v1:PBKDF2:..."
}
```

**响应**：
```json
{
  "ok": true,
  "data": {
    "secret_base32": "JBSWY3DPEHPK3PXP",
    "otpauth_url": "otpauth://totp/...",
    "expires_at": "2026-06-27T00:10:00.000Z"
  }
}
```

#### POST /auth/totp/enable

用 pending secret 校验首个 TOTP code，成功后启用 TOTP 并生成一次性恢复码。

**请求**：
```json
{
  "password_hash": "v1:PBKDF2:...",
  "totp_code": "123456"
}
```

**响应**：
```json
{
  "ok": true,
  "data": {
    "enabled": true,
    "recovery_codes": [
      "ABCD-EFGH",
      "IJKL-MNOP",
      "QRST-UVWX",
      "2345-6789",
      "KLMN-2345",
      "PQRS-6789",
      "WXYZ-3456",
      "789A-BCDE",
      "FGHJ-KMNP",
      "TVWX-YZ23"
    ]
  }
}
```

#### POST /auth/totp/disable

关闭 TOTP。需 `password_hash` + `totp_code` 或 `recovery_code`。

**请求**：
```json
{
  "password_hash": "v1:PBKDF2:...",
  "totp_code": "123456",
  "recovery_code": "ABCD-EFGH"
}
```

**响应**：
```json
{
  "ok": true,
  "data": {
    "enabled": false,
    "disabled_at": "2026-06-27T00:00:00.000Z"
  }
}
```

若使用恢复码禁用，该恢复码先标记为已使用；禁用成功后删除剩余恢复码与 TOTP secret。

#### POST /auth/totp/recovery-codes/rotate

刷新恢复码。需 `password_hash` + `totp_code`；成功后作废旧的未使用恢复码，只展示本次新码。

**请求**：
```json
{
  "password_hash": "v1:PBKDF2:...",
  "totp_code": "123456",
  "recovery_code": "ABCD-EFGH"
}
```

**响应**：
```json
{
  "ok": true,
  "data": {
    "recovery_codes": [
      "ABCD-EFGH",
      "IJKL-MNOP",
      "QRST-UVWX",
      "2345-6789",
      "KLMN-2345",
      "PQRS-6789",
      "WXYZ-3456",
      "789A-BCDE",
      "FGHJ-KMNP",
      "TVWX-YZ23"
    ]
  }
}
```

若用恢复码刷新，先消耗该恢复码，再作废旧未用恢复码并生成新 10 个恢复码。若同时传 `totp_code` 与 `recovery_code`，只校验 `totp_code`。

**错误码（计划）**：
- `TOTP_INVALID`：`totp_code` 校验失败（disable / rotate / enable 等）
- `RECOVERY_CODE_INVALID`：`recovery_code` 校验失败（disable / rotate / login）
- `TOTP_NOT_ENABLED`：当前登录用户名未启用 TOTP
- `TOTP_ALREADY_ENABLED`：当前登录用户名已启用 TOTP，不能重复 setup/enable
- `TOTP_SETUP_EXPIRED`：pending secret 已过期，需要重新 setup
- `TOTP_WRAP_SECRET_MISSING`（503）：Worker A 缺少 `TOTP_WRAP_SECRET`，TOTP 管理 fail-closed
- `AUTH_INVALID`：密码二次校验失败

### GET /auth/me

获取当前登录用户信息。

**响应**：
```json
{
  "ok": true,
  "data": {
    "handle": "alice",
    "handle_qualified": "alice",
    "display_name": "Alice",
    "bio": "Hello from Alice",
    "worker_b_url": "https://alice-worker-b.workers.dev",
    "avatar_key": "kv:img_xxx",
    "contact_email": "alice@example.com",
    "created_at": "2026-06-17T00:00:00.000Z",
    "pubkey": "<ed25519_public_key_hex>",
    "registry_user_id": "usr_…",
    "pubkey_fingerprint": "key_…",
    "did_v2": "did:hailuo:<64hex>",
    "must_change_credentials": true
  }
}
```

`must_change_credentials` 仅在为默认站主账号且尚未完成首次改密时出现。

`did_v2` 优先读 `system_config.did_v2`（登记完成时写入）；若缺失则按站主公钥派生 `did:hailuo:<64hex>`。

`handle_qualified` 为对外正式名（HANDLE-QUAL-V1，SSOT：registry `docs/handle-qualified-format-v1.md`）：只有 HC 认证成功（`handle_scope=global`）才是裸 `handle`（如 `alice`）；**其余一律**为 `handle:registry_id`（如 `hailuo-7ax89bns:reg1`，主中心也不再例外）。优先读 `system_config.handle_qualified`（入库前把历史 `alice@reg1` 规范为 `alice:reg1`）；若缺失且已登记，则按 home `registry_id` 合成带区域名。未登记时为 `null`。

> **node_url 与 worker_b_url 关系（M-OPT-SPLIT-B 系列 ✅）**：
>
> 本仓库 `users` 表**无独立 `node_url` 列**，`worker_b_url` 即节点的权威公开基址。
>
> **语义约束**（B-1 ✅ · `0080_url_semantic_guard.sql`）：
> - `users.worker_b_url` **非空**（SQL CHECK：`LENGTH(worker_b_url) > 0`）
> - `users.worker_b_url` 必须以 `http://` 或 `https://` 开头（SQL CHECK）
>
> **Phase 1 同源策略**（B-2 ✅ · 路由层）：
> - 节点**只能写自己本地**的 `worker_b_url`（从 `resolveLocalPublicBaseUrl()` 获取，不能从外部传入）
> - 注册/换域流程中，`worker_b_url` 由站主 env 注入，不由粉丝/外部节点控制
>
> **Phase 2（M27-0 后）**：允许 operator 显式配置不同源 host，届时应用层放宽同源限制。

---

### PATCH /auth/profile

更新当前节点站主**公开资料**（昵称、简介、头像、公开联系邮箱）。**鉴权**：`Authorization: Bearer <jwt>`。

`contact_email` 是站主主动填写的公开联系邮箱，不自动公开登记邮箱。

**不得**通过本接口修改 `birth_date` / `gender` / `country` / `phone`（登记人口学已下架，SPILL-1c）；请求体若含这些字段返回 `409 USE_REGISTRATION_PROFILE`。登记邮箱请走 `PATCH /api/local/registry/registration-profile`。

**请求**：
```json
{
  "display_name": "Alice",
  "bio": "一句话介绍自己或这个节点",
  "avatar_key": "kv:img_xxx",
  "contact_email": "alice@example.com"
}
```

**响应**：与 `GET /auth/me` 的 `data` 字段同形（**不再**含 `birth_date`/`gender`；SPILL-1c 起公开资料投影已剥离人口学）。

**错误码**：
- `BAD_REQUEST`（400）：请求体不是 JSON、字段类型/邮箱格式不正确
- `USE_REGISTRATION_PROFILE`（409）：请求体含 `birth_date` / `gender` / `country` / `phone`
- `USER_NOT_REGISTERED`（409）：节点尚未完成登记，`users` 表还没有记录

---

### GET /auth/password-params

改密前获取当前登录用户的 PBKDF2 参数（**浏览器 derive 旧密码 hash 用**）。

**鉴权**：`Authorization: Bearer <jwt>`（必填）

**响应**：与 `GET /auth/login-params` 的 `data` 字段同形（`kdf_version` / `iterations` / `salt_hex` 等）。

---

### POST /auth/change-password

修改站主密码（M2-1b-4 新增）。

> **设计要点**：需现有 JWT 登录态 + 旧凭证二次校验。**新/旧 PBKDF2 均在浏览器完成**；Worker 比对 `old_password_hash`、写入 `new_password_hash`（不做边缘 PBKDF2）。
>
> **兼容迁移**：节点尚未运行 `owner-bootstrap` 时（`owner_credentials` 表为空），`old_password` 填 `JWT_SECRET` + `new_password_hash`（浏览器 derive 新密码）完成 INSERT 第一行。

**鉴权**：`Authorization: Bearer <jwt>`（必填）

**请求体（正式路径）**：
```json
{
  "old_password_hash": "v1:PBKDF2:...",
  "new_password_hash": "v1:PBKDF2:...",
  "new_username": "<新登录用户名：首次必填；普通改密可选（留空不改），不可为 admin>"
}
```

- `new_password_hash` 须含**新随机 salt**（浏览器 `hashPassword` 生成）。
- `new_username`（OWNER-RENAME）：首次强制设置**必填**；普通改密**可选**（留空 = 不改登录名，填了且与当前不同则改名）。合法性与首次一致：`^[A-Za-z0-9_-]{1,64}$`、不可为 `admin`、不得与已有用户名重复；改名时 TOTP 绑定同步迁移。
- 改名成功后当前 JWT 的 `oun` 已过期：浏览器应用新用户名 + 新密码**静默重新登录**；自动重登失败时提示站主退出后用新登录名登录。
- 新密码强度由**浏览器** `checkPasswordStrength` 前置校验（≥ 8 字符 + 字母 + 数字；不强制符号）；Worker 正式路径仅校验 hash 格式（`validatePasswordHashFormat`），兼容明文路径仍走服务端 `checkPasswordStrength`。

**请求体（兼容迁移路径）**：
```json
{
  "old_password": "<旧 JWT_SECRET>",
  "new_password": "<新密码，用于服务端强度校验>",
  "new_password_hash": "v1:PBKDF2:..."
}
```

**响应（正式旋转路径）**：
```json
{
  "ok": true,
  "data": {
    "rotated_at": "2026-01-02T00:00:00.000Z",
    "requires_dm_key_rewrap": false,
    "requires_notes_key_rewrap": false,
    "requires_group_key_rewrap": false,
    "username_changed_to": "alice"
  }
}
```

`requires_dm_key_rewrap`（M10-3）：当 D1 存在 `dm_wrapped_keys` / `dm_wrapped_identity` 时为 `true`，前端改密成功后须 re-wrap 全部会话密钥。

`requires_notes_key_rewrap`（M11-6）：当 D1 存在 `private_notes_wrapped_key` 时为 `true`。

`requires_group_key_rewrap`：当 D1 存在 `group_wrapped_keys` 时为 `true`，前端须用旧 `password_hash` 解包再以新 hash 重包；漏做会导致发群消息失败。

`username_changed_to` 仅在本次请求同时更换了 `owner_credentials.username` 时返回。

**响应（兼容迁移路径，首次将 JWT_SECRET 换为 PBKDF2 hash）**：
```json
{ "ok": true, "data": { "migrated_from_legacy": true, "requires_dm_key_rewrap": false, "requires_notes_key_rewrap": false, "requires_group_key_rewrap": false, "rotated_at": "..." } }
```

**错误码**：
- `OLD_PASSWORD_INCORRECT`（401）：旧密码错误（只发生在改密表单；前端据此提示"填当前登录密码"）— OWNER-OLD-PWD
- `AUTH_INVALID`（401）：JWT.sub / `oun` 与 `owner_credentials.username` 对不上；或首次设置用户名不合法
- `SAME_PASSWORD`（400）：新密码与旧密码相同
- `WEAK_PASSWORD`（400）：新密码强度不足（须 ≥ 8 字符且含字母与数字），响应 `message` 字段含具体 reason
- `INTERNAL_ERROR`（500）：D1 写入失败

**副作用**：
- 修改成功后**不会**吊销现有 JWT（M10+ "全量登出"接口独立提供），24h 内现有 JWT 仍有效
- 修改成功后**不会**吊销已签发的粉丝 Token

---

## 注册接口

> **字段口径总览（必读）**：登记流程涉及的字段（采集 / 落库 / 公开面）以 [`product-overview.md` §10.1 字段矩阵](./product-overview.md#101-字段矩阵总览) 为权威事实源（R-MSG-3 拍板）；本文档字段表仅列**节点采集侧**必填与格式。两份表不一致时以矩阵表为准。
> **R-MSG-3e（R-MSG-3b-1 落地）**：`phone` 自本版本起**停止采集与上送**，旧 D1 `users.phone` 列保留兼容；`gender` 实际为可选（代码侧已支持 `null`），本表标注同步修正。

### POST /api/local/register

**JWT 鉴权**（NCF-INGRESS-1：由 legacy 升格为 owner-gateway）。供已登录站主 Web 在 Turnstile 通过后调用；Worker A 收到请求后原样转发给注册中心 `POST /api/register/precheck`。

**NCF-REG-IP-1**：这次转发若能确定客户地址，会另加请求头 `X-Hailuo-Client-Ip`。站主通道验签通过时用入口注入的地址，否则用 Worker A 自己收到的 `CF-Connecting-IP`。没有合法地址就不加这个头。响应 JSON 不回显该地址。邮箱验证码转发不加。

> v2.3 M1-0a 新增；NCF-INGRESS-1 明确须站主 JWT + Owner Gateway 白名单（生产不经 Worker A 公网匿名调用）。

**请求**（JSON）：
```json
{
  "handle": "alice",
  "pubkey": "<ed25519_pubkey_hex>",
  "node_url": "https://alice-worker-b.workers.dev",
  "email": "alice@example.com",
  "turnstile_token": "<cloudflare_turnstile_widget_token>",
  "terms_accepted": true,
  "terms_version": "1.0"
}
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `handle` | string | ✅ | **登记硬规则**：用户只填裸本地段（**5–32 字节**（UTF-8 真实物理存储字节：1 英文/数字 = 1 字节，1 汉字 = 3 字节）、小写字母开头、禁连续 4 同字；**不要自带 @**）；正式名后缀由注册中心写入。lookup 读路径仍兼容旧 3–32 / 数字开头存量名 |
| `pubkey` | string | ✅ | Ed25519 公钥 hex（由 `scripts/register.mjs` 离线生成） |
| `node_url` | string | ✅ | Worker B 公开 URL，必须 `https://` |
| `email` | string | ✅ | 必填；登记阶段**不发/不验**验证码；冲突仅当已有 **verified** 同邮箱。**域名规则 v5**：`EMAIL_ALLOWLIST_VERSION=v5`，判定顺序 ① **黑名单优先**（`a@mx.yopmail.com` 仍拦）→ ② **白名单父域链命中即放行**（`a@qq.com` / `a@vip.qq.com`）→ ③ **段数 ≥4 一律** `EMAIL_DOMAIN_NOT_ALLOWED`（`a@a.b.c.d`）→ ④ **恰好 3 段本地放行**，由注册中心 `single_per_org`（是否允许三级域名，默认开）终裁 → ⑤ **1～2 段须命中白名单**（`a@random-company.com` 拒）。**v5 起废除「整域只能注册一次」**（`EMAIL_DOMAIN_ALREADY_REGISTERED` 不再返回） |
| `email_verify_token` | string | — | 登记不要求；认证见 `/certify` |
| `turnstile_token` | string | 生产必填 | Cloudflare Turnstile widget 返回的一次性 token |
| `~~age_over_18~~` | ~~boolean~~ | ~~✅~~ | **2026-09-27 起移除**；登记不再要求年龄自证 |
| `~~birth_date~~` / `~~country~~` / `~~gender~~` | — | — | **R-MSG-3b-3 起停止采集/上送**；**SPILL-1c** PATCH 改档已关（`DEMOGRAPHICS_REMOVED`）；详见 [`product-overview.md` §10.1](./product-overview.md#101-字段矩阵总览) |
| `~~phone~~` | ~~string~~ | ~~—~~ | **R-MSG-3b-1 起停止采集** — 旧字段保留兼容；新注册不再上送 |
| `terms_accepted` | boolean | ✅ | 必须为 `true` |
| `terms_version` | string | 默认 1.0 | 须与注册中心当前版本一致 |

**成功响应（透传注册中心 precheck 结果）**：
```json
{
  "ok": true,
  "data": {
    "challenge_id": "ch_xxxxxxxxxxxx",
    "nonce": "nonce_xxxxxxxxxxxx",
    "expires_at": "2026-01-01T00:10:00.000Z"
  }
}
```

**错误码（转发注册中心错误码）**：

| 错误码 | HTTP | 含义 |
|---|---|---|
| `REGISTER_BAD_REQUEST` | 400 | 参数格式错误 |
| `REGISTER_EMAIL_REQUIRED` | 400 | 缺少 email |
| `REGISTER_EMAIL_INVALID` | 400 | email 格式非法 |
| `REGISTER_EMAIL_VERIFY_TOKEN_INVALID` | 403 | （兼容）若带了 token 则无效/过期/已消费；**登记默认不要求 token** |
| `REGISTER_TURNSTILE_REQUIRED` | 403 | 缺少 turnstile_token（生产环境） |
| `REGISTER_TURNSTILE_INVALID` | 403 | Turnstile 校验失败 |
| `REGISTER_HANDLE_CONFLICT` | 409 | handle 已被注册或有活跃 challenge |
| `REGISTER_HANDLE_RESERVED` | 400 | handle 以保留前缀 `hailuo-registry` 开头（节点预检 + 注册中心权威） |
| `REGISTER_HANDLE_INVALID` | 400 | handle 不符合登记硬规则（5–32 字节（UTF-8）、字母开头、禁连续 4 同字） |
| `REGISTER_HANDLE_AT_FORBIDDEN` | 400 | 登记入参含 `@`（正式名后缀仅由注册中心写入） |
| `REGISTER_NODE_URL_CONFLICT` | 409 | node_url 已被注册或有活跃 challenge |
| `REGISTER_EMAIL_CONFLICT` | 409 | 已有 **verified** 同邮箱，或活跃 challenge 声明了同一 email |
| `REGISTER_INTERNAL` | 500 | 注册中心内部错误 |

---

### POST /api/local/email-verify-request

**JWT 鉴权**（owner-gateway）。代理调用注册中心 `POST /api/register/email-verify-request`，向指定邮箱发送 6 位验证码。

**请求**：
```json
{ "email": "alice@example.com" }
```

**响应**：
```json
{ "ok": true, "data": { "email": "alice@example.com", "expires_in": 600 } }
```

**错误码**：

| 错误码 | HTTP | 含义 |
|---|---|---|
| `EMAIL_VERIFY_REQUEST_INVALID` | 400 | 参数格式错误 |
| `EMAIL_VERIFY_REQUEST_RATE_LIMITED` | 429 | 60s 冷却内重复请求 |
| `EMAIL_ALREADY_REGISTERED` | 409 | 该邮箱已注册 |
| `EMAIL_VERIFY_REQUEST_INTERNAL` | 500 | 发送邮件失败 |

---

### POST /api/local/email-verify-confirm

**JWT 鉴权**（owner-gateway）。代理调用注册中心 `POST /api/register/email-verify-confirm`，校验 6 位验证码并返回 `email_verify_token`。

**请求**：
```json
{ "email": "alice@example.com", "code": "123456" }
```

**响应**：
```json
{ "ok": true, "data": { "email_verify_token": "<token>", "expires_in": 600 } }
```

**错误码**：

| 错误码 | HTTP | 含义 |
|---|---|---|
| `EMAIL_VERIFY_CONFIRM_INVALID` | 400 | 参数格式错误 |
| `EMAIL_VERIFY_CONFIRM_CODE_INVALID` | 403 | 验证码错误或过期 |
| `EMAIL_VERIFY_CONFIRM_CODE_MAX_ATTEMPTS` | 429 | 尝试次数过多 |

---

### GET /api/local/register/bootstrap-targets

**JWT 鉴权**。返回浏览器应自己去拉的入口地址列表。响应不含浏览器地址。

### POST /api/local/register/intake

**JWT 鉴权**。请求体 `{ "manifest": "<入口原文>", "avoid_registry_id"?: "<一家编号>" }`。节点用钉死公钥再验签并写下接待地址。不向入口发请求，不接受浏览器地址字段。验签失败不改成主中心回落。

### POST /api/local/register/complete

**需要 JWT**（站主 Web 登记流程）。Worker A 在边缘完成 precheck → proof KV → challenge 签名 → verify，验签 `registry_identity` 后写 `registry_endpoints[0]` 与 `users` 表。

**NCF-REG-BROWSER-1**：登记页把 `browser_relay` 带上。`phase=prepare` 时节点只签好预检正文并返回 `{ relay: { step, registry_url, path, body } }`，由浏览器自己把这份正文送到注册中心。浏览器再把注册中心的回复交回：`phase=precheck_result` 之后节点签提交正文；`phase=verify_result` 之后节点自己去取领取凭证，页面和交回的回复里都去掉 `claim_token` 与 `node_api_token`。每日同步、健康上报和信息流不走这条浏览器通路。没有 `browser_relay` 时仍由节点代发预检和提交。

**NCF-REG-IP-1**：节点自己代发的 precheck 与 `challenge/verify` 会带 `X-Hailuo-Client-Ip`（规则同 `POST /api/local/register`）。浏览器直送时不带这个头，次数按注册中心看见的连接地址计算。轮询 status 和 ack 不带。返回给浏览器的 JSON 不含这个地址。

**M33-P8-n / REG-ASYNC-FIX / FIX2-node（跨系统恢复）**：注册中心 `challenge/verify` 返回 **202** + `claim_token`。本接口写 proof 后提交 verify，将 `claim_token` + 受理时 `pubkey`/`node_url` 暂存 `registration_sync_state`（phase=`registry_accepted`），再轮询 `GET .../status`（Bearer claim；`poll_after_ms≥3000` + 本地退避；**读 `attempts` 抬升 `localBackoff` 地板**，配对 registry FIX2-7）；拿到明文后写入 phase=`registry_verified`、本地落库，再 `POST .../ack`。本地失败 → `REGISTRATION_SYNC_PENDING`（503）；处理超时 → `REGISTRATION_PROCESSING`（504）。**再次调用本接口**按 phase 续跑（勿重新 precheck）。`node_api_token` / `claim_token` 禁止回显/打日志。详见 [`reg-async-fix2-node-plan.md`](./reg-async-fix2-node-plan.md)。

**NCF-CLAIM-PICKUP-1（浏览器直送后领取明文）**：`phase=verify_result` 交回的回复里**没有** `claim_token`。节点用 `ED25519_PRIVATE_KEY` 对 `hailuo-register-claim-pickup.<challenge_id>` 做 Ed25519 签名，调注册中心 `POST /api/register/challenge/:challengeId/claim-pickup`（body 只有 `signature`，不带客户地址头），取回明文后再按上面的 REG-ASYNC 链路写 `registry_accepted`、轮询、落库、ack。领取失败按结构化错误返回，**不抛 500**：

| 情况 | 本接口状态 | `error_code` |
|---|---|---|
| 中心说还不能领（中心 404） | 409 | `REGISTER_CLAIM_NOT_READY`（透传） |
| 中心暂时不能封存（中心 503） | 409 | `REGISTER_CLAIM_ENVELOPE_UNAVAILABLE`（透传） |
| 领取请求没送出去 / 中心返回其它错 | 409 | `REGISTRY_ERROR` |

409 是刻意的：网页把 0/5xx 当成「换入口再试一次」，那条重试会复用一次性的 Turnstile token。领取失败时 `registry_challenge_pending` 保留，用户重试仍可续跑。明文、签名都禁止进日志。门禁 `test:ncf-claim-pickup`。

**REG-BR-2a（路径 A challenge_pending 续跑）**：precheck 成功 → verify 未完成时写入 `registry_challenge_pending`（约 10 分钟窗口，含 `challenge_id` / `nonce` / `pubkey_hex` / `node_url` / `precheck_at` / `expires_at`）；再次进入本接口时按 `tryChallengeResume` 重建 proof + sign + verify，**不重打 precheck**。写入失败 try/catch 静默不阻断 verify 主流程。~~路径 B `registry_bootstrap_inbound_pending` / `postBootstrapEmailConfirm`~~ 已于 2026-09-28（REG-BO-0c）从代码删除；登记邮件兜底改走路径 D（registry outbound-plan）。
**请求**（JSON）：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `handle` | string | ✅ | 海螺名 |
| `display_name` | string | | 显示名称 |
| `email` | string | ✅ | 登记邮箱（方案 B：必填；**不**要求先收验证码） |
| `email_verify_token` | string | | 可选；**非**登记前置 |
| `turnstile_token` | string | ✅ | 主注册中心 Turnstile token |
| `~~age_over_18~~` | ~~boolean~~ | ~~✅~~ | **2026-09-27 起移除**；登记不再要求年龄自证 |
| `~~birth_date~~` / `~~country~~` / `~~gender~~` | — | — | **R-MSG-3b-3 起登记停采** — 勿再送；**SPILL-1c** 起 PATCH 改档亦拒 |
| `~~phone~~` | ~~string~~ | ~~—~~ | **R-MSG-3b-1 起停止采集** — 旧字段保留兼容；新注册不再上送，详见 [`product-overview.md` §10.1](./product-overview.md#101-字段矩阵总览) |
| `terms_accepted` | boolean | ✅ | 必须为 `true` |
| `terms_version` | string | | 默认 `1.0`，须与注册中心一致 |
| `browser_relay` | object | | 可选。`phase` 为 `prepare`、`precheck_result` 或 `verify_result`。后两步可带 `upstream_status` 与 `upstream_body` |

**成功**：`{ ok: true, data: { handle, display_name, user_id, message } }`。需要浏览器继续送往注册中心时改为 `{ ok: true, data: { relay: { step, registry_url, path, body } } }`，`step` 为 `precheck` 或 `verify`。这份 `body` 不含领取凭证。

**副作用（M-DS-V2）**：解析注册中心 `challenge/verify` 响应中的 `suggested_daily_sync_utc_second_of_day`，写入 `system_config`：

| key | 值 |
|---|---|
| `daily_sync_utc_second_of_day` | UTC 日内秒 `0..86399`（与 registry 建议不一致时以 registry 为准并记 `daily_sync_schedule_mismatch`） |
| `daily_sync_schedule_version` | `daily_sync_v3` |

缺字段时（旧 registry）按 `computeDailySyncUtcSecondOfDay(user_id)` 本地回退。

**错误码**：`ALREADY_REGISTERED`（409）、`REGISTRATION_SYNC_PENDING`（503，中心已成功、本地待续跑）、`REGISTRATION_PROCESSING`（504，异步处理未完成）、`REGISTRY_IDENTITY_INVALID`（502）、`REGISTRY_TRUST_ANCHOR_MISMATCH`（502，身份未通过节点钉死的主中心锚点）等。

---

### POST /api/local/register/append-complete

**需要 JWT**（M9-3-7）。站主已在主注册中心登记后，向 `registry_endpoints` 中 **`status: pending`** 的备用中心追加登记；代理目标为该条目的 `registry_url`（非 `[0]`）。

**请求**（JSON）：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `registry_id` | string | ✅ | 待登记备用中心的 `registry_id` |
| `turnstile_token` | string | ✅ | **该备用注册中心域名** Turnstile token |
| `email` | string | | 可选 |
| `email_verify_token` | string | | 可选 |

**成功**：`{ ok: true, data: { registry_id, registry_url, handle, display_name, user_id, message } }`

**错误码**：

| 错误码 | HTTP | 含义 |
|---|---|---|
| `NOT_REGISTERED` | 409 | 尚未完成主注册中心登记 |
| `REGISTRY_ENDPOINT_NOT_FOUND` | 404 | `registry_id` 不在列表中 |
| `REGISTRY_ALREADY_ACTIVE` | 409 | 该中心已 active 或不可追加 |
| `REGISTRY_IDENTITY_MISMATCH` | 502 | verify 返回的身份与 pending 配置不一致 |

---

### GET /.well-known/hailuo-proof

**无需 JWT**（注册中心回访验证用）。在注册 `challenge/verify` 阶段，注册中心会回访此端点确认节点 URL 归属。

**响应**：
```json
{
  "ok": true,
  "data": {
    "challenge_id": "<challenge_id>",
    "nonce": "<nonce>",
    "pubkey_fingerprint": "<16_hex>"
  }
}
```

---

## 站主直读接口（JWT 鉴权）

### GET /api/local/posts

**JWT 鉴权**（仅站主登录态调用）。直读 D1 `posts` 表，绕过 KV，发完即见（强一致）。访客请走 Worker B `/posts`。

> v2.3 M3-1a 新增。

**Query**：`?limit=20&before=<post_id>`

**响应**：
```json
{
  "ok": true,
  "data": {
    "items": [
      {
        "id": "post_xxx",
        "content": "帖子内容",
        "sig": "<ed25519签名>",
        "image_keys": ["kv:img_xxx"],
        "created_at": "2026-01-01T00:00:00.000Z",
        "deleted_at": null,
        "post_kind": "original",
        "repost_of": null
      }
    ],
    "next_cursor": null
  }
}
```

转发帖项示例（M9-1）：

```json
{
  "id": "post_repost01",
  "content": "",
  "sig": "<hex>",
  "image_keys": [],
  "created_at": "2026-07-04T08:00:00.000Z",
  "deleted_at": null,
  "post_kind": "repost",
  "repost_of": {
    "node_url": "https://bob-worker-b.example.workers.dev",
    "post_id": "post_origin01",
    "author_handle": "bob"
  }
}
```

---

### GET /api/local/feed

**M14-10**：**JWT 鉴权**。站主直读 D1 `feed_cache`（Cron 聚合写入的关注流 + 注册中心官方公告），与 Worker B `GET /feed` 字段对齐。protected 档下 Web Following tab 走此路径，避免对本节点 Worker B `/feed` 申请 follower token（站主不在自 `follows` 表）。

**Query**：`?limit=20&cursor=<feed_cache.id>`

**M-F2 / M-F2b 读时过滤**：结果按「活跃关注 ∪ 官方源」二次过滤；单次最多扫 5×50=250 行。**M-F2b**：若扫描预算用尽且源表未耗尽，即使本页可见行 ≤ `limit`，仍返回 `has_more: true`，`cursor` 取已扫到的最后一行 id（含被过滤行），避免前端误以为到底。

**响应**：
```json
{
  "ok": true,
  "data": {
    "items": [
      {
        "id": "https://peer.example#post_abc",
        "node_url": "https://peer.example",
        "post_id": "post_abc",
        "author_handle": "peer",
        "content": "…",
        "sig": "…",
        "image_urls": ["https://peer.example/img/kv:img_xxx"],
        "created_at": "2026-01-01T00:00:00.000Z",
        "source_type": "official"
      }
    ],
    "has_more": false,
    "cursor": null
  }
}
```

---

### GET /api/local/notifications

**JWT 鉴权**（M9-20）。站主轮询读取他人对本节点帖子的点赞/回复通知（REL-FIX-3 起含 `group_join_request_received` 入群待审批）；不新增 Cron、不做推送。

**通知类型**：`like` / `reply` / `friend_request_received` / `friend_request_accepted` / `friend_request_rejected` / `friend_request_cancelled` / `friend_request_withdrawn` / `group_join_request_received`（REL-FIX-3：`request_id`=群 id 便于跳转群设置，`related_node_url`=申请人 Worker B URL，`content_preview`=`群名 · @申请人`）。

> **REL-FIX-11**：`friend_request_withdrawn` = **发起方自己撤回**请求后写给**本端站主**的可见性通知（与 `friend_request_cancelled`「对方撤回 → 通知接收方」语义不同，不可复用同一 type）。`request_id`=friend_requests.id（深链直达通讯录面板对应行），`related_node_url`=对方 Worker B URL，`content_preview`=对方 handle。

**Query**：`?limit=20&before=<notification_id>`

**响应**：
```json
{
  "ok": true,
  "data": {
    "items": [
      {
        "id": "notif_xxx",
        "type": "reply",
        "post_id": "post_xxx",
        "actor_handle": "bob",
        "actor_node_url": "https://bob-worker-b.workers.dev",
        "reply_id": "reply_xxx",
        "content_preview": "回复摘要…",
        "created_at": "2026-06-21T12:00:00.000Z",
        "read_at": null
      }
    ],
    "unread_count": 3,
    "has_more": false,
    "cursor": null
  }
}
```

### POST /api/local/notifications/mark-read

**JWT 鉴权**。标记通知已读；请求体可选 `{ "ids": ["notif_xxx"] }`，缺省则全部未读标为已读。

**响应**：
```json
{
  "ok": true,
  "data": { "marked": 3, "unread_count": 0 }
}
```

---

### GET /api/local/registry-official-feed-status

**JWT 鉴权**（仅站主登录态调用）。读取注册中心官方公告同步诊断状态，用于 Web 设置页“运行日志”判断节点凭证、节点签名、最近拉取错误和本地已缓存公告数。

**响应**：
```json
{
  "ok": true,
  "data": {
    "registry_url": "https://hailuo-registry.allovo.eu.org",
    "node_credentials_configured": true,
    "node_signature_configured": true,
    "last_status": "ok",
    "last_checked_at": "2026-06-18T08:00:00.000Z",
    "last_source_url": "https://hailuo-registry.allovo.eu.org",
    "last_fetched_count": 1,
    "last_insert_count": 1,
    "last_error": null,
    "cached_official_count": 1,
    "latest_official_created_at": "2026-06-18T07:50:40.766Z"
  }
}
```

---

### POST /api/local/registry-official-feed/pull

**JWT 鉴权**（仅站主登录态调用）。手动拉取注册中心官方公告并刷新 `feed:latest`，设置页「拉取官方公告」按钮使用。为保护注册中心，按 UTC 日期限制每天 3 次；失败也计入尝试次数，防止反复点击造成压力。

**响应**：
```json
{
  "ok": true,
  "data": {
    "fetched_count": 1,
    "inserted_count": 1,
    "remaining_today": 2,
    "quota_date": "2026-06-18"
  }
}
```

`inserted_count` 当前表示本轮写入/覆盖处理到 `feed_cache` 的公告条数；重复公告会用 `INSERT OR REPLACE` 更新，不会生成重复 feed 项。

**错误码**：
- `REGISTRY_OFFICIAL_PULL_LIMITED`（429）：当天手动拉取次数已达上限
- `REGISTRY_OFFICIAL_PULL_FAILED`（500）：注册中心请求、D1 写入或 `feed:latest` 刷新失败

---

### POST /api/local/follows/pull-probe

**JWT 鉴权**（仅站主登录态调用）。手动探测各关注节点的 `GET /posts?limit=20` 拉取（与 Cron `fetchAndAggregateFeed` 同路径与 Token 重试逻辑），**不写** `feed_cache` / `feed:latest`，供排障浏览器可达但 Cron 报 404 的场景。

**响应**：
```json
{
  "ok": true,
  "data": {
    "items": [
      {
        "fetch_url": "https://bob-worker-b.workers.dev",
        "posts_url": "https://bob-worker-b.workers.dev/posts?limit=20",
        "ok": false,
        "post_count": 0,
        "error": "HTTP 404",
        "http_status": 404,
        "response_url": "https://bob-worker-b.workers.dev/posts?limit=20",
        "body_snippet": "...",
        "token_retry": false
      }
    ]
  }
}
```

**错误码**：
- `FOLLOW_PULL_PROBE_FAILED`（500）：D1 读取或探测过程异常

---

### GET /api/local/owner-sessions

**JWT 鉴权**（M34-4）。Settings「最近登录设备」列表。

**查询参数**：`limit`（可选，默认 20，上限 50）。

**响应**（**禁止**回显 `ip_hash` / `token_hash` / `jwt_fingerprint` / **完整明文 IP**；**允许**脱敏 `ip_masked`）：
```json
{
  "ok": true,
  "data": {
    "items": [
      {
        "session_id": "oses_01HXYZ",
        "created_at": "2026-08-29T10:00:00.000Z",
        "last_seen_at": "2026-08-29T11:00:00.000Z",
        "ended_at": null,
        "ip_country": "SG",
        "ip_masked": "203.0.113.*",
        "user_agent_family": "Chrome / Windows",
        "channel": "web",
        "is_current": true,
        "is_active": true,
        "can_revoke_jwt": true
      }
    ]
  }
}
```

| 字段 | 说明 |
|------|------|
| `ip_masked` | M34-4b：脱敏 IP（IPv4 `a.b.c.*` / IPv6 前 4 hextet + `:*`）；旧会话可空 |
| `is_current` | 是否为本请求 JWT 对应会话 |
| `is_active` | 未结束且仍在 `OWNER_SESSION_TTL_SEC` 心跳窗内 |
| `can_revoke_jwt` | 是否存有 `token_hash`（迁移前旧会话可能为 false，仍可结束会话行） |

**错误码**：`UNAUTHORIZED` · `OWNER_SESSIONS_LIST_FAILED`

---

### DELETE /api/local/owner-sessions/:sessionId

**JWT 鉴权**（M34-4）。结束指定会话；若有 `token_hash` 则写入 `revoked_tokens` 使该设备 JWT 立即失效；然后**删除** `owner_sessions` 这一行，设置页列表不再显示。登录审计 `owner_login_events` 不删。

**响应**：
```json
{
  "ok": true,
  "data": {
    "ended": true,
    "jwt_revoked": true,
    "is_current": false,
    "owner_engagement": "active"
  }
}
```

| 字段 | 说明 |
|------|------|
| `is_current` | 若为 true，前端应清本地 JWT 并回到登录页 |
| `jwt_revoked` | 是否已写入 `revoked_tokens`（无 hash 的旧会话可能为 false） |

**错误码**：`UNAUTHORIZED` · `SESSION_ID_REQUIRED` · `SESSION_NOT_FOUND` · `OWNER_SESSION_REVOKE_FAILED`

---

### GET /api/local/online-status

**JWT 鉴权**（M34-2 / M34-6）。返回站主参与度与关注流自动同步是否因 `dormant` 暂停，供 Settings「关注流自动同步」卡片展示。

**响应**：
```json
{
  "ok": true,
  "data": {
    "owner_engagement": "active",
    "owner_last_seen_at": "2026-08-29T08:00:00.000Z",
    "feed_auto_sync": "running",
    "feed_pull_last_ok_at": "2026-08-29T07:58:00.000Z",
    "feed_pull_cycle_ok_at": "2026-08-29T07:58:00.000Z",
    "feed_dormant_sweep_active": false,
    "owner_dormant_feed_policy": "skip"
  }
}
```

| 字段 | 说明 |
|------|------|
| `owner_engagement` | `active` / `dormant` / `unknown`（未登录过） |
| `feed_auto_sync` | `running`：正常自动拉；`paused`：dormant+`skip` 且未到 24h 地板；`slow`：dormant+`slow`；`floor`：dormant+`skip` 但 24h 地板到期或全量扫尾中 |
| `owner_dormant_feed_policy` | env `OWNER_DORMANT_FEED_POLICY`（`skip`\|`slow`\|`normal`，默认 `skip`） |
| `feed_pull_last_ok_at` | 上次关注流 batch 全成功时间（可空） |
| `feed_pull_cycle_ok_at` | 上次**全关注**扫完时间（M34-6；可空=从未） |
| `feed_dormant_sweep_active` | 是否正在执行 24h 地板扫尾（M34-6） |

**M34-6 地板**：即使 `OWNER_DORMANT_FEED_POLICY=skip`，距 `feed_pull_cycle_ok_at` ≥24h（或从未扫过）时，Cron 仍会在偶数分钟强制拉关注，直到按 batch 游标扫完全部 follows；扫完后写回 `feed_pull_cycle_ok_at` 并恢复 skip 节能。

**错误码**：
- `ONLINE_STATUS_FAILED`（500）

---

### POST /api/local/feed-aggregate/run

**JWT 鉴权**（M34-2）。站主手动跑一轮关注流聚合，**绕过** Cron 的 dormant skip；仍受单次子请求预算约束（与 Cron `runScheduledInvocation` 同入口）。

**响应**：
```json
{
  "ok": true,
  "data": {
    "status": "ok",
    "fetched": 3,
    "failed": 0,
    "next_cursor": null,
    "kv_publish": null
  }
}
```

**错误码**：
- `FEED_AGGREGATE_RUN_FAILED`（500）

---

### GET /api/local/registry-daily-sync-status

**JWT 鉴权**（M-DS-2a）。读取注册中心 **daily-sync** 上次执行摘要与各聚合块状态，供 Settings「注册中心日同步」面板展示。

**响应** `data` 字段摘要：

| 字段 | 说明 |
|------|------|
| `last_success_at` / `last_status` / `last_error` | 上次全 endpoint 同步结果（`system_config`） |
| `sync_interval_days` | 周期 sync 间隔（日），默认 3 |
| `official_feed` | 官方公告拉取诊断（`readRegistryOfficialFeedDiagnostics`） |
| `blacklist` | `blacklist_remote_etag`、`blacklist_remote_last_sync_at` |
| `recommendations` | 推荐块上次检查时间、条数、错误 |
| `endpoints[]` | 各 `registry_id` 的 `status`、`consecutive_fail_days`、`last_ok_at` 等 |
| `lookup_resolve` | **M-OPT-8 / 8b / 8c**：分层命中（`l1_*` / `l2_mutual` / `l3_fof` / `l4_*`）与 `l4_ratio` / `l1_ratio` / `l2_ratio` / `l3_ratio` |
| `federation` | **M9-3-CL4**：联邦诊断（见下）；**不**返回 peer 拓扑 |

#### `federation`（M9-3-CL4）

| 字段 | 说明 |
|------|------|
| `home_registry_id` | 本节点已登记 home（`registered_registries`） |
| `endpoints_count` / `endpoints_cap` | 当前入口数与上限（硬上限 5） |
| `last_lookup` | 最近一次 L4 联邦 lookup 摘要（`system_config.federation_last_lookup_json`）；含 `home_registry_id` / `resolved_via_registry_id` / `route_stale` / `error_code` / `http_status` / `at`；无则 `null` |
| `federated_blacklist` | CL3 联邦黑名单摘要（`etag` / `cert_epoch` / `item_count` / `updated_at` / `enforce`）；**生产默认 enforce=true**（显式 `FEDERATION_BLACKLIST_ENFORCE=false` 才关） |

站主可用 `GET /api/lookup/:handle`（JWT）触发 L4 以刷新 `last_lookup`，再读本诊断接口。

---

### POST /api/local/registry-daily-sync/run

**JWT 鉴权**（M-DS-2a 联调 / 排障）。站主手动触发一次 `syncRegistryDaily(env, { force: true, markManualSuccess: true })`，**跳过** 本地 `interval×12h` 节流并向中心带 `force`，与 Cron 调度正交。

**M16-DAILY-SYNC-COOLDOWN-1（用户层 1 天节流）**：
- `force=true` → **跳过 `shouldRunScheduledDailySync`（不判断 `interval × 12h`）**
- **用户层节流 = 成功后 24h**（前后端双层）：
  - 后端：`consumeManualDailySyncQuota` 读独立锚点 `registry_daily_sync_last_manual_at`（D1 `system_config`）；命中 → **429** `MANUAL_DAILY_SYNC_COOLDOWN`
  - 仅**成功**才 `markManualSuccess` 落锚（失败不延长冷却）；与 cron 的 `last_success_at` **物理隔离**
  - 登记完成 / 弃用 health 转调等其它 `force` 路径**不**写手动锚点
  - 窗口可由 env `MANUAL_DAILY_SYNC_COOLDOWN_HOURS` 覆盖（缺省 24，护栏最多 30 天）
  - 前端：Settings 按 `diagnostics.last_manual_at` 计算剩余小时，冷却中禁用「立即同步」按钮
- **触发链路**：Settings → `handleRunDailySyncNow` → `client.runRegistryDailySync()` → `POST /api/local/registry-daily-sync/run` → quota 门闩 → `syncRegistryDaily(env, { force: true, markManualSuccess: true })` → `POST /api/node/daily-sync`

**响应**：
```json
{
  "ok": true,
  "data": {
    "message": "注册中心 daily-sync 已触发",
    "diagnostics": { "...": "同 GET status" }
  }
}
```

**错误码**：
- `MANUAL_DAILY_SYNC_COOLDOWN`（429）：手动冷却未满；`data` 含 `last_manual_at`、`retry_after_seconds`、`retry_after_hours`
- `NODE_NOT_REGISTERED`（409）
- `DAILY_SYNC_FAILED`（500）

**429 示例**：
```json
{
  "ok": false,
  "error_code": "MANUAL_DAILY_SYNC_COOLDOWN",
  "message": "手动 daily-sync 节流中：上次成功时间 …；还需等待 N 小时",
  "data": {
    "last_manual_at": "2026-10-11T08:00:00.000Z",
    "retry_after_seconds": 3600,
    "retry_after_hours": 1
  }
}
```

---

### GET /api/local/registry-daily-sync-status

**JWT 鉴权**（M-DS-2a）。读取本节点注册中心 **daily-sync** 上次结果与各聚合块摘要（官方公告 / 黑名单 / 推荐 / endpoints 失败天数等），Settings「日同步」区使用。

**响应** `200`（字段随实现扩展，核心示例）：

```json
{
  "ok": true,
  "data": {
    "last_success_at": "2026-07-12T10:05:27.000Z",
    "last_status": "ok",
    "last_error": null,
    "last_manual_at": "2026-10-11T08:00:00.000Z",
    "official_feed": { "last_sync_at": "2026-07-12T10:05:27.000Z", "cached_count": 3 },
    "blacklist": { "remote_etag": "\"abc\"", "last_sync_at": "2026-07-12T10:05:27.000Z" },
    "recommendations": { "last_checked_at": "2026-07-12T10:05:27.000Z", "last_fetched_count": 10 },
    "endpoints": [
      { "registry_id": "reg1", "status": "active", "consecutive_fail_days": 0 }
    ]
  }
}
```

`last_manual_at`：M16-DAILY-SYNC-COOLDOWN-1 手动「立即同步」最近成功时间；与 cron `last_success_at` 独立。

---

### POST /api/local/registry-daily-sync/run

**JWT 鉴权**（M-DS-2a 联调 / 排障）。站主手动触发一次 `syncRegistryDaily(env, { force: true, markManualSuccess: true })`，**跳过** 本地周期节流与 Cron 调度 gate；用于部署验证或 registry 不可达恢复后补拉。

**M16-DAILY-SYNC-COOLDOWN-1**：成功后写入独立锚点 `registry_daily_sync_last_manual_at`，默认 **24h** 内再次点击返回 **429** `MANUAL_DAILY_SYNC_COOLDOWN`（`data.retry_after_seconds` + `data.retry_after_hours`）。失败不占冷却。详见上一同名小节与 `docs/m16-daily-sync-cooldown-plan.md` v0.2。

**响应** `200`：含 `message` + 刷新后的 `diagnostics`（同 `GET .../registry-daily-sync-status`，含 `last_manual_at`）。

**错误码**：
- `MANUAL_DAILY_SYNC_COOLDOWN`（429）：手动冷却未满
- `NODE_NOT_REGISTERED`（409）：缺 `node_api_token` / `owner_user_id`
- `DAILY_SYNC_FAILED`（500）：全部 endpoint 失败或网络异常

---

### GET /api/local/registry-recommended-users

**JWT 鉴权**（仅站主登录态调用）。读取本节点 D1 中缓存的“注册中心推荐用户”。Worker A 会在登记完成后 `syncRegistryDailyOnRegistration` 立即拉取一次；之后由 **M-OPT-2n** 按周期（默认每 3 日）`POST /api/node/daily-sync` 聚合同步带回推荐块（受 `interval×12h` 成功节流约束）。

**M17-4-2c**：同一响应附带本节点 Cron 写入的 **好友的好友**（`fof_items`，≤5）。右栏「推荐关注」先渲染官方 `items`，再渲染 `fof_items`；FoF CTA 仅为「关注」。

**查询参数**（M32-1）：

| 参数 | 默认 | 说明 |
|------|------|------|
| `exclude_following` | `true` | 为 `true`/`1`/缺省时，按本地 `follows`（含 `cache_entries` 补齐的 `user_id` / `pubkey_fingerprint`）过滤已关注用户；`false`/`0` 时返回完整缓存。FoF 行同样在读时再滤一次已关注，并与官方 `items` 按 node URL 去重 |

过滤键优先级：`user_id` → `pubkey_fingerprint` → 规范化 `worker_b_url` → `handle`（遗留回退）。过滤后展示条数可能少于缓存条数（目标约 10 条，MVP 接受不足）。

缓存表：`registry_recommended_users`。状态字段记录在 `system_config`：

- `registry_recommended_users_last_checked_at`
- `registry_recommended_users_last_status`
- `registry_recommended_users_last_error`
- `registry_recommended_users_last_fetched_count`
- `registry_recommended_users_source_registry_id`（M9-3-9：实际成功响应的注册中心 `registry_id`，主失败 failover 备用时有值）

FoF 表：`fof_recommended_users`（GOVERNANCE，M17-4-2b Cron 写入）。元数据键：`fof_recommended_users_last_refreshed_at` 等（见 M17-4-2b）。

**响应**：
```json
{
  "ok": true,
  "data": {
    "items": [
      {
        "user_id": "usr_xxx",
        "handle": "alice",
        "node_url": "https://alice.example.com",
        "worker_b_url": "https://alice-worker-b.example.com",
        "health_status": "active",
        "profile_status": "completed",
        "pubkey_fingerprint": "key_abcd1234",
        "registered_at": "2026-06-18T00:00:00.000Z",
        "last_health_at": "2026-06-18T06:00:00.000Z",
        "reason": "active_recently",
        "fetched_at": "2026-06-18T08:00:00.000Z"
      }
    ],
    "fof_items": [
      {
        "handle": "carol",
        "node_url": "https://carol.example.com",
        "worker_b_url": "https://carol.example.com",
        "display_name": "Carol",
        "mutual_count": 2,
        "reason": "friend_of_friend",
        "fetched_at": "2026-09-15T07:25:00.000Z"
      }
    ],
    "fof_last_refreshed_at": "2026-09-15T07:25:00.000Z",
    "fof_next_refresh_after": "2026-09-15T08:25:00.000Z",
    "last_checked_at": "2026-06-18T08:00:00.000Z",
    "last_status": "ok",
    "last_error": null,
    "last_fetched_count": 1,
    "next_refresh_after": "2026-06-19T08:00:00.000Z",
    "last_source_registry_id": "registry-primary",
    "hidden_following_count": 2,
    "displayed_count": 8
  }
}
```

`hidden_following_count`：因已关注而从本次响应 `items` 中隐藏的条数。`displayed_count`：过滤后 `items.length`（不含 `fof_items`）。`fof_items` 不含邮箱 / 公钥 / 共同好友 handle 名单；`mutual_count` 仅为计数。

**错误码**：
- `REGISTRY_RECOMMENDATIONS_READ_FAILED`（500）：本地 D1 缓存查询失败

---

### POST /api/local/registry/rotate-token（R-MSG-1b / R-MSG-1d）

**JWT 鉴权**。代理注册中心 `POST /api/node/rotate-token`（旧 `nat_` + Ed25519 签名由 `registryFetch` 注入），成功后**原子**写入本节点（**R-MSG-1d**：三处均为 AES-GCM 密文 `natw1:…`，需 `NODE_API_TOKEN_WRAP_SECRET`；发请求时再 unwrap 为明文 Bearer）：

**M16-DAILY-SYNC-COOLDOWN-0（v0.1）现实**：
- **端点无限流**（`apps/worker-a/src/routes/local-reads/registry-profile.ts:530` 无 quota / 无 cooldown / 无 limit 检查）
- **i18n 文案与代码不一致**：`web/src/lib/i18n/catalogs/zh/settings.ts:428-430` `settingsRegistryTokenRotateConfirm` 写"每天最多 3 次"——**代码无限流**——**v0.1 已按代码修正 i18n**（删"每天最多 3 次" + 改"旧通行证立即作废；失败可重试"）
- **v0.6 待决策 #2**：是否加 N 次/天节流（详见 `docs/m16-daily-sync-cooldown-plan.md` §4）



- `system_config.node_api_token`
- `registered_registries[0].node_api_token`
- `registry_endpoints` 中同 `registry_id` 条目的 `node_api_token`

失败时保留本地旧凭证（不先删后换）。中心已轮换但本地落盘失败返回 `500 ROTATE_PERSIST_FAILED`。缺少 wrap secret 时落盘失败（fail-closed）。

**成功响应**（浏览器**不**收完整明文，仅 display）：

```json
{
  "ok": true,
  "data": {
    "user_id": "usr_...",
    "node_api_token_display": "nat_xxxx...",
    "rotated_at": "2026-09-16T00:00:00.000Z"
  }
}
```

常见错误：透传中心 `ROTATE_RATE_LIMITED` / `ROTATE_HOME_ONLY` / `NODE_TOKEN_*` / `NODE_SIGNATURE_*`；本节点 `ROTATE_PERSIST_FAILED`、`REGISTRY_ALL_UNAVAILABLE`。

### GET /api/local/registry/registration-profile

**JWT 鉴权**（仅站主登录态调用）。代理注册中心 `GET /api/node/registration-profile`，返回登记合规档案（**email**、terms_*、认证收件展示字段等；**不含**人口学）。Worker A 经 `registryFetch` 注入 `node_api_token`、`X-Hailuo-Node-User-Id` 与节点 Ed25519 签名。

**成功响应**：与注册中心契约一致，`{ ok: true, data: { user_id, handle_local, handle_qualified, email, terms_version, terms_accepted_at, registered_at, updated_at, cert_inbound_*? } }`（SPILL-1c：registry 已 DROP 人口学明文列；**HANDLE-SLIM**：已停用 `user_name`，改 `handle_local` + `handle_qualified`；节点侧投影同步剥离 `user_name` / 人口学）。

Worker A 在代理成功后会用本节点登记落盘副本（`users.handle` → `handle_local`、`system_config.handle_qualified`、`register_terms_version` / `register_terms_accepted_at`）**补齐空的** `handle_*` / `terms_*`，避免设置页只读栏空白。若注册中心暂不可用，或读取过程异常（例如缺少 `NODE_API_TOKEN_WRAP_SECRET`），只要本节点已有海螺名或许可版本，就回落本地副本（`profile_source: "local_fallback"`），不再整段报「读取登记资料失败」。

**M7-41**：若中心返回的 `email` 非空、且本节点 `users.registration_email` 为空，GET 成功路径会**回填**本地列（fail-soft，不影响响应），供 `GET /auth/me` 与个人主页只读展示。

**错误码**：
- 注册中心原样透传（如 `NODE_TOKEN_INVALID`、`NODE_SIGNATURE_INVALID` 等）
- `USER_NOT_REGISTERED`（409）：本节点尚未完成注册中心登记（无 `registered_registries` / `node_api_token`）。设置页应视为「尚未登记」软空态，**不要**当成「读取登记资料失败」。
- `REGISTRY_ALL_UNAVAILABLE`（503）：无可用注册中心 endpoint
- `REGISTRY_REGISTRATION_PROFILE_INVALID`（502）：上游响应非 JSON
- `REGISTRATION_PROFILE_READ_FAILED`（500）：本地代理过程异常（已登记但读档失败时才用）

---

### PATCH /api/local/registry/registration-profile

**JWT 鉴权**。代理注册中心 `PATCH /api/node/registration-profile`。

**可 PATCH 字段**（SPILL-1c）：仅 `email`（部分更新）。

**已下架人口学**：请求体若含 `birth_date` / `country` / `phone` / `gender` → 本节点直接 `400 DEMOGRAPHICS_REMOVED`（不转发、不消耗注册中心配额）。`shared-utils` 侧对应校验函数已物理删除。

**M7-41b 邮箱硬锁**：本节点公开资料蓝标 `email_verified === true`（登记邮箱已通过注册中心认证）时，若 PATCH 试图改成**不同**邮箱 → `409 REGISTRATION_EMAIL_LOCKED`（同值幂等放行）；**未认证前**即使已有邮箱仍可修改。设置页在认证完成后改为只读并隐藏保存按钮。GET 响应含 `email_verified`（中心态 ∪ 本节点蓝标）。

**成功响应**：与 GET 相同 `data` 结构。PATCH 成功后 Worker A 同步本地 `users.registration_email` 与邮箱验证态（fail-soft）；**不再**把人口学写回本地 D1 `users`。

**错误码**：
- `DEMOGRAPHICS_REMOVED`（400）：请求含已下架人口学字段
- `REGISTRATION_EMAIL_LOCKED`（409）：登记邮箱已通过认证，不可再修改
- 注册中心原样透传
- `REGISTRATION_PROFILE_UPDATE_FAILED`（500）：本地代理异常
- `REGISTRATION_PROFILE_INVALID`（400）：JSON 非法 / 邮箱格式无效

---

## 邮箱认证代理（M7-36 / M33-6）

> 注册中心权威契约见 `hailuo-registry/docs/registry-api.md`（`GET/POST /api/node/cert-*`、`esp-verify-request`）。  
> 浏览器经 **Owner Gateway** + JWT 调用下列本地路径；Worker A 代理时注入节点 Ed25519 签名与 `node_api_token`，**禁止**浏览器直连 Worker A 公网地址。

### GET /api/local/registry/certification-context

**JWT 鉴权**。代理 `GET /api/node/certification-context` 并**本地合并**从主注册中心 URL 推导的 `cert_inbound_*` 展示字段；上游仅返回通道开关、海螺币与 TTL（M33-v2-9）。

**成功响应（200）**：

```json
{
  "ok": true,
  "data": {
    "email_verified": false,
    "email_status": "none",
    "channel_a_enabled": true,
    "channel_b_enabled": true,
    "hailuo_coins": 1,
    "esp_verify_coin_cost": 1,
    "cert_inbound_token_ttl_hours": 24,
    "cert_inbound_host": "allovo.eu.org",
    "cert_inbound_address_example": "verify+<token>@allovo.eu.org",
    "cert_inbound_purpose": "该域仅用于邮箱认证收信，不作其他用途"
  }
}
```

**本地代理错误码**：
- 注册中心原样透传（如 `NODE_TOKEN_INVALID`、`NODE_SIGNATURE_INVALID`）
- `REGISTRY_CERT_CONTEXT_INVALID`（502）：上游响应非 JSON
- `CERTIFICATION_CONTEXT_READ_FAILED`（500）：本地代理异常
- `REGISTRY_ALL_UNAVAILABLE`（503）

---

### POST /api/local/registry/cert-inbound-address

**JWT 鉴权**。M33-v2：**Worker A 本地签发**收件地址；认证收件域由主注册中心 URL **本地推导**（M33-v2-9）。签发前读取 `certification-context`（通道开关/TTL）；**登记邮箱以本节点 `users.registration_email` 为准**（登记成功时写入）。SPILL-1c 后中心 `registration-profile` DTO 已删掉 email 明文，中心的 email 仅在旧节点上作兼容回落。

**M7-39 · 收件地址升级 v3**：地址 local-part 由 4 段变 5 段，**内嵌 handle**（handle 全域唯一，与 `user_id` 同级）：

```
verify+<handle10>.<uid10>.<nonce10>.<expB36>.<mac12>@<host>
```

- `handle10`：本节点 `users.handle`（trim + 小写；≥10 字符取后 10，<10 字符取整体）
- `uid10`：`user_id` 后 10 字符
- `mac12`：HMAC-SHA256 前 6 字节 hex，派生自本节点 `users.pubkey`；**v3 拼串 = `v3|<handle10>|<userId>|<nonce>|<exp>`**（handle10 计入 MAC，防伪造归属）
- **v3 段分隔用 `.`**：handle10 / nonce10 自身允许 `-`，用 `-` 会导致 5 段歧义；解析仍兼容历史 `-` 地址
- **nonce 与 MAC 均按小写**：邮箱 local-part 入站会被转小写（注册中心队列 `verify_to` 即小写）；签发时混合大小写会导致 `mac_invalid`
- v2 老地址（4 段）**仍可被注册中心解析与验签**（soft-deprecate），但不再签发新 v2

**请求体**：无或空 JSON。

**成功响应（200）**：

```json
{
  "ok": true,
  "data": {
    "cert_inbound_host": "mail.allovo.eu.org",
    "cert_inbound_address": "verify+alice.abc123XYZ.nonce10.exp.mac12@allovo.eu.org",
    "cert_inbound_address_example": "verify+<token>@mail.allovo.eu.org",
    "cert_inbound_purpose": "该域仅用于邮箱认证收信，不作其他用途",
    "expires_at": "2026-08-23T08:00:00.000Z",
    "expires_in": 86400
  }
}
```

**常见错误码**：`CERTIFY_EMAIL_REQUIRED`（400）、`CERTIFY_ALREADY_VERIFIED`（409）、`CERT_INBOUND_CHANNEL_DISABLED`（403）、`CERT_INBOUND_HOST_MISSING`（503）、`ED25519_PRIVATE_KEY_MISSING`（503）、`NODE_NOT_REGISTERED`（503）、**`NODE_HANDLE_MISSING`（503 · M7-39 本节点 `users.handle` 缺失，无法签发 v3 地址）**。

**注册中心签发 API（M33-v2 已拆除）**：`POST /api/node/cert-inbound-address` 不再挂载（404）。签发走本接口本地 v3 实现（M7-39）。

**本地错误码**：`REGISTRY_CERT_INBOUND_INVALID`（502）、`CERT_INBOUND_ADDRESS_FAILED`（500）、`REGISTRY_ALL_UNAVAILABLE`（503）。

---

### POST /api/local/registry/esp-verify-request

**JWT 鉴权**。代理 `POST /api/node/esp-verify-request`（通道 B：扣海螺币后发 ESP 验证码）。

**M7-39 · handle 必带**：Worker A 从本节点 `users.handle` 读取 handle **注入**转发 body（前端无需传）。本节点无 handle → `NODE_HANDLE_MISSING`（503）。body 非法 JSON → `ESP_VERIFY_REQUEST_INVALID`（400）。

**请求体（可选 JSON）**：

```json
{ "request_id": "client-uuid-or-nonce" }
```

- `request_id`：8–64 位 `[a-zA-Z0-9_-]`，用于幂等；省略时注册中心自动生成。
- Owner Gateway **M7-36-h6a** 须预读 POST body 再 HMAC 签名，保证 JSON body 与转发字节一致。

**成功响应（200）**：

```json
{
  "ok": true,
  "data": {
    "email": "alice@example.com",
    "expires_in": 600,
    "hailuo_coins": 0,
    "spent": 1
  }
}
```

**常见上游错误码**（透传）：`HAILUO_COIN_INSUFFICIENT`（402）、`ESP_VERIFY_REQUEST_INVALID`（400）、`CERT_ESP_CHANNEL_DISABLED`（403）、`CERTIFY_ALREADY_VERIFIED`（409）、`EMAIL_VERIFY_REQUEST_RATE_LIMITED`（429）、`EMAIL_VERIFY_REQUEST_INTERNAL`（500，已退款可重试）。

**本地代理错误码**：`REGISTRY_ESP_VERIFY_INVALID`（502）、`ESP_VERIFY_REQUEST_FAILED`（500）、`REGISTRY_ALL_UNAVAILABLE`（503）。

> **M33-h2 硬化**：重复 `request_id` 幂等返回首次成功响应，不二次扣币；并发双发由 D1 CAS + 唯一索引保证。详见注册中心 `registry-api.md` §`esp-verify-request`。

---

### POST /api/local/registry/email-certify

**JWT 鉴权**。代理 `POST /api/node/email-certify`（登记邮箱验码认证闭环）。

**M7-39 · handle 必带**：Worker A 从本节点 `users.handle` 读取 handle **注入**转发 body（前端无需传）。handle 全域唯一（与 `user_id` 同级），注册中心侧显式校验归属：
- 本节点无 handle → `NODE_HANDLE_MISSING`（503）
- body 缺 `email` / `email_verify_token` → `EMAIL_CERTIFY_INVALID`（400）/ `REGISTER_EMAIL_VERIFY_TOKEN_INVALID`（400）
- 中心侧 handle 不匹配 → `CERTIFY_HANDLE_MISMATCH`（403）透传

**请求体**：

```json
{
  "email": "alice@example.com",
  "email_verify_token": "<token from email-verify-confirm>"
}
```

**成功响应（200）**：

```json
{
  "ok": true,
  "data": {
    "email_status": "verified",
    "email_verified_at": "2026-10-21T08:00:00.000Z",
    "email_verified": true
  }
}
```

**本地错误码**：`REGISTRY_EMAIL_CERTIFY_INVALID`（502）、`REGISTRY_ALL_UNAVAILABLE`（503）。

---

### GET /api/local/registry/cert-purge-status

**JWT 鉴权**。代理 `GET /api/node/cert-purge-status`，供节点内清号提醒横幅（**不发 ESP**）。

**成功响应（200）**：

```json
{
  "ok": true,
  "data": {
    "applicable": true,
    "email_verified": false,
    "email_status": "none",
    "registered_at": "2025-08-22T08:00:00.000Z",
    "purge_at": "2027-08-22T08:00:00.000Z",
    "days_until_purge": 450,
    "reminder_level": "none",
    "reminder_threshold_days": null,
    "policy": {
      "uncertified_purge_months": 24,
      "handle_freeze_days": 30,
      "purge_reminder_days": [90, 30, 7]
    }
  }
}
```

| 字段 | 说明 |
|---|---|
| `reminder_level` | `none` / `overdue` / 命中阈值的十进制字符串（如 `"90"`） |
| `reminder_threshold_days` | **M33-h6b**：与 `reminder_level` 对应的整数天；`none`/`overdue` 为 `null` |
| `policy.purge_reminder_days` | 管理页可配阈值列表；节点 UI 须动态展示，勿写死 90/30/7 |

**本地代理错误码**：`REGISTRY_CERT_PURGE_STATUS_INVALID`（502）、`CERT_PURGE_STATUS_READ_FAILED`（500）、`REGISTRY_ALL_UNAVAILABLE`（503）。

---

## 节点换域接口（M7-30，设计定稿）

> **计划**：[`m7-30-node-url-change-plan.md`](./m7-30-node-url-change-plan.md) · 注册中心契约见 `hailuo-registry/docs/registry-api.md` §`POST /api/node/url-change/*`  
> **M7-30a 实现前只读本文**；禁止通过 `PATCH /api/local/registry/registration-profile` 改 URL。

### POST /api/local/registry/url-change/precheck（M7-30a ✅ precheck）

**JWT 鉴权**。代理 `POST /api/node/url-change/precheck`。

**请求体**：

```json
{
  "new_node_url": "https://example.com",
  "new_worker_b_url": "https://example.com"
}
```

Phase 1：`new_worker_b_url` 必须与 `new_node_url` 相同。成功返回 `url_change_id`、`nonce`、`expires_at`；Worker A 将 `<url_change_id>.<nonce>` 写入 `REGISTRY_URL_CHANGE_PROOF_KV_KEY`（**不**写注册 proof key）。

### POST /api/local/registry/url-change/confirm（M7-30a/b ✅ confirm · M7-30f-1 step-up）

**JWT 鉴权**。代理 `POST /api/node/url-change/confirm`。

**请求体（Web 向导推荐）**：

```json
{
  "url_change_id": "ucg_...",
  "nonce": "<precheck 返回的 nonce>",
  "step_up": {
    "password_hash": "<浏览器 PBKDF2 v1 字符串，与登录同形>",
    "totp_code": "<若已启用 TOTP 则必填>"
  }
}
```

> **M7-30f-1**：`step_up` **必填**。Worker A 先校验密码（及 TOTP），通过后才签名并调用注册中心；失败不转发。  
> 失败码：`STEP_UP_REQUIRED`（缺字段）/ `STEP_UP_INVALID`（密码或验证码错误）/ `TOTP_REQUIRED`（已启用但未填）/ `LOGIN_LOCKED`（与登录共用 D1 `login_attempts` IP 窗口）。

Worker A 使用节点 `ED25519_PRIVATE_KEY` 对 `<url_change_id>.<nonce>` 代为签名后转发注册中心。也可直接传 `signature`（registry base64 格式）。

成功后的本地副作用：更新 D1 `users.worker_b_url`、`system_config`、公开 KV；清理 url_change proof KV；备用 `registry_endpoints[1..]` 标记 `url_sync_state=stale`；**M7-30f-2 / M7-30h-6 / M7-30k-1** 写入 D1 `node_url_moved_entries`（SSOT）并同步 STATE_KV 链式迁址声明（legacy `node:url-moved` + `node:url-moved:index` + `entry:*`）；**M7-30f-4** 写入 `system_config` 迁址键并装填 D1 `url_change_notify_jobs`（已知联系人 outbox）。

**成功响应（registry 200 + 本地 sync 成功）**：`data` 为注册中心 confirm 字段（`user_id` / `node_url` / `worker_b_url` / `changed_at` 等）。

**成功响应（registry 200 + 本地 sync 失败，M7-30h-5）**：HTTP 仍为注册中心状态码（通常 200），`data` 在 registry 字段上**可选**增加：

```json
{
  "ok": true,
  "data": {
    "user_id": "...",
    "node_url": "https://new.example",
    "worker_b_url": "https://new.example",
    "changed_at": "...",
    "local_sync": {
      "ok": false,
      "reconcile_pending": true
    }
  }
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `local_sync.ok` | boolean | `false` 表示本地 D1/KV 未完全同步 |
| `local_sync.reconcile_pending` | boolean | `true` 表示已入 D1 `url_change_local_reconcile`，Cron `url-change-reconcile` 将重试 |

站主侧建议：展示「注册中心已换域，节点本地同步延迟中」；可调 `GET .../url-change/status` 或等待 Cron（约每 10 分钟 `%10===8` 槽）。

> **M7-30d**：**confirm 路径不**更新本站 `follows` / `cache_entries`（被关注方旧 URL 仍由关注方侧愈合）。详见 [`m7-30d-url-change-follows-cache.md`](./m7-30d-url-change-follows-cache.md)。  
> **M7-30e**：粉丝 Token、互证 proof、私信 URL **不迁移**。详见 [`m7-30e-url-change-owner-faq.md`](./m7-30e-url-change-owner-faq.md)。
> **M7-30f-2 / M7-30h-6**：宽限期内勿关旧 Worker B 路由；契约见 [`worker-b-api.md`](./worker-b-api.md) `/.well-known/hailuo-node-moved`（支持 `?old_url=` 链式查询）。
> **M7-30f-3（粉丝节点）**：Cron `fetchAndAggregateFeed` 若见迁址响应头 / well-known 声明，验签后 `UPDATE follows` 并清 `cache_entries`，单源重试拉取 1 次；每 Cron 最多 3 个迁址；**M7-30j-4** 迁址 well-known/users/链式 hop 计入同一 `CronSubrequestBudget(48)`，开始前按 `URL_MOVE_CHAIN_MAX_HOPS×2` 预留；链式解析 `URL_MOVE_CHAIN_MAX_HOPS=5`。实现：`apps/worker-a/src/lib/followUrlMigrate.ts`。
> **M7-30f-4（换域方）**：confirm 后从 `follows` / DM peer / 近 30 日互动 actor 去重装填 outbox；签名信封写入 D1 `url_change_notify_events`（按 `url_change_id` 固化，**M7-30j-1**）；Cron `url-change-notify` 每轮 ≤20 次 `POST {peer}/api/node/events`（出站前 `resolveSafeOutboundPeerUrl`，跳转不跟随），**按 job 的 `url_change_id` 取对应快照**（禁止只读被覆盖的全局 `system_config` 信封）。入站处理在 Worker A `POST /api/node/events`（仅 HMAC 内部；公开入口见 worker-b-api）。
> **M7-30f-5（Settings）**：`GET /api/local/registry/url-change/status` 返回宽限期、outbox 计数、旧址探活与 checklist；Web `UrlMoveStatusPanel` 展示并支持复制公告文案。
> **M7-30h-5**：本地 sync 失败不吞为「全成功」；须带 `local_sync` 并由 Cron reconcile。

### GET /api/local/registry/url-change/status（M7-30f-5）

**JWT 鉴权**。读本站 `system_config` 迁址键 + `url_change_notify_jobs` 按 status 汇总。

**Query**：
- `probe_old=1`（可选）：额外 `GET {old}/health` 探测旧址是否可达（+1 子请求）

**成功 data 字段**：`active`、`old_node_url`、`new_node_url`、`grace_until`、`grace_active`、`days_remaining`、`old_route_reachable`、`notify.{total,pending,sent,failed,dead,skipped}`、`checklist.{keep_old_route_required,may_close_old_route}`。

### POST /api/node/events（M7-30f-4 · 内部专属）

**仅** Worker B Service Binding + `X-Internal-Forward: hmac-v2` 可调用。公开入口：Worker B 同路径。

**请求体**（`type=node_url_changed`）：
```json
{
  "type": "node_url_changed",
  "from_handle": "alice",
  "from_node_url_old": "https://old.example",
  "from_node_url_new": "https://new.example",
  "changed_at": "2026-08-19T00:00:00.000Z",
  "grace_until": "2026-09-02T00:00:00.000Z",
  "nonce": "nce_...",
  "sig": "<ed25519 hex>"
}
```

验签 canonical：`HAILUO_NODE_URL_CHANGED_V1` + 上述字段（换行分隔，不含 `type`/`sig`）。用新址 `GET /users/:from_handle` 的 `pubkey` 验签；通过后将本站 `follows` 中仍指向 `from_node_url_old` 的行改为新址并清 `cache_entries`。

**M7-30j-3 安全（入站）**：`from_node_url_old/new` 须通过 registry 同款 SSRF 门禁（`https` + 443 + 禁私网/环回）；D1 `node_event_nonces` 去重（重放 → `EVENT_REPLAY`）；按 `handle|origin` 60s 窗限频（→ `EVENT_RATE_LIMITED` 429）；`(old,new,handle)` 验签结果短缓存 5min（仍须新 nonce）。

**成功**：`{ "ok": true, "data": { "applied": 1, "matched": 1 } }`  
**失败码**：`INTERNAL_FORWARD_REJECTED`（401）/ `INVALID_BODY`（400）/ `EVENT_UNSUPPORTED`（400）/ `EVENT_VERIFY_FAILED`（400）/ `EVENT_REPLAY`（400）/ `EVENT_URL_BLOCKED`（400）/ `EVENT_RATE_LIMITED`（429）。

---

## 私有记录接口（M11）

> **计划事实源**：[`m11-private-notes-plan.md`](./m11-private-notes-plan.md)。  
> 私有记录是“给自己发消息”式的站主本地能力，只走 Worker A + Owner Gateway + JWT；不进入公开帖子、注册中心、Worker B `/img/*` 或私信跨节点投递链路。
> M11-1～M11-5 已落地文本记录、私有附件、D1 导出/导入闭环；导出文件只包含附件元数据，不打包 B2/KV 对象本体。

### GET /api/private-notes

**JWT 鉴权**。分页读取站主私有记录。

**Query**：
- `limit`：默认 30，最大 100
- `before`：可选游标；新响应使用 `created_at|id` 复合 cursor，旧 `created_at` cursor 仍兼容
- `q`：可选关键词，第一版用 D1 轻量搜索

**响应**：
```json
{
  "ok": true,
  "data": {
    "items": [
      {
        "id": "note_xxx",
        "content": "今天记一件事",
        "kind": "note",
        "attachments": [],
        "created_at": "2026-06-26T10:00:00.000Z",
        "updated_at": "2026-06-26T10:00:00.000Z"
      }
    ],
    "cursor": "2026-06-26T10:00:00.000Z|note_xxx",
    "has_more": false
  }
}
```

### POST /api/private-notes

**JWT 鉴权**。创建一条私有记录。

**请求**：
```json
{
  "content": "给自己发一条记录",
  "attachment_ids": ["att_xxx"]
}
```

`content` 当前上限 10,000 字符；`content` 和 `attachment_ids` 至少有一个非空。`attachment_ids` 只能绑定当前尚未绑定的私有附件。

### PATCH /api/private-notes/:id

**JWT 鉴权**。更新私有记录正文。纯文本记录不允许更新为空；已有未删除附件的记录允许正文为空，便于把“纯附件记录”改回无文字状态或后续补文字。响应会带回当前附件列表。

**请求**：
```json
{ "content": "更新后的记录" }
```

### DELETE /api/private-notes/:id

**JWT 鉴权**。软删除私有记录及其附件元数据；对象物理删除留后续清理工具。

### GET /api/private-notes/export

**JWT 鉴权**。导出当前未删除的私有记录和附件元数据，用于跨浏览器/跨设备迁移。

响应：
```json
{
  "ok": true,
  "data": {
    "meta": {
      "schema_version": 1,
      "exported_at": "2026-06-27T12:00:00.000Z",
      "attachments_included": false,
      "counts": { "notes": 2, "attachments": 1 }
    },
    "notes": [],
    "attachments": []
  }
}
```

`attachments_included=false` 表示 JSON 只包含附件 `id/note_id/storage/object_key/mime/size_bytes/name/created_at/deleted_at` 元数据，不包含 B2/KV 对象二进制内容。v1 单次导出上限为 5,000 条记录和 10,000 条附件元数据；超过时返回 `PRIVATE_NOTE_EXPORT_TOO_LARGE`，后续再做分页导出 v2。

### POST /api/private-notes/import

**JWT 鉴权**。导入 `GET /api/private-notes/export` 生成的 JSON snapshot。导入策略为合并导入：同 ID 已存在则跳过，不覆盖、不删除现有 D1 记录；附件只恢复元数据，不尝试恢复对象本体。导入按 D1 batch 分块提交；中途失败可重试，已写入的记录会在下一次导入中计入 skipped。

响应：
```json
{
  "ok": true,
  "data": {
    "imported_notes": 2,
    "skipped_notes": 0,
    "imported_attachments": 1,
    "skipped_attachments": 0,
    "attachments_included": false
  }
}
```

### GET /api/private-notes/wrapped-key

**JWT 鉴权**。读取站主密码包裹的私有记录主密钥状态。未配置时 `data.enabled=false`；已配置时返回 `wrapped_key_json`（Worker 不解包）。

### PUT /api/private-notes/wrapped-key

**JWT 鉴权**。写入或更新包裹主密钥。请求体：

```json
{
  "wrapped_key_json": "{...}",
  "key_epoch": 1
}
```

浏览器用站主 `password_hash` 派生 KEK 后 AES-GCM 包裹 32 字节主密钥；正文以 `enc:v1:` 前缀密文存入 `private_notes.content`。M11-6 第一版仅加密正文，附件仍为私有对象存储（未对附件字节做 E2EE）。

改密成功后若 D1 存在包裹主密钥，响应 `requires_notes_key_rewrap: true`，浏览器须用新 `password_hash` 重新包裹。

### POST /api/private-notes/attachments

**JWT 鉴权**。上传私有附件。附件不使用公开 `/api/images`，不返回 `kv:img_*` / `b2:img_*` 公共媒体 key。

- `images_storage='b2'` 且 B2 配置完整、探针 `ok` 时：写 B2 私有对象，`storage='b2_private'`，上限按 Worker 请求体保守 500MB。
- 否则：仅允许小图片写 `IMAGE_KV` 私有 key，`storage='kv_private'`，上限 25MB。
- `Content-Type` 用请求头；可选 `X-File-Name` 保存展示名。
- 上传后对象路径保持 `notes/_pending/<attachment_id>`（B2）或 `private-notes:_pending:<attachment_id>`（KV）稳定前缀，仅在 D1 绑定 `note_id`。

### GET /api/private-notes/attachments/:id/content

**JWT 鉴权**。读取私有附件内容；由 Worker A 从 B2 私有对象或 KV 私有 key 读取并返回。响应 `Cache-Control: private, no-store` + `Vary: Authorization`，上游 403/404 统一映射为 `PRIVATE_NOTE_ATTACHMENT_NOT_FOUND`，不得暴露 B2 endpoint、bucket 或签名 query。

### DELETE /api/private-notes/attachments/:id

**JWT 鉴权**。软删除附件元数据，并尽力删除 KV/B2 对象；对象删除失败不回滚 D1 软删。

**错误码**：
- `PRIVATE_NOTE_EMPTY`（400）：正文和附件均为空
- `PRIVATE_NOTE_NOT_FOUND`（404）：记录不存在或已删除
- `PRIVATE_NOTE_ATTACHMENT_NOT_FOUND`（404）：附件不存在、已删除或上游不可读
- `PRIVATE_NOTE_CONTENT_TOO_LONG`（400）：正文超过限制
- `PRIVATE_NOTE_ATTACHMENT_EMPTY`（400）：附件内容为空
- `PRIVATE_NOTE_INVALID_TYPE`（400）：未启用 B2 时上传了非图片附件
- `PRIVATE_NOTE_TOO_LARGE`（400）：附件超过当前后端大小上限
- `PRIVATE_NOTE_LENGTH_REQUIRED`（411）：B2 私有附件上传缺少 `Content-Length`
- `PRIVATE_NOTE_EXPORT_FAILED`（500）：导出 D1 记录失败
- `PRIVATE_NOTE_EXPORT_TOO_LARGE`（400）：当前记录或附件元数据超过 v1 单次导出上限
- `PRIVATE_NOTE_IMPORT_INVALID`（400）：导入 JSON schema、ID、时间或附件归属无效
- `PRIVATE_NOTE_IMPORT_FAILED`（500）：导入 D1 写入失败
- `PRIVATE_NOTE_SAVE_FAILED`（500）：D1 或对象存储写入失败

---

## 节点搬家（M9-7）

> **计划事实源**：[`m9-7-staging-aes-gcm-plan.md`](./m9-7-staging-aes-gcm-plan.md)（A1+B1）；运维清单 [`deploy.md` §节点搬家正规路径（M9-7）](./deploy.md#节点搬家正规路径-m9-7)。
> **Wire 格式**：Worker A 仍收发明文 `hailuo-node-export-v1` JSON（含 `owner_credentials`、Ed25519 私钥、私密笔记等）——**勿**把 wire 明文上传公开网盘。
> **落盘格式**：Web 用口令 AES-256-GCM 包一层 `hailuo-node-export-v2-enc`（`encryptNodeExportJson` / `decryptNodeExportJson`）；Worker **不**跑 PBKDF2。明文 v1 文件仅紧急/本地，UI 警告。
> **正规路径（已落地）**：默认导入 **只写** `DB_IMPORT` → 对账 `import_ready` → `POST /api/node/import/promote-staging`（或本机 `scripts/cutover-db-import.ps1`，确认短语 `CUTOVER`）灌入 IDENTITY/GOVERNANCE/CONTENT；**A7-DB-RETIRE：不再交换旧 `DB` id**（wrangler 已无该 binding）。Web **不**改 binding。
> **逃生口（R-AUDIT-3/5）**：`NODE_INPLACE_IMPORT_ENABLED` 默认关；开启后仍须 `unsafe_inplace_import` +（有数据时）`confirm_overwrite`；半库风险仍在，**非**生产默认。
> **TOTP**：`owner_totp_*` **不迁入**；目标库有行则 `NODE_IMPORT_TOTP_PRESENT`；切流后站主重开 TOTP。
> **不含**：IMAGE_KV / POSTS_CACHE_KV 二进制、MESSAGING_DB（私信/群聊用 M10-5b）。

### GET /api/node/export

**JWT 鉴权**（Owner Gateway 转发）。导出当前节点 D1 权威表 dump + 图片 manifest + Ed25519 私钥 JWK。

**响应**：`Content-Type: application/json`，`Content-Disposition: attachment; filename="hailuo-node-export-v1.json"`，`Cache-Control: no-store`。

**bundle 结构**：
```json
{
  "meta": {
    "schema_version": "hailuo-node-export-v1",
    "proto_version": "1.0",
    "exported_at": "2026-07-08T05:00:00.000Z",
    "export_origin": "https://node.example.workers.dev",
    "table_counts": { "users": 1, "posts": 12 },
    "image_manifest_count": 3,
    "notes": ["…"]
  },
  "d1": {
    "users": [{ "handle": "alice", "pubkey": "…" }],
    "posts": []
  },
  "crypto": {
    "ed25519_public_key_hex": "…",
    "ed25519_private_key_jwk": { "kty": "OKP", "crv": "Ed25519", "d": "…", "x": "…" },
    "ed25519_private_key_pkcs8_hex_hint": "…"
  },
  "image_manifest": [
    { "storage_key": "img:abc", "sources": ["posts:xyz"] }
  ]
}
```

**错误码**：
- `NODE_EXPORT_NOT_CONFIGURED`（500）：未配置 `ED25519_PRIVATE_KEY`
- `NODE_EXPORT_TOO_LARGE`（400）：单表超过 5000 行或整包超过约 8 MB
- `NODE_EXPORT_FAILED`（500）：导出失败

### POST /api/node/import

**JWT 鉴权**。导入 `GET /api/node/export` 生成的明文 v1 bundle（浏览器可先解密 v2-enc）。请求体可为完整 bundle，或：

```json
{
  "confirm_overwrite": true,
  "bundle": { "meta": { "schema_version": "hailuo-node-export-v1" }, "d1": {}, "crypto": {}, "image_manifest": [] }
}
```

**导入策略（M9-7-S2）**：

1. **正规路径（默认）**：未设 `unsafe_inplace_import` 时，**只写** `DB_IMPORT` staging；不要求 `NODE_INPLACE_IMPORT_ENABLED`。缺 binding → `NODE_IMPORT_STAGING_MISSING`（503）。
2. **逃生口**：`unsafe_inplace_import: true` 时写主库 `DB`，且须 `NODE_INPLACE_IMPORT_ENABLED=true`，否则 `NODE_IMPORT_DISABLED` / `NODE_IMPORT_UNSAFE_REQUIRED`。
3. 目标库（staging 或主库）`users` 已有数据时还必须 `confirm_overwrite: true`。
4. **先完整校验**（表白名单、行形态、列名 ⊆ `PRAGMA table_info`）→ 校验目标库无 `owner_totp_*` 行 → 通过后才 DELETE/INSERT。
5. `owner_totp_*` **永不导入**；目标库任一张有行则 `NODE_IMPORT_TOTP_PRESENT`（409）。查询 **fail-closed**。
6. 导入后写目标库 `system_config.posts_cache_dirty=true`；响应含 `import_target: "DB_IMPORT" | "DB"`。
7. **M9-7-S3（仅 staging）**：导入后对账（全表 COUNT，跳过 `system_config`；关键表 `users`/`posts`/`follows`/`owner_credentials` 抽样 SHA-256）。通过则 `system_config.import_ready=true` + `import_reconcile` JSON；失败 → `NODE_IMPORT_RECONCILE_FAILED`（409，已写 `import_ready=false`，附 `data.reconcile`）。
8. **注意**：D1 `batch()` 只保证单次 batch 原子；多表 DELETE/多批 INSERT **不能**整包回滚——故正规路径写空 staging，主库切流靠脚本（B1）。

**响应**：
```json
{
  "ok": true,
  "data": {
    "imported_tables": { "users": 1, "posts": 12 },
    "skipped_tables": ["owner_totp_settings", "owner_totp_recovery_codes"],
    "image_manifest_count": 3,
    "posts_cache_dirty": true,
    "import_target": "DB_IMPORT",
    "import_ready": true,
    "reconcile": {
      "ok": true,
      "reconciled_at": "2026-07-17T15:00:00.000Z",
      "table_counts": { "users": { "expected": 1, "actual": 1, "ok": true } },
      "sample_hashes": { "users": { "ok": true, "bundle_hash": "…", "db_hash": "…", "sample_rows": 1 } },
      "mismatches": []
    },
    "operator_steps": [
      "对账通过：system_config.import_ready=true。可运行 scripts/cutover-db-import.ps1…",
      "请在 Settings 重新启用站主 TOTP…"
    ]
  }
}
```

**错误码**：
- `NODE_IMPORT_STAGING_MISSING`（503）：未配置 `DB_IMPORT`
- `NODE_IMPORT_RECONCILE_FAILED`（409）：staging 对账失败（COUNT/hash 不一致）
- `NODE_IMPORT_DISABLED`（403）：原地导入未开启 `NODE_INPLACE_IMPORT_ENABLED`
- `NODE_IMPORT_UNSAFE_REQUIRED`（400）：原地路径缺少 `unsafe_inplace_import: true`
- `NODE_IMPORT_INVALID`（400）：JSON 或 `schema_version` 无效
- `NODE_IMPORT_INVALID_COLUMN`（400）：列名非法或不在目标 schema（未清库）
- `NODE_IMPORT_CONFIRM_REQUIRED`（409）：目标已有数据，需 `confirm_overwrite: true`
- `NODE_IMPORT_TOTP_PRESENT`（409）：目标库残留 TOTP，须先停用
- `NODE_IMPORT_FORBIDDEN_TABLE`（400）：包含不允许的表名
- `NODE_IMPORT_FAILED`（500）：导入失败

### GET /api/node/import-status

**JWT 鉴权**（Owner Gateway）。读取 `DB_IMPORT` 上的 `import_ready` / `import_reconcile`（切流前检查）。

**成功**：
```json
{
  "ok": true,
  "data": {
    "import_target": "DB_IMPORT",
    "import_ready": true,
    "reconcile": { "ok": true, "reconciled_at": "…", "table_counts": {}, "sample_hashes": {}, "mismatches": [] }
  }
}
```

**错误码**：`NODE_IMPORT_STAGING_MISSING`（503）、`NODE_IMPORT_STATUS_FAILED`（500）。

### POST /api/node/import/promote-staging

**JWT 鉴权**（Owner Gateway）。**A7-DB-RETIRE**：把 `DB_IMPORT` staging 按 `NODE_EXPORT_TABLE_BINDING` 灌入 IDENTITY / GOVERNANCE / CONTENT（替代旧 cutover 交换 `DB`↔`DB_IMPORT` id）。

**请求体**：
```json
{ "confirm_promote": true, "confirm_overwrite": false }
```

- `confirm_promote`（必填 true）
- `confirm_overwrite`：三库 IDENTITY 已有 `users` 时须 true

**成功**：`data.import_target = "SPLIT"`，含 `imported_tables` / `skipped_tables` / `operator_steps`（只返回计数，不 dump 行）。

**错误码**：`NODE_IMPORT_PROMOTE_CONFIRM_REQUIRED`（400）、`NODE_IMPORT_NOT_READY`（409）、`NODE_IMPORT_CONFIRM_REQUIRED`（409）、`NODE_IMPORT_TOTP_PRESENT`（409）、`NODE_IMPORT_PROMOTE_TOO_LARGE`（400）、`NODE_IMPORT_STAGING_MISSING`（503）、`NODE_IMPORT_PROMOTE_FAILED`（500）。

---

## 托管 L0 与删号（M9-8）

> **计划事实源**：`方案优化.md` §7.1（P-15）。默认架构为自托管；`HOSTED_L0_MODE=true` 时标记为托管试用，须用户知情同意。  
> **前置**：M9-7 export/import 已提供「出口自由」；本步补齐隐私声明、数据保留口径与删号。

### GET /api/node/hosted-l0/status

**JWT 鉴权**。返回部署模式、隐私同意状态、数据保留天数、是否需补签隐私声明。

**响应**：
```json
{
  "ok": true,
  "data": {
    "deployment_mode": "hosted_l0",
    "hosted_l0_enabled": true,
    "operator_label": "海螺托管试用",
    "privacy_version": "1.0",
    "privacy_accepted": false,
    "privacy_accepted_at": null,
    "data_retention_days": 30,
    "export_available": true,
    "account_deleted": false,
    "account_deleted_at": null,
    "requires_privacy_acceptance": true
  }
}
```

`deployment_mode`：`self_hosted`（默认）| `hosted_l0`（`HOSTED_L0_MODE=true`）。

### GET /api/node/hosted-l0/privacy

**JWT 鉴权**。返回托管 L0 隐私声明正文（版本 + sections）。

### POST /api/node/hosted-l0/privacy/accept

**JWT 鉴权**。仅在 `HOSTED_L0_MODE=true` 时可用；写入 `system_config.hosted_l0_privacy_*`。

**请求**（可选）：
```json
{ "privacy_version": "1.0" }
```

**错误码**：
- `HOSTED_L0_NOT_ENABLED`（400）：非托管模式
- `HOSTED_L0_PRIVACY_VERSION_MISMATCH`（400）：版本不匹配

### POST /api/node/account/delete

**JWT 鉴权**。清空 M9-7 白名单 D1 表 + `owner_credentials`，写入 `account_deleted_at`。不删除 KV 二进制、不代发注册中心注销。

**请求**：
```json
{
  "confirm_phrase": "删除我的账号",
  "export_acknowledged": true
}
```

**错误码**：
- `ACCOUNT_DELETE_CONFIRM_INVALID`（400）：口令错误
- `ACCOUNT_DELETE_EXPORT_ACK_REQUIRED`（400）：未确认导出
- `ACCOUNT_DELETE_FAILED`（500）：删除失败

---

> SPILL-1b-6-d 退役段：原「## 机器节点 invite（M9-9）」段（line 1958～含 `GET / POST /api/node/machine-invites`、`machine_registration_secret`、`MACHINE_INVITE_*` 错误码）随 Worker A 路由删除（SPILL-1b-6-a `10bab34a`）+ 共享类型删除（SPILL-1b-6-c `ac4d1156`）+ UI 清理（SPILL-1b-6-b `f484e8a4`）一并退役。机器节点 invite 已永久下线，仅供 `git log` 历史回查。

## 帖子接口

### POST /api/posts

发帖。

**请求**（multipart/form-data 或 JSON）：
```json
{
  "content": "帖子内容，最多 500 字符",
  "images": []
}
```

**响应**：
```json
{
  "ok": true,
  "data": {
    "id": "post_xxx",
    "content": "帖子内容",
    "sig": "<ed25519签名>",
    "created_at": "2026-01-01T00:00:00.000Z",
    "image_urls": ["https://alice-worker-b.workers.dev/img/xxx"]
  }
}
```

**错误码**：
- `CONTENT_TOO_LONG`（400）：内容超过 500 字符
- `UNAUTHORIZED`（401）：未登录

---

### POST /api/posts/repost（M9-1）

**JWT 鉴权**。纯转发：在**本节点**创建一条 `post_kind=repost` 的新帖，**只存原帖引用**，不复制正文/图片。

> 设计细节见 [`m9-1-repost-plan.md`](./m9-1-repost-plan.md) §四。

**请求**：
```json
{
  "origin_node_url": "https://bob-worker-b.example.workers.dev",
  "origin_post_id": "post_01HXXX",
  "origin_author_handle": "bob"
}
```

| 字段 | 必填 | 说明 |
|------|------|------|
| `origin_node_url` | 是 | 原帖 Worker B 根 URL（http/https）；禁止 Worker A 地址 |
| `origin_post_id` | 是 | `post_` 前缀 ID |
| `origin_author_handle` | 否 | 展示用；缺省从本节点 D1（自节点 / 已关注 profile）回落 `unknown` |

**成功响应**：
```json
{
  "ok": true,
  "data": {
    "id": "post_zzz",
    "post_kind": "repost",
    "repost_of": {
      "node_url": "https://bob-worker-b.example.workers.dev",
      "post_id": "post_01HXXX",
      "author_handle": "bob"
    },
    "sig": "<hex>",
    "created_at": "2026-07-04T08:00:00.000Z"
  }
}
```

**错误码**：
- `INVALID_BODY`（400）
- `ORIGIN_NODE_URL_REQUIRED` / `ORIGIN_NODE_URL_INVALID`（400）
- `ORIGIN_POST_ID_INVALID`（400）
- `ORIGIN_POST_NOT_FOUND`（404）
- `ORIGIN_POST_OFFICIAL`（403）
- `ORIGIN_POST_IS_REPOST`（400）
- `ORIGIN_POST_FORBIDDEN`（403）：protected 节点预检仍不可读
- `REPOST_ALREADY_EXISTS`（409）
- `REPOST_ORIGIN_UNREACHABLE`（502）
- `POST_SIGN_FAILED` / `POST_INTERNAL`（500）
- `UNAUTHORIZED`（401）

**副作用**：D1 INSERT + `posts_latest_dirty`；`waitUntil(refreshPostsCacheIfDirty)`；不写 IMAGE_KV。

**预检**：转发前 GET `{origin}/posts/{id}`（本节点 origin 直读 D1）；401/403 时申请粉丝 Token 重试一次。

---

### GET /api/node-settings/follower-token-mode（M14-1 + **SEC-AUDIT-ENFORCED-FORCE-2**）

**JWT 鉴权**。读取当前读帖保护档位（D1 `system_config` 权威；无行时回落 env / 产品默认）。

> **SEC-AUDIT-ENFORCED-FORCE-2**：程序强制锁关闭。未配置时默认 `token-required`；`source` 为 `d1` 或 `env`（仅当 FORCE 再开时才为 `program`）。

**响应示例**：
```json
{
  "ok": true,
  "data": {
    "mode": "token-required",
    "source": "d1"
  }
}
```

- `mode`：canonical 五档之一；未写入时为默认 `token-required`。
- `source`：`d1` | `env` |（可选再锁）`program`。

| 配置值 | Settings 文案 | 说明 |
|---|---|---|
| `token-required`（**产品默认**） | 读帖须凭证 | 读帖须合法粉丝 Token；签发**不查**关注表 |
| `public-read` | 公开读 | 站主可显式放宽；匿名可读 |
| `following-only` | 已关注节点可读 | 遗留 `enforced` 读作此档 |
| `mutual-only` | 互粉可读 | 须互粉 + proof |
| `owner-only` | 仅站主可读 | 不对外签发粉丝 Token |

SSOT：`@hailuo/shared-utils` `FOLLOWER_TOKEN_MODE_DEFAULT` / `FOLLOWER_TOKEN_MODE_FORCE_ENABLED`。

---

### PATCH /api/node-settings/follower-token-mode（M14-1 + **SEC-AUDIT-ENFORCED-FORCE-2**）

**JWT 鉴权**。body：`{ "mode": "<canonical 五档>" }` → 写入 D1 + `STATE_KV`。

**错误码**：
- `INVALID_MODE` / `BAD_REQUEST`（400）
- `MODE_PROGRAM_LOCKED`（403）：仅当程序强制锁再开时返回（现行默认关闭，站主可改档）

---

### POST /api/read/mutual-proof（M14-3 实现；**契约 M14-1 定稿**）

**JWT 鉴权**（`requireOwnerJWT` + Pages Owner Gateway）。读者节点站主为本节点生成互粉读帖证明，供向互粉节点申领读帖 Token 时携带。

**鉴权路径**：
- 站主 Web：`Owner Gateway` → 本 Worker A（**禁止**匿名浏览器直连 Worker A 公网地址）；Web 侧封装见 `web/src/lib/readMutualProofClient.ts`，由 `ensureFollowerToken` 在需要时调用。
- Cron：读者 Worker A **`buildReadMutualProofForOwner(env, ownerWorkerBUrl)`**（`routes/read-mutual-proof.ts` 导出，不经 HTTP）

**请求**：
```json
{
  "owner_worker_b_url": "https://alice-worker-b.workers.dev",
  "owner_handle": "alice"
}
```

**响应**：
```json
{
  "ok": true,
  "data": {
    "proof": {
      "reader_worker_b_url": "https://bob-worker-b.workers.dev",
      "owner_worker_b_url": "https://alice-worker-b.workers.dev",
      "purpose": "read-token",
      "exp": 1710000000,
      "nonce": "...",
      "sig": "..."
    }
  }
}
```

证明与 `dm_send_ticket` 同构（Ed25519 + exp + nonce）；`purpose` 固定 `read-token`，与私信 ticket 分离；URL 字段须经 `normalizeWorkerBOrigin()`。

**错误码**：`NOT_MUTUAL_FOLLOW`（403）、`USER_NOT_REGISTERED`（409）、`INVALID_BODY`（400）。

---

### GET /api/node-settings/media-storage

**JWT 鉴权**。读取当前媒体存储 backend 与 B2 / Filebase 脱敏配置。

**响应（M5-SR 扩展）**：
```json
{
  "ok": true,
  "data": {
    "mode": "router",
    "write_priority": ["filebase", "b2", "r2", "kv"],
    "active_write_backend": "filebase",
    "backend": "filebase",
    "b2": { "...": "..." },
    "filebase": { "...": "..." },
    "usage": {
      "kv": {
        "configured": true,
        "bytes_used": 52428800,
        "bytes_limit": 1073741824,
        "bytes_buffer": 0,
        "bytes_threshold": 1073741824,
        "percent_of_threshold": 4.9,
        "object_count": 42,
        "last_calibrated_at": null,
        "status": "ok"
      },
      "filebase": {
        "configured": true,
        "bytes_used": 2147483648,
        "bytes_limit": 5368709120,
        "bytes_buffer": 52428800,
        "bytes_threshold": 5316280320,
        "percent_of_threshold": 40.4,
        "object_count": 128,
        "last_calibrated_at": "2026-06-28T12:00:00.000Z",
        "status": "ok"
      },
      "b2": {
        "configured": true,
        "bytes_used": 0,
        "bytes_limit": 10737418240,
        "bytes_buffer": 104857600,
        "bytes_threshold": 10632560640,
        "percent_of_threshold": 0,
        "object_count": 0,
        "status": "ok"
      }
    },
    "probe_status": "ok",
    "b2_probe_status": "ok",
    "filebase_probe_status": "ok",
    "updated_at": "2026-06-24T12:00:00.000Z",
    "r2_bound": true,
    "thresholds": {
      "kv_high_watermark": 0.9,
      "kv_preferred_max_bytes": 10485760,
      "r2_high_watermark": 0.9,
      "r2_target_watermark": 0.7
    }
  }
}
```

`mode`：`router`（自动链，按 `write_priority`）| `manual`（legacy 三选一；满额时可按 `write_priority` 溢出）。`write_priority` 来自 D1 `media_write_priority`，反映 Filebase/B2 **配置先后**。

`backend` 权威源为 `system_config.images_storage`（`kv` | `b2` | `filebase` | `r2`）。`probe_status` 对应当前 active backend 的探针状态；`b2_probe_status` / `filebase_probe_status` 分别独立返回。

`usage.kv`（**M8-14-10 / 10b**）：`IMAGE_KV` 媒体自记账用量（软上限约 1 GiB，对齐 Free Tier）；**不是** Cloudflare 控制台精确值。上传成功后累加；`backfill_usage` / `recalibrate_kv` 会列举 `IMAGE_KV`（prefix `kv:`）校准并以 list 为真值写入（可下调），同时 `INSERT OR IGNORE` 补登记孤儿对象。`usage.r2` 仅在 `HAILUO_IMAGE_R2` 已绑定且探针 `ok` 时返回。

B2 / Filebase 凭证存 D1 `media_storage_config`（`id='b2'` / `id='filebase'`）；Worker B 读代理运行态分别同步到 `STATE_KV` 键 `node:media_b2_config` / `node:media_filebase_config`（含密钥，永不对公网暴露）。

---

### PATCH /api/node-settings/media-storage

**JWT 鉴权**。切换 backend、保存 B2 / Filebase 配置，或切换 M5-SR 自动路由模式。

**请求（启用自动路由，M5-SR）**：
```json
{ "mode": "router" }
```

router 模式下可仅保存凭证（不要求 `backend` 单选）：
```json
{
  "mode": "router",
  "filebase": { "key_id": "...", "app_key": "...", "bucket_name": "...", "endpoint": "https://s3.filebase.io" },
  "b2": { "key_id": "...", "app_key": "...", "bucket_name": "...", "endpoint": "https://..." }
}
```

**请求（手动校准 Filebase 用量）**：
```json
{ "recalibrate_filebase": true }
```

**请求（M5-SR-P2d 登记聚合回填 + Filebase API）**：
```json
{ "backfill_usage": true }
```

从 `media_object_registry`（`released_at IS NULL`）按 backend 聚合 `bytes_used` / `object_count`，与本地计数取 max；并触发 Filebase / R2 校准，以及 **KV list 校准**（M8-14-10b，可下调）。

**请求（M5-SR-P2b 手动 B2 用量同步）**：
```json
{ "recalibrate_b2": true }
```

通过 B2 S3 兼容 `ListObjectsV2` 分页列举 bucket 对象并汇总字节数，与本地计数取 max。大 bucket 单次可能因分页上限只扫部分对象（日志 `truncated`）。Cron 每日 UTC 03:00 自动执行一次。

**请求（M5-SR-P2c 手动 R2 用量同步）**：
```json
{ "recalibrate_r2": true }
```

优先调用 Cloudflare REST `GET /accounts/{account_id}/r2/buckets/{bucket_name}/usage`（需 Worker 环境变量 `R2_USAGE_ACCOUNT_ID`、`R2_USAGE_BUCKET_NAME` 与 secret `R2_USAGE_API_TOKEN`）。未配置时回落 `HAILUO_IMAGE_R2` binding 的 `list()` 分页汇总。R2 行 `bytes_limit` 为 null，无满额切换阈值，仅展示与路由参考。Cron 每日 UTC 04:00 自动执行一次。

**请求（M8-14-10b 手动 KV 用量同步）**：
```json
{ "recalibrate_kv": true }
```

列举 `IMAGE_KV`（prefix `kv:`），按 metadata.size 汇总写入 `media_storage_usage`（backend=`kv`，以 list 为真值可下调），并对缺失行 `INSERT OR IGNORE` 进 `media_object_registry`。`backfill_usage` 也会先执行本校准。

**请求（M8-14-10c 清理孤儿 KV 图）**：
```json
{ "gc_orphan_kv": true }
```

列举 `IMAGE_KV` prefix `kv:`；跳过仍被未删帖 `image_keys` 或 `users.avatar_key` 引用的对象；其余删除 bytes、登记 `released_at`、减计数，并末尾再跑 `recalibrate_kv` 等价校准。记录附件 `private-notes:` 不在扫描范围。

仅切 mode / 校准类字段时可不传 `backend`（与 `recalibrate_filebase` 相同）。

**请求（切 KV）**：
```json
{ "backend": "kv" }
```

切 KV 时保留 D1 中 B2 / Filebase 配置与对应 `STATE_KV`，旧 `b2:img_*` / `filebase:img_*` 仍可读。

**请求（启用 Filebase，M5-FB）**：
```json
{
  "backend": "filebase",
  "filebase": {
    "key_id": "...",
    "app_key": "...",
    "bucket_name": "hailuo-media",
    "endpoint": "https://s3.filebase.io",
    "region": "auto"
  }
}
```

Filebase S3 兼容 endpoint 默认 `https://s3.filebase.io`；region 默认 `auto`（勿用 B2 的 `us-east-1`）。

**请求（启用 B2）**：
```json
{
  "backend": "b2",
  "b2": {
    "key_id": "...",
    "app_key": "...",
    "bucket_name": "hailuo-images",
    "endpoint": "https://s3.us-west-004.backblazeb2.com",
    "region": "us-west-004"
  }
}
```

`app_key` 省略或空字符串表示保留 D1 已有密钥（若从未保存则必填）。保存前执行 B2 探针；探针失败不切换 `images_storage`。

**请求（清除 B2 配置）**：
```json
{ "backend": "kv", "clear_b2": true }
```

**请求（清除 Filebase 配置）**：
```json
{ "backend": "kv", "clear_filebase": true }
```

**错误码**：
- `MEDIA_STORAGE_INVALID_BACKEND`（400）
- `B2_CONFIG_INCOMPLETE`（400）
- `B2_CONFIG_INVALID_URL`（400）
- `B2_PROBE_FAILED`（502）
- `FILEBASE_CONFIG_INCOMPLETE`（400）
- `FILEBASE_CONFIG_INVALID_URL`（400）
- `FILEBASE_PROBE_FAILED`（502）
- `MEDIA_STORAGE_SAVE_FAILED`（500）：含 D1 已写但 `STATE_KV` 同步失败时（此时不切换 `images_storage`）

- `MEDIA_STORAGE_FULL`（507）：router 模式下链上所有后端已满或未配置
- `MEDIA_STORAGE_ROUTER_DISABLED`（507）：manual 模式下当前 backend 已满（提示开启 router）

---

### POST /api/images

上传媒体文件。`mode=router` 时按 D1 `write_priority`（云存储配置先后）选库；`mode=manual` 时先 `images_storage`，满额可溢出到链上其它库。

> M2-5 新增；M5-B2 起 B2 配置来自 D1/Web 设置；M5-FB 起 Filebase 对称支持 `filebase:img_*` 前缀。

**JWT 鉴权**（仅站主调用）。

**请求头**：
- `Content-Type`：KV 仅 `image/*`；B2/R2/Filebase 任意类型
- B2/Filebase 流式上传需 `Content-Length`

**请求体大小**：
- KV：最大 25 MB（KV 单值硬上限）
- B2/R2/Filebase：默认最大 **100 MB**（Cloudflare Free/Pro Workers 请求体限制）
- operator 可通过 env `MEDIA_MAX_REQUEST_BYTES` 覆盖（Business 209715200、Enterprise 524288000）

**响应**（`mode=router` 时可能额外带 `size_bytes`、`usage_after`）：
```json
{
  "ok": true,
  "data": {
    "key": "filebase:img_abc123",
    "url": "https://alice-worker-b.workers.dev/img/filebase:img_abc123",
    "storage": "filebase",
    "size_bytes": 1048576,
    "usage_after": {
      "bytes_used": 52428800,
      "bytes_threshold": 5316280320
    }
  }
}
```

`storage` 取值：`kv` | `b2` | `filebase` | `r2`。

**错误码**：
- `IMAGE_REQUIRED`（400）：请求体为空
- `IMAGE_TOO_LARGE`（400）：超过 25 MB
- `IMAGE_INVALID_TYPE`（400）：Content-Type 不是 `image/*`
- `UNAUTHORIZED`（401）：未登录

---

### GET /api/images/:key

**M14-11 / SEC-AUDIT-2026-10-12**：站主 JWT 读媒体二进制。Web 在**保护档**（`owner-only` / `following-only` / `mutual-only` / `token-required`）下对本站图走本端点，不依赖粉丝 Token / 媒体票据（站主无法「关注自己」申领）。

**JWT 鉴权**（仅站主；Pages Owner Gateway 转发时携带浏览器 `Authorization`）。

**路径参数**：`key` 为 URL 编码的 internal key（`kv:img_*` / `r2:img_*` / `b2:img_*` / `filebase:img_*`）。

**响应**：二进制流；`Cache-Control: private, no-store`。

**错误码**：
- `IMAGE_NOT_FOUND`（404）
- `UNAUTHORIZED`（401）

> **SEC-AUDIT-2026-10-6a · 媒体票据（MEDIA-TICKET-1）边界说明**：
> 面向浏览器 `<img src>` 的媒体票据**不经 Worker A**——由**被访问方 Worker B** 自行签发并校验（`POST /api/media/tickets` + `GET /img/:key?ticket=`，见 [`worker-b-api.md`](./worker-b-api.md)）。理由：①Worker A 地址永不对外暴露（§F-02），票据出现在 URL 里更不能借道 Worker A 公网地址；②`MEDIA_TICKET_SECRET` 只存在于消费方 Worker B，泄露面收敛在单个 Worker 内，无需跨 Worker 同步密钥；③签发是纯 HMAC 计算，**零 KV/D1 写入**，不触碰 Free Tier 写额度。
> Worker A 本节端点**不变**：站主 JWT 读自己的媒体，与票据能力正交。

---

### DELETE /api/posts/:id

删帖（软删除）。

**副作用（M5-SR-P2）**：`waitUntil` 异步释放 `image_keys` 中已登记的公开媒体对象——删除底层存储（KV/R2/B2/Filebase）并对 `media_storage_usage` 执行 `decrementUsage`。仅对 router 上线后经 `POST /api/images` 登记进 `media_object_registry` 的对象生效；历史未登记对象跳过（用量可能仍高估）。

**响应**：`{ "ok": true }`

**错误码**：
- `POST_NOT_FOUND`（404）：帖子不存在
- `UNAUTHORIZED`（401）：未登录

---

## 加好友接口（M17-1 · 设计定稿 v1.2）

> Worker A 只保存 `friend_requests` 状态机、本地副本 + `local_notifications` 通知行；
> 不接受明文附言、对方私钥或其它节点直连。外部节点投递必须先到对方 Worker B `POST /friend-requests/inbox`，
> 再由 Worker B 通过 Service Binding + HMAC 转发到本节内部端点。站主 Web 走 Pages Functions / Owner Gateway 同源入口（同 `dm.ts` 模式）。

跨节点 envelope：`HAILUO_FRIEND_REQUEST_V1\n{method} {path}\n{ts}\n{nonce}\n{body_sha256_hex}`，Ed25519 sign/verify，5 分钟窗口；详见 [`apps/worker-a/src/lib/friendRequestEnvelope.ts`](../apps/worker-a/src/lib/friendRequestEnvelope.ts)。

envelope body：

- `POST /friend-requests/inbox`（origin → target）：`{ request_id, origin:{ node_url, handle, display_name?, avatar_key?, pubkey }, target:{ node_url, handle }, message?, nonce, sig, ts }`
- `POST /friend-requests/outbox`（target → origin）：`{ request_id, status: 'accepted' | 'rejected', actor:{ node_url, handle, pubkey }, nonce, sig, ts }`

错误码（plan §5.6）：`FRIEND_REQUEST_NOT_FOUND` / `NOT_RECIPIENT` / `NOT_ORIGIN` / `ALREADY_RESOLVED` / `ALREADY_FOLLOWING` / `FRIEND_REQUEST_SELF` / `BLACKLISTED` / `RATE_LIMITED` / `INCOMING_DISABLED` / `FRIEND_REQUEST_INVALID_PARAMS` / `FRIEND_REQUEST_INVALID_SIG` / `FRIEND_REQUEST_REPLAY`。

> **M17-FIX-4 breaking**：原 `ALREADY_FRIENDS`（409）已更名为 `ALREADY_FOLLOWING`——语义为「本端 `follows` 已有对方行」（单边），**不是**互粉确认。

### 站主端（`[JWT]` · M17-1e ✅ 已落地）

- `GET /api/friend-requests?direction=incoming|outgoing&status=pending&limit=20&cursor=` — 列请求（`FRIEND_REQUEST_INVALID_PARAMS` 400）
  - **REL-FIX-4**：列表行额外带 `inbox_status` / `inbox_error` 两个**发起侧投递回执**字段（`direction=outgoing` 才有意义；`incoming` 恒为 `''`）。
    - `inbox_status`：`''`（未投递 / 投递中）· `'acked'`（对端已收下，确定送达）· `'pending_retry'`（投递失败，cron 24h 内重投）· `'giveup'`（超 24h 放弃，对方大概率从未收到）。
    - `inbox_error`：最近一次投递失败的**脱敏短码**（`INCOMING_DISABLED` / `BLACKLISTED` / `RATE_LIMITED` 等；不含 URL / 邮箱 / IP 原文）。
  - **旧库降级**：CONTENT_DB 未 apply migration `0061`/`0062`（缺列）时，列表**不 500**，回落基础列查询并把两字段返回空串（= 未知，**不谎报 `acked`**）。前端按"未确认送达"呈现。
  - 用途：站主可感知"对方到底收没收到"，`giveup` 时给出可行动提示 + 重新发起入口（`web/src/components/FriendDeliveryBadge.tsx`）。
  - **REL-FIX-11**：列表行额外带 `outbox_status` / `outbox_error` 两个**接收侧回执**字段（`direction=incoming` 才有意义；`outgoing` 恒为 `''`）。
    - `outbox_status`：`''`（回执投递中 / 初始）· `'acked'`（发起方已确认收到回执，对方知道结果了）· `'pending_retry'`（回执投递失败，cron 24h 内重投）· `'giveup'`（超 24h 放弃，**发起方很可能仍在干等**）。
    - `outbox_error`：最近一次回执投递失败的**脱敏短码**（`INCOMING_DISABLED` / `BLACKLISTED` / `RATE_LIMITED` 等；不含 URL / 邮箱 / IP 原文）。
    - 与 `inbox_status` **严格对称**：`inbox_status` 回答「我发的请求，对方收没收到」；`outbox_status` 回答「我回的结果，对方知不知道」。
  - **REL-FIX-11**：`status` 过滤新增 `'resolved'` 模式 —— **已处理但回执未确认送达对方**（`status IN ('accepted','rejected') AND COALESCE(outbox_status,'') != 'acked'`）。
    - **只允许 `direction=incoming`**：发起方行的 `outbox_status` 语义不同（只记录「撤回通知有没有送到对端」），拿它判断「对方知不知道结果」会**撒谎** → 传 `direction=outgoing&status=resolved` 显式返 `400 FRIEND_REQUEST_INVALID_PARAMS`，**不静默给错数据**。
  - **REL-FIX-11**：响应 `data` 额外带 `pending_count`（该方向的 `status='pending'` 行数；纯 D1 `COUNT(*)` 读，**零 KV 写**）—— 未读角标数据源（对齐 REL-FIX-5 群主待审批角标做法）。统计失败 fail-soft 返 `0`。
  - **旧库降级（REL-FIX-11 扩）**：缺 `inbox_status` / `inbox_error` / `outbox_error` 任一列时（未 apply `0061`/`0062`/`0063`）走同一降级路径，列表**不 500**；`outbox_status` 属基础列（`0060`）仍能取到 → 「已处理但回执未确认」这一维度在旧库上依然可用，只是拿不到失败短码。
  - 用途（接收侧）：接收方可感知"我回的结果，对方知不知道"，`giveup` 时给出可行动提示（`web/src/components/FriendReceiptBadge.tsx`）。
  - **SEC-AUDIT-2026-10-7（存储级 Pin 与首见状态）**：
    - 当 `direction=incoming` 时，列表行附带 `has_pin?: boolean` 与 `first_seen?: boolean`；
    - `has_pin: true` / `first_seen: false`：本站 `follows` 表中已固化该节点的 64 hex 权威公钥 Pin（已知好友，前端展示「已验证公钥」徽标，二次确认弹窗降级钓鱼警示）；
    - `has_pin: false` / `first_seen: true`：未关注或冷启动首见节点（前端强化展示「来源未验证 · 首次接触」徽标与钓鱼警示条）。
    - **换钥冒名拦截**：已有 Pin 节点若被攻击者用新公钥冒名发信，收件箱门禁直接 `403 FRIEND_REQUEST_INVALID_SIG` 拒收，**绝对不入库、不写通知**；数据库故障时严格 **fail-closed** 返回 `503 PIN_CHECK_FAILED`。
    - **合法换钥通道**：节点合法迁移/换钥经由带旧签名的 `node_url_changed` 声明自动更新本地 Pin；若离线单方换钥，站主可在通讯录取关对方后重新发起关注以更新本地信任 Pin（TOFU 原则）。
    - **SEC-AUDIT-2026-10-7-2（Repair 写 pin 收尾）**：
      - Repair 取对端权威公钥（补 `follows.followed_pubkey`）走**外部子请求预算封顶** `FRIEND_REQUEST_REPAIR_PIN_FETCH_CAP=10`（origin / target 两段共享同一计数器）—— 扫描批 50×2 最坏 100 次出站会击穿 Cloudflare 单次 invocation **50 子请求硬上限**；预算耗尽时**只跳过取 pin，DB 修复照常**，未取到的 pin 顺延后续 tick（Repair 幂等可重入）。
      - 取档**校验 handle 同一人**：`GET /users/:handle` 返回的 handle 必须与请求 handle 指同一人（两边都带 `@regN` 时须全串相等；任一为裸名时比裸名段）—— 否则视为取档失败，**绝不把他人公钥写成 Pin**（错 Pin 比无 Pin 更危险，会误拒真实好友）。
      - `friend-request-gc` 任务声明的外部子请求预算由 15 上调为 **25**（inbox 10 + outbox 5 + Repair 取 pin 10），与实际最坏值账实一致，仍在 `CRON_EXTERNAL_SUBREQUEST_CAP(50)` 内。
- `POST /api/friend-requests` body=`{ target_node_url, target_handle, message? }` — 发起（本地 INSERT + `waitUntil` 投递对端 Worker B `/friend-requests/inbox`；`FRIEND_REQUEST_SELF` / `ALREADY_FOLLOWING` / `BLACKLISTED` / `RATE_LIMITED` / `FRIEND_REQUEST_INVALID_PARAMS`）
- `POST /api/friend-requests/:id/accept` — 接受（本地写 follows + `waitUntil` 投递对端 `/friend-requests/outbox`；`FRIEND_REQUEST_NOT_FOUND` / `NOT_RECIPIENT` / `ALREADY_RESOLVED`）
- `POST /api/friend-requests/:id/reject` body=`{ reason? }` — 拒绝（同上错误码 + `waitUntil` outbox）
- `DELETE /api/friend-requests/:id` — 撤回（仅 origin；本地 `status=cancelled` 后 `waitUntil` 投递 `status=cancelled` outbox → target；对端写 `friend_request_cancelled` 通知；`NOT_ORIGIN` / `ALREADY_RESOLVED`）
  - **REL-FIX-11**：撤回成功后**本端**额外写一条 `friend_request_withdrawn` 本地通知（fail-soft，不阻断撤回主流程）—— 撤回后该行从 `pending` 列表消失，若无此通知，站主回头完全看不到「我撤回了没」「对方知不知道我撤回了」。通知 `request_id` 直达通讯录面板对应行（前端深链 `/messages?tab=contacts&request=<fr_id>`）。

路由：`apps/worker-a/src/routes/friend-requests.ts`；JWT 挂载须同时覆盖精确路径与 `/*`（Hono `/*` 不匹配精确 `/api/friend-requests`）。跨节点投递 helper：`lib/friendRequestDelivery.ts`。

### 跨节点接收方（`/friend-requests/inbox`，Service Binding + HMAC · M17-1e ✅ 已落地）

收件方 Worker B 的公开 `POST /friend-requests/inbox` 通过 Service Binding 转发到本端点，并携带 `X-Internal-Forward: hmac-v2` + `X-Timestamp` + `X-Nonce` + `X-Signature`。Worker A 用 `INTERNAL_FORWARD_SECRET` 绑 method/path/body 验 HMAC；缺失或不符返回 `INTERNAL_FORWARD_REJECTED`（403）。逻辑层走 `friendRequestInbox.ts`：JSON parse → 时间窗口 → Ed25519 envelope 验签（用 envelope.origin.pubkey）→ target_node_url 须命中本机别名（REL-FIX-2：match 归一 + `resolveLocalNodeUrlAliases` 成员判定；canonical/users/env/旧址宽限/D1 entry；落库仍原文归一）→ 黑名单门控（本地 blacklist 表）→ `system_config.friend_requests_inbox_enabled` 开关（默认开）→ inbox 频控 100/h/源节点 → pending UNIQUE 索引幂等 → INSERT friend_requests（status='pending'，**SEC-AUDIT-2026-10-14**：同步落库申请里的 `origin_pubkey`。**NCF-SEC-BIND-1**：本地尚无 Pin 时，接受前必须取对端公开档案，公钥一致才写入 `follows.followed_pubkey`；不一致或对端不可达则拒绝接受，不把申请里的公钥钉进去）→ 写 `local_notifications`（`friend_request_received`）。

路由：`apps/worker-a/src/routes/friend-requests-internal.ts`（不挂 JWT）。

### 跨节点状态回报（`/friend-requests/outbox`，Service Binding + HMAC · M17-1e ✅ 已落地）

发件方 Worker B 的公开 `POST /friend-requests/outbox` 通过 Service Binding 转发到本端点，同样携带 HMAC v2 头。逻辑层走 `friendRequestOutbox.ts`：JSON parse → 时间窗口 → Ed25519 envelope 验签 → 查找本地 friend_requests 行。**`accepted` / `rejected`**（target→origin）：actor 须等于该行 target；幂等后 accepted 双写 follows + `friend_request_accepted`，rejected 写 `friend_request_rejected`。**`cancelled`（M17-4-1，origin→target）**：本站须为该行 target，actor 须等于 origin；pending→cancelled + 写 `friend_request_cancelled` 通知。

### 站主开关（`/api/node-settings/friend-requests` · M17-2 ✅ 已落地）

- `GET /api/node-settings/friend-requests` → `{ allow_incoming: boolean }`（默认 `true`；D1 `system_config.friend_requests_inbox_enabled`）
- `PATCH /api/node-settings/friend-requests` body=`{ allow_incoming: boolean }` — 站主开关

路由：`apps/worker-a/src/routes/node-settings.ts`（既有 `nodeSettingsApp`）。

### 群号窗诊断（`GET /api/node-settings/group-lifecycle` · V2-20 ✅ 已落地）

- 鉴权：站主 JWT（既有 `nodeSettingsApp` 父中间件）。
- 响应 `{ has_owner, config_interval_days, last_daily_sync_reported_at }`：
  - `has_owner=false` → 未登记站主（无 `system_config.owner_user_id`）
  - `config_interval_days=null` → **omit 中**（未学中心值；下次 presence 200 后学）
  - `config_interval_days=30..90` → 中心当前窗基数（`IDENTITY.node_sync_state.config_interval_days`）
  - `last_daily_sync_reported_at=null` → 从未带块上报过
  - `last_daily_sync_reported_at=ISO` → 上次成功上报的 `group_lifecycle.computed_at`（增量锚点）
- 用途：站主在 Settings 看到"中心窗长已变 → 我本地已清"等状态；运营排障 `INTERVAL_MISMATCH` 触发的 `operation_log`（`event: 'group_lifecycle_interval_mismatch'`）时同端点对账。
- 路由：`apps/worker-a/src/routes/node-settings.ts`（`getConfigIntervalDays` / `getLastDailySyncReportedAt` / `readOwnerUserId`），**无新 binding**。

### 好友列表（`GET /api/local/mutual-follows` · M17-2 ✅ 已落地）

站主 JWT。返回 `{ items: [{ node_url, handle, display_name, avatar_key, request_id, accepted_at }] }`：本端 `friend_requests.status='accepted'`（己方为 origin 或 target）且本地 `follows` 仍有对应行。解除好友走既有 `DELETE /api/follows/:nodeUrl`（不改状态机历史）。

路由：`apps/worker-a/src/routes/local-reads/mutual-follows.ts`；Owner Gateway allowlist exact `GET /api/local/mutual-follows`。互粉权威查询封装于 `lib/mutualFriendsProjection.ts`（与 M17-4-2a 公开投影同源）。

> **M17-4-3**：Timeline「好友」tab **无独立 Worker A 列表端点**——前端对关注流按本接口 `node_url` 过滤（`web/src/lib/friendsFeed.ts`）。

> Owner Gateway / Pages `_owner-allowlist.js` 已放行本路径（M17-1f）；Worker A handler 与 Settings UI 随 M17-2 落地。

### 内部互粉投影（`GET /internal/users/:handle/friends` · M17-4-2a）

**仅** Worker B Service Binding + `INTERNAL_FORWARD_SECRET`（HMAC v2）。公开入口见 `docs/worker-b-api.md` `GET /users/:handle/friends`。

- `:handle` 须等于本站站主 handle（大小写不敏感），否则 `404 USER_NOT_FOUND`
- `limit`：查询参数或头 `X-Hailuo-Friends-Limit`，clamp 1～20（默认 20）
- 返回 `{ handle, items:[{ handle, node_url, display_name }], limit }`；**无** pubkey / email / avatar / request_id
- 语义：`friend_requests.status='accepted'` ∩ 本地 `follows`（与 mutual-follows 同源）

路由：`apps/worker-a/src/routes/internal-friends-projection.ts`。

**跨节点联调（M17-3）**：`npm run smoke:m17-3`（env 双节点：发起 → 同意 → 互粉 → `POST /api/dm/send-ticket` 门控 → 取关再 `DM_NOT_MUTUAL`）；契约 `npm run test:m17-3`。运维见 [`deploy.md`](./deploy.md)「加好友 friend-requests（M17-3）」。

**跨节点 outbox 真投递（M17-FIX-1 ✅ 已落地）**：`deliverStatusOutbox`（`apps/worker-a/src/routes/friend-requests.ts`）在 accept/reject 时不再 early-return；走 fetch target 公开档案（`apps/worker-a/src/lib/friendRequestOutboxFetcher.ts` 走 Worker B `GET /users/:handle`，仅取 pubkey/display_name/avatar_key/handle 四字段，**不缓存**到 STATE_KV 防身份关联留痕）→ 构造含 `display_name?` / `avatar_key?` 可选字段的 outbox envelope → `deliverFriendRequestOutboxToOrigin` → 写 `friend_requests.outbox_status`：成功 `'acked'`、失败 `'pending_retry'`。Origin 端 `applyFriendRequestOutbox` accepted 分支 INSERT follows 时带回 `actor.handle` / `display_name` / `avatar_key`（修复前 P1-2 三个展示字段全空 → `mutual-follows` 列表 `display_name` 为空）。

**outbox_status 三态**（`friend_requests.outbox_status`）：

| 字面 | 含义 |
|------|------|
| `''` | 初始 / 未处理 |
| `'acked'` | origin 端已收到对端 accept/reject 回报（D1 写完成） |
| `'pending_retry'` | 投递失败（fetch target 不可达 / 对端拒绝 / 异常）待 cron 兜底 |
| `'giveup'` | `gcFriendRequestOutbox` 兜底超 24h 未投递 — 标记放弃 |

> **M17-4-1**：撤回不再把 `outbox_status` 写成 `'cancelled'`。`friend_requests.status='cancelled'` 表示业务态；投递态仍走 `''` → `acked` / `pending_retry` / `giveup`（`deliverCancelOutbox` origin→target）。

**outbox 重试兜底（`friend-request-outbox-gc` · REL-FIX-1）**：复用 M17-1g 的 `friend-request-gc` 任务槽位（不增 Cron 槽），同 `isGroupExternalSlotMinute`。`gcFriendRequestOutbox` 扫 `outbox_status='pending_retry'` + `status ∈ (accepted,rejected,cancelled)`：超 24h → `'giveup'`；窗内按批 **真重投**（`lib/friendRequestOutboxDeliver.ts` 的 `deliverStatusOutbox` / `deliverCancelOutbox`，重建 ts/nonce）。失败刷 `outbox_last_retry_at` 沉队尾（不动 `updated_at`）。日志含 `outbox_scanned` / `outbox_acked` / `outbox_given_up` / `outbox_errors`。

**跨节点 inbox 投递跟踪（M-F3 ✅ / M-F3b ✅）**：发起端 `deliverOriginInbox` 成功写 `inbox_status='acked'`，失败写 `pending_retry` + `inbox_error`（短错误码，不含 URL/邮箱）。migration `0061` 加 `inbox_status` / `inbox_error`；**M-F3b** migration `0062` 加 `inbox_last_retry_at`（破队头阻塞：失败重试刷本列、不动 `updated_at`，扫描按 `COALESCE(NULLIF(inbox_last_retry_at,''), updated_at) ASC`）。

**inbox_status 四态**（与 outbox 对称）：`''` 初始 / `'acked'` 对端已收 / `'pending_retry'` 待重试 / `'giveup'` 超 24h 放弃。

**inbox 重试兜底**：同槽 `gcFriendRequestInbox`——窗内最多 10 条/tick 重建 envelope 重投；窗外写 `giveup`。日志含 `inbox_scanned` / `inbox_acked` / `inbox_given_up` / `inbox_errors`。

### Cron：加好友保留清理与双写 Repair（M17-1g ✅ 已落地）

Worker A `cronBudget` 任务 `friend-request-gc` 挂在群专槽 `isGroupExternalSlotMinute`（`minute % 5 === 0 && minute % 2 !== 0`，即 5/15/25/35/45，与 DM GC 同槽、不占新 Cron）：

- `expireOldFriendRequests`：`pending` 且 `created_at` 早于 now−30d → `status='expired'`（JS ISO bind，禁 SQL `datetime('now')`）
- `repairFriendRequestFollows`：本端 `accepted` 行缺本地 `follows` → `INSERT OR IGNORE`（origin / target 各扫一批，上限 `FRIEND_REQUEST_REPAIR_BATCH=50`）；**rejected 不写 follows，不做 Repair**
- `gcFriendRequestRateBuckets`：清 48h 前频控桶（表未建 fail-soft）
- `gcFriendRequestOutbox`：outbox pending_retry 超窗 giveup
- `gcFriendRequestInbox`（M-F3）：inbox pending_retry 窗内重投 / 超窗 giveup
- 各步 fail-soft；有变更或错误时打 `[cron/gc] friendRequestRetention` 日志

lib：`apps/worker-a/src/lib/friendRequestRetention.ts`。

## 关注接口

### POST /api/follows

关注一个节点。

**请求**：
```json
{ "node_url": "https://bob-worker-b.workers.dev" }
```

**响应**：`{ "ok": true }`

**错误码**：
- `ALREADY_FOLLOWING`（409）：已关注
- `FOLLOW_LIMIT_EXCEEDED`（400）：超过关注上限（如有）

---

### DELETE /api/follows/:nodeUrl

取关（`:nodeUrl` 需 URL encode）。

**M-F2 副作用（站主可见行为不变，响应仍 `{ "ok": true }`）**：

1. 删除 `follows` 行时 `RETURNING followed_worker_b_url`（迁址后可能与 `follower_node_url` 不同）。
2. **跨库串行**清理：`feed_cache`（GOVERNANCE_DB，按两列 URL 都删）→ `cache_entries`（IDENTITY_DB）→ 置 `system_config.feed_latest_dirty = true`（IDENTITY_DB）。禁止 JOIN / 禁止合并单 binding batch。
3. **F-01**：本路径**零 `KV.put`**；既有每分钟 Cron 见 dirty 后刷 `feed:latest` KV（含内容指纹去重）。
4. 清理失败 **fail-soft**（不影响取关成功）；`GET /api/local/feed` 另有读时「活跃关注 ∪ 官方源」二次过滤作第二道防线（**M-F2b**：扫描预算用尽未耗尽源表时仍 `has_more=true`，cursor 推进到已扫末行）。

**响应**：`{ "ok": true }`

---

### GET /api/follows

获取关注列表。

**响应**：
```json
{
  "ok": true,
  "data": {
    "items": [
      { "node_url": "https://bob-worker-b.workers.dev", "followed_at": "...", "last_active": "..." }
    ],
    "total": 5
  }
}
```

---

## Token 接口

### POST /api/follower-tokens（**内部专属，M6-0a 架构修正**）

为请求粉丝 Token 的节点签发 Ed25519 Token（24h TTL）。**本端点不对外公开**——仅 Worker B 通过 Cloudflare Service Binding (`env.WORKER_A.fetch(...)`) 转发并携带 `X-Internal-Forward: hmac-v2` + `X-Timestamp` + `X-Nonce` + `X-Signature` 时才会被接受。

> ⚠️ **架构修正（M6-0a）**：M6-0 原始实现误把本端点放在 Worker A 公开层让粉丝直连，违反 §F-02 "Worker A 地址永不对外暴露" 硬约束。M6-0a 把公开入口搬到 Worker B `POST /api/follower-tokens`，本端点转为内部专属 + 头守卫。
>
> 粉丝**不应**也**无法**直接调用本端点 — 即使拿到 Worker A 的 `*.workers.dev` 地址，缺失 `X-Internal-Forward` 头即返 401。

**调用链路**：
```
follower → Worker B `POST /api/follower-tokens`（公开入口）
        → env.WORKER_A.fetch(...)（Cloudflare Service Binding，不经公网）
        → Worker A `POST /api/follower-tokens`（本端点）
        → D1 黑名单查 + Ed25519 签名
        ↓ 原路返回
```

**头守卫**（M6-0a 新增）：
- 必须携带：`X-Internal-Forward: hmac-v2`、`X-Timestamp`、`X-Nonce`、`X-Signature`
- 缺失或不符 → 401 `INTERNAL_FORWARD_REJECTED`
- Worker A 未配置 `INTERNAL_FORWARD_SECRET` secret → 同样返 401（部署错误，对外不区分以避免泄露部署状态）
- 头部比较使用恒时间字符串比较，防 timing attack

**请求 body**（由 Worker B 透传）：
```json
{
  "follower_node_url": "https://bob-worker-b.workers.dev",
  "follower_handle": "bob",
  "read_mutual_proof": { "...": "M14-3 mutual-only 时必填" }
}
```
- `follower_node_url`（必填）：粉丝节点 Worker B URL；**M14-1** 起须经 `normalizeWorkerBOrigin()`（trim + 去尾斜杠）后再查黑名单 / follows / 写入 Token `sub`。
- `follower_handle`（可选）：粉丝站主注册 handle；写入 Token `fan` 字段，供 Worker B 互动 actor 使用（**勿用 `iss`**，`iss` 是被读节点的 `BOOTSTRAP_HANDLE`）
- `read_mutual_proof`（M14-3，`mutual-only` 时必填）：读者节点签发的互粉证明；结构见 [`m14-read-protection-plan.md`](./m14-read-protection-plan.md) §6.3。验签优先用 `follows.followed_pubkey`；该 Pin 为空才拉取对方公开资料，并在验签通过后回填。失败仍是 `NOT_MUTUAL_FOLLOW`，不区分原因。
- **调用端（M14-9）**：浏览器 `web/src/lib/auth.ts` `ensureFollowerToken` 在 `NOT_MUTUAL_FOLLOW` 时自动调 `POST /api/read/mutual-proof` 并重试；Cron `handlers/feedFetch.ts` 内部 `buildReadMutualProofForOwner` 同理。

**响应**：
```json
{
  "ok": true,
  "data": { "token": "<ed25519_jwt>", "expires_at": "2026-01-02T00:00:00.000Z" }
}
```

Token 结构（JWT-like，三段 base64url 拼接）：
```
<header>.<payload>.<signature>
```
- `header`：`{ "alg": "EdDSA", "typ": "JWT" }`
- `payload`：`{ sub, iss, fan?, read_scope?, iat, exp }`（`exp = iat + 86400`）
  - `sub`：已 `normalizeWorkerBOrigin` 的读者 Worker B URL
  - `read_scope`（M14-1）：protected 档签发时必填；取值 `following-only` | `mutual-only`；Worker B 按当前节点模式校验（`mutual-only` scope 在 `following-only` 节点也可通过）
- `signature`：Ed25519 私钥对 `<header>.<payload>` 签名

**错误码**：
- `INTERNAL_FORWARD_REJECTED`（401）：`X-Internal-Forward` 头缺失/不符，或 Worker A 未配置 secret（**M6-0a 新增**）
- `INVALID_BODY`（400）：请求体非 JSON
- `NODE_URL_REQUIRED`（400）：`follower_node_url` 缺失或为空
- `NODE_URL_INVALID`（400）：`follower_node_url` 不以 `https://` 开头
- `FOLLOWER_HANDLE_INVALID`（400）：`follower_handle` 格式不合法（与注册中心 HANDLE_RE 对齐）
- `BLACKLISTED`（403）：该节点在本节点 D1 黑名单中
- `FOLLOWER_NOT_ALLOWED`（403，M14-2）：`following-only` 下不在 `follows` 表
- `NOT_MUTUAL_FOLLOW`（403，M14-3）：互粉校验失败
- `READ_TOKEN_ISSUANCE_DISABLED`（503，M14-4）：`owner-only` 下拒绝签发
- `RATE_LIMITED`（429，SDH-5）：`follower_node_url` 每小时申领次数超限（D1 `follower_token_rate_buckets`）
- `READ_PROOF_INVALID`（403，M14-3）：互粉证明无效
- `INTERNAL_ERROR`（500）：D1 查询失败或 Ed25519 签名失败

**部署要点**：
1. 用 `wrangler secret put INTERNAL_FORWARD_SECRET` 注入随机字符串（建议 32 字节 base64url）
2. 同节点 Worker B 必须用同一值设置 `INTERNAL_FORWARD_SECRET` secret
3. Worker B `wrangler.toml` 添加 `[[services]] binding = "WORKER_A"` 启用 Service Binding
4. 详见 worker-b-api.md `POST /api/follower-tokens` 段

**Worker B 验证流程**（粉丝读端点）：当 Worker B `FOLLOWER_TOKEN_MODE='enforced'` 时，`requireFollowerToken()` 中间件对每个 `[Token]` 端点执行：取 Bearer Token → 解码 payload 查 `exp` → `verifyFollowerToken` Ed25519 严格验签 → 按序探测 `STATE_KV` 键 `blacklist:local:` / `blacklist:registry:` / 遗留 `blacklist:`（M6-4）→ 通过则 `c.set('followerToken', payload)`。本地拉黑由 M6-3 Cron 每 5 分钟从 D1 同步；注册中心全局封禁由 M6-4 整点 Cron 拉取同步。

M6-0 不接入速率限制；**SDH-5 已接入** D1 每小时限频（60 次/`follower_node_url`/小时，见 `followerTokenRateLimit.ts`）。

---

## 内部互动接口（M9-18 / M9-19）

### /interactions/posts/:postId/*

**内部专属**：只接受 Worker B 通过 Cloudflare Service Binding 转发并携带 `X-Internal-Forward: hmac-v2`、`X-Timestamp`、`X-Nonce`、`X-Signature` 的请求。Worker A 用 `INTERNAL_FORWARD_SECRET` 绑定 method/path/body 验 HMAC；缺失或不符返回 `INTERNAL_FORWARD_REJECTED`。

公开调用方应访问 Worker B 的 `/interactions/*`，不要直连 Worker A。公开互动权威数据写入发帖人节点 D1，禁止每次互动写 KV。

**M9-19 envelope 验签**（所有互动写操作强制要求，SEC-AUDIT-2026-10-4 收口）：
- 签名输入：`type:post_id:actor_handle:actor_node_url:created_at:nonce:body_hash`（点赞/unlike 的 `body_hash` 为空串；回复为 content 的 SHA-256 hex；`delete_reply` 为 reply_id 的 SHA-256 hex）
- 时间窗口 ±5 分钟；`interaction_nonces` 表按 `(post_id, actor_node_url, nonce)` 去重
- `actor.pubkey` + `sig` 必填；黑名单查 D1 `blacklist` 表
- 错误码：`SIGNATURE_EXPIRED` / `NONCE_DUPLICATE` / `SIGNATURE_INVALID` / `BLACKLISTED` / `BODY_HASH_MISMATCH`

**旧格式退出**：本版本起，点赞、取消点赞、回复缺失或无法解析 `envelope` 均返回 `400 ENVELOPE_REQUIRED`，不再接受顶层 `actor` / `sig` 写入。内部 HMAC 只证明可信转发，不能替代互动者签名。现有 Web 已通过站主 JWT 签名接口获取 envelope，Worker B 已强制携带；旧客户端须先升级为相同流程，不提供未验签兼容开关。已存互动不回写、不删除；摘要与回复读取不变。`delete_reply` 保持原有强制 envelope 校验及错误码。

#### POST /api/interactions/sign-envelope `[JWT]`

站主 JWT 签发互动 envelope（浏览器经写层 / Owner Gateway 调用；私钥不出 Worker）。

**请求**：
```json
{
  "type": "like",
  "post_id": "post_xxx",
  "content": "仅 reply 时填写",
  "reply_id": "仅 delete_reply 时填写"
}
```

**响应**：
```json
{
  "ok": true,
  "data": {
    "envelope": { "...": "见 worker-b-api.md M9-19 示例" }
  }
}
```

#### POST /interactions/posts/:postId/like

写入点赞，`post_likes` 以 `(post_id, actor_node_url)` 为主键去重。

**请求体（Worker B 转发）**：
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
    "created_at": "<当前 ISO 8601 时间>",
    "nonce": "<32 hex>",
    "body_hash": "",
    "sig": "<128 hex>"
  }
}
```

**响应**：
```json
{
  "ok": true,
  "data": {
    "post_id": "post_xxx",
    "like_count": 1,
    "reply_count": 0,
    "liked_by_me": true
  }
}
```

#### DELETE /interactions/posts/:postId/like

按 `post_id + envelope.actor.node_url` 取消点赞。请求为 `{ "envelope": ... }`，结构同点赞示例，但必须重新签发 `type: "unlike"` 的 envelope，不能复用点赞签名。

#### POST /interactions/posts/:postId/replies

写入回复；`content` trim 后不能为空，最长 300 字符。

**请求体（Worker B 转发）**：
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
      "like_count": 1,
      "reply_count": 1,
      "liked_by_me": true
    }
  }
}
```

#### POST /interactions/posts/:postId/summary

读取点赞数、回复数和当前 actor 是否已点赞。

#### GET /interactions/posts/:postId/replies

读取最近回复。`limit` 默认 20，最大 50。

**错误码**：
- `INTERNAL_FORWARD_REJECTED`（401）：内部 HMAC 验签失败
- `ENVELOPE_REQUIRED`（400）：点赞、取消点赞或回复缺少可解析的签名 envelope
- `ACTOR_INVALID`（400）：互动身份无效
- `POST_NOT_FOUND`（404）：帖子不存在或已删除
- `REPLY_CONTENT_REQUIRED`（400）：回复内容为空
- `REPLY_CONTENT_TOO_LONG`（400）：回复超过 300 字符

---

## 私信 E2EE 接口（M10-2）

> Worker A 只保存私信密文 envelope、包裹后的会话密钥和 nonce 去重记录；不接收明文消息、明文 `message_key` 或站主明文密码。外部节点投递必须先到收件方 Worker B `POST /dm/inbox`，再由 Worker B 通过 Service Binding + HMAC 转发到本节内部端点，浏览器和其它节点不得直连 Worker A。

### PUT /api/me/dm-pubkey `[JWT]`

设置本节点站主的 X25519 私信公钥，并同步到 `STATE_KV` 公开资料快照，供其它节点通过 Worker B `GET /users/:handle` 读取。

**请求**：
```json
{ "dm_pubkey": "<32-byte-x25519-public-key-hex>" }
```

**响应**：
```json
{ "ok": true, "data": { "dm_pubkey": "<hex>" } }
```

**错误码**：`DM_PUBKEY_INVALID`（400）、`USER_NOT_REGISTERED`（409）。

### GET /api/lookup/:handle/dm-pubkey `[JWT]`（DM-PEER-PUBKEY-1）

站主发私信前，由**本机 Worker A 服务端**去对端 Worker B `GET /users/:handle` 取 `dm_pubkey`。浏览器不再直接跨域访问对端 Worker B，避免用户网络访问不了 `*.workers.dev` 或默认 `token-required` 档 CORS 拦截。

**Query**：`node_url?` — 对端 Worker B 公开基址。客户端通常已从 follows / mutual / DM 列表拿到；省略时回落到注册中心 lookup。两者都必须通过 `assertSafePeerWorkerBUrl` / `resolveSafeOutboundPeerUrl` 门禁。

**行为**：
- 通过 `fetchOutboundPeer` 发请求（`redirect: manual`、中性 UA、10 秒超时）；
- 只解析 `dm_pubkey`（64 hex）与 `worker_b_url`，**不**透传 bio / contact_email 等资料；
- `Cache-Control: private, no-store`，不写缓存、不写 D1；
- 不新增 D1 / KV / Cron 资源。

**响应 `200`**：
```json
{
  "ok": true,
  "data": {
    "dm_pubkey": "<64-hex>",
    "worker_b_url": "https://bob-worker-b.workers.dev"
  }
}
```

**错误码**：
- `DM_PEER_NOT_FOUND`（400/404）：`node_url` 非法或找不到对方节点；
- `DM_PEER_UNREACHABLE`（503）：对端不可达 / 超时；
- `DM_PEER_PROFILE_NOT_FOUND`（404）：对端节点上找不到该 handle；
- `DM_PEER_PROFILE_UNAVAILABLE`（502）：对端返回非 JSON / 5xx；
- `DM_PEER_NO_PUBKEY`（404）：对端公开资料可读，但确实没有 `dm_pubkey`。

### POST /api/dm/send-ticket `[JWT]`

站主发信前向本节点签发 `dm_send_ticket`。Worker A 先检查本地 `follows.follower_node_url` 是否包含收件方 Worker B URL；本端未关注对方则返回 `DM_NOT_MUTUAL`（文案：「未与对方互粉，无法发送私信」——互粉需双端各自校验，本端只查单向关注）。ticket TTL 为 300 秒，使用本节点 Ed25519 私钥签名。

**请求**：
```json
{
  "recipient_handle": "bob",
  "recipient_worker_b_url": "https://bob-worker-b.workers.dev"
}
```

**响应**：
```json
{
  "ok": true,
  "data": {
    "ticket": {
      "sender_handle": "alice",
      "recipient_handle": "bob",
      "recipient_worker_b_url": "https://bob-worker-b.workers.dev",
      "exp": 1780000000,
      "nonce": "<random-hex>",
      "sig": "<ed25519-signature-hex>"
    }
  }
}
```

### POST /api/dm/deliver `[JWT]`（DM-PEER-PUBKEY-1）

由本机 Worker A 服务端把**已签名的** DM envelope 转发到收件节点 Worker B `/dm/inbox`。浏览器不再直接跨域访问对端 `workers.dev`，避免用户网络阻断 / 企业代理 / 默认 `token-required` 档 CORS。

**请求**：
```json
{
  "recipient_worker_b_url": "https://bob-worker-b.workers.dev",
  "envelope": { "v": 1, "message_id": "dm_...", "sig": "...", "...": "..." }
}
```

**行为**：
- `recipient_worker_b_url` 必须通过 `resolveSafeOutboundPeerUrl` / SSRF 门禁；`normalizeWorkerBOrigin` 去尾斜杠；
- `fetchOutboundPeer`（`redirect: manual`、中性 UA、10 秒超时）POST `${recipient}/dm/inbox`，body 为 `{ "envelope": ... }`；
- 不重签、不修改 envelope；只透传对端的响应状态与 JSON（前端继续按 `DM_NONCE_REPLAY` / `DM_TICKET_INVALID` / `DM_NOT_MUTUAL` 等既有错误码处理）；
- 响应 `private, no-store`；不写 D1/KV、不新增 Cron/binding。

**错误码**：
- `INVALID_BODY`（400）、`DM_ENVELOPE_INVALID`（400）、`DM_PEER_NOT_FOUND`（400，收件 URL 非法）；
- `DM_ENVELOPE_TOO_LARGE`（413，>64KB）；
- `DM_PEER_UNREACHABLE`（503，对端不可达 / 超时）。

### POST /api/dm/sign-envelope `[JWT]`

浏览器在本地完成 X25519 ECDH + AES-GCM 加密后，将**未签名**的 envelope 字段（含 `ciphertext`、`ephemeral_pubkey`、`send_ticket` 等）提交本端点；Worker A 用本节点 `ED25519_PRIVATE_KEY` 对 canonical payload 签名并返回完整 `DM_ENVELOPE_V1`（含 `sig`）。私钥永不离开 Worker，浏览器不得自行伪造 envelope 签名。

**签名前强校验（M10-7 新增）**：
- `sender_handle` 必须等于本节点 D1 `users.handle`
- `sender_worker_b_url` 必须等于本节点公开基址（`resolveLocalPublicBaseUrl`）
- `key_epoch` 必须 ≥ `1`；`key_epoch > 1` 时必须是本节点 `dm_wrapped_keys` 已登记的 `(conversation_id, key_epoch, peer_handle)`（多客户端/重登会话钥轮换；未登记返回 `envelope key_epoch 未在本节点登记`）

校验失败返回 `DM_ENVELOPE_INVALID`（403）。

**请求**：
```json
{
  "envelope": {
    "v": 1,
    "message_id": "dm_...",
    "conversation_id": "conv_...",
    "sender_handle": "alice",
    "recipient_handle": "bob",
    "ciphertext": "<base64>",
    "ephemeral_pubkey": "<hex>",
    "send_ticket": { "...": "dm_send_ticket" }
  }
}
```

**响应**：
```json
{ "ok": true, "data": { "envelope": { "v": 1, "sig": "<hex>", "...": "..." } } }
```

**错误码**：`DM_ENVELOPE_INVALID`（400）、`DM_SEND_TICKET_INVALID`（400）。

### POST /api/dm/outbox `[JWT]`

保存本节点发件箱副本。请求体含已加密并已签名的 `envelope`，可选 `delivery_status`。Worker A 验证发送方为本节点、收件方在本地关注列表中、ticket 与 envelope 签名有效（验签公钥取自 D1 `users.pubkey`）后，写入 `dm_messages.direction = 'outbox'`。

> **MSG-FIX-2（local-first）**：客户端应先以 `delivery_status: "pending"` 落本机出件箱与明文，再向对端 Worker B 投递；成功（或对端已有 → `409 DM_NONCE_REPLAY` 幂等成功）后写 `"sent"`；失败写 `"failed"` 并用**同一 envelope**（同 `message_id`/`nonce`）重试。旧值 `"delivered"` 写入时归一为 `"sent"`。

**请求**：
```json
{
  "envelope": { "v": 1, "...": "DM_ENVELOPE_V1" },
  "delivery_status": "pending"
}
```

`delivery_status` 可选：`pending` | `sent` | `failed`（缺省 `pending`）。

**响应**：
```json
{ "ok": true, "data": { "message_id": "dm_...", "delivery_status": "pending" } }
```

### GET /api/dm/outbox/:messageId `[JWT]`

MSG-FIX-2：按 `message_id` 取回本机出件箱单行（含完整 `envelope`），供同信封重试投递。

**错误码**：`DM_MESSAGE_NOT_FOUND`（404）。

### PATCH /api/dm/outbox/:messageId `[JWT]`

MSG-FIX-2：仅更新出件箱 `delivery_status`（`pending` | `sent` | `failed`）。

**请求**：`{ "delivery_status": "sent" }`

**错误码**：`DM_MESSAGE_NOT_FOUND`（404）、`DM_ENVELOPE_INVALID`（400）。

### GET /api/dm/inbox `[JWT]`

分页读取本节点收件箱密文。

**Query**：`cursor=<created_at>` 可选，`limit` 默认 20，最大 50。

**响应**：
```json
{
  "ok": true,
  "data": {
    "items": [
      {
        "message_id": "dm_...",
        "conversation_id": "conv_...",
        "direction": "inbox",
        "peer_handle": "alice",
        "peer_worker_b_url": "https://alice-worker-b.workers.dev",
        "envelope": { "v": 1 },
        "created_at": "2026-06-22T00:00:00.000Z",
        "read_at": null,
        "delivery_status": "delivered"
      }
    ],
    "has_more": false,
    "cursor": null
  }
}
```

### GET /api/dm/outbox `[JWT]`

分页读取本节点发件箱密文副本。Query 与响应结构同 `GET /api/dm/inbox`，`direction = "outbox"`。

### GET /api/dm/unread-count `[JWT]`

返回本节点收件箱未读数（`read_at IS NULL`），供 Web 非消息页 30s 轮询红点。

**响应**：
```json
{ "ok": true, "data": { "unread_count": 3 } }
```

### POST /api/dm/messages/:id/read `[JWT]`

将单条收件箱消息标记为已读，写入 `read_at`（ISO 8601）。发件箱消息不可标记。

**响应**：
```json
{
  "ok": true,
  "data": { "message_id": "dm_...", "read_at": "2026-06-22T12:00:00.000Z" }
}
```

**错误码**：`DM_MESSAGE_NOT_FOUND`（404）、`INVALID_BODY`（400，非 inbox 消息）。

### DELETE /api/dm/messages/:id `[JWT]`

硬删本节点 D1 中单条私信（入箱或发件箱皆可）；**不能**删除对方节点副本。

**响应**：
```json
{ "ok": true, "data": { "message_id": "dm_...", "deleted": true } }
```

**错误码**：`DM_MESSAGE_NOT_FOUND`（404）。

### DELETE /api/dm/conversations/:id `[JWT]`

硬删本节点该会话全部 `dm_messages` 行及对应 `dm_wrapped_keys`。

**响应**：
```json
{
  "ok": true,
  "data": { "conversation_id": "conv_...", "deleted_messages": 12 }
}
```

**错误码**：`DM_CONVERSATION_NOT_FOUND`（404，消息与包裹密钥均不存在）。

### GET /api/owner/wrapped-vault `[JWT]`

M-VAULT-2 / VAULT-PRE-REG-KEY：读取站主保险箱主密钥的外层包裹（`IDENTITY_DB.owner_wrapped_vault`）。`wrapped_vault_json` 由浏览器用登录 `password_hash` 加密后上传，Worker A **永不解密**。

**存储键**（`owner_handle`）：
- 已登记（`users` 有行）→ `users.handle`
- 未登记 → `fp:` + `SHA-256(utf8(规范化 ED25519_PUBLIC_KEY hex))` 前 32 hex（登记完成时迁到 handle）

**响应**（有行）：
```json
{
  "ok": true,
  "data": {
    "wrapped_vault_json": "{\"v\":1,\"wrap_alg\":\"AES-256-GCM\",\"kdf\":\"SHA256-password_hash-v1\"}",
    "key_version": 1,
    "updated_at": "2026-10-07T00:00:00.000Z"
  }
}
```

**错误码**：`VAULT_NOT_FOUND`（404，尚未创建）；缺身份公钥 → `INTERNAL_ERROR`（500）。**不再**因未登记返回 `USER_NOT_REGISTERED`。

### PUT /api/owner/wrapped-vault `[JWT]`

保存或更新保险箱外层包裹。Worker 只校验 JSON 非空且长度上限，不做密码学校验。存储键规则同 GET。

**请求**：
```json
{
  "wrapped_vault_json": "{\"v\":1,\"wrap_alg\":\"AES-256-GCM\",\"kdf\":\"SHA256-password_hash-v1\",\"nonce\":\"…\",\"ciphertext\":\"…\"}",
  "key_version": 1
}
```

**响应**：与 GET 成功体同形（含写入后的 `updated_at`）。

**错误码**：`VAULT_INVALID_BODY`（400）；缺身份公钥 → `INTERNAL_ERROR`（500）。

### GET /api/dm/wrapped-identity `[JWT]`

登录 hydrate 时读取本节点 D1 中保存的包裹身份私钥。`wrapped_identity_json` 是浏览器用 KEK（`info=hailuo-dm-identity-v1`）加密后的 JSON 字符串，Worker A 不解密。

**响应**（有备份）：
```json
{
  "ok": true,
  "data": {
    "owner_handle": "alice",
    "public_key_hex": "<64_hex>",
    "wrapped_identity_json": "{\"v\":1}",
    "updated_at": "2026-06-22T00:00:00.000Z"
  }
}
```

无备份时：`{ "ok": true, "data": null }`。

### PUT /api/dm/wrapped-identity `[JWT]`

保存或更新浏览器包裹后的身份私钥，并**原子**同步 `users.dm_pubkey` 与 `STATE_KV` 公开资料。

**请求**：
```json
{
  "public_key_hex": "<64_hex>",
  "wrapped_identity_json": "{\"v\":1,\"wrap_alg\":\"AES-256-GCM\"}"
}
```

**响应**：
```json
{
  "ok": true,
  "data": {
    "owner_handle": "alice",
    "public_key_hex": "<64_hex>",
    "updated_at": "2026-06-22T00:00:00.000Z"
  }
}
```

**错误码**：

- `DM_IDENTITY_BACKUP_MISSING`（409）：节点已有 `dm_pubkey` 但 D1 无 `dm_wrapped_identity` 行，且客户端提交的公钥与现有一致（无法在无私钥时补备份）。
- `INVALID_BODY`（400）：公钥格式或 JSON 超长。

### GET /api/dm/wrapped-keys `[JWT]`

登录 hydrate 时读取本节点 D1 中保存的包裹会话密钥。`wrapped_key_json` 是浏览器用 KEK 加密后的 JSON 字符串，Worker A 不解密。

**响应**：
```json
{
  "ok": true,
  "data": {
    "items": [
      {
        "conversation_id": "conv_...",
        "key_epoch": 1,
        "peer_handle": "bob",
        "wrapped_key_json": "{\"v\":1}",
        "updated_at": "2026-06-22T00:00:00.000Z"
      }
    ]
  }
}
```

### PUT /api/dm/wrapped-keys `[JWT]`

保存或更新浏览器包裹后的会话密钥。`wrapped_key_json` 最大 8192 字符。

**请求**：
```json
{
  "conversation_id": "conv_...",
  "key_epoch": 1,
  "peer_handle": "bob",
  "wrapped_key_json": "{\"v\":1,\"wrap_alg\":\"AES-256-GCM\"}"
}
```

**响应**：
```json
{ "ok": true, "data": { "conversation_id": "conv_...", "key_epoch": 1 } }
```

### POST /api/dm/import-messages `[JWT]`（M10-5b）

批量合并导入备份中的 `dm_messages` 副本（历史 envelope，不触发跨节点投递、不写 `dm_nonces`）。

**请求体**：

```json
{
  "items": [
    {
      "message_id": "dm_…",
      "conversation_id": "conv_…",
      "direction": "inbox",
      "peer_handle": "bob",
      "peer_worker_b_url": "https://bob-b.workers.dev",
      "envelope_json": "{ … DM_ENVELOPE_V1 … }",
      "created_at": "2026-06-01T12:00:00.000Z",
      "read_at": null,
      "delivery_status": "delivered"
    }
  ]
}
```

**约束**：

- 单次 `items` 长度 **1～200**，整包 body ≤ **512 KB**。
- `direction` 为 `inbox` | `outbox`；`envelope_json` 须可解析为 `DM_ENVELOPE_V1`，且与 `message_id` / `conversation_id` 一致。
- 收件箱行 `recipient_handle`、发件箱行 `sender_handle` 须匹配 JWT 站主 `users.handle`。
- SQL：`INSERT OR IGNORE`；相同 `message_id` 跳过。

**响应**：

```json
{
  "ok": true,
  "data": {
    "inserted": 12,
    "skipped": 3,
    "invalid": 0,
    "errors": []
  }
}
```

**错误码**：

| code | HTTP | 说明 |
|------|------|------|
| `DM_IMPORT_INVALID` | 400 | 字段/格式错误或无有效行 |
| `DM_IMPORT_BATCH_TOO_LARGE` | 400 | 超 200 行或 body 超 512 KB |
| `USER_NOT_REGISTERED` | 409 | 节点尚未注册 |

### POST /dm/inbox（内部 HMAC）

收件方 Worker B 的公开 `POST /dm/inbox` 通过 Service Binding 转发到本端点，并携带 `X-Internal-Forward: hmac-v2`、`X-Timestamp`、`X-Nonce`、`X-Signature`。Worker A 用 `INTERNAL_FORWARD_SECRET` 绑定 `POST /dm/inbox` + 原始 body 验 HMAC。

**校验顺序**：

- 解析 `DM_ENVELOPE_V1`，限制密文体积，不解析明文。
- 收件人必须匹配本节点 `users.handle`，ticket 目标 Worker B 必须匹配本节点公开 Worker B URL。
- 查 D1 `blacklist.node_url`，命中返回 `BLACKLISTED`。
- 查 D1 `follows.follower_node_url`，本端未关注发送方则 `DM_NOT_MUTUAL`（「未与对方互粉，无法接收私信」）。
- 按 `sender_worker_b_url` D1 每小时限频（默认 120 次/小时，`dm_rate_buckets` UPSERT 原子递增），超限 `DM_RATE_LIMITED`（429）。
- 验签公钥：`follows.followed_pubkey` 已有 64 位 Pin 时直接用 Pin 验 `dm_send_ticket` 与 envelope，不再请求对端。Pin 为空才经 `fetchTargetUserProfile` 取档（核对是同一个人）；验签通过后才回填空 Pin。钥匙不符仍返回既有 `DM_TICKET_INVALID` / `DM_ENVELOPE_INVALID`。
- 将 envelope nonce 与 ticket nonce 写入 `dm_nonces` 防重放；重复返回 `DM_NONCE_REPLAY`。
- 写入 `dm_messages.direction = 'inbox'`，`envelope_json` 只保存密文 envelope。

**错误码**：`INTERNAL_FORWARD_REJECTED`（403）、`DM_ENVELOPE_INVALID`（400）、`DM_TICKET_INVALID`（403）、`DM_NOT_MUTUAL`（403）、`BLACKLISTED`（403）、`DM_RATE_LIMITED`（429）、`DM_NONCE_REPLAY`（409）、`USER_NOT_REGISTERED`（409）、`INTERNAL_ERROR`（500）。

---

## 群聊（M16-1c · Owner Gateway JWT）

> SSOT：[`m16-group-chat-plan.md`](./m16-group-chat-plan.md) §7.2。`MESSAGING_DB` 存 `group_*` 表；互粉/拉黑仍读主库 `DB`（后续 M16-2+）。
>
> **OWNER-KEY-6 · 产品口径**：群聊为**托管群密**（信群主 = 信群主节点）。持钥与代封见 `owner-epoch-key` / `owner-seal-pending` / `owner-rekey`；成员节点不持明文群钥。前端创建/加入/设置须展示知情文案（i18n `groupsOwnerKey*`）。**私信 M10 仍端到端，不受影响。** 计划：[`group-owner-held-key-2026-11-plan.md`](./group-owner-held-key-2026-11-plan.md)。

### POST /api/groups `[JWT]`

建群（群主本节点）。

**请求**：
```json
{ "name": "示例群", "announcement": "可选公告" }
```

**成功**：
```json
{
  "ok": true,
  "data": {
    "group_id": "grp_ABCDEFGH",
    "name": "示例群",
    "owner_worker_b_url": "https://...",
    "epoch": 1,
    "tree_id": 0,
    "created_at": "2026-07-05T00:00:00.000Z",
    "message_shard_id": "primary",
    "join_policy": "approval",
    "owner_key_held": true,
    "group_key_hex": "<仅当已配 GROUP_OWNER_KEY_WRAP_SECRET；64 hex；一次性给群主 JWT 做 vault wrap>",
    "key_fingerprint": "<SHA-256(group_key) 64 hex；与 owner_key_held 同出>"
  }
}
```

**OWNER-KEY-2**：若 Worker A 已配置 `GROUP_OWNER_KEY_WRAP_SECRET`（≥32），建群时服务端生成 epoch=1 群钥、写入 `group_owner_epoch_keys`（at-rest 密文），并在本响应中**一次性**回 `group_key_hex` 供群主浏览器做 vault wrap；缺 secret 时 `owner_key_held=false` 且无 `group_key_hex`（回落浏览器自生成 + 可选 bootstrap PUT）。**禁止**把 `group_key_hex` 写入日志 / 长期本地存储。

**M16-JOIN-POLICY-1**：新群 `group_id` 为短形态 `grp_` + 8 位 Crockford（约 12 字符）；默认 `join_policy: "approval"`。旧长 id 群不改写。

**M16-P4a · `message_shard_id`**：当 `MESSAGING_SHARD_1` 已绑定且会话库估算 `tier === hard`（≥400 MB，默认触发线）时，建群成功即登记 `group_message_shard_routes → shard_1`，本字段为 `"shard_1"`；否则为 `"primary"`。`MESSAGING_AUTO_SHARD_ENABLED=false` 时恒为 `"primary"`。

### POST /api/groups/:groupId/invites `[JWT]`

群主创建邀请。响应含 `invite_token`（`ginv_…` 主键）与 **`invite_code`（8 位短码，分享用）**。

**M16-INVITE-LIFE**：邀请在有效期内**可复用**（多人可用）；可选 `ttl_days`；`requires_approval` 写入邀请行快照（审批分支见 LIFE-3）。

**请求 body**（均可选）：
```json
{
  "ttl_days": 7,
  "requires_approval": false
}
```

| 字段 | 说明 |
|------|------|
| `ttl_days` | 白名单：`7` / `30` / `365` / `3650`；缺省 **7** |
| `requires_approval` | 布尔；缺省取群 `join_requires_approval`（默认 false） |

**成功**：
```json
{
  "ok": true,
  "data": {
    "group_id": "grp_...",
    "group_name": "周末徒步",
    "owner_worker_b_url": "https://...",
    "invite_token": "ginv_...",
    "invite_code": "K7M2Q9XP",
    "expires_at": "2026-07-12T00:00:00.000Z",
    "requires_approval": false,
    "ttl_days": 7
  }
}
```

分享推荐形态：`https://<owner_worker_b_url>/#c/<invite_code>`（二维码 / 剪贴板）。旧 JSON / `#i/` 长链仍可被客户端解析。

**错误码**：`GROUP_INVITE_TTL_INVALID`（400）、`GROUP_NOT_FOUND`（404）、`GROUP_NOT_MEMBER`（403）。

### POST /api/groups/invites/accept `[JWT]`（M16-INVITE-SHORT）

成员本节点接受邀请；**路径无 groupId**（短码入群时客户端尚不知道 `group_id`）。跨节点时 fetch 群主 Worker B `POST /groups/invite-accept`。

**请求**：
```json
{
  "owner_worker_b_url": "https://owner-b.workers.dev",
  "invite_token": "K7M2Q9XP",
  "wrapped_key_json": "{...}"
}
```

- `invite_token`：8 位短码 **或** 旧 `ginv_…`
- `group_id`：可选；若提供须与邀请行一致
- 群主权威按 `invite_code` / `invite_token` 查表还原 `group_id`
- **LIFE-1**：成功**不**消耗邀请；有效期内可再次被他人使用。旧行若已有 `consumed_at` 仍返回 `GROUP_INVITE_CONSUMED`；`revoked_at` 非空返回 `GROUP_INVITE_REVOKED`

**成功**：同下（含权威 `group_id` + `membership_status`）。

### POST /api/groups/join `[JWT]`（M16-JOIN-POLICY-2）

按**固定群号**加入（主路径；**不**要临时 invite）。跨节点时成员节点 fetch 群主 Worker B `POST /groups/join`。

**请求**：
```json
{
  "owner_worker_b_url": "https://owner-b.workers.dev",
  "group_id": "grp_ABCDEFGH",
  "wrapped_key_json": "{...}"
}
```

行为（读群主 `groups.join_policy`）：

| join_policy | 结果 |
|-------------|------|
| `closed` | `403 GROUP_JOIN_CLOSED` |
| `approval` | `membership_status: "pending"`（写 `group_members`） |
| `open` | `membership_status: "active"`（写 `group_pending_members` 待上树） |

**成功**：
```json
{
  "ok": true,
  "data": {
    "group_id": "grp_ABCDEFGH",
    "epoch": 1,
    "tree_id": 0,
    "name": "示例群",
    "owner_worker_b_url": "https://...",
    "membership_status": "pending",
    "join_policy": "approval",
    "owner_handle": "alice",
    "owner_pubkey": "<64hex>"
  }
}
```

`owner_handle` / `owner_pubkey`（GRP-RELAY-AUTH-2）：权威群主成员行 pin；成员本节点 `mirrorAcceptedGroupLocally` 写入本地 `group_members`（`role=owner`），供后续 `owner_receipt` 验签。缺 pin 时字段可省略（影子 fail-soft）。

**错误码**：`GROUP_JOIN_CLOSED`（403）、`GROUP_NOT_FOUND`（404）、`GROUP_ALREADY_MEMBER`（409）、`GROUP_MEMBER_LIMIT`（409，含群主共 2000 人已满）、`GROUP_RATE_LIMITED`（429，单成员约 30 次/小时）、`GROUP_OWNER_UNREACHABLE`（502）等。

> **GROUP-CAP-SPEAK-1**：群员硬上限 **含群主共 2000**（`active`/`pending` + 未入册 `pending_members` 去重计数）。建树排序看 `last_speak_at`（chat 成功落库推进）；入树资格仍看 `last_ack_at` 30min 窗。

> **M16-JOIN-POLICY-4**：主分享为 `#g/`；`#c/` / `#i/` / 旧 JSON 仍兼容（前端折叠入口）。入群尝试走 `group_rate_buckets` 限频。

### POST /api/groups/:groupId/invites/accept `[JWT]`

成员本节点接受邀请（旧路径，仍保留）。跨节点时 fetch 群主 Worker B `POST /groups/invite-accept`。

**请求**：
```json
{
  "owner_worker_b_url": "https://owner-b.workers.dev",
  "invite_token": "ginv_...",
  "wrapped_key_json": "{...}"
}
```

**成功**：
```json
{
  "ok": true,
  "data": {
    "group_id": "grp_...",
    "epoch": 1,
    "tree_id": 1,
    "name": "示例群",
    "owner_worker_b_url": "https://...",
    "membership_status": "active",
    "owner_handle": "alice",
    "owner_pubkey": "<64hex>"
  }
}
```

`membership_status`：`active`（已正式入群）或 `pending`（等待群主同意，LIFE-3）。  
`owner_handle` / `owner_pubkey`（GRP-RELAY-AUTH-2）：同上，成员镜像写入本地群主 pin 行。

**OWNER-KEY-3**：群主节点在 accept / join / 审批通过后，若本机持有当前 epoch 持钥且成员已登记 `member_dh_pubkey`，Worker **自动 X25519 代封**写入 `group_wrapped_keys` 并尽量将 `key_state` 置 `active`（缺持钥表或非群主节点则 fail-soft，不挡入群；成员仍可走 Fast-Pull / 浏览器补封）。`wrapped_key_json` 请求体仍可选（迁移期兼容）。

**错误码**：`GROUP_NOT_FOUND`（404）、`GROUP_INVITE_EXPIRED`（409）、`GROUP_INVITE_CONSUMED`（409，仅旧已消耗行）、`GROUP_INVITE_REVOKED`（409）、`GROUP_ALREADY_MEMBER`（409）、`GROUP_MEMBER_LIMIT`（409，含群主共 2000 人已满）、`GROUP_OWNER_UNREACHABLE`（502）。

### GET /api/groups/:groupId/members `[JWT]`（GRP-MEMBER-PAGE-1 · 大群分页）

在册成员（`status IN ('active','pending')`）名单；任何在册成员都可读，管理操作仍仅群主/管理员。

**查询参数（全部可选，向后兼容）**

| 参数 | 说明 |
|---|---|
| `limit` | 每页条数，1～500；**不传 = 全量**（换钥 / 补封需要完整名单 + DH 公钥） |
| `offset` | 跳过条数，默认 0；与 `limit` 搭配翻页 |
| `include_dh` | `0` = 不返回 `member_dh_pubkey`（展示侧用）；缺省返回 |

**成功**：`{ "ok": true, "data": { "items": [ { "member_worker_b_url", "member_handle", "role", "is_admin", "status", "key_state", "joined_at", "member_dh_pubkey"? } ], "total": 123, "has_more": true } }`

**硬约束**

- `total` 为群成员总数（含 pending），前端标题人数用它，不要用当前页长度。
- 排序：群主 → 管理员 → `joined_at ASC` → **`member_worker_b_url ASC`**（末位 tiebreaker 必须保留，否则同秒入群会翻页重复 / 漏人）。
- 展示侧固定 `limit=100&include_dh=0`，避免 2000 人群一次拉 ~300KB JSON + 渲染 2000 个节点；追加用 `offset`（当前已加载条数）。
- 不传 `limit` 时仍返回全量，`member_dh_pubkey` 供 `owner-rekey` / `owner-seal-pending` 的浏览器补封使用。

### GET /api/groups/:groupId/join-requests `[JWT]`（M16-INVITE-LIFE-3 · REL-FIX-6 跨节点管理员代理）

群主列出 `group_members.status=pending` 的入群申请。

**成功**：`{ "ok": true, "data": { "items": [ { "member_worker_b_url", "member_handle", "member_pubkey", "key_state", "joined_at" } ] } }`

**REL-FIX-6 跨节点代理**：入群 pending 只落**群主** D1，跨节点管理员本机查恒为 `[]`。

- **本机是群主** → 直接查本地权威（同上）。
- **本机是群主库在册 active 管理员** → Worker A 向群主公开 Worker B 发 `POST /groups/admin-join-requests`（`GROUP_ADMIN_JOIN_REQUEST_V1` 签名），群主侧权威校验后返回同结构 `items`。
- **其他** → 403 `GROUP_NOT_MEMBER`。

> ⚠️ 管理员身份**由群主侧查群主库 `group_members.is_admin=1` 权威判定**，不采信请求方自证（成员本机 `is_admin` 恒为 0）。

**错误码**：`GROUP_NOT_FOUND`（404）、`GROUP_NOT_MEMBER`（403，非群主/非管理员）、`GROUP_RATE_LIMITED`（429，代理拉取超限）、`GROUP_ENVELOPE_INVALID`（400，签名/字段非法）。

### POST /api/groups/:groupId/join-requests/approve `[JWT]`（REL-FIX-6 跨节点管理员代理）

**请求**：`{ "member_worker_b_url": "https://..." }` → 成员改为 `active` 并写入待上树列表。

- 本机是群主 → 本地审批。
- 本机是跨节点管理员 → 经群主代理审批（群主侧以管理员身份执行同一 `approve` 逻辑）。

**REL-FIX-7**：群主权威侧审批完成后，向申请人 `member_worker_b_url` 投递 `GROUP_JOIN_DECISION_V1`（失败落 `group_join_decision_outbox` 待 cron 重投，不阻断本接口成功）。申请人节点落地见内部 `POST /groups/join-decision`。

**错误码**：同 `GET .../join-requests`。

### POST /api/groups/:groupId/join-requests/reject `[JWT]`（REL-FIX-6 跨节点管理员代理）

**请求**：`{ "member_worker_b_url": "https://..." }` → 删除 pending 行（可再次申请）。本机是群主则本地拒绝；跨节点管理员经群主代理拒绝。

**REL-FIX-7**：同上，回推 `decision=rejected`（outbox 可重投，不阻断本接口）。

**错误码**：同 `GET .../join-requests`。

### POST /api/groups/:groupId/invites/revoke `[JWT]`（LIFE-5）

**请求**：`{ "invite_token": "ginv_…" }` 或 `{ "invite_code": "K7M2Q9XP" }` → 置 `revoked_at`。

### PUT /api/groups/:groupId/join-policy `[JWT]`（M16-JOIN-POLICY）

**请求**（推荐）：
```json
{ "join_policy": "closed" | "approval" | "open" }
```

| 值 | 含义 |
|----|------|
| `closed` | 禁止按群号加入 |
| `approval` | 需群主同意（写 `group_members.status=pending`） |
| `open` | 允许直接加入 |

兼容旧布尔：`{ "join_requires_approval": true }` → `approval`；`false` → `open`。同步双写旧列 `join_requires_approval`（仅 `approval` 为 1）。已发出邀请的 `requires_approval` 快照不变。

**错误码**：`GROUP_JOIN_POLICY_INVALID`（400）。

### PUT /api/groups/:groupId/admins `[JWT]`（M16-GROUP-MOD · UX-GROUPS-7f）

仅**群主**可任命或撤销管理员。管理员人数上限 `GROUP_ADMIN_MAX = 5`（不含群主）。升管/降管是 idempotent：对已是管理员再点升管返回当前态、不重复计数。

**请求**：
```json
{ "member_worker_b_url": "https://...", "is_admin": true }
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `member_worker_b_url` | string | 是 | 目标成员的 Worker B URL；trim 后非空 |
| `is_admin` | boolean | 是 | `true`=升管；`false`=降管 |

**响应**（`200 OK`）：
```json
{ "ok": true, "data": { "group_id": "grp_xxxxxxxx", "member_worker_b_url": "https://...", "is_admin": true } }
```

**错误码**：
- `GROUP_ENVELOPE_INVALID`（400）：`group_id` 不符合正则 / `member_worker_b_url` 为空或非字符串 / `is_admin` 非 boolean / 目标为群主本人
- `GROUP_NOT_MEMBER`（403）：调用方非群主（管理员也被拒） / 目标不在册（`status != 'active'`）
- `GROUP_ADMIN_LIMIT`（409）：升管时 `COUNT(is_admin=1 AND status='active')` 已达 5
- `GROUP_NOT_FOUND`（404）：群不存在或已解散
- `USER_NOT_REGISTERED`（409）：节点未完成注册

### POST /api/groups/:groupId/kick `[JWT]`（M16-GROUP-MOD · UX-GROUPS-7f）

群主或管理员手动踢人。**群主可踢普通成员与管理员**；**管理员不可踢群主或其他管理员**。EPOCH-MOD-1 / **REKEY-1**：踢人成功后保持当前 epoch、标记 `rekey_scheduled=1`、保持其他成员 key_state、删除目标 `group_wrapped_keys` / `group_pending_members`、重算 `relay_tree`，并向群内发 system 消息。**禁止**附带 `wrapped_keys` 冒充换钥（详见下文 EPOCH v0.3 · REKEY-1 段）。

**请求**：
```json
{ "member_worker_b_url": "https://..." }
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `member_worker_b_url` | string | 是 | 目标成员的 Worker B URL；trim 后非空；不能等于调用方自身 |

**响应**（`200 OK`）：
```json
{ "ok": true, "data": { "group_id": "grp_xxxxxxxx", "member_worker_b_url": "https://...", "status": "kicked", "new_epoch": 1, "rekey_scheduled": true } }
```

**错误码**：
- `GROUP_ENVELOPE_INVALID`（400）：`group_id` 不符合正则 / `member_worker_b_url` 为空或非字符串 / 目标是调用方自身
- `GROUP_REKEY_NOT_READY`（400）：请求附带非空 `wrapped_keys`（REKEY-1：踢人仅隔绝）
- `GROUP_NOT_MEMBER`（403）：调用方非群主也非管理员 / 目标是群主 / 管理员尝试踢其他管理员
- `GROUP_NOT_FOUND`（404）：目标成员不存在或不在册（`status != 'active'`） / 踢人失败（本节点非群主节点等内部异常）
- `USER_NOT_REGISTERED`（409）：节点未完成注册

### PUT /api/groups/:groupId/announcement `[JWT]`（M16-GROUP-MOD · UX-GROUPS-7c）

群主或管理员可改群公告。空字符串视作清空。公告最大长度 512（与建群时一致）。

**请求**：
```json
{ "announcement": "新公告内容（可空字符串清空）" }
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `announcement` | string | 是 | trim 后 0～512 字符；空字符串 → 后端写 `null` |

**响应**（`200 OK`）：
```json
{ "ok": true, "data": { "group_id": "grp_xxxxxxxx", "announcement": "新公告内容" | null } }
```

**错误码**：
- `GROUP_ENVELOPE_INVALID`（400）：`group_id` 路径不符合正则 / `announcement` 非字符串
- `GROUP_NOT_FOUND`（404）：群不存在或已解散
- `GROUP_NOT_MEMBER`（403）：非群主也非管理员
- `USER_NOT_REGISTERED`（409）：节点未完成注册

### PUT /api/groups/:groupId/name `[JWT]`（UX-GROUPS-7b）

仅**群主**可改群名称（比 announcement 更收敛，避免管理员误改核心元数据）。群号（`group_id`）一旦生成**不可改**——本端点不接受 `group_id` 字段。

**请求**：
```json
{ "name": "新群名称" }
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `name` | string | 是 | 1～64 字符（trim 后）；空字符串 → `GROUP_NAME_INVALID`；超过 64 → `GROUP_NAME_INVALID` |

**响应**（`200 OK`）：
```json
{ "ok": true, "data": { "group_id": "grp_xxxxxxxx", "name": "新群名称" } }
```

**错误码**：
- `GROUP_ENVELOPE_INVALID`（400）：`group_id` 路径不符合正则 / `name` 非字符串
- `GROUP_NAME_INVALID`（400）：name 为空 / 超过 64 字符
- `GROUP_NOT_FOUND`（404）：群不存在或已解散
- `GROUP_NOT_MEMBER`（403）：非群主（管理员也被拒）
- `USER_NOT_REGISTERED`（409）：节点未完成注册

### GET /api/groups/local `[JWT]`

读本节点已加入群列表（含 `sync_tier` / `key_state` / `status`；另含 `join_policy` / `join_requires_approval` / `rekey_scheduled`）。

**响应**（`200 OK`）：
```json
{
  "ok": true,
  "data": {
    "items": [
      {
        "group_id": "grp_...",
        "name": "示例群",
        "announcement": null,
        "owner_worker_b_url": "https://...",
        "epoch": 1,
        "tree_id": 0,
        "dissolved_at": null,
        "join_requires_approval": 1,
        "join_policy": "approval",
        "members_muted": 0,
        "rekey_scheduled": 1,
        "role": "owner",
        "is_admin": 0,
        "key_state": "active",
        "status": "active",
        "sync_tier": "active",
        "local_retention_days": 90,
        "member_count": 3,
        "pending_join_count": 2,
        "rekey_members_total": 12,
        "rekey_dh_ready": 10,
        "rekey_wraps_ready": 5
      }
    ]
  }
}
```

**`rekey_scheduled` / 进度字段（EPOCH-UX-1）**：

- `rekey_scheduled`：群级待真换钥标记（踢人隔绝后为 1；`rekey-commit` 成功清 0）。所有成员可见，供灰色横幅。
- `rekey_members_total` / `rekey_dh_ready` / `rekey_wraps_ready`：**仅本机为群主或管理员**时有值，否则 `null`。分母为留下 `active` 人数；`rekey_wraps_ready` 计 `epoch = current+1` 且 json 非空的 wrap。只用于进度文案，不含成员 handle/URL 明细。

**`pending_join_count`（REL-FIX-5）**：待审批入群申请数（`group_members.status='pending'`）。

- **仅本机为群主时 > 0**；本机非群主恒为 `0`。
  - 判据是**本机成员行的 `role='owner'`**，不是 URL 比对 → 换域名迁移（M7-30）后 `groups.owner_worker_b_url` 与 `users.worker_b_url` 短暂分叉时角标不会消失。
  - 入群 `pending` 行**只落群主库**；成员节点本地镜像的那行是自己的申请 → 若只按 `status='pending'` 计数会把「我自己的申请」算成「待我审批」，故必须按群主身份收窄。
- 跨节点管理员的待审批列表**不在此聚合**：仍走 `GET /api/groups/:groupId/join-requests` 的 REL-FIX-6 代理按需拉取（聚合会产生 N 次跨节点请求风暴 + 触发群主侧限频）。
- 该字段只用于 UI 显示**数量**，不含申请人 `handle` / 节点 URL（防身份关联）。
- **不新增请求 / binding / 表**：由已有 `GET /api/groups/local` 一条 SQL 子查询聚合，D1 读，零 KV 写（Free Tier 约束）。

### GET /api/groups/local/:groupId/messages `[JWT]`（M16-4b）

读本节点 `member_group_messages` 本地密文副本，供 Web 会话展示与 3s 轮询；同时返回群元数据（含未同步 / dissolved / `key_state` 数据源）。

**Query**：
- `limit`：可选，默认 **50**，最大 **50**
- `cursor`：可选，ISO 8601 `created_at`；传入时返回**更旧**一页（`ORDER BY created_at DESC`）

**成功**：
```json
{
  "ok": true,
  "data": {
    "group": {
      "group_id": "grp_...",
      "name": "示例群",
      "announcement": null,
      "owner_worker_b_url": "https://...",
      "epoch": 1,
      "tree_id": 0,
      "dissolved_at": null,
      "role": "owner",
      "key_state": "active",
      "status": "active",
      "sync_tier": "active",
      "sync_cursor": "gmsg_...",
      "local_retention_days": 90,
      "last_sync_at": "2026-07-05T08:00:00.000Z"
    },
    "items": [
      {
        "message_id": "gmsg_...",
        "group_id": "grp_...",
        "epoch": 1,
        "sender_worker_b_url": "https://...",
        "sender_handle": "alice",
        "msg_kind": "chat",
        "ciphertext": "...",
        "created_at": "2026-07-05T08:01:00.000Z"
      }
    ],
    "has_more": false,
    "cursor": null
  }
}
```

**错误码**：`GROUP_ENVELOPE_INVALID`（400）、`USER_NOT_REGISTERED`（409）、`GROUP_NOT_FOUND`（404，非成员或群不在本节点）。

**说明**：浏览器经 Owner Gateway 访问；禁止直连群主 Worker B 拉 sync/relay 消息。

### PUT /api/groups/local/:groupId/settings `[JWT]`（M16-4f）

更新本节点 `group_sync_state.local_retention_days`（**1～365**，默认 **90**）。

**请求**：
```json
{ "local_retention_days": 90 }
```

**成功**：
```json
{
  "ok": true,
  "data": {
    "group_id": "grp_...",
    "local_retention_days": 90,
    "sync_tier": "active"
  }
}
```

**错误码**：`GROUP_ENVELOPE_INVALID`（400）、`USER_NOT_REGISTERED`（409）、`GROUP_NOT_FOUND`（404）、`MESSAGING_DB_CAPACITY_WARN`（409，预估 ≥350 MB 且延长 retention）、`MESSAGING_DB_CAPACITY_HARD`（409，预估 ≥400 MB 且延长或 >90 天）。

**容量预检（M16-7d）**：仅当 `local_retention_days` **高于当前值**时触发；缩短 retention 始终允许。运维可设 env `MESSAGING_CAPACITY_OVERRIDE=true` 跳过预检。

### GET /api/messaging/events `[JWT]`（M-RT-1 · SSE）

Owner Gateway 透传的站主消息通知流。**只推 id/cursor，不推明文/密文**。无 Durable Objects：连接内约每 500ms 读 D1 tip；约 25s 后发 `reconnect` 由客户端重连。

**Query**（可选）：
- `dm_cursor`：客户端已知的私信 tip cursor（`created_at` + TAB + `message_id`）
- `group_cursor`：群 tip cursor（member/owner 两表取较新）

**响应**：`Content-Type: text/event-stream`

| 事件 `type` | 含义 |
|---|---|
| `hello` | 连接就绪 |
| `NEW` | `{ scope: "dm"\|"group", id, cursor }` — 浏览器应立刻拉 inbox / 群本地消息 |
| `reconnect` | 服务端主动结束本连接，客户端应重连 |

**安全**：须站主 JWT + Owner Gateway allowlist；禁止把 IP/邮箱等写入事件体。

### GET /api/messaging/db-capacity `[JWT]`（M16-7d）

粗算本节点 `MESSAGING_DB`（DM + 群）占用，供 Settings 黄色提示。

**成功**：
```json
{
  "ok": true,
  "data": {
    "estimated_bytes": 320000000,
    "estimated_mb": 305.2,
    "tier": "normal",
    "total_estimated_bytes": 380000000,
    "total_estimated_mb": 362.4,
    "total_tier": "warn",
    "warn_threshold_mb": 350,
    "hard_threshold_mb": 400,
    "limit_mb": 500,
    "capacity_override": false,
    "shard_available": true,
    "shard_routed_groups": 2,
    "auto_shard_enabled": true,
    "auto_shard_tier_trigger": "hard",
    "auto_shard_last_migrated_group_id": "grp_xxx",
    "auto_shard_last_migrated_at": "2026-07-08T03:00:00.000Z",
    "auto_shard_pending_groups_on_primary": 3,
    "auto_shard_last_error": null,
    "auto_shard_last_error_at": null,
    "breakdown": {
      "dm_message_bytes": 120000000,
      "group_member_message_bytes": 80000000,
      "group_owner_message_bytes": 5000000,
      "media_local_bytes": 10000000,
      "fixed_overhead_bytes": 20971520,
      "index_overhead_factor": 1.28
    }
  }
}
```

`tier`：`normal`（<350 MB）、`warn`（≥350 MB）、`hard`（≥400 MB）。**按 `MESSAGING_DB` primary 单库估算**（D1 Free 每库 500 MB）；`total_*` 为 primary + `MESSAGING_SHARD_1` 群消息表合计参考。Cron GC 在 primary `warn`/`hard` 时打日志 `[messaging/watermark]`（24h 同 tier 去重）。

**M16-P 分片字段**：
- `shard_available`：是否已绑定 `MESSAGING_SHARD_1`（bootstrap/deploy 自动创建并绑定，M16-P3）
- `shard_routed_groups`：已登记 `group_message_shard_routes.shard_id = shard_1` 的群数量

**M16-P4c 自动分片可观测**（`hard` 水位 Cron 卸货 + 新群直上分片，见 [`m16-p4-auto-shard-plan.md`](./m16-p4-auto-shard-plan.md)）：
- `auto_shard_enabled`：有 `MESSAGING_SHARD_1` 且 `MESSAGING_AUTO_SHARD_ENABLED !== 'false'`
- `auto_shard_tier_trigger`：触发线，默认 `hard`（400 MB）；运维可 env 改为 `warn`
- `auto_shard_last_migrated_group_id` / `auto_shard_last_migrated_at`：最近一次 Cron 完成整群卸货并登记路由的群与时间（`system_config`）
- `auto_shard_pending_groups_on_primary`：primary 上仍有消息、尚未登记 `shard_1` 的群数量
- `auto_shard_last_error` / `auto_shard_last_error_at`：最近一次自动卸货失败原因与时间（成功完成会清除）

Web 群设置：`tier >= warn` 且 `shard_available && auto_shard_enabled` 时展示中文说明（迁移不中断聊天）。

群消息大表（`group_messages` / `member_group_messages`）按 `group_id` 路由；metadata 与 `dm_*` 仍留 `MESSAGING_DB`。手工插队：`node scripts/migrate-group-messages-to-shard.mjs --group-id <id> --local|--remote`。

### POST /api/groups/:groupId/leave `[JWT]`（M16-4f · EPOCH v0.3 + SEC-1）

成员退出；**群主不可退出**。

- **本机最高优先**：本节点立刻 `status=left` + 客户端清钥；群主宕机不挡本地退出。
- **异步权威**：若本机非群主，向群主 Worker B `POST /groups/member-left` 投递 **`GROUP_MEMBER_LEFT_V1`** 信令（字段：`group_id` / `member_worker_b_url` / `timestamp` / `nonce` / `sig`，可选 `member_handle`）。权威用 pin 的 `member_pubkey` 验签 + `group_nonces` 防重放后才 `left` + system relay + **`recomputeAndPersistRelayTree({ force:true })`**。
- **不**紧急 `epoch++` / 不换钥（仅踢人/拉黑强制换钥）。
- 权威错误：`GROUP_ENVELOPE_INVALID`（400/403，缺字段/过期/验签失败）、`GROUP_NONCE_REPLAY`（409）。

### POST /api/groups/:groupId/kick `[JWT]`（EPOCH v0.3 · REKEY-1）

群主/管理员踢人。Body 可选：

- `expected_epoch`：可选正安全整数；权威检查冲突 → `409 EPOCH_CONFLICT`
- `wrapped_keys[]`：**REKEY-1 起禁止**。非空（或非数组）→ `400 GROUP_REKEY_NOT_READY`。踢人只做隔绝，不得用单人/占位 wrap 冒充换钥；全员可读 wrap + `rekey-commit` 留给 REKEY-2。

成功 data 含 `new_epoch`（**保持原 epoch**）和 `rekey_scheduled: true`。浏览器不生成或缓存未分发的新钥；前端 client 不再附带 `wrapped_keys`。

**EPOCH-MOD-1**：非本机群主时，本节点签 `GROUP_MODERATION_KICK` 后经安全出站投递群主 Worker B `/groups/moderation`，不使用本地镜像授予权限。群主内部入口只接受 Service Binding + HMAC，再校验本机为群主、群未解散、活跃管理员的 pin 公钥签名、nonce 与每小时 30 次 D1 额度，然后复用群主踢人逻辑（管理员不能踢群主、自己或其他管理员）。复用现有 owner JWT 端点与 Gateway 白名单。

**EPOCH-REKEY-1**：隔绝与换钥硬拆——① `status=kicked` + force 摘边 + system + `rekey_scheduled=1`；② **不** CAS `epoch++`、**不**把留下成员打成 `pending`/`epoch_rotation_pending`、**不**写入新 wrap。被踢者无法再经树发言/收包；旧群钥仍服务留下成员，直至 REKEY-2 commit。

错误含 `GROUP_REKEY_NOT_READY`（400）、`GROUP_MODERATION_FORBIDDEN`（403）、`GROUP_ENVELOPE_INVALID`（400，含自踢等外形拒绝）、`GROUP_NONCE_REPLAY`（409，不扣额度）、`GROUP_RATE_LIMITED`（429）、`GROUP_MODERATION_UNAVAILABLE`（503）。隔绝已写入但 force 建树失败时亦返 503；成员已 `kicked`，客户端须**换新 nonce**重试做幂等收尾（再建树并在缺省时补发 system）。网络响应丢失时操作可能已生效，应刷新名单确认。仅隔绝是临时阶段，被踢者仍持旧群钥，前向保密等待 REKEY-2，不能宣称已换钥。

### POST /api/groups/:groupId/fast-pull-key `[JWT]`（EPOCH v0.3 P1）

本地缺 wrap 时向群主权威快拉本成员当前 `epoch` 的 `wrapped_key_json` 并落库。Body：`{ "epoch": N }`。
SEC-5 / EPOCH NET-2：远程请求由本节点 Ed25519 私钥签名，不能指定其他成员；返回的群号、成员 URL、epoch 必须与请求一致才落库。本地已有包时不发出站请求。

**成功**：
```json
{
  "ok": true,
  "data": {
    "group_id": "grp_...",
    "epoch": 2,
    "member_worker_b_url": "https://member-b.example.com",
    "wrapped_key_json": "{\"v\":1,\"wrap_alg\":\"AES-256-GCM\",...}"
  }
}
```

**错误码**：`GROUP_NOT_FOUND` / `GROUP_KEY_PENDING`（404）、`GROUP_KEY_PENDING`（409，网络失败或响应错包）、`USER_NOT_REGISTERED`（409）、`GROUP_WRAP_FORBIDDEN`（403）、`GROUP_WRAP_RATE_LIMITED`（429）、`GROUP_WRAP_UNAVAILABLE`（503）。

### POST /groups/fetch-wrapped-key `[内部 HMAC]`（SEC-5 / EPOCH NET-2）

仅由 Worker B Service Binding 转发；HMAC 不替代成员验签。请求、签名字节及错误码见 Worker B 同名接口。A 独立重复校验签名信封外形与 ±5min 时间窗，用该群 `status='active'` 成员已固定的 `member_pubkey` 验签；不采信请求自带公钥。成员的 `key_state='pending_key'` / `epoch_rotation_pending` 不影响补钥资格。

顺序：外形/时间 → 本机群主权威 + 活跃成员 + pin 验签 → D1 原子消费 nonce → **仅新 nonce** 再 D1 原子频控 → 查询本人 wrap。鉴权失败统一 403（不透露群或 wrap 是否存在）；仅鉴权后缺包返回 404。存储失败关闭访问并返回 503。每群每成员 UTC 整点小时最多 30 次，与 epoch 无关，独立于发信/sync 桶；**重放不扣额度**，直接 `409 GROUP_NONCE_REPLAY`。超限返回 429（此时 nonce 已占用，客户端须换新 timestamp/nonce），不读 wrap。nonce 复用 `group_nonces`，频控复用 `group_rate_buckets`，不写 KV，不增加迁移/Cron。

nonce 沿用 7 天清理；补钥小时桶在超过 1 天后由既有 `gcGroupRetention` 每批最多清理 100 行，不清当前桶或其他业务桶。新增一次 D1 调用已纳入 Cron 服务调用估算；配额模型与高基数积压风险见 Epoch 计划「NET-2 落地」。

本端点及 Worker B 对应端点所有响应均为 `Cache-Control: private, no-store`。旧节点无签名快拉不再兼容，须升级；不提供未验签回退开关。pin 来源仍是入群时固定的成员公钥，本步不额外证明成员 URL 的外部所有权。

### POST /api/groups/:groupId/dissolve `[JWT]`（M16-6）

群主解散群：写 `groups.dissolved_at`；成员经 `sync-with-parent` 下行获知后进入 **48h** 本地只读窗口，超时由 Cron `gcDissolvedGroups` purge 本节点副本。

**成功**：
```json
{
  "ok": true,
  "data": {
    "group_id": "grp_...",
    "dissolved_at": "2026-07-05T08:30:00.000Z"
  }
}
```

**错误码**：`GROUP_NOT_FOUND`（404）、`GROUP_NOT_MEMBER`（403，非群主）、`USER_NOT_REGISTERED`（409）。

### GET /api/groups/:groupId/wrapped-keys `[JWT]`（M16-4c）

读本节点 `group_wrapped_keys` 中**本成员** `member_worker_b_url` 对应的包裹群密钥；浏览器用站主 KEK unwrap 后写入 sessionStorage。

**Query**：
- `epoch`：可选，整数；不传则返回该群全部 epoch 行

**成功**：
```json
{
  "ok": true,
  "data": {
    "group_id": "grp_...",
    "key_state": "active",
    "items": [
      {
        "epoch": 1,
        "member_worker_b_url": "https://...",
        "wrapped_key_json": "{\"v\":1,\"wrap_alg\":\"AES-256-GCM\",...}",
        "updated_at": "2026-07-05T08:00:00.000Z"
      }
    ]
  }
}
```

**错误码**：`GROUP_ENVELOPE_INVALID`（400）、`USER_NOT_REGISTERED`（409）、`GROUP_NOT_FOUND`（404）。

### PUT /api/groups/:groupId/wrapped-keys `[JWT]`（M16-4c · REKEY-2）

上传浏览器 wrap 后的 `group_key`（Worker 永不接收明文 group_key）。内部与 batch 共用写入 helper。

**请求**：
```json
{
  "epoch": 1,
  "wrapped_key_json": "{\"v\":1,\"wrap_alg\":\"AES-256-GCM\",\"kdf\":\"VAULT-HKDF-v1\",\"epoch\":1,...}",
  "member_worker_b_url": "https://...",
  "key_fingerprint": "<可选；下一 epoch 必填，SHA-256(group_key) 64 hex>"
}
```

- `member_worker_b_url` 可选，默认本节点；**群主或管理员**可为其他在册成员上传
- `epoch` 仅允许**当前**或**当前+1**（预传下一轮）；其它值 → `400 GROUP_ENVELOPE_INVALID`
- 为他人预传 **epoch = current+1** 时，目标须已登记 `member_dh_pubkey`，否则 `409 GROUP_REKEY_NOT_READY`
- **下一 epoch** 须带 `key_fingerprint`；若库中已有不同指纹的 wraps → `409 GROUP_REKEY_KEY_MISMATCH`（请改走 batch + `replace_key`）
- 本节点成员为自己上传**当前 epoch** 成功后，`group_members.key_state` 置 `active`
- wrap JSON：自包常用 **v1**（vault/password KEK）；为他人密封用 **v2**（`kdf=X25519-HKDF-v1` + `ephemeral_pubkey`）

**成功**：
```json
{
  "ok": true,
  "data": {
    "group_id": "grp_...",
    "epoch": 1,
    "member_worker_b_url": "https://..."
  }
}
```

**错误码**：`GROUP_ENVELOPE_INVALID`（400）、`GROUP_NOT_FOUND`（404）、`GROUP_NOT_MEMBER`（403）、`GROUP_REKEY_NOT_READY`（409）、`GROUP_REKEY_KEY_MISMATCH`（409）。

**建群后流程（OWNER-KEY-2）**：优先用建群响应的 `group_key_hex`（已进持钥表）→ `wrapGroupKey`（vault）→ `PUT` epoch=1 本节点 wrapped key；缺服务端钥时本机 `generateGroupKey` 并可选 `PUT .../owner-epoch-key` bootstrap。

### GET /api/groups/:groupId/owner-epoch-key `[JWT]`（OWNER-KEY-2）

**仅群主**。查询 `group_owner_epoch_keys` 是否已落盘；**不**返回明文 / `key_material`。

**Query**：`epoch` 可选；缺省为群当前 `groups.epoch`。

**成功**：
```json
{
  "ok": true,
  "data": {
    "group_id": "grp_...",
    "epoch": 1,
    "held": true,
    "key_fingerprint": "<64 hex 或 null>",
    "updated_at": "<ISO 或 null>"
  }
}
```

**错误码**：`GROUP_ENVELOPE_INVALID`（400）、`GROUP_NOT_MEMBER`（403，非群主）、`GROUP_NOT_FOUND`（404）、`USER_NOT_REGISTERED`（409）。

### PUT /api/groups/:groupId/owner-epoch-key `[JWT]`（OWNER-KEY-2）

**仅群主**。老群一次性 bootstrap：上传当前 epoch 明文 `group_key_hex`，Worker 用 `GROUP_OWNER_KEY_WRAP_SECRET` 包裹写入持钥表。同源指纹幂等；异源 → `409 GROUP_OWNER_KEY_MISMATCH`。缺 wrap secret → `503 GROUP_OWNER_KEY_WRAP_SECRET_MISSING`。仅允许 **当前** `groups.epoch`（下一 epoch 留给 OWNER-KEY-5）。

**请求**：
```json
{ "epoch": 1, "group_key_hex": "<64 hex>" }
```

**成功**：
```json
{
  "ok": true,
  "data": {
    "group_id": "grp_...",
    "epoch": 1,
    "key_fingerprint": "<64 hex>",
    "created": true
  }
}
```

**错误码**：`GROUP_ENVELOPE_INVALID`（400）、`GROUP_NOT_MEMBER`（403）、`GROUP_NOT_FOUND`（404）、`GROUP_OWNER_KEY_MISMATCH`（409）、`GROUP_OWNER_KEY_WRAP_SECRET_MISSING`（503）、`USER_NOT_REGISTERED`（409）。

### POST /api/groups/:groupId/owner-seal-pending `[JWT]`（OWNER-KEY-4）

**群主或管理员**（须在**群主节点**执行）。扫描 `status=active AND key_state=pending_key`，对已登记 `member_dh_pubkey` 者用持钥表当前 epoch **服务端 X25519 代封**（≤32/批），并尽量翻 `key_state=active`。浏览器**不**持明文群钥。Fast-Pull 在群主节点缺 wrap 时也会 fail-soft 尝试同路径代封。

**请求**（可选）：
```json
{ "limit": 32 }
```

**成功**：
```json
{
  "ok": true,
  "data": {
    "group_id": "grp_...",
    "epoch": 1,
    "sealed": 3,
    "skipped_no_dh": 1,
    "failed": 0,
    "remaining_pending_key": 1,
    "batch_limit": 32
  }
}
```

**错误码**：`GROUP_ENVELOPE_INVALID`（400）、`GROUP_NOT_MEMBER`（403，非主/管或非群主节点）、`GROUP_NOT_FOUND`（404）、`GROUP_OWNER_KEY_MISSING`（503，持钥表未托管）、`USER_NOT_REGISTERED`（409）。

### PUT /api/groups/:groupId/wrapped-keys/batch `[JWT]`（SEC-AUDIT-2026-10-16）

真 batch 写入：单次请求在 D1 `batch` 内写入最多 **32** 条 wraps，并钉死同源 `key_fingerprint`。

**请求**：
```json
{
  "epoch": 4,
  "key_fingerprint": "<SHA-256(group_key) 64 hex>",
  "replace_key": true,
  "items": [
    { "member_worker_b_url": "https://...", "wrapped_key_json": "{...}" }
  ]
}
```

- `items` 长度 1～32；同批 URL 不得重复
- **下一 epoch**：`key_fingerprint` 必填；`replace_key=true`（仅主/管）会先删该群该 epoch 全部 wraps 再写入——用于重试换钥清异源残留
- 未 `replace_key` 且库中已有不同 fingerprint → `409 GROUP_REKEY_KEY_MISMATCH`
- 为他人密封下一 epoch 仍须对方已登 `member_dh_pubkey`

**成功**：`{ "ok": true, "data": { "group_id", "epoch", "written", "key_fingerprint", "replaced" } }`

**错误码**：同上单条 + `GROUP_REKEY_KEY_MISMATCH`。

### PUT /api/groups/:groupId/dh-pubkey `[JWT]`（EPOCH-REKEY-2）

本机登记群成员 X25519 `member_dh_pubkey`（与 Ed25519 签名钥职责分离；形态同 `dm_pubkey`）。

**请求**：`{ "member_dh_pubkey": "<64 位小写 hex>" }`

**成功**：`{ "ok": true, "data": { "group_id", "member_worker_b_url", "member_dh_pubkey" } }`

**错误码**：`GROUP_ENVELOPE_INVALID`（400）、`GROUP_NOT_FOUND`（404）、`GROUP_NOT_MEMBER`（403/409）、`USER_NOT_REGISTERED`（409）。

### POST /api/groups/:groupId/owner-rekey `[JWT]`（OWNER-KEY-5）

**群主或管理员**，且须在**群主节点**。服务端生成（或复用）`epoch+1` 持钥 → 按批为已登记 `member_dh_pubkey` 的 active 成员 X25519 代封 next wraps → wraps **齐备且** `commit!==false` 时再走与 `rekey-commit` 相同的 CAS。浏览器**不**持明文群钥。

**分批（Free CPU）**：单次请求最多代封 `REKEY_WRAP_BATCH_MAX`（32）人；异源 / 缺指纹的 next wraps 会整 epoch 清掉后重封，同源 fingerprint 可续批。`remaining_unsealed > 0` 时 `committed` 恒为 `false`，调用方（Web `ownerServerRekey`）须轮询直至齐备。

**请求**（均可选）：
```json
{ "expected_epoch": 3, "commit": true }
```

- `expected_epoch`：缺省等于当前 `groups.epoch`；显式传入则须匹配。  
- `commit`：缺省 `true`；`false` 或尚有 `remaining_unsealed` 时不翻 epoch。

**前置**：`rekey_scheduled=1`；已配置 `GROUP_OWNER_KEY_WRAP_SECRET`；至少 1 名 sealable（有 DH）。缺 secret → `503 GROUP_OWNER_KEY_WRAP_SECRET_MISSING`（前端可回落浏览器 Batch，迁移期 deprecated）。

**成功**（本批封完且齐备 + `commit=true`）：
```json
{
  "ok": true,
  "data": {
    "group_id": "grp_...",
    "previous_epoch": 3,
    "next_epoch": 4,
    "key_fingerprint": "<64 hex>",
    "sealed": 12,
    "deferred_count": 0,
    "remaining_unsealed": 0,
    "committed": true,
    "new_epoch": 4,
    "rekey_scheduled": false,
    "wrapped_count": 12,
    "batch_limit": 32
  }
}
```

**成功**（本批未齐备，须继续 POST）：`committed: false`，`remaining_unsealed > 0`，`rekey_scheduled: true`，`new_epoch: null`。

**错误码**：`GROUP_ENVELOPE_INVALID`（400）、`GROUP_NOT_MEMBER`（403，非主/管或非群主节点）、`GROUP_NOT_FOUND`（404）、`GROUP_REKEY_NOT_READY` / `EPOCH_CONFLICT` / `GROUP_REKEY_KEY_MISMATCH`（409）、`GROUP_OWNER_KEY_WRAP_SECRET_MISSING` / `GROUP_WRAP_UNAVAILABLE`（503）、`USER_NOT_REGISTERED`（409）。

### POST /api/groups/:groupId/rekey-commit `[JWT]`（EPOCH-REKEY-2）

管理员在 next-epoch wraps 齐备后 CAS 推进 epoch（crash-safe：齐备前不翻）。**OWNER-KEY-5 起**：新群主路径优先 `owner-rekey`；本端点仍供浏览器 Batch 迁移期兜底与 `commit:false` 后的手动提交。

**请求**：`{ "expected_epoch": 3 }`（须等于当前 `groups.epoch`）

**前置**：`rekey_scheduled=1`；已登记 DH 的留下 `active` 成员（sealable）在 `epoch=expected+1` 的 wraps 齐备且 **共享同一非空 `key_fingerprint`**（SEC-AUDIT-2026-10-15/16：缺 DH 可 deferred，不挡；混指纹 → `GROUP_REKEY_KEY_MISMATCH`）。

**成功**：
```json
{
  "ok": true,
  "data": {
    "group_id": "grp_...",
    "previous_epoch": 3,
    "new_epoch": 4,
    "rekey_scheduled": false,
    "wrapped_count": 12,
    "deferred_count": 0
  }
}
```

副作用：`groups.epoch++`、`rekey_scheduled=0`；sealable 成员 `key_state=epoch_rotation_pending`；deferred 成员 `pending_key`（随后 Fast-Pull / sync 取新 wrap）。

**错误码**：`GROUP_ENVELOPE_INVALID`（400）、`GROUP_NOT_FOUND`（404）、`GROUP_NOT_MEMBER` / 非主非管（403）、`GROUP_REKEY_NOT_READY`（409）、`GROUP_REKEY_KEY_MISMATCH`（409）、`EPOCH_CONFLICT`（409）。

### POST /api/groups/sign-envelope `[JWT]`（M16-4d · MSG-FIX-0）

站主 JWT 代签 `GROUP_MESSAGE_ENVELOPE_V1`（浏览器不持 Ed25519 私钥，对齐 `POST /api/dm/sign-envelope`）。  
**MSG-FIX-0**：普通群成员也可代签；不再要求本机必须是群主。

**签名前强校验**：
- `sender_handle` 必须等于本节点 D1 `users.handle`
- `sender_worker_b_url` 必须等于本节点 `worker_b_url`（`normalizeGroupMemberUrl`）
- `owner_worker_b_url` 必须等于 D1 `groups.owner_worker_b_url`（**可为远端群主**；与信封一致即可）
- `epoch` 必须等于 D1 `groups.epoch`（防浏览器用过期 / 未来 epoch 蒙混）
- 群必须存在且未解散
- 本站主须为该群 `group_members` **active** 成员（否则 `403 GROUP_NOT_MEMBER`）
- `msg_kind === 'chat'` 且全员禁言时：仅群主/管理员可代签（否则 `403 GROUP_MEMBERS_MUTED`，与发信路径对齐）

envelope 字段不一致时返回 `GROUP_ENVELOPE_INVALID`（403/404/409/410）。

**请求**：`{ "envelope": { ...不含 sig 的 GROUP_MESSAGE 字段, "ciphertext": "..." } }`

**成功**：`{ "ok": true, "data": { "envelope": GroupMessageEnvelope } }`

**错误码**：`GROUP_ENVELOPE_INVALID`（400/403/404/409/410）、`GROUP_NOT_MEMBER`（403）、`GROUP_MEMBERS_MUTED`（403）

### 内部 POST /groups/invite-accept（Service Binding + HMAC）

Worker B `POST /groups/invite-accept` 转发入口；群主权威写入 membership。
粗校验：须有成员三字段 + `invite_token`；`group_id` 可选（短码入群时由群主查 `invite_code` 还原）。

### 内部 POST /groups/join-decision（Service Binding + HMAC · REL-FIX-7）

群主 Worker A 向**申请人节点**回推入群审批结果；Worker B `POST /groups/join-decision` 转发入口。申请人侧 Worker A 权威落地：验签 + 更新本机 membership + 写本地通知。

**请求体**（`GROUP_JOIN_DECISION_V1`）：
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

**权威判定**：验签**只用本机 `group_members` 中 `role='owner' AND status='active'` 的 pin 公钥**（**不采信信封里的 `owner_pubkey`**）；时间窗 ±5min；nonce 落 `group_nonces` 防重放；`member_worker_b_url` 须为本机 Worker B URL。

**落地**：同意 → 本机 `group_members.status='active'`；拒绝 → **置终态 `status='left'`（REL-FIX-8，不删行）**；两种都写本地通知 `group_join_approved` / `group_join_rejected`（fail-soft）。

**REL-FIX-8 投递幂等**：拒绝结果**重复投递**必须幂等收敛——本地成员行已非 `pending`（如已被置 `'left'`）时返回 **200 `applied=false`**，不重复写通知。这样群主 outbox 的重投（因响应丢失触发、且每次重建 ts/nonce）能正确收敛到 `sent`，不会因 404 `GROUP_NOT_MEMBER` 重投到死。`status='left'` 的成员被群列表（`status IN ('active','pending')`）过滤掉；再次申请时 `INSERT OR REPLACE` 会把 `left` 行重写为 `pending`/`active`。

**成功**：`{ "ok": true, "data": { "group_id": "grp_…", "status": "active" | "rejected", "applied": boolean } }`

**错误码**：`GROUP_ENVELOPE_INVALID`（400，字段/签名/时间窗非法）、`GROUP_NOT_MEMBER`（403，非本机目标）、`GROUP_NOT_FOUND`（404）、`GROUP_NONCE_REPLAY`（409）、`USER_NOT_REGISTERED`（409，节点未注册）。

### 内部 POST /groups/join-decision（Service Binding + HMAC · REL-FIX-7）

群主 Worker A 向**申请人节点**回推入群审批结果；Worker B `POST /groups/join-decision` 转发入口。申请人侧 Worker A 权威落地：验签 + 更新本机 membership + 写本地通知。

**请求体**（`GROUP_JOIN_DECISION_V1`）：
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

**权威判定**：验签**只用本机 `group_members` 中 `role='owner' AND status='active'` 的 pin 公钥**（**不采信信封里的 `owner_pubkey`**）；时间窗 ±5min；nonce 落 `group_nonces` 防重放；`member_worker_b_url` 须为本机 Worker B URL。

**落地**：同意 → 本机 `group_members.status='active'`；拒绝 → **置终态 `status='left'`（REL-FIX-8，不删行）**；两种都写本地通知 `group_join_approved` / `group_join_rejected`（fail-soft）。

**REL-FIX-8 投递幂等**：拒绝结果**重复投递**必须幂等收敛——本地成员行已非 `pending`（如已被置 `'left'`）时返回 **200 `applied=false`**，不重复写通知。这样群主 outbox 的重投（因响应丢失触发、且每次重建 ts/nonce）能正确收敛到 `sent`，不会因 404 `GROUP_NOT_MEMBER` 重投到死。`status='left'` 的成员被群列表（`status IN ('active','pending')`）过滤掉；再次申请时 `INSERT OR REPLACE` 会把 `left` 行重写为 `pending`/`active`。

**成功**：`{ "ok": true, "data": { "group_id": "grp_…", "status": "active" | "rejected", "applied": boolean } }`

**错误码**：`GROUP_ENVELOPE_INVALID`（400，字段/签名/时间窗非法）、`GROUP_NOT_MEMBER`（403，非本机目标）、`GROUP_NOT_FOUND`（404）、`GROUP_NONCE_REPLAY`（409）、`USER_NOT_REGISTERED`（409，节点未注册）。

### POST /api/groups/:groupId/messages `[JWT]`（M16-2）

群主或成员经 Owner Gateway 发群消息。

**请求**：
```json
{ "envelope": { "...": "GROUP_MESSAGE_ENVELOPE_V1" } }
```

**行为**：
- **群主**（本节点 `owner_worker_b_url`）：写权威 `group_messages` + 本地 `member_group_messages` + 向 seed ×5 `POST /groups/relay`
- **成员**：写本地 `member_group_messages` + `group_outbox`；即时 fetch 群主 Worker B `POST /groups/inbound`
  - **GRP-RELAY-AUTH-4（主责加速）**：必须先打群主 inbound；仅当响应带回 `owner_receipt` 时，才对主责名单中的 **peer** 走 `/groups/relay`（并携带该回执）。**无 receipt 不得直推 peer**（只打群主 / 等群主树扇出），堵住「未经群主起播就先扇出」的口子。

**成功**：
```json
{
  "ok": true,
  "data": {
    "message_id": "gmsg_...",
    "duplicate": false,
    "outbox_state": "sent"
  }
}
```

`outbox_state` 仅成员路径返回；幂等重复 `message_id` 时 `duplicate: true`。

**错误码**：`GROUP_ENVELOPE_INVALID`（400）、`GROUP_NOT_FOUND`（404）、`GROUP_NOT_MEMBER`（403）、`GROUP_EPOCH_STALE`（409）、`GROUP_NONCE_REPLAY`（409）、`GROUP_RATE_LIMITED`（429）、`GROUP_KEY_PENDING`（403）、`GROUP_MESSAGE_EXPIRED`（400）、`BLACKLISTED`（403）、`GROUP_OWNER_UNREACHABLE`（502）。

### 内部 POST /groups/inbound（Service Binding + HMAC · M16-2）

Worker B `POST /groups/inbound` 转发入口；群主 Worker A 验签 + membership + 写权威 D1 + relay seed。

**请求体**：`{ "envelope": GROUP_MESSAGE_ENVELOPE_V1 }`

**成功（GRP-RELAY-AUTH-2 / DUP-1）**：`{ "ok": true, "data": { "message_id": "gmsg_…", "duplicate?": boolean, "owner_receipt?": OwnerReceiptV1 } }`  
受理写入权威库后，群主用 `ED25519_PRIVATE_KEY` 签发 `owner_receipt`（绑 `ciphertext` 摘要；TTL=`min(issued+7d, envelope.expires_at)`），并随随后 `/groups/relay` fanout 携带。缺私钥时 fail-soft：仍 `ok`，但不附 receipt（影子阶段不挡受理）。  
**幂等 `duplicate: true`（GRP-RELAY-AUTH-DUP-1）**：消息已存在时**仍补签并回传** `owner_receipt`（不重复 fanout、不 mirror），供发信方 Outbox 弱网重试后继续 AUTH-4 主责直推 peer。

#### OwnerReceiptV1（GRP-RELAY-AUTH · 群主副签回执）

Ed25519 **签名**证明「群主已受理该密文」；**不是**用私钥加密元数据。密文仍只在浏览器用群密钥解密。

| 字段 | 类型 | 说明 |
|---|---|---|
| `v` | `1` | 版本 |
| `group_id` / `message_id` / `epoch` | string / string / number | 与信封一致 |
| `sender_worker_b_url` / `sender_handle` | string | 归一后 URL；handle 小写 |
| `ciphertext_sha256` | string | `envelope.ciphertext` 的 SHA-256 hex（防旧回执贴新密文） |
| `owner_worker_b_url` | string | 群主 Worker B URL（归一） |
| `issued_at` / `exp` | ISO string | `exp = min(issued+7d, envelope.expires_at)` |
| `recv_seq` | number? | **MSG-FIX-5**：群主权威入库分配的单调序（`group_messages.recv_seq`），**进签名**——中继节点只透传、不可伪造序号。缺省 = 老节点签发的回执 |
| `sig` | hex | 群主节点身份钥对 canonical 字节串的 Ed25519 签名 |

Canonical 输入与 `packages/shared-crypto` `OWNER_RECEIPT_V1` / `buildOwnerReceiptSignatureInput` 字节同源。计划 SSOT：[`grp-relay-auth-2026-10-plan.md`](./grp-relay-auth-2026-10-plan.md)。

**canonical 的跨版本兼容（REL-FIX-13 · MSG-FIX-5 兼容修正）**：`recv_seq` 存在时 canonical 为 **11 行**（末行是序号）；`recv_seq` **缺失时整行省略**，canonical 退化为 **10 行**——与 MSG-FIX-5 之前的老群主节点签发的字节**完全一致**，升级后的收端才能验过老回执。⚠️ 不得用「空串占位」写法（`join('\n')` 会多一个尾部 `\n` → 11 行），那会让老回执被误判 `GROUP_RECEIPT_INVALID`。收端验签对**无序号**回执额外尝试一次 MSG-FIX-5 初版 canonical（过渡期回退）；**带序号**回执**不做回退**（防伪造语义不得削弱）。反向不兼容（新回执给老节点验）是协议升级固有边界，无法靠代码消除。

**recv_seq 权威背书（MSG-FIX-5）**：群主入库时在**同一事务**内分配 `recv_seq`（INSERT 内联子查询 `COALESCE(MAX(recv_seq),0)+1`），并把它签进 `owner_receipt`。relay 中继只允许把回执里的序号透传落库，**不得自造**；中继伪造序号（改 `recv_seq` 不重签）会被收端验签拒收（`GROUP_RECEIPT_INVALID`）。回执缺 `recv_seq`（老节点）时落库写 `NULL`，由后续 sync 下行补齐。收端拒收 `recv_seq` 非整数或 `< 1`。**relay 落库用 upsert**（`ON CONFLICT(message_id) DO UPDATE ... COALESCE`）——发信方本机已存在该消息行（本地发信先落库、序号仍为 NULL）时，旧的 `INSERT OR IGNORE` 会整条跳过导致本机序号补不上；upsert 只在本地缺失时补齐，**已有值一律保留**（本地行是本机权威，中继不得覆盖）。

**跨分片入库的原子性边界（MSG-FIX-6）**：`group_nonces` 在 `MESSAGING_DB`，`group_messages` / `member_group_messages` 可能被路由到 `MESSAGING_SHARD_1`（overflow 分片）。D1 的 `db.batch()` **绑定在单一 database_id 上**——statement 载荷只有 SQL + params、**不带各自的 binding id**，跨库单 batch **不报错**，而是把全部语句**静默执行到 batch 所属那个库**（静默写错库，比抛错更难发现）。故群主入库按物理库拆写：

| 情形 | 写入顺序 | 语义 |
|---|---|---|
| 同库（群未分片） | `MESSAGING_DB.batch([nonce, group_messages, member_group_messages])` | **单事务原子**：三条语句要么全成要么全回滚 |
| 异库（群已路由到 shard_1） | ① `MESSAGING_DB.batch([nonce])` ② `MESSAGING_SHARD_1.batch([group_messages, member_group_messages])` | **跨库无事务**：两步串行；②失败时**补偿删除**①写入的 nonce 行，让发送方用同一 nonce 重试能真正补发（否则「nonce 已消耗 + 消息丢失」→ 重试恒得 409 `GROUP_NONCE_REPLAY`） |

顺序固定为「先扣 nonce（防重放优先）→ 后写消息」；nonce 占用必须先于消息落库，否则消息先到会被重放窗口绕过。补偿删除为 **best-effort**（跨库写失败时补偿也可能失败，故单独记错误日志）。

**系列验收（GRP-RELAY-AUTH-5）**：`test:grp-relay-auth-1`～`5` 覆盖 canonical/签验、inbound 签发、收端「无 receipt 拒收 / 篡改密文拒收」、主责无回执不直推 peer、文档闭环。收端强制为程序内常量（无 wrangler env）。

### 内部 POST /groups/relay（Service Binding + HMAC · M16-2）

Worker B `POST /groups/relay` 转发入口；本节点 `group_relay_seen` 去重 → 写 `member_group_messages` → 向 children fanout（hop_count≤10）。

**请求体**：`{ "envelope": GROUP_MESSAGE_ENVELOPE_V1, "hop_count": 0, "owner_receipt?": OwnerReceiptV1, "next_hops?": [...], "route_slice?": [...] }`  
形状非法的 `owner_receipt` 整包按 `GROUP_ENVELOPE_INVALID` 拒。

**owner_receipt 校验（GRP-RELAY-AUTH-3）**：在发送者 envelope 验签与禁言闸**之前**执行。用本机群主成员 pin（`owner_pubkey`）验 `owner_receipt.sig`，并核对 group/message/epoch/sender/owner URL 与 `ciphertext_sha256`。  
收端**恒强制**（程序内常量 `GROUP_RELAY_RECEIPT_REQUIRED = true`，**不**读 env / wrangler）：  
- 缺 receipt → `403 GROUP_RECEIPT_REQUIRED`  
- 无 pin / 验签失败 / **篡改密文摘要** / 过期 / 错公钥 → `403 GROUP_RECEIPT_INVALID`

**错误码（receipt 相关）**：`GROUP_RECEIPT_REQUIRED`（403，缺回执）、`GROUP_RECEIPT_INVALID`（403，形状合法但验签/字段/摘要/时间窗失败）。其它仍见 envelope / 禁言 / `GROUP_NOT_FOUND` 等。

**禁言闸（MUTE-RELAY-1）**：receipt + 发送者验签通过后、seen/落库/fanout 之前——**仅当**本机 `groups.members_muted=1` 时查发送方成员行并做发言权判定（`decideMuteRelayChatGate` / `canSpeakWhenMuted`）：普通成员 chat → `403 GROUP_MEMBERS_MUTED`；成员行缺失/非 active → `403 GROUP_NOT_MEMBER`（禁言下 fail-closed）。**未禁言**时不因中继本地缺成员行拒收。system 不受禁言限制。

### POST /api/groups/:groupId/sync `[JWT]`（M16-3）

成员本节点向父节点发起 `sync-with-parent`（Cron/手动入口）。群主节点调用返回 `403 GROUP_NOT_MEMBER`。

**请求（可选）**：
```json
{ "cursor": "gmsg_...", "acks": ["gmsg_..."], "heartbeat": true }
```

**成功**：`{ "ok": true, "data": GroupSyncDown }`（含 `messages[]`、`relay_tree?`、`wrapped_key?`、`tree_id`、`epoch`、`cursor`；**GRP-RELAY-AUTH-PIN-1** 起可选 `owner_handle` / `owner_pubkey`）

`messages[]` 单条字段：`message_id`、`group_id`、`epoch`、`sender_worker_b_url`、`sender_handle`、`msg_kind`、`ciphertext`、`created_at`；**MSG-FIX-4** 起可选 `recv_seq`（群主权威入库单调序；服务端 sync 过滤主用 `recv_seq > cursor 翻译值`，**不再**用客户端 `created_at` 做游标，避免时钟乱序永久空洞）；**M16-7c** 起可选 `envelope_json`（完整 `GROUP_MESSAGE` envelope JSON，含 signed `media` 块）。对外 `cursor` 仍可回写最新 `message_id`（兼容旧客户端存法）；成员镜像写入时复制下行 `recv_seq`，本地不得自造乱序。sync 补拉路径写入 `member_group_messages.envelope_json` 后，Web `GET /api/groups/local/:id/messages` 可解析 `media` 并走 ticket/proxy/mirror（与 relay 路径一致）。

**群主 pin 回填（GRP-RELAY-AUTH-PIN-1）**：群主权威 sync（及本机已有 pin 的中间父）下行可带 `owner_handle` / `owner_pubkey`；成员 `applyGroupSyncDown` 写入本地 `group_members`（`role=owner`），与入群 `mirrorAcceptedGroupLocally` 同源。缺 pin 字段可省略（中间父尚未回填时）；不计入 empty-ack 的 `hasDelta`。收端恒强制验签，成员侧须能拿到群主 pin（入群 mirror 或 sync 回填）。

**错误码**：`GROUP_PARENT_UNREACHABLE`（502）、`GROUP_SYNC_REJECTED`、`GROUP_RATE_LIMITED`（429）、`GROUP_NONCE_REPLAY`（409）

**E-4 父节点降级（M16-7e）**：
- `sync_tier=unsynced` 时 **始终直连群主** `owner_worker_b_url`（不再问 relay 父节点）。
- `sync_tier=active` 且父节点 **连续 2 次** sync 失败（502 unreachable 或拒绝）→ 写 `group_sync_state.sync_tier=unsynced`、`parent_worker_b_url=owner`（Cron 下一周期走 unsynced 30min 兜底）。
- 群主 sync 成功且下行 `relay_tree` 重新纳入成员 → `applyGroupSyncDown` 恢复 `sync_tier=active` 与树内 `parent_worker_b_url`；`parent_sync_fail_streak` 清零。
- D1：`group_sync_state.parent_sync_fail_streak`（migration `0005`）。

### 内部 POST /groups/sync-with-parent（Service Binding + HMAC · M16-3）

Worker B `POST /groups/sync-with-parent` 转发入口。群主节点处理 seed/未同步成员 ack↑ 并返回权威消息/树/密钥↓；中间父节点处理直接子节点 sync。

**请求体**：`GROUP_SYNC_V1` 签名 JSON（含 `cursor`、`acks[]`、`heartbeat?`）

---

## Messaging Media（M16-0j · MM 计划 v1.3）

> SSOT：[`m10-p2-dm-media-plan.md`](./m10-p2-dm-media-plan.md) v1.3。E2EE 密文 blob；**不复用**公开帖 `POST /api/images`。

### PUT /api/messaging/media `[JWT]`

上传私信或群聊媒体密文（图片；**M10-P3** 起私信亦支持短语音 `audio/*`）。群聊语音不做。

**Query**：

| 参数 | 必填 | 说明 |
|------|------|------|
| `purpose` | 是 | `dm` \| `group` |

**请求头**：

| 头 | 说明 |
|----|------|
| `Content-Type` | `application/octet-stream` |
| `X-Hailuo-Plain-Mime` | 明文 MIME，如 `image/jpeg` / `audio/webm`（`purpose=dm` 时供 KV 路由） |
| `Content-Length` | B2/Filebase/R2 流式上传必填 |

**路由**：

- `purpose=dm`：`resolveUploadBackend`（含 KV 兜底；KV 允许 `image/*` 与 `audio/*`）
- `purpose=group`：`resolveMessagingCloudBackend`（**仅** filebase/b2/r2；满或 probe≠ok → **507** `GROUP_MEDIA_CLOUD_REQUIRED`，**禁止** fallback KV）

**成功响应**：

```json
{
  "ok": true,
  "data": {
    "storage_key": "b2:msg_…",
    "backend": "b2",
    "size_bytes": 102400,
    "media_id": "01J…"
  }
}
```

**错误码**：`GROUP_MEDIA_CLOUD_REQUIRED`（507）、`MESSAGING_MEDIA_TOO_LARGE`（400）、`MESSAGING_MEDIA_INVALID_PURPOSE`（400）、`MEDIA_STORAGE_FULL`（507）

### GET /api/messaging/cloud-capability `[JWT]`

```json
{
  "ok": true,
  "data": {
    "can_send_group_media": true,
    "can_mirror_group_media": true,
    "default_view_mode": "mirror",
    "max_bytes": 10485760,
    "max_per_message": 4
  }
}
```

`can_send_group_media=false` 时 UI 禁用群图发送；`default_view_mode=stream_only` 表示 KV-only（仅在线 proxy 看）。

### GET /api/messaging/media/:storage_key `[JWT]`

读本节点已登记 blob（含 mirror 副本）。registry 校验 key 属于本站主 DM/群会话。

### GET /api/messaging/media/proxy `[JWT]`

**浏览器远端读唯一入口**。Query：`message_id`、`media_id`、`conversation_id`（DM）或 `group_id`（群）。

本节点 Worker A：验本地消息行 → 签发 ticket → fetch 发送方 Worker B `/dm/media/:key` 或 `/groups/media/:key` → 流式返回密文。

响应头：`Cache-Control: private, no-store`；`Content-Type: application/octet-stream`。

**禁止**向 Web 返回发送方 Worker B 直链。

### DELETE /api/messaging/media/:storage_key `[JWT]`

释放本节点对象；`decrementUsage`；手动删发送方群图时响应含警告字段 `warn_remote_viewers: true`。

### POST /api/dm/media/fetch-ticket `[JWT]`

Body：`{ "message_id", "media_id", "conversation_id", "sender_storage_key" }`。  
签发 `DM_MEDIA_FETCH_TICKET_V1`（TTL ≤5min），供本节点 server-side fetch / proxy 使用。

### POST /api/groups/media/fetch-ticket `[JWT]`

Body：`{ "group_id", "message_id", "media_id", "sender_storage_key", "sender_worker_b_url" }`。  
签发 `GROUP_MEDIA_FETCH_TICKET_V1`。

### Cron：私信保留清理（M10-3）

Worker A 既有 `minute % 5 === 0` Cron 分支执行：

- 读取 `system_config.dm_retention_days`（默认 180），删除过期 `dm_messages`。
- 删除无剩余消息的 `dm_wrapped_keys`（孤儿清理；若用户删光消息后很快用同一 `conversation_id` 重发，极端竞态下可能清掉旧包裹密钥，浏览器需重新协商会话密钥，后果可恢复）。
- 删除 `created_at` 早于保留 cutoff 再减 7 天的 `dm_nonces`。
- 清理 48 小时前的 `dm_rate_buckets` 行。
- 各步 fail-soft：D1 无跨表事务，某步失败时 `gcDmRetention` 返回 `errors[]` 与已完成的删除计数，Cron 日志可排障。

### 改密与私信 re-wrap（M10-3）

`POST /auth/change-password` 成功响应增加 `requires_dm_key_rewrap: boolean`：当 D1 存在 `dm_wrapped_keys` **或** `dm_wrapped_identity` 时为 `true`，提示浏览器须用旧密码 unwrap 全部会话密钥与身份私钥后用新密码 re-wrap 并 `PUT` 对应端点（Worker 无法代劳，KEK 仅在浏览器）。

## 黑名单接口（M6-1 + M6-3 + M6-4）

挂在 `/api/blacklist/*`，**全部 JWT 鉴权**（站主才能管理黑名单）。

**生效链路**（M6-0 / M6-0a / M6-1 / M6-3 / M6-4 协同闭环）：
1. 本端点写 D1 `blacklist` 表（POST / DELETE），**同事务内** 把 `system_config.blacklist_dirty='true'`（`DB.batch` 单事务，PK 冲突回滚不污染 dirty 标志）
2. M6-3 Cron `syncBlacklistToKvIfDirty` 每 5 分钟（`* * * * *` 触发、`minute % 5 === 0` 分支）读 dirty 标志：
   - `'false'` → 仅 1 次 D1 SELECT 即返回，零 KV 写
   - `'true'` → 全量 SELECT D1 + KV LIST `prefix='blacklist:'` 算 diff（含 `blacklist:local:` 写入与遗留 `blacklist:https://` 键 best-effort 清理）→ `Promise.allSettled` 批量 put/delete → 整批成功才清 dirty + 更新 `blacklist_last_sync_at`；部分失败保持 `'true'` 下次重试至最终一致
3. M6-0 内部签发端点 `POST /api/follower-tokens` 签发前先查 D1 黑名单 → 命中即返 403 `BLACKLISTED`（**即时阻断新 token 签发，0 延迟**）
4. M6-0 Worker B `requireFollowerToken()` 中间件按序读 `blacklist:local:<sub>` → `blacklist:registry:<sub>` → 遗留 `blacklist:<sub>` → 任一命中即返 403 `BLACKLISTED`（**吊销已签 token**；本地拉黑最长约 5 分钟；注册中心全局封禁随 **daily-sync** 更新，最长约 24h + 调度延迟）
5. **M9-13**：POST/DELETE 成功后 `waitUntil(triggerBlacklistImmediateSync)` → Worker A 经 `WORKER_B` Service Binding 调 Worker B `/internal/blacklist-sync` 写 `STATE_KV`（**仅 `blacklist:local:` 前缀**）；失败时 dirty 保持 `true` 由 M6-3 Cron 补偿。管理 UI 须提示：「公开读层封禁即时生效依赖即时同步；仅 Cron 时最长约 5 分钟」
6. **M6-4**：注册中心全局黑名单由 **`POST /api/node/daily-sync` 响应块** `applyRegistryBlacklistFromDailySync` 落库（不再单独整点 `GET /api/blacklist` Cron）。`system_config` 键：`blacklist_remote_etag`、`blacklist_remote_last_sync_at`（migration `0032_registry_blacklist_sync.sql`）

**与 `revoked_tokens` 表的关系**：M6-0 follower token 的 `sub = follower_node_url`（节点维度），Worker B 直接按 sub 查 STATE_KV，无需枚举单个 token_hash。因此本接口只写 `blacklist` 表，不操作 `revoked_tokens`（后者当前仅服务站主 JWT 吊销，见 M2-1）。

**KV 写预算**：dirty 节流确保只在 D1 实际变更后才触发 KV 写；注册中心黑名单经 daily-sync 约 1 次/天拉取，304/unchanged 时不写 KV。Free Tier 1000 写/天上限远超典型站点需求。

**M6-3 部署提示**：本节点首次部署 M6-3 时必须先跑 `wrangler d1 migrations apply DB --remote --config apps/worker-a/wrangler.toml` 套用 `0009_blacklist_sync.sql` 初始化两行 `system_config`（`blacklist_dirty='false'` + `blacklist_last_sync_at=''`），否则 cron 首次读 dirty 会取到 NULL 而早返回，但 POST/DELETE 路径的 `UPDATE` 也将不修改任何行 → 黑名单写 D1 后永不同步到 KV。

**M6-4 部署提示**：在 M6-3 已 apply 的前提下，再 apply `0032_registry_blacklist_sync.sql` 初始化 `blacklist_remote_etag` / `blacklist_remote_last_sync_at`。节点须已在注册中心登记且 D1 有有效 `node_api_token`（`registryFetch` 才能拉 `/api/blacklist`）。注册中心侧须 apply migration `0024_node_blacklist.sql` 并部署 M24-1 gateway。跨仓计划见 [`m6-4-registry-blacklist-plan.md`](./m6-4-registry-blacklist-plan.md)。

### POST /api/blacklist

封禁一个粉丝节点。

**请求**：
```json
{ "node_url": "https://bob-worker-b.workers.dev", "reason": "垃圾内容" }
```

字段：
- `node_url`（必填，string）：被封禁节点的 Worker B 地址，必须以 `https://` 开头
- `reason`（可选，string，≤ 200 字符 Unicode 码点）：封禁原因，留空发 `""`

**响应**（200）：
```json
{
  "ok": true,
  "data": {
    "node_url": "https://bob-worker-b.workers.dev",
    "reason": "垃圾内容",
    "created_at": "2026-01-02T03:04:05.678Z"
  }
}
```

**错误码**：
- `INVALID_BODY`（400）：请求体非 JSON
- `NODE_URL_REQUIRED`（400）：`node_url` 缺失或空白
- `NODE_URL_INVALID`（400）：`node_url` 不以 `https://` 开头
- `CANNOT_BLACKLIST_SELF`（400）：尝试拉黑本节点自己（与 `WORKER_B_URL` 相同）
- `REASON_INVALID`（400）：`reason` 字段类型不为字符串
- `REASON_TOO_LONG`（400）：`reason` 超过 200 字符（Unicode 码点）
- `ALREADY_BLACKLISTED`（409）：该节点已在黑名单中（D1 PK 冲突）
- `BLACKLIST_FULL`（409）：黑名单条目数已达上限（默认 1000）
- `BLACKLIST_INTERNAL`（500）：D1 写失败

---

### DELETE /api/blacklist/:nodeUrl

解封一个节点。`:nodeUrl` 必须 URL-encoded（如 `https%3A%2F%2Fbob-worker-b.workers.dev`）。

**响应**（200）：`{ "ok": true }`

**错误码**：
- `BLACKLIST_NOT_FOUND`（404）：该节点不在黑名单中
- `BLACKLIST_INTERNAL`（500）：D1 删失败

---

### GET /api/blacklist

获取本节点黑名单全量列表（按 `created_at DESC` 倒序）。

**响应**（200）：
```json
{
  "ok": true,
  "data": {
    "items": [
      { "node_url": "https://bob-worker-b.workers.dev", "reason": "垃圾内容", "created_at": "2026-01-02T03:04:05.678Z" }
    ],
    "total": 1
  }
}
```

**错误码**：
- `BLACKLIST_INTERNAL`（500）：D1 查询失败

---

## Worker A Cron 调度（M9-22 · M13-2 · M-DS · M-DS-V2）

> 部署错峰表见 [`deploy.md`](./deploy.md) §Cron；v2 调度 SSOT：[`m-ds-v2-daily-sync-schedule-plan.md`](./m-ds-v2-daily-sync-schedule-plan.md)。聚合语义 SSOT：[`m-ds-registry-daily-sync-plan.md`](./m-ds-registry-daily-sync-plan.md)。

### 单槽 `* * * * *` 与早退

Worker A 仅占用账号 **1 条** Cron（`wrangler.toml` `crons = ["* * * * *"]`）。`scheduled()` 内：

| 分支 | 条件 | 行为 |
|------|------|------|
| 每分钟 | 无条件（早退前） | `refreshPostsCacheIfDirty`；**presence** `maybeScheduleRegistryDailySync`（**R-MSG-2c：日常只跑 presence**） |
| D1 GC / 校准轮转 | UTC `minute` 0～5 + **7** | `runRotatedHourlyGc`（0～5 纯 D1 不占外部池；**7=`calibrate` 可能外部 HTTP，故避开 Feed**；M13-19/19b） |
| 重任务块 | `minute % 2 === 0` **或** `minute % 5 === 0` | `runCronBudgeted`（Feed / outbound / 探针 / 群任务等） |
| 早退 | `%2 !== 0` 且 `%5 !== 0` | 上述重任务不跑 |

所有 gate 使用 **UTC** `getUTCHours()` / `getUTCMinutes()`。

### daily_sync_v5 · 日常单通道（R-MSG-2c 现行）

> 全文 SSOT：[`r-msg-2a-channel-model-contract.md`](./r-msg-2a-channel-model-contract.md)。错峰 **salt 仍 `daily_sync_v4`**；响应 / `system_config.daily_sync_schedule_version` 为 **`daily_sync_v5`**。

**不再**挂在 `cronBudget` 的 `registry-daily-sync` / 周期 policy / 周期推荐任务。

**日常 — presence（`POST /api/node/daily-sync`）**

1. 读 `system_config.daily_sync_utc_second_of_day`；缺失则按 seed `computeDailySyncUtcSecondOfDay` **lazy backfill**。
2. 仅在 `isSyncDueOnUtcDay(seed, sync_interval_days)` 的周期日触发（默认 **30** 日）。
3. 命中分配 UTC 分钟后 `waitUntil(sleep → syncRegistryDaily)`；body 含 `channel: presence` + 可选三游标 `policy_etag` / `blacklist_etag` / `recommendations_etag`；**M34-3** 附带 `owner_activity_hint`。
4. 响应条件块：`unchanged` 轻块，或 `pull_hint`（`posts/feed` | `blacklist` | `recommendations/users`）→ **同 tick 辅拉**（不另开周期 Cron）。
5. 非 `force` 另受 **`sync_interval_days × 12h`** 成功节流（默认 360h）。
6. **M16-GROUP-LIFECYCLE-V2（11a/13/14 + 20）**：IDENTITY `node_sync_state` 缓存中心响应 `data.interval_days` → `config_interval_days`；有缓存才附带 `group_lifecycle` + 顶层 `body.interval_days`（**V2-20：两字段同生死**，任一缺失都不挂——`lifecycle=null` 时连 `interval_days` 也不挂）；`created[]` 按 `last_daily_sync_reported_at` 增量过滤（无锚点 fail-open 全量）；**V2-20**：`GROUP_LIFECYCLE_INTERVAL_MISMATCH` 时清缓存 + 写 `operation_log`（`event: 'group_lifecycle_interval_mismatch'`，`level: 'warn'`，含 `primary_id`），下次重学；`truncateNewestGroupLifecycleItems` 用 `Date.parse` 排序（V2-20：防 ISO 形态不一致 `…Z` / `…000Z` / `…+00:00` 字典序错位）。

**`node_sync_state`（IDENTITY_DB · migration `0100`）**

| 列 | 说明 |
|---|---|
| `user_id` | PK；`system_config.owner_user_id` |
| `last_daily_sync_reported_at` | 上次成功上报的 `group_lifecycle.computed_at`（秒级 ISO）；供增量过滤 |
| `config_interval_days` | 缓存中心 `data.interval_days`（30～90）；**不是** `sync_interval_days` |
| `updated_at` | 行更新时间 |

无 `config_interval_days` 时 presence 仍可跑，但 **omit** `group_lifecycle`（先学窗再报）。`sync_interval_days`（调度）与 `interval_days`（群号窗）分立，见 `dailySyncScheduleConfig.ts` 注释（V2-15）。

**停周期（routine）**：`maybeScheduleRegistryPolicyPoll` / `maybeScheduleRegistryRecommendations` 已 no-op，index **不再 await**。

**辅通道保留**：`GET /api/node/policy-digest`、`GET /api/blacklist`、`GET /api/posts/feed`、`GET /api/recommendations/users` — 仅 **force** / **pull_hint 同 tick** / **紧急 2e** 使用。

| `system_config` 键 | 说明 |
|---|---|
| `daily_sync_utc_second_of_day` | UTC 日内秒；登记 verify 写入或 backfill |
| `daily_sync_schedule_version` | **`daily_sync_v5`**（语义；错峰算法常量名仍 v4） |
| `sync_interval_days` | 默认 `30`（取值 30\|90；旧 1\|2\|3 迁移为 30） |
| `policy_poll_interval_days` | 兼容落库；**routine 不再用于 Cron 门闩** |
| `registry_policy_digest_etag` | 上次 policy ETag（presence 游标） |
| `blacklist_remote_etag` | 上次全局黑名单 ETag |
| `registry_recommendations_etag` | 上次推荐名单 etag |
| `registry_daily_sync_last_success_at` | presence 上次成功（节流） |

**登记**：verify 写入调度秒；完成后 **立即** `syncRegistryDaily({ force: true })`（presence + policy + 推荐）。

**手动**：`POST /api/local/registry-daily-sync/run`（`force: true`）= presence + 辅拉全量。

跨仓算法 fixture：`scripts/fixtures/daily-sync-schedule-v3.json`（内容为 v4 salt）。

### （历史）daily_sync_v4 双通道

v4 时代另有周期 `maybeScheduleRegistryPolicyPoll` / `maybeScheduleRegistryRecommendations`（约 N/7）。**R-MSG-2c 已拆除**；勿再按 N/7 计 routine 配额。

### `runCronBudgeted` 任务（M13-10）

| 任务 id | 触发 | 外部 fetch 估算 |
|---|---|---|
| `feed-aggregate` | `minute % 2 === 0` | ≤40；KV 指纹去重 |
| `group-sync` / outbox / mirror / 群 GC 等 | `isGroupExternalSlotMinute`（5/15/25/35/45，无 Feed） | 见各 task；专槽避免被 Feed defer |
| `retry-outbound` | `:05` `:35` | ≤3 |
| `probe-storage` | `:10` `:40` | ≤3 |
| `fof-recommendations-if-due`（**M17-4-2b**） | `:25`（`minute === 25`，亦属 `%5` 进块） | ≤10（采样 ≤5 好友节点拉 `/users/:handle/friends` + Token 重试；落库 GOVERNANCE `fof_recommended_users` ≤5 条；TTL 1h；`FOOF_RECOMMENDATIONS_ENABLED` 默认可关） |
| 其它 D1/KV 任务 | 多挂无 Feed 的 `%5` 分钟 | 0 |

官方公告 / **注册中心全局黑名单**主路径：**presence 条件块**（`pull_hint` 同 tick 辅拉）；全局黑名单**不要**再挂独立整点 GET Cron。搜人正式名：主中心裸名或 `handle@registry_id`，不支持 DID。

### 在线分层与站主 dormant 节能（M34）

> SSOT：[`m34-owner-engagement-plan.md`](./m34-owner-engagement-plan.md)。**M34-1 ✅** 会话表 + 心跳/登出；**M34-2 ✅** Cron dormant 跳过 `feed-aggregate` + Settings；**M34-2b ✅** 群义务 always；**M34-3 ✅** presence 上报 `owner_activity_hint`；**M34-4 ✅** Settings 最近登录设备 + 注销会话；**M34-4b ✅** 设备名=系统·脱敏 IP + Gateway 转发 UA；**M34-5 ✅** JWT 有效时旧 session 心跳自愈重开 + Web 页面进入/可见补心跳。

**两层在线（`OnlineStatus[]`）**：

| `layer` | 含义 | 判定 |
|---------|------|------|
| `worker` | 节点基础设施在线 | Worker A/B `/health` + 注册中心 presence（daily-sync） |
| `owner_browser` | 站主浏览器会话在线 | JWT + `POST /auth/session/heartbeat` 窗口内 `last_seen_at` |

**站主 `dormant`（未登录浏览器）时 Cron 节能（M34-2 ✅ / M34-2b 纠偏）**：默认 **跳过** `feed-aggregate`（不主动拉关注节点帖子）；`url-change-notify` 为 `active_only`；`probe-storage` dormant 降为每 6h。**不跳过** presence（R-MSG-2c）、D1 GC；**不跳过** 群 `group-sync-batch` / `group-outbox-retry` / `group-media-mirror-retry`（群成员发信与 sync 义务，与浏览器是否打开无关）；DM/群 **被动收件** 不变。粉丝读 Worker B `/feed` 仍用已有 KV 缓存（可能变陈旧直至站主再次登录或 `POST /api/local/feed-aggregate/run`）。

env：`OWNER_SESSION_TTL_SEC`（默认 300）；`OWNER_DORMANT_FEED_POLICY=skip|slow|normal`（默认 `skip`，M34-2 生效）。登录审计表 `owner_sessions` / `owner_login_events`（D1 only，IP 哈希存储）。

**M34-3 · 注册中心双态**：`buildDailySyncPostBody` 附带 `owner_activity_hint`；注册中心写入 `users.owner_engagement` + **双槽位** `owner_last_online_at` / `owner_last_offline_at`（每用户最多两条、同槽覆盖、非累计；M34-3b），**仅** `/admin/api/users*` 可见，**禁止**进入 `GET /lookup`。

---

## 监控接口

### GET /api/metrics

查看资源用量统计。

**响应**：
```json
{
  "ok": true,
  "data": {
    "requests_today": 42,
    "kv_writes_today": 5,
    "d1_writes_today": 30,
    "follows_count": 12,
    "posts_count": 100,
    "quota_utilization": {
      "requests": "0.04%",
      "kv_writes": "0.5%"
    }
  }
}
```

---

## 通用错误响应格式

```json
{ "ok": false, "error_code": "XXX_YYY", "message": "中文错误描述" }
```

## 加好友接口（M17-1 · 设计定稿 v1.2）

> Worker A 只保存 `friend_requests` 状态机、本地副本 + `local_notifications` 通知行；
> 不接受明文附言、对方私钥或其它节点直连。外部节点投递必须先到对方 Worker B `POST /friend-requests/inbox`，
> 再由 Worker B 通过 Service Binding + HMAC 转发到本节内部端点。站主 Web 走 Pages Functions / Owner Gateway 同源入口（同 `dm.ts` 模式）。

跨节点 envelope：`HAILUO_FRIEND_REQUEST_V1\n{method} {path}\n{ts}\n{nonce}\n{body_sha256_hex}`，Ed25519 sign/verify，5 分钟窗口；详见 [`apps/worker-a/src/lib/friendRequestEnvelope.ts`](../apps/worker-a/src/lib/friendRequestEnvelope.ts)。

envelope body：

- `POST /friend-requests/inbox`（origin → target）：`{ request_id, origin:{ node_url, handle, display_name?, avatar_key?, pubkey }, target:{ node_url, handle }, message?, nonce, sig, ts }`
- `POST /friend-requests/outbox`（target → origin）：`{ request_id, status: 'accepted' | 'rejected', actor:{ node_url, handle, pubkey }, nonce, sig, ts }`

错误码（plan §5.6）：`FRIEND_REQUEST_NOT_FOUND` / `NOT_RECIPIENT` / `NOT_ORIGIN` / `ALREADY_RESOLVED` / `ALREADY_FOLLOWING` / `FRIEND_REQUEST_SELF` / `BLACKLISTED` / `RATE_LIMITED` / `INCOMING_DISABLED` / `FRIEND_REQUEST_INVALID_PARAMS` / `FRIEND_REQUEST_INVALID_SIG` / `FRIEND_REQUEST_REPLAY`。

> **M17-FIX-4 breaking**：原 `ALREADY_FRIENDS`（409）已更名为 `ALREADY_FOLLOWING`——语义为「本端 `follows` 已有对方行」（单边），**不是**互粉确认。

### 站主端（`[JWT]` · M17-1e ✅ 已落地）

- `GET /api/friend-requests?direction=incoming|outgoing&status=pending&limit=20&cursor=` — 列请求（`FRIEND_REQUEST_INVALID_PARAMS` 400）
  - **REL-FIX-4**：列表行额外带 `inbox_status` / `inbox_error` 两个**发起侧投递回执**字段（`direction=outgoing` 才有意义；`incoming` 恒为 `''`）。
    - `inbox_status`：`''`（未投递 / 投递中）· `'acked'`（对端已收下，确定送达）· `'pending_retry'`（投递失败，cron 24h 内重投）· `'giveup'`（超 24h 放弃，对方大概率从未收到）。
    - `inbox_error`：最近一次投递失败的**脱敏短码**（`INCOMING_DISABLED` / `BLACKLISTED` / `RATE_LIMITED` 等；不含 URL / 邮箱 / IP 原文）。
  - **旧库降级**：CONTENT_DB 未 apply migration `0061`/`0062`（缺列）时，列表**不 500**，回落基础列查询并把两字段返回空串（= 未知，**不谎报 `acked`**）。前端按"未确认送达"呈现。
  - 用途：站主可感知"对方到底收没收到"，`giveup` 时给出可行动提示 + 重新发起入口（`web/src/components/FriendDeliveryBadge.tsx`）。
  - **REL-FIX-11**：列表行额外带 `outbox_status` / `outbox_error` 两个**接收侧回执**字段（`direction=incoming` 才有意义；`outgoing` 恒为 `''`）。
    - `outbox_status`：`''`（回执投递中 / 初始）· `'acked'`（发起方已确认收到回执，对方知道结果了）· `'pending_retry'`（回执投递失败，cron 24h 内重投）· `'giveup'`（超 24h 放弃，**发起方很可能仍在干等**）。
    - `outbox_error`：最近一次回执投递失败的**脱敏短码**（`INCOMING_DISABLED` / `BLACKLISTED` / `RATE_LIMITED` 等；不含 URL / 邮箱 / IP 原文）。
    - 与 `inbox_status` **严格对称**：`inbox_status` 回答「我发的请求，对方收没收到」；`outbox_status` 回答「我回的结果，对方知不知道」。
  - **REL-FIX-11**：`status` 过滤新增 `'resolved'` 模式 —— **已处理但回执未确认送达对方**（`status IN ('accepted','rejected') AND COALESCE(outbox_status,'') != 'acked'`）。
    - **只允许 `direction=incoming`**：发起方行的 `outbox_status` 语义不同（只记录「撤回通知有没有送到对端」），拿它判断「对方知不知道结果」会**撒谎** → 传 `direction=outgoing&status=resolved` 显式返 `400 FRIEND_REQUEST_INVALID_PARAMS`，**不静默给错数据**。
  - **REL-FIX-11**：响应 `data` 额外带 `pending_count`（该方向的 `status='pending'` 行数；纯 D1 `COUNT(*)` 读，**零 KV 写**）—— 未读角标数据源（对齐 REL-FIX-5 群主待审批角标做法）。统计失败 fail-soft 返 `0`。
  - **旧库降级（REL-FIX-11 扩）**：缺 `inbox_status` / `inbox_error` / `outbox_error` 任一列时（未 apply `0061`/`0062`/`0063`）走同一降级路径，列表**不 500**；`outbox_status` 属基础列（`0060`）仍能取到 → 「已处理但回执未确认」这一维度在旧库上依然可用，只是拿不到失败短码。
  - 用途（接收侧）：接收方可感知"我回的结果，对方知不知道"，`giveup` 时给出可行动提示（`web/src/components/FriendReceiptBadge.tsx`）。
- `POST /api/friend-requests` body=`{ target_node_url, target_handle, message? }` — 发起（本地 INSERT + `waitUntil` 投递对端 Worker B `/friend-requests/inbox`；`FRIEND_REQUEST_SELF` / `ALREADY_FOLLOWING` / `BLACKLISTED` / `RATE_LIMITED` / `FRIEND_REQUEST_INVALID_PARAMS`）
- `POST /api/friend-requests/:id/accept` — 接受（本地写 follows + `waitUntil` 投递对端 `/friend-requests/outbox`；`FRIEND_REQUEST_NOT_FOUND` / `NOT_RECIPIENT` / `ALREADY_RESOLVED`）
- `POST /api/friend-requests/:id/reject` body=`{ reason? }` — 拒绝（同上错误码 + `waitUntil` outbox）
- `DELETE /api/friend-requests/:id` — 撤回（仅 origin；本地 `status=cancelled` 后 `waitUntil` 投递 `status=cancelled` outbox → target；对端写 `friend_request_cancelled` 通知；`NOT_ORIGIN` / `ALREADY_RESOLVED`）
  - **REL-FIX-11**：撤回成功后**本端**额外写一条 `friend_request_withdrawn` 本地通知（fail-soft，不阻断撤回主流程）—— 撤回后该行从 `pending` 列表消失，若无此通知，站主回头完全看不到「我撤回了没」「对方知不知道我撤回了」。通知 `request_id` 直达通讯录面板对应行（前端深链 `/messages?tab=contacts&request=<fr_id>`）。

路由：`apps/worker-a/src/routes/friend-requests.ts`；JWT 挂载须同时覆盖精确路径与 `/*`（Hono `/*` 不匹配精确 `/api/friend-requests`）。跨节点投递 helper：`lib/friendRequestDelivery.ts`。

### 跨节点接收方（`/friend-requests/inbox`，Service Binding + HMAC · M17-1e ✅ 已落地）

收件方 Worker B 的公开 `POST /friend-requests/inbox` 通过 Service Binding 转发到本端点，并携带 `X-Internal-Forward: hmac-v2` + `X-Timestamp` + `X-Nonce` + `X-Signature`。Worker A 用 `INTERNAL_FORWARD_SECRET` 绑 method/path/body 验 HMAC；缺失或不符返回 `INTERNAL_FORWARD_REJECTED`（403）。逻辑层走 `friendRequestInbox.ts`：JSON parse → 时间窗口 → Ed25519 envelope 验签（用 envelope.origin.pubkey）→ target_node_url 须命中本机别名（REL-FIX-2：match 归一 + `resolveLocalNodeUrlAliases` 成员判定；canonical/users/env/旧址宽限/D1 entry；落库仍原文归一）→ 黑名单门控（本地 blacklist 表）→ `system_config.friend_requests_inbox_enabled` 开关（默认开）→ inbox 频控 100/h/源节点 → pending UNIQUE 索引幂等 → INSERT friend_requests（status='pending'，**SEC-AUDIT-2026-10-14**：同步落库申请里的 `origin_pubkey`。**NCF-SEC-BIND-1**：本地尚无 Pin 时，接受前必须取对端公开档案，公钥一致才写入 `follows.followed_pubkey`；不一致或对端不可达则拒绝接受，不把申请里的公钥钉进去）→ 写 `local_notifications`（`friend_request_received`）。

路由：`apps/worker-a/src/routes/friend-requests-internal.ts`（不挂 JWT）。

### 跨节点状态回报（`/friend-requests/outbox`，Service Binding + HMAC · M17-1e ✅ 已落地）

发件方 Worker B 的公开 `POST /friend-requests/outbox` 通过 Service Binding 转发到本端点，同样携带 HMAC v2 头。逻辑层走 `friendRequestOutbox.ts`：JSON parse → 时间窗口 → Ed25519 envelope 验签 → 查找本地 friend_requests 行。**`accepted` / `rejected`**（target→origin）：actor 须等于该行 target；幂等后 accepted 双写 follows + `friend_request_accepted`，rejected 写 `friend_request_rejected`。**`cancelled`（M17-4-1，origin→target）**：本站须为该行 target，actor 须等于 origin；pending→cancelled + 写 `friend_request_cancelled` 通知。

### 站主开关（`/api/node-settings/friend-requests` · M17-2 ✅ 已落地）

- `GET /api/node-settings/friend-requests` → `{ allow_incoming: boolean }`（默认 `true`；D1 `system_config.friend_requests_inbox_enabled`）
- `PATCH /api/node-settings/friend-requests` body=`{ allow_incoming: boolean }` — 站主开关

路由：`apps/worker-a/src/routes/node-settings.ts`（既有 `nodeSettingsApp`）。

### 群号窗诊断（`GET /api/node-settings/group-lifecycle` · V2-20 ✅ 已落地）

- 鉴权：站主 JWT（既有 `nodeSettingsApp` 父中间件）。
- 响应 `{ has_owner, config_interval_days, last_daily_sync_reported_at }`：
  - `has_owner=false` → 未登记站主（无 `system_config.owner_user_id`）
  - `config_interval_days=null` → **omit 中**（未学中心值；下次 presence 200 后学）
  - `config_interval_days=30..90` → 中心当前窗基数（`IDENTITY.node_sync_state.config_interval_days`）
  - `last_daily_sync_reported_at=null` → 从未带块上报过
  - `last_daily_sync_reported_at=ISO` → 上次成功上报的 `group_lifecycle.computed_at`（增量锚点）
- 用途：站主在 Settings 看到"中心窗长已变 → 我本地已清"等状态；运营排障 `INTERVAL_MISMATCH` 触发的 `operation_log`（`event: 'group_lifecycle_interval_mismatch'`）时同端点对账。
- 路由：`apps/worker-a/src/routes/node-settings.ts`（`getConfigIntervalDays` / `getLastDailySyncReportedAt` / `readOwnerUserId`），**无新 binding**。

### 好友列表（`GET /api/local/mutual-follows` · M17-2 ✅ 已落地）

站主 JWT。返回 `{ items: [{ node_url, handle, display_name, avatar_key, request_id, accepted_at }] }`：本端 `friend_requests.status='accepted'`（己方为 origin 或 target）且本地 `follows` 仍有对应行。解除好友走既有 `DELETE /api/follows/:nodeUrl`（不改状态机历史）。

路由：`apps/worker-a/src/routes/local-reads/mutual-follows.ts`；Owner Gateway allowlist exact `GET /api/local/mutual-follows`。互粉权威查询封装于 `lib/mutualFriendsProjection.ts`（与 M17-4-2a 公开投影同源）。

> **M17-4-3**：Timeline「好友」tab **无独立 Worker A 列表端点**——前端对关注流按本接口 `node_url` 过滤（`web/src/lib/friendsFeed.ts`）。

> Owner Gateway / Pages `_owner-allowlist.js` 已放行本路径（M17-1f）；Worker A handler 与 Settings UI 随 M17-2 落地。

### 内部互粉投影（`GET /internal/users/:handle/friends` · M17-4-2a）

**仅** Worker B Service Binding + `INTERNAL_FORWARD_SECRET`（HMAC v2）。公开入口见 `docs/worker-b-api.md` `GET /users/:handle/friends`。

- `:handle` 须等于本站站主 handle（大小写不敏感），否则 `404 USER_NOT_FOUND`
- `limit`：查询参数或头 `X-Hailuo-Friends-Limit`，clamp 1～20（默认 20）
- 返回 `{ handle, items:[{ handle, node_url, display_name }], limit }`；**无** pubkey / email / avatar / request_id
- 语义：`friend_requests.status='accepted'` ∩ 本地 `follows`（与 mutual-follows 同源）

路由：`apps/worker-a/src/routes/internal-friends-projection.ts`。

**跨节点联调（M17-3）**：`npm run smoke:m17-3`（env 双节点：发起 → 同意 → 互粉 → `POST /api/dm/send-ticket` 门控 → 取关再 `DM_NOT_MUTUAL`）；契约 `npm run test:m17-3`。运维见 [`deploy.md`](./deploy.md)「加好友 friend-requests（M17-3）」。

**跨节点 outbox 真投递（M17-FIX-1 ✅ 已落地）**：`deliverStatusOutbox`（`apps/worker-a/src/routes/friend-requests.ts`）在 accept/reject 时不再 early-return；走 fetch target 公开档案（`apps/worker-a/src/lib/friendRequestOutboxFetcher.ts` 走 Worker B `GET /users/:handle`，仅取 pubkey/display_name/avatar_key/handle 四字段，**不缓存**到 STATE_KV 防身份关联留痕）→ 构造含 `display_name?` / `avatar_key?` 可选字段的 outbox envelope → `deliverFriendRequestOutboxToOrigin` → 写 `friend_requests.outbox_status`：成功 `'acked'`、失败 `'pending_retry'`。Origin 端 `applyFriendRequestOutbox` accepted 分支 INSERT follows 时带回 `actor.handle` / `display_name` / `avatar_key`（修复前 P1-2 三个展示字段全空 → `mutual-follows` 列表 `display_name` 为空）。

**outbox_status 三态**（`friend_requests.outbox_status`）：

| 字面 | 含义 |
|------|------|
| `''` | 初始 / 未处理 |
| `'acked'` | origin 端已收到对端 accept/reject 回报（D1 写完成） |
| `'pending_retry'` | 投递失败（fetch target 不可达 / 对端拒绝 / 异常）待 cron 兜底 |
| `'giveup'` | `gcFriendRequestOutbox` 兜底超 24h 未投递 — 标记放弃 |

> **M17-4-1**：撤回不再把 `outbox_status` 写成 `'cancelled'`。`friend_requests.status='cancelled'` 表示业务态；投递态仍走 `''` → `acked` / `pending_retry` / `giveup`（`deliverCancelOutbox` origin→target）。

**outbox 重试兜底（`friend-request-outbox-gc` · REL-FIX-1）**：复用 M17-1g 的 `friend-request-gc` 任务槽位（不增 Cron 槽），同 `isGroupExternalSlotMinute`。`gcFriendRequestOutbox` 扫 `outbox_status='pending_retry'` + `status ∈ (accepted,rejected,cancelled)`：超 24h → `'giveup'`；窗内按批 **真重投**（`lib/friendRequestOutboxDeliver.ts` 的 `deliverStatusOutbox` / `deliverCancelOutbox`，重建 ts/nonce）。失败刷 `outbox_last_retry_at` 沉队尾（不动 `updated_at`）。日志含 `outbox_scanned` / `outbox_acked` / `outbox_given_up` / `outbox_errors`。

**跨节点 inbox 投递跟踪（M-F3 ✅ / M-F3b ✅）**：发起端 `deliverOriginInbox` 成功写 `inbox_status='acked'`，失败写 `pending_retry` + `inbox_error`（短错误码，不含 URL/邮箱）。migration `0061` 加 `inbox_status` / `inbox_error`；**M-F3b** migration `0062` 加 `inbox_last_retry_at`（破队头阻塞：失败重试刷本列、不动 `updated_at`，扫描按 `COALESCE(NULLIF(inbox_last_retry_at,''), updated_at) ASC`）。

**inbox_status 四态**（与 outbox 对称）：`''` 初始 / `'acked'` 对端已收 / `'pending_retry'` 待重试 / `'giveup'` 超 24h 放弃。

**inbox 重试兜底**：同槽 `gcFriendRequestInbox`——窗内最多 10 条/tick 重建 envelope 重投；窗外写 `giveup`。日志含 `inbox_scanned` / `inbox_acked` / `inbox_given_up` / `inbox_errors`。

### Cron：加好友保留清理与双写 Repair（M17-1g ✅ 已落地）

Worker A `cronBudget` 任务 `friend-request-gc` 挂在群专槽 `isGroupExternalSlotMinute`（`minute % 5 === 0 && minute % 2 !== 0`，即 5/15/25/35/45，与 DM GC 同槽、不占新 Cron）：

- `expireOldFriendRequests`：`pending` 且 `created_at` 早于 now−30d → `status='expired'`（JS ISO bind，禁 SQL `datetime('now')`）
- `repairFriendRequestFollows`：本端 `accepted` 行缺本地 `follows` → `INSERT OR IGNORE`（origin / target 各扫一批，上限 `FRIEND_REQUEST_REPAIR_BATCH=50`）；**rejected 不写 follows，不做 Repair**
- `gcFriendRequestRateBuckets`：清 48h 前频控桶（表未建 fail-soft）
- `gcFriendRequestOutbox`：outbox pending_retry 超窗 giveup
- `gcFriendRequestInbox`（M-F3）：inbox pending_retry 窗内重投 / 超窗 giveup
- 各步 fail-soft；有变更或错误时打 `[cron/gc] friendRequestRetention` 日志

lib：`apps/worker-a/src/lib/friendRequestRetention.ts`。

## 关注接口补充：展示资料字段

`POST /api/follows` 仍以 `node_url` 作为关注关系的权威键。前端从搜索或推荐入口关注时，可额外提交可选 `profile`，用于关注管理页展示：

```json
{
  "node_url": "https://bob-worker-b.workers.dev",
  "profile": {
    "handle": "bob",
    "display_name": "Bob",
    "avatar_key": "kv:img_xxx",
    "worker_b_url": "https://bob-worker-b.workers.dev",
    "pubkey": "efddce494f32e7e8bad0c7fac2c8ab916dec363616754b09cf4d732247bf3f2a"
  }
}
```

成功响应与 `GET /api/follows` 的 `items[]` 均包含：

```json
{
  "id": "follow_xxx",
  "node_url": "https://bob-worker-b.workers.dev",
  "handle": "bob",
  "display_name": "Bob",
  "avatar_key": "kv:img_xxx",
  "worker_b_url": "https://bob-worker-b.workers.dev",
  "pubkey": "efddce494f32e7e8bad0c7fac2c8ab916dec363616754b09cf4d732247bf3f2a",
  "followed_at": "2026-06-19T04:00:00.000Z",
  "last_active": null,
  "fail_count": 0
}
```

旧关注记录若没有资料字段，`GET /api/follows` 会尝试从本地 `cache_entries.response_json`（lookup 缓存）按 `node_url / worker_b_url` 回填 `handle` 等展示字段；仍未命中时返回空字符串，由前端显示默认头像与「未命名节点」。

**换域（M7-30d）**：confirm **不会**改写 `follows` 行。被关注节点换域后需取关旧 URL 再关注新 URL；lookup 缓存 stale 时见 [`m7-30d-url-change-follows-cache.md`](./m7-30d-url-change-follows-cache.md)。

## 错误码汇总

### Worker A 本地错误码

| 错误码 | HTTP 状态 | 含义 |
|---|---|---|
| `UNAUTHORIZED` | 401 | 未登录或 JWT 无效/过期 |
| `AUTH_INVALID` | 401 | 登录凭证错误 |
| `FORBIDDEN` | 403 | 无权限操作 |
| `BLACKLISTED` | 403 | 节点在黑名单中 |
| `POST_NOT_FOUND` | 404 | 帖子不存在 |
| `CONTENT_REQUIRED` | 400 | 内容不能为空 |
| `CONTENT_TOO_LONG` | 400 | 内容超过 500 字符 |
| `INVALID_BODY` | 400 | 请求体必须为 JSON |
| `IMAGE_KEY_INVALID` | 400 | 无效的图片 key（仅允许 kv:img_/r2:img_/b2:img_ 前缀） |
| `ALREADY_FOLLOWING` | 409 | 已关注 |
| `FOLLOW_NOT_FOUND` | 404 | 未关注该节点或不存在 |
| `NODE_URL_REQUIRED` | 400 | node_url 不能为空 |
| `NODE_URL_INVALID` | 400 | node_url 必须以 https:// 开头 |
| `CANNOT_FOLLOW_SELF` | 400 | 不能关注自己 |
| `FOLLOW_INTERNAL` | 500 | 关注/取关操作失败（服务器错误） |
| `FOLLOW_LIMIT_EXCEEDED` | 400 | 超过关注上限 |
| `INTERNAL_ERROR` | 500 | 服务器内部错误（通用） |
| `REGISTRY_UNAVAILABLE` | 502 | 注册中心不可达（上游转发失败） |

### 注册中心错误码（Worker A 透传）

| 错误码 | HTTP 状态 | 含义 |
|---|---|---|
| `REGISTER_BAD_REQUEST` | 400 | 参数格式错误 |
| `REGISTER_EMAIL_REQUIRED` | 400 | 缺少 email |
| `REGISTER_EMAIL_INVALID` | 400 | email 格式非法 |
| `REGISTER_EMAIL_VERIFY_TOKEN_REQUIRED` | 403 | 缺少 email_verify_token |
| `REGISTER_EMAIL_VERIFY_TOKEN_INVALID` | 403 | email_verify_token 无效/过期/已消费 |
| `REGISTER_TURNSTILE_REQUIRED` | 403 | 缺少 turnstile_token（生产） |
| `REGISTER_TURNSTILE_INVALID` | 403 | Turnstile 校验失败 |
| `REGISTER_HANDLE_CONFLICT` | 409 | handle 已被注册或有活跃 challenge |
| `REGISTER_NODE_URL_CONFLICT` | 409 | node_url 冲突 |
| `REGISTER_EMAIL_CONFLICT` | 409 | email 冲突 |
| `REGISTER_CHALLENGE_NOT_FOUND` | 404 | challenge_id 不存在 |
| `REGISTER_CHALLENGE_CONSUMED` | 409 | challenge 已被消费（非 pending 状态） |
| `REGISTER_EXPIRED` | 410 | challenge 已过期 |
| `REGISTER_PUBKEY_INVALID` | 401 | pubkey 格式无效 |
| `REGISTER_SIGNATURE_INVALID` | 401 | Ed25519 签名校验失败 |
| `REGISTER_NODE_URL_VERIFY_FAILED` | 502 | 注册中心回访 node_url proof 失败 |
| `REGISTER_INTERNAL` | 500 | 注册中心内部错误 |
| `LOOKUP_NOT_FOUND` | 404 | handle 不存在 |
| `LOOKUP_REGISTRY_QUOTA_EXCEEDED` | 429 | 本节点今日 lookup 注册中心次数达上限（`REGISTRY_LOOKUP_DAY_LIMIT`，默认 **10**，M-OPT-1qn）；L1（follows / `cache_entries`）命中仍可用 |
| `LOOKUP_INTERNAL` | 500 | lookup 内部错误 |
| `NODE_TOKEN_MISSING` | 401 | 缺少 Authorization header |
| `NODE_TOKEN_REVOKED` | 401 | token 已吊销 |
| `NODE_TOKEN_INVALID` | 401 | token 无效 |
| `NODE_HEALTH_INTERNAL` | 500 | health 上报内部错误 |

---

## 多注册中心有序列表（M9-3，M9-3-0 契约 + M9-3-1～8 实装）

> **状态**：节点侧 **M9-3-1～8 ✅ 已实装**；注册中心侧对称契约见 `hailuo-registry/docs/registry-api.md` §M23。  
> **计划**：`docs/m9-3-multi-registry-plan.md`；联调前硬化见 `docs/m9-3-b-multi-registry-hardening-plan.md`

### 设计原则

| 原则 | 说明 |
|---|---|
| 追加不替换 | D1 `registry_endpoints` 为**有序数组**；`[0]` 为最早登记的主注册中心，新实例**尾部追加** |
| 主优先 failover | 按数组下标升序尝试；仅当当前候选通信失败时才尝试下一个 |
| 重试再切换 | 对**同一候选**：最多 **3 次**请求；失败后 **等待 3 秒**再试；3 次均失败才切下一个 |
| 每中心独立 token | 每个元素可有独立 `node_api_token` / `owner_user_id`；**禁止**用备用中心的 token 调用主中心 API |
| 冷启动兜底 | `env.REGISTRY_URL` 仅在 D1 无 `registry_endpoints` 时作引导；注册后以 D1 为权威 |
| 数量上限 | `registry_endpoints.length ≤ 5`（**M9-3-B1 ✅**：`add_registry` 超限时整次 apply 返回 `skipped` / `max_endpoints`，不写 D1） |

### D1 存储（`system_config`）

| Key | 类型 | 说明 |
|---|---|---|
| `registry_endpoints` | JSON 数组 | 有序端点列表（见下表） |
| `registry_directive_nonces` | JSON 字符串数组 | 已消费的 directive `nonce`（防重放）；建议保留最近 500 条 |

#### `RegistryEndpoint` 元素

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `registry_id` | string | ✓ | 注册中心实例 ID（全网唯一，由注册中心签发） |
| `registry_url` | string | ✓ | `https://` 根 URL，无尾斜杠 |
| `trust_pubkey` | string | ✓ | 该实例 Ed25519 公钥：32 字节 raw 的 base64（可含 padding） |
| `node_api_token` | string | | 在该中心登记后写入；`pending` 条目可无 |
| `owner_user_id` | string | | 同上 |
| `status` | enum | ✓ | `active` \| `pending` \| `unreachable` |
| `added_at` | string | ✓ | ISO 8601 UTC |
| `last_ok_at` | string | | 上次通信成功时间 |
| `last_fail_at` | string | | 上次通信失败时间 |
| `fail_streak` | number | ✓ | 连续失败次数，成功时归零 |

**STATE_KV 同步**（脱敏，供 Worker B / Web 只读）：`node:registry_endpoints` — 同上结构但**不得**含 `node_api_token`。

### `registryRouter` / `registryFetch` 行为（实装约束）

> **M9-3-3 ✅**：`apps/worker-a/src/lib/registryRouter.ts` 已实装 `registryRouterFetch`（3×3s cron / 2×2s sync、失败分类、endpoint 状态回写）。**M9-3-4 ✅**：`registryFetch` 委托 router；Cron 对每个 active endpoint 各报 health；登记 proxyPost 走 `resolvePrimaryRegistryUrl`。

```
resolveRegistryEndpoints(env):
  读 D1 registry_endpoints；若空则合成单元素 [{ registry_url: env.REGISTRY_URL, status: 'active', ... }]

registryFetch(env, path, opts, { targetRegistryId? }):
  candidates = 按 priority 排序的 endpoints（可选过滤 targetRegistryId）
  for endpoint in candidates:
    if 需要 token 且 endpoint 无 node_api_token → skip
    for attempt in 1..3:
      try fetch(endpoint.registry_url + path, 该 endpoint 的双头 + 节点 Ed25519 签名)
      if 2xx:
        更新 last_ok_at, fail_streak=0
        若响应含 directives + registry_signature → applyRegistryDirectives(...)
        return response
      if 不可重试(4xx 参数错误 / 本地签名失败) → throw
      if attempt < 3 → wait 3s
    标记 endpoint.status='unreachable'（或仅增 fail_streak），继续下一候选
  throw REGISTRY_ALL_UNAVAILABLE
```

#### 失败分类

| 类型 | 示例 | 行为 |
|---|---|---|
| 可切换 | 网络错误、超时、502/503/504 | 当前候选 3 次后试下一个 |
| 不切换 | 400、节点本地签名失败 | 立即失败 |
| 单端点配置 | 401 `NODE_TOKEN_INVALID`（该中心不认 token） | 标该 endpoint `pending` 或保留 `active` 仅记日志；**不**用其它中心 token 顶替 |

> Cron `waitUntil` 路径使用完整 3×3s；用户同步请求（如登记代理）可降为 2×2s，避免 UI 长时间阻塞。

#### outbound_events 审计（M9-3-8 ✅）

`outbound_events` 表（migration `0021`）追加：

| 列 | 说明 |
|---|---|
| `registry_id` | 本次通信成功的注册中心实例 ID |
| `router_attempts` | 最终成功 endpoint 上的尝试次数 |
| `router_detail` | failover / 重试摘要（如 `primary:503:attempt_3; failover->backup; backup:ok:attempt_1`） |

- **health**：Cron 对每个 active endpoint 各写一条，含上述三字段。
- **registryFetch**（lookup / 官方 feed / 推荐用户等）：失败必写；成功仅在 failover 或多于 1 次尝试时写（lookup 避免 D1 写膨胀）。

### 下行 `directives` 验签（节点消费，M9-3-6 实装）

注册中心在**已鉴权成功**的响应（首期：`POST /api/node/health` 200）可附加：

```json
{
  "ok": true,
  "data": { "...": "..." },
  "directives": [ { "...": "..." } ],
  "registry_signature": "<128 hex chars>"
}
```

节点**必须**在改 D1 前完成：

1. 用**本次通信成功**的 `endpoint.trust_pubkey` 验 `registry_signature`
2. 校验 `directives[].issued_at` 在 ±300s 窗口内
3. 校验每个 `directives[].nonce` 未在 `registry_directive_nonces` 中出现
4. 仅 then 执行 `action`

#### 第一期允许的 `action`

| action | 行为 | 签发方约束 |
|---|---|---|
| `add_registry` | 若节点**已有 home** 且 `registry_id` 不存在且 `len(endpoints) < 5`，**尾部 append** `{ status: 'pending', ... }`；无 home 时**跳过该条**（M9-PH-BI-6：不作为冷启动/容量开窗，接待走入口）；已达 5 条则 **skip 整次 apply**，`reason: max_endpoints`；`registry_url` 非 `https://` 或 `trust_pubkey` 非 32B Ed25519 → **跳过该条**（M9-3-B3） | 仅 **`registry_endpoints[0]`**（主注册中心）可签发 |
| `noop` | 无操作 | 任意已信任中心 |

**不做**：`remove_registry`、`replace_primary`（第一期）。

`applyRegistryDirectives` 整次 skip 的 `reason` 枚举（M9-3-B1/B3）：`empty_directives`、`missing_signature`、`invalid_directives`、`issued_at_out_of_window`、`nonce_replay`、`signature_invalid`、`max_endpoints`。`add_registry` 字段非法（http URL / 无效公钥）时跳过单条 append，不新增 reason 码。

`add_registry` 后节点**不会**自动改 home：须对该中心单独走登记流程写入 `node_api_token`。未登记节点的接待中心以入口 `active_intake` 为准，不靠本指令开窗。

#### `REGISTRY_DIRECTIVE_V1` 签名输入（与注册中心 M23 对齐）

UTF-8 四行，行尾 `\n`：

```text
REGISTRY_DIRECTIVE_V1
POST /api/node/health
<issued_at>:<nonce>:<issuer_registry_id>:<directives_canonical_json>
```

- **M9-3-B7**：`<issuer_registry_id>` 始终为**签发方**（主注册中心 `[0]`）的 `registry_id`，含单条 `add_registry` 亦然
- `directives_canonical_json` = `JSON.stringify(directives)`，数组内对象键按**字母序**递归排序后序列化（与注册中心签名侧同算法）
- 签名算法：Ed25519，私钥为注册中心 `REGISTRY_ED25519_PRIVATE_KEY`；输出 **64 字节 hex**（128 字符）
- 验签公钥：节点 D1 中**本次通信 endpoint** 的 `trust_pubkey`

### 登记时信任锚（M9-3-1，扩展 `challenge/verify` 响应）

注册中心 `POST /api/register/challenge/verify` 成功时追加（见注册中心 `registry-api.md`）：

```json
{
  "registry_identity": {
    "registry_id": "reg1",
    "pubkey": "<base64 Ed25519 32B>",
    "registry_url": "https://registry.example"
  },
  "registry_signature": "<hex>",
  "suggested_daily_sync_utc_second_of_day": 28142
}
```

节点须用 `REGISTRY_IDENTITY_V1` 验签通过后才与 `node_api_token` 一并写入 `registry_endpoints[0]`；**M-DS-V2** 同时将 `suggested_daily_sync_utc_second_of_day` 落库供 Cron 日同步调度（见 §`POST /api/local/register/complete`）。

```text
REGISTRY_IDENTITY_V1
POST /api/register/challenge/verify
<issued_at>:<nonce>:<registry_identity_canonical_json>
```

`issued_at` / `nonce` 来自 `registry_identity` 对象内字段（实装时注册中心一并返回）。

**升级迁移 well-known 验签（M9-3-B8）**：Cron `migrateRegistryEndpointsIfNeeded` 拉 `GET /.well-known/hailuo-registry-identity` 时，若响应含 `nonce` + `registry_signature` 则验：

```text
REGISTRY_IDENTITY_V1
GET /.well-known/hailuo-registry-identity
<issued_at>:<nonce>:<registry_identity_canonical_json>
```

缺 signature 的旧注册中心：**官方主链禁止 TOFU**（M9-PH-TA-2）；须通过钉死主中心公钥的 well-known 锚点验签。验签失败则 migrate 返回 `failed` / `REGISTRY_TRUST_ANCHOR_MISMATCH`（或等价 reason）。

### 主中心信任锚（M9-PH-TA）

| 项 | 说明 |
|---|---|
| 常量 | `apps/worker-a/src/lib/primaryRegistryTrustAnchor.ts`：`PRIMARY_REGISTRY_ID=reg1`、`PRIMARY_TRUST_PUBKEY_B64` |
| 登记 / 改 URL | 候选 `REGISTRY_URL` 必须过 `REGISTRY_IDENTITY_V1` + 钉死公钥；失败 → `REGISTRY_TRUST_ANCHOR_MISMATCH`（502） |
| 备用中心 | 仅认主中心签的 `add_registry`（`REGISTRY_DIRECTIVE_V1`）；`[0].trust_pubkey` 须先匹配锚点；拒 env 裸备用 |
| Fork 换锚 | 替换源码锚点公钥与默认 URL = 另起联邦；不得冒充官方 `reg1` |

运维说明：[`deploy.md` §主中心信任锚](./deploy.md#主中心信任锚m9-ph-ta--开源后必读)；计划：[`m9-ph-trust-anchor-plan.md`](./m9-ph-trust-anchor-plan.md)。

### Worker B 只读（M9-3-5 ✅）

`GET /api/public/registry-endpoints` — 返回脱敏 `registry_endpoints` 数组，供 Web 运行时覆盖 `PUBLIC_REGISTRY_URL`。

**响应** `200`：

```json
{
  "ok": true,
  "data": {
    "items": [
      {
        "registry_id": "reg1",
        "registry_url": "https://registry.example",
        "trust_pubkey": "<base64>",
        "status": "active",
        "added_at": "2026-06-21T00:00:00.000Z",
        "last_ok_at": "2026-06-21T01:00:00.000Z",
        "fail_streak": 0
      }
    ]
  }
}
```

**约束**：数据来自 Worker A Cron 写入的 `STATE_KV` 键 `node:registry_endpoints`；**不得**含 `node_api_token` / `owner_user_id`。公开读，`Cache-Control: public, max-age=60`。

---

## 海螺入口消费层（active_intake · M9-PH-BI-*）

> 本节记录浏览器把入口原文交给 Worker A，验签通过后写入 `active_intake` 的契约。节点不自己去拉入口。
> **权威来源**：
> - 节点侧 SSOT：[`m9-ph-bootstrap-intake-plan.md`](./m9-ph-bootstrap-intake-plan.md)（**v0.9**，含字段名与行为约束）
> - 入口侧 SSOT：[`hailuo-bootstrap/docs/m-bootstrap-ops-plan.md`](https://github.com/.../hailuo-bootstrap/blob/main/docs/m-bootstrap-ops-plan.md) §四/§八/§十二

### `active_intake`（system_config 键：`active_intake`）

**语义**：当前接待（B）——仅**未登记 / 重新登记流程**使用；**不是** home（C）。

**存储位置**：`IDENTITY_DB.system_config` 键 `active_intake`（JSON，**非** KV）

**来源**：
- 浏览器交来的入口原文验签成功 → `source='bootstrap'`
- 验签失败或没交原文 → 不改已有记录，也不写入主中心回落

**写入时机**：点登记时浏览器自己向入口领取原文，再交给 `POST /api/local/register/intake`。节点只验这段文字。还没登记成功时，信息流和其它路径不读这份地址，也不代拉入口。连不上这一家时，由浏览器再问入口一次，并带 `avoid_registry_id`。两份领取同时回来时：没带避开参数的只留先写入的那一份；带了避开参数并且成功的那一份覆盖本地。失败不把库写成主中心回落。

**字段**：

| 字段 | 类型 | 说明 |
|---|---|---|
| `registry_id` | string | 当前接待的 registry_id（来自 manifest `intake.registry_id`） |
| `registry_url` | string | 当前接待的 URL（来自 manifest `intake.registry_url`，去尾斜杠） |
| `trust_pubkey` | string | 当前接待的 Ed25519 公钥（来自 manifest `intake.trust_pubkey`，raw 32B base64） |
| `pubkey_version` | number | 入口信任根公钥版本号（EV-2-2 起；V1 manifest 写入时 = 1，V2 manifest 写入时 = manifest 字段值；回落主中心 = 1） |
| `source` | `'bootstrap' \| 'primary_fallback'` | 验签成功后写入；`primary_fallback` 仅回落用，不参与信任锚校验 |
| `updated_at` | ISO 8601 string | 本次写入时间 |
| `rotation_window_end_at` | ISO 8601 string \| null（**V3 起，EV-3-6**） | 旧钥过渡期过期时间。V3 manifest 写入时 = manifest 字段值；V1/V2 manifest 写入时 = `null`（**omit 字段，字节级兼容旧 V1 缓存**，**不**破 6 键 schema）；`primary_fallback` 显式 `null`。非 ISO 字符串 → parse 拒（fail-closed）。 |

### Bootstrap Manifest 协议版本（EV-2-2 起）

入口与节点并行支持 v0.1 / v0.2 manifest，按 `type` 字面分流；V1 / V2 同时有效。

| type 字面 | 顶层键数 | 字段要求 | 用途 |
|---|---|---|---|
| `HAILUO_BOOTSTRAP_MANIFEST_V1` | 5 | `type / manifest_version / issued_at / roster_synced_at / intake` | v0.1 旧 manifest；隐式 `pubkey_version=1` |
| `HAILUO_BOOTSTRAP_MANIFEST_V2` | 6 | 上述 5 项 + `pubkey_version`（正整数） | v0.2 manifest；显式 `pubkey_version` 字段必须 = 本地钉死 `BOOTSTRAP_TRUST_PUBKEY_VERSION`，否则 `BOOTSTRAP_MANIFEST_PUBKEY_VERSION_MISMATCH` |

**双侧同翻约束**：`BOOTSTRAP_TRUST_PUBKEY_VERSION` 在节点端为**钉死常量**（开源固化）；入口端翻号时**必须**与节点端同 commit 翻同一整数（不能单边翻）。翻号期间 V1 manifest 仍走 v0.1 路径。

### V3 协议分流（EV-3-2 起 · NCF-EV-3-6 收尾）

V2 manifest 在 `signers[]` 存在时走 V3 多签路径（`verifyManifestV2Multi` OR 验签 + 4 类新错误码）。`rotation_window_end_at` 是 V3 协议过渡期字段，节点端消费时**统一走 `isRotationWindowExpired()` 助手**（`apps/worker-a/src/lib/activeIntake.ts`）：

| 输入形态 | 行为 |
|---|---|
| `null` / 字段缺省 | 永不过期（V1/V2 兼容）；序列化时**不**写字段（V1 旧缓存字节级兼容） |
| 合法 ISO 8601 UTC 字符串 + `now < end` | 不过期（V3 过渡期内），接受 V3 manifest |
| 合法 ISO 8601 UTC 字符串 + `now > end` | 过期 → `BOOTSTRAP_MANIFEST_LEGACY_AFTER_WINDOW`（拒绝落库） |
| 合法 ISO 8601 UTC 字符串 + `now === end` | 算未过期（half-open `[now, end]` 语义） |
| 非 ISO 字符串 | 当作过期（fail-closed）→ `BOOTSTRAP_MANIFEST_LEGACY_AFTER_WINDOW` |

**持久化**：`active_intake.rotation_window_end_at`（V3 写字段值 / V1/V2 显式 `null`）；下次 refresh 命中缓存时也能识别本缓存是 V3 manifest 写过的（**不**依赖"已上 V3 协议"的全局态变量）。

### Bootstrap Manifest 验签错误码

`bootstrapIntake.ts` 导出的 `BootstrapIntakeErrorCode`：

| 错误码 | 含义 | 对应场景 |
|---|---|---|
| `BOOTSTRAP_FETCH_FAILED` | manifest 拉取失败（HTTP 错误或超时 5s） | 入口域名不可达 |
| `BOOTSTRAP_MANIFEST_INVALID` | manifest JSON 结构非法 / 未知 type | 非 JSON 或缺少顶层字段；v0.3+ 未知 type 拒收 |
| `BOOTSTRAP_SIG_INVALID` | Ed25519 签名验签失败 | 篡改 manifest 或钥不匹配 |
| `BOOTSTRAP_ROSTER_STALE` | `roster_synced_at` 超 24h 窗口 | 入口 24h 内未刷新名册 |
| `BOOTSTRAP_VERSION_ROLLBACK` | manifest version 不单调（本地缓存 version ≥ 新版） | 版本回滚攻击 |
| `BOOTSTRAP_ALTERNATES_FORBIDDEN` | manifest 含 `alternates[]` | 入口协议违规，拒绝多备用列表 |
| `BOOTSTRAP_MANIFEST_PUBKEY_VERSION_MISMATCH` | V2 manifest `pubkey_version` ≠ 本地钉死 `BOOTSTRAP_TRUST_PUBKEY_VERSION`（EV-2-2） | 入口已翻号但本仓未升级（防单边滚动） |
| `BOOTSTRAP_MANIFEST_LEGACY_AFTER_WINDOW` | V3 manifest `rotation_window_end_at` 已过期（EV-3-2 / EV-3-6） | 旧 V2 manifest 过渡期满（节点端统一走 `isRotationWindowExpired` 助手校验） |
| `BOOTSTRAP_SIGNER_PUBKEY_UNKNOWN` | V3 manifest `signers[i].pubkey_b64` 不在 V1/V2 白名单（EV-3-2） | 入口 `signers[]` 漏配或被替换攻击 |
| `BOOTSTRAP_SIGNER_VERSION_MISMATCH` | V3 manifest `signers[i].pubkey_version` 与白名单版本号不匹配（EV-3-2） | 入口 signers 版本号漂移 |
| `BOOTSTRAP_SIGNER_SIG_INVALID` | V3 manifest `signers[]` OR 验签均失败（EV-3-2） | 入口 signers 全部签名无效 |

**回落行为**：上述任一错误（除 `BOOTSTRAP_FETCH_FAILED` 外）均触发回落主中心锚点，写入 `source='primary_fallback'`；**不改** `registered_registries`（home）。

### 入口公钥钉死

- **钉死公钥**：`BOOTSTRAP_TRUST_PUBKEY_B64`（`apps/worker-a/src/lib/bootstrapIntakeTrustAnchor.ts`）
- **钉死公钥版本号**：`BOOTSTRAP_TRUST_PUBKEY_VERSION: number = 1`（EV-2-2 起）
- **钉死状态**：`BOOTSTRAP_TRUST_PUBKEY_STATUS === 'pinned'`
- **验签方式**：用钉死公钥验签 manifest `sig`，**禁止**用 manifest 内 `intake.trust_pubkey` 自验
- **翻号约束**：版本号是**钉死常量**，**不得**动态读取 manifest 字段。翻号必须 BSP + NCF 同 commit 双侧同翻（防签了但换钥叙事滥用）。

### 与 registry_endpoints（home / 备用中心）的区别

| | `active_intake`（B） | `registry_endpoints`（C / 备用） |
|---|---|---|
| 用途 | 未登记节点找当前接待 | 已登记节点的 home / 联邦备用 |
| 来源 | 浏览器交来的入口原文验签 | `registered_registries`（登记写入） / 主中心 directive `add_registry` |
| 用途 | 登记流程（POST /api/register/*） | daily-sync / health 上报 / 联邦读 |

### 相关代码

- `apps/worker-a/src/lib/bootstrapIntake.ts`：`refreshActiveIntakeFromBootstrap()` 主逻辑
- `apps/worker-a/src/lib/activeIntake.ts`：`parseActiveIntake()` / `writeActiveIntake()` D1 读写
- `apps/worker-a/src/lib/bootstrapIntakeTrustAnchor.ts`：`BOOTSTRAP_TRUST_PUBKEY_B64` 常量

---

## 注册中心上游契约（Worker A 作为客户端）

> 本节记录 Worker A 调用注册中心的实际请求/响应格式，供 `scripts/register.mjs`、
> `registryFetch()` 和 Cron 上报实现时对照。
>
> **权威来源**：`hailuo-registry/workers/registry-gateway/src/routes/`。
> **Base URL**：`env.REGISTRY_URL`（如 `https://registry.hailuo.net`）。

---

### 注册流程（scripts/register.mjs 调用，无需鉴权）

#### 步骤 1：POST /api/register/email-verify-request

向注册邮箱发送 6 位验证码。

**请求**：
```json
{ "email": "alice@example.com" }
```

**响应** `200`：
```json
{ "ok": true, "data": { "email": "alice@example.com", "expires_in": 600 } }
```

**关键约束**：同一邮箱 60s 冷却；注册中心做邮箱域名黑/白名单检查。

---

#### 步骤 2：POST /api/register/email-verify-confirm

校验 6 位验证码，返回 10 分钟有效的 `email_verify_token`。

**请求**：
```json
{ "email": "alice@example.com", "code": "123456" }
```

**响应** `200`：
```json
{
  "ok": true,
  "data": {
    "email_verify_token": "<opaque_token>",
    "expires_in": 600
  }
}
```

**关键约束**：验证码 6 位数字；超过最大尝试次数返回 429。

---

#### 步骤 3：POST /api/register/precheck

创建注册 challenge。失败不创建 challenge，不消耗 email_verify_token。

**请求**（**所有字段必填**）：
```json
{
  "handle": "alice",
  "pubkey": "<ed25519_pubkey_hex>",
  "node_url": "https://alice-worker-b.workers.dev",
  "email": "alice@example.com",
  "email_verify_token": "<token_from_step_2>",
  "turnstile_token": "<turnstile_widget_token>"
}
```

> 本地/CI 测试：`REGISTER_TURNSTILE_ENFORCE=false` 时可不带 `turnstile_token`；
> `TURNSTILE_TEST_MODE=true` 时填 `"test-pass"` 即可。

**响应** `200`：
```json
{
  "ok": true,
  "data": {
    "challenge_id": "ch_xxxxxxxxxxxx",
    "nonce": "nonce_xxxxxxxxxxxx",
    "expires_at": "2026-01-01T00:10:00.000Z"
  }
}
```

**关键约束**：challenge 有效期 10 分钟；同 handle/node_url/email 不能有并发活跃 challenge。

---

#### 步骤 4：POST /api/register/challenge/verify

提交 Ed25519 签名完成注册。**路径为 `/challenge/verify`，不是 `/verify`**。

签名消息（固定格式）：`<challenge_id>.<nonce>`

```ts
// 在 scripts/register.mjs 里：
const message = `${challenge_id}.${nonce}`;
const signature = await signEd25519(privateKeyHex, message); // hex 编码
```

**请求**：
```json
{
  "challenge_id": "ch_xxxxxxxxxxxx",
  "signature": "<ed25519_signature_hex>"
}
```

注册中心收到请求后：
1. 校验签名（Ed25519 verify）
2. 回访 `GET {node_url}/.well-known/hailuo-proof` 确认节点归属
3. 写 users 表，签发 `node_api_token`

**响应** `200`（**一次性明文 token，立即存储**）：
```json
{
  "ok": true,
  "data": {
    "user_id": "u_xxxxxxxxxxxx",
    "node_api_token": "nat_xxxxxxxxxxxx",
    "node_api_token_display": "nat_xxxx...xxxx",
    "registered_at": "2026-01-01T00:00:00.000Z"
  }
}
```

> ⚠️ `node_api_token` 明文**只在这里出现一次**，注册中心仅存其 SHA-256 hash。
> `scripts/register.mjs` 必须立即把 `node_api_token` 和 `user_id` 写入节点 D1 `system_config`。

---

### 运行时接口（Cron / 启动时调用，需单头或双头）

#### POST /api/node/daily-sync（M-DS 主路径 · M-DS-V2 调度）

节点向注册中心 **每日聚合同步**（health 自报 + directives + 官方公告 + 黑名单 + 推荐）。详见上文 §Worker A Cron 调度。

**请求头**：
```
X-Hailuo-Node-User-Id: <owner_user_id>
Authorization: Bearer <node_api_token>
```

**请求体**（主 endpoint，protobuf envelope JSON 示例）：

```json
{
  "proto_version": "1.0",
  "known_registry_ids": ["reg1"],
  "official_feed_since": "2026-07-01T00:00:00.000Z",
  "official_feed_max_pages": 3,
  "blacklist_etag": "\"abc\"",
  "recommendations_limit": 10
}
```

**响应** `200`：含 `data.health`、`data.official_feed`、`data.blacklist`、`data.recommendations`；顶层 `directives` + `registry_signature` 非空时须按 §多注册中心验签。

**fail-soft**：`outbound_events(kind='registry/daily-sync')`；`retry-outbound` 重试；连续 2 自然日失败 → endpoint `unreachable`。

注册中心契约：`hailuo-registry/docs/registry-api.md` §`POST /api/node/daily-sync`。

---

#### POST /api/node/health（节点侧已停用 · M-OPT-12）

> **⚠️ 节点仓禁止新调用**：Cron / 登记后同步 / Settings「立即日同步」一律走 **`POST /api/node/daily-sync`**。`reportHealthToRegistry` 仅作 deprecated 转调，旧 `outbound_events(kind=registry/health)` 重试也会改写为 daily-sync。
> **注册中心侧**（M-OPT-11）：兼容期仍可能 200 + `Deprecation`/`Sunset`；`NODE_HEALTH_REPORT_DISABLED=true` 后固定 410 `HEALTH_DISABLED`。
> **勿与公开探活混淆**：Settings「自测公开 /health」与注册中心 Cron `runHealthChecks` 访问的是节点 **`GET <Worker B 或 node_url>/health`**，不是本 POST。

本段仅保留历史契约摘要；新实现请只对接 §`POST /api/node/daily-sync`。

**历史请求头**（兼容期旧客户端）：
```
X-Hailuo-Node-User-Id: <owner_user_id>
Authorization: Bearer <node_api_token>
```

**历史 Cron 触发（已移除）**：原 `minute % 15 === 5` 独立 health 上报。

---

#### GET /api/node/me

查询节点自身注册信息（验证 token 有效性）。当前 Worker A 仅在启动初始化时用。

**请求头**：
```
Authorization: Bearer <node_api_token>
```

**响应** `200`：
```json
{
  "ok": true,
  "data": {
    "user_id": "u_xxxxxxxxxxxx",
    "user_name": "alice",
    "node_url": "https://alice-worker-b.workers.dev"
  }
}
```

---

#### GET /lookup/:handle

反查 handle 对应节点信息（pubkey / node_url / worker_b_url）。

**入参正式名（M9-PH-1）**：主中心用户可为裸 `handle`（如 `alice`）；其它中心须 `handle@registry_id`。存量 `alice@reg1` 会规范为 `alice` 再解析。不支持 DID。

**M-OPT-8 / 8b 统一解析器**（Worker A：`resolveNodeByHandle`；路由 `GET /api/lookup/:handle` 仅委托此入口）：
1. **L1 follows**：本地 `follows.followed_handle` 命中 → 直接返回 `worker_b_url` / `node_url`（不计 `lookup_day` 配额、不回源）
2. **L1 cache**：D1 `cache_entries` 未过期命中 → 返回缓存 JSON（不计配额、不回源）
3. **L2 互粉协助（M-OPT-8b）**：海螺节点**默认开**（`LOOKUP_L2_MUTUAL_ASSIST_ENABLED`；显式 `false` 关闭）。向最多 5 个已关注联系人的 Worker B `GET /lookup-assist/:handle` 询问（超时 2s；先校验公开 https，跳转不跟随；不计 `lookup_day`；出站日轮次默认 ≤50）。命中写入 `cache_entries`，`resolve_source=l2_mutual`。MVP 候选=已关注且有 handle 的联系人。
4. **L3 有限 FoF（M-OPT-8c）**：海螺节点**默认开**（`LOOKUP_L3_FOF_ENABLED`；显式 `false` 关闭）。向最多 5 个联系人带 `?fof=1` 询问（超时 3s；出站日轮次默认 ≤20）。对端先答 L1，未命中再问其联系人 L1（**禁止再 FoF**）。命中 `resolve_source=l3_fof`。
5. **L4 注册中心**：以上均未命中 → 扣本地日配额后 `GET {REGISTRY_URL}/lookup/:handle`，成功写入 `cache_entries`

**M9-3-CL1（配对 registry M23-12L）**：
- 成功 `data` 可透传联邦 meta：`home_registry_id` / `resolved_via_registry_id` / `route_version` / `route_stale`（旧客户端可忽略）。
- 注册中心返回 **503** `FEDERATED_HOME_UNAVAILABLE` 时，本接口原样 **503**，**不得**降成 `LOOKUP_NOT_FOUND`（404）。
- 注册中心 **404** 仍映射为 `LOOKUP_NOT_FOUND`。

**TTL**：`cache_entries` **7 日**（`LOOKUP_CACHE_TTL_SECONDS`；M-OPT-1c）。关注成功且 body 带 `profile.handle` 时会预热缓存。响应 `data` 可含 `resolve_source`：`l1_follows` / `l1_cache` / `l2_mutual` / `l3_fof` / `l4_registry`（排障用，前端可忽略）。

**指标**：每次解析记入 D1 `lookup_resolve_day_stats`；`l4_ratio` = `l4_registry / (l1 + l2_mutual + l3_fof + l4_registry)`；另有 `l2_*` / `l3_*`。

> ⚠️ **路径无 `/api` 前缀**：完整路径为 `GET {REGISTRY_URL}/lookup/{handle}`。

**请求头（双头必填）**：
```
X-Hailuo-Node-User-Id: <owner_user_id>
Authorization: Bearer <node_api_token>
```

**响应** `200`：
```json
{
  "ok": true,
  "data": {
    "user_id": "u_xxxxxxxxxxxx",
    "handle": "bob",
    "node_url": "https://bob-worker-b.workers.dev",
    "worker_b_url": "https://bob-worker-b.workers.dev",
    "registry_status": "registered",
    "profile_status": "completed",
    "health_status": "active",
    "pubkey_fingerprint": "a1b2c3d4e5f6a1b2",
    "registered_at": "2025-12-01T00:00:00.000Z",
    "last_health_at": "2026-01-01T00:00:00.000Z",
    "home_registry_id": "reg1",
    "resolved_via_registry_id": "reg1",
    "route_version": 1,
    "route_stale": false
  }
}
```

**fail-soft 策略**：lookup 缓存不命中时发起远程请求；注册中心 **404** → `LOOKUP_NOT_FOUND`；**503** 联邦 home 不可用 → `FEDERATED_HOME_UNAVAILABLE`（保留 503）；其它不可达 → `LOOKUP_INTERNAL`；**不写 outbound_events**（非关键路径）。

---

### 注册流程完整时序（scripts/register.mjs）

```
1. computePubkeyFingerprint(pubkeyHex)     ← shared-crypto，M1-1a
2. POST /api/register/email-verify-request  ← 发验证码到邮箱
3. 提示用户输入 6 位验证码
4. POST /api/register/email-verify-confirm  ← 换取 email_verify_token
5. POST /api/register/precheck              ← 创建 challenge（附 turnstile_token）
   → 得到 challenge_id + nonce
6. signature = Ed25519Sign(privkey, `${challenge_id}.${nonce}`)
7. POST /api/register/challenge/verify      ← 注册中心回访 /.well-known/hailuo-proof
   → 得到 user_id + node_api_token（一次性明文）
8. D1 batch:
   INSERT OR REPLACE INTO system_config(key,value) VALUES ('node_api_token', node_api_token)
   INSERT OR REPLACE INTO system_config(key,value) VALUES ('owner_user_id', user_id)
```

> `scripts/register.mjs` 在步骤 5 之前需要节点 Worker A 已经在线（注册中心步骤 7 需回访
> `/.well-known/hailuo-proof`）；因此执行顺序：**先 `wrangler deploy`，再跑注册脚本**。
