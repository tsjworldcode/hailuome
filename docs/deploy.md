# 部署手册 — 海螺节点（hailuo-node-cf）

> **站主请优先阅读**：[`deploy-github-actions.md`](./deploy-github-actions.md)（**推荐**：GitHub Actions 自动创建 D1/KV/Pages）→ [`部署指南.md`](./部署指南.md)  
> Workers Builds / Deploy 按钮**不会**自动创建资源，首次部署会失败，仅作参考：[`deploy-workers-builds.md`](./deploy-workers-builds.md)  
> 本文件为**技术附录**：Workers Builds 字段、手动 wrangler 命令、curl 冒烟清单。

## 硬约束（部署前必读 · R-AUDIT-SEP-A2）

> **违反下列任一条，Free Tier 会立刻撞墙或留下不可恢复的配额事故。部署前必须看清楚。**

1. **节点账号 ≠ 注册中心账号（必须不同 Cloudflare 账号）**  
   - 本仓库（`hailuo-node-cf`）部署在**站主自己的** Cloudflare 账号。  
   - 官方注册中心（`hailuo-registry`）部署在**运营方另一账号**。  
   - **禁止**把官方 registry 与任一生产节点放进同一 CF 账号。  
   - **原因**：Workers Free 每账号 **D1 上限 10 个物理库**。节点侧约 **6/10**（`IDENTITY_DB` / `GOVERNANCE_DB` / `CONTENT_DB` / `DB_IMPORT` / `MESSAGING_DB` / `MESSAGING_SHARD_1`；**A7-DB-RETIRE 已移除遗留 `DB` binding**）；registry 另需 IDENTITY / GOVERNANCE / CONTENT（及观察期 alias）。同账号一部署就会超过 10。  
   - 站主自托管节点：只需连公共 registry API（见 [`部署指南.md`](./部署指南.md) §1.2），**不要**在本账号再 `wrangler deploy` 官方 registry 仓库。  
   - 运营方自建联邦 / 次中心：registry 用独立账号（或 Paid），节点账号继续只跑节点三件套。

2. **节点账号剩余 D1 头寸 ≤ 3**  
   - 新增第 8 个物理 D1 前：先腾库、合并观察期 alias、或评估升 Paid（见计划 [`remediation-plan-audit-2026-09-13.md`](./remediation-plan-audit-2026-09-13.md) C-1）。  
   - **禁止**为腾额度把 IDENTITY / GOVERNANCE / CONTENT 合并回单库（推翻 M-OPT-SPLIT）。

3. **Worker A 永不公开**（既有红线，此处重申）  
   - A 地址不写公开文档、不配 CORS 给粉丝、不登记到注册中心公开字段。

4. **`*.workers.dev` / `*.pages.dev` 三组件差异**（R-AUDIT-CF-DEPLOY P1-1 撤销后定稿，2026-09-16）  
   - **Worker A**（私密写层）：保持 `workers_dev = false`（已在 wrangler.toml 顶层写死）；禁止暴露公网入口。  
   - **Worker B**（公开读层）：**默认开** `*.workers.dev`（wrangler.toml 不写 `workers_dev` 字段，走 Cloudflare 默认 `true`）；部署者配好自定义域后，可选在 Cloudflare 控制台 Settings → Triggers → Compatibility flags 取消「workers.dev URL」启用即可关停兜底。  
   - **Pages**（Web 前端）：`*.pages.dev` 与 `workers_dev` 是独立开关；Pages 默认开 Pages 预览子域，部署者配自定义域后可关闭。  
   - **禁止**：为求"统一基线"硬把 `workers_dev = false` 套到 Worker B —— 会卡死未配自定义域的部署者；Service Binding 内部转发走 worker-to-worker 通道，不经过 `*.workers.dev` 域名解析，"防 WAF 旁路"理由不成立。

---

## 部署范围

| 组件 | 部署方式 | 环境 |
|---|---|---|
| Worker A | `wrangler deploy --env production --config apps/worker-a/wrangler.toml` | Cloudflare Workers |
| Worker B | `wrangler deploy --env production --config apps/worker-b/wrangler.toml` | Cloudflare Workers |
| Web 前端 | `wrangler pages deploy web/dist --project-name hailuo-web` | Cloudflare Pages |

---

## Monorepo / Workers Builds（M8-4，整仓 fork）

站主 **Deploy to Cloudflare** 或 **Workers Builds** 连接 GitHub 时，请在**仓库根目录**安装依赖，再按 workspace 构建/部署（不要只在 `apps/worker-a` 里单独 `npm install`）。

| 场景 | 安装 | 构建 | 部署 |
|------|------|------|------|
| Worker A | `npm ci`（根目录） | `npm run build:worker-a` | `npm run deploy:worker-a` |
| Worker B | `npm ci`（根目录） | `npm run build:worker-b` | `npm run deploy:worker-b` |
| A + B 顺序 | `npm ci` | `npm run build:workers` | `npm run deploy:all` |

**Cloudflare Workers Builds — 整包构建（参考；首次部署不会建 D1/KV，会失败）**：新建任意「构建入口」Worker，Connect Git 后：

| 字段 | 值 |
|------|-----|
| Install command | `npm ci` |
| Build command | 留空或 `echo skip` |
| Deploy command | `npm run deploy:ci` |

Builds API Token 须含 **D1 Edit + Pages Edit**（默认往往没有）。**不必**再写 Build Secret `CLOUDFLARE_API_TOKEN`（失败时排障再补）。  
详见 [`deploy-workers-builds.md`](./deploy-workers-builds.md)。  
下列表格仅用于「资源已就绪、只分别部署 A/B 代码」的进阶拆分：

**Cloudflare Workers Builds 填法（资源已就绪时）**（两个 Worker 各建一个项目，Root directory 均留空 = 仓库根）：

| 字段 | Worker A | Worker B |
|------|----------|----------|
| Install command | `npm ci` | `npm ci` |
| Build command | `npm run build:worker-a` | `npm run build:worker-b` |
| Deploy command | `npm run deploy:worker-a` | `npm run deploy:worker-b` |

Deploy 按钮 URL（整仓 fork，子目录仅指定 Worker 入口）：

- Worker A：`https://deploy.workers.cloudflare.com/?url=<本仓库 Git URL>&subdir=apps/worker-a`
- Worker B：同上，`subdir=apps/worker-b`（**须先完成 A**）

契约自检：`npm run test:m8-4`（17 项，含 workspace 依赖声明）。

---

## Deploy 按钮与 `cloudflare.bindings`（M8-5）

> **推荐**：GitHub Actions，自动创建 D1/KV/Pages，见 [`deploy-github-actions.md`](./deploy-github-actions.md)。  
> **参考**：Workers Builds + `npm run deploy:ci`，见 [`deploy-workers-builds.md`](./deploy-workers-builds.md)（**不会**自动建资源，首次部署会失败）。  
> 官方 Deploy 按钮**不能**自动创建 D1/KV，仅适合资源已就绪或 legacy 对照。

README 与 [`部署指南.md`](./部署指南.md) 中的 **Deploy to Cloudflare** 按钮指向本仓库；首次点击会在**你的 GitHub** 下 fork 整仓，并在你的 Cloudflare 账号创建 Worker。

| 按钮 | URL（`subdir` 指定 Worker 入口，依赖仍在仓库根 `npm ci`） |
|------|------|
| Worker A | `https://deploy.workers.cloudflare.com/?url=https://github.com/tsjworldcode/hailuo-node-cf&subdir=apps/worker-a` |
| Worker B | 同上，`subdir=apps/worker-b`（**须先完成 A**） |

**向导预填命令**（整仓 fork、Root directory 留空 = 仓库根）：

| 字段 | Worker A | Worker B |
|------|----------|----------|
| Install command | `npm ci` | `npm ci` |
| Build command | `npm run build:worker-a` | `npm run build:worker-b` |
| Deploy command | `npm run deploy:worker-a` | `npm run deploy:worker-b` |

Worker A 的生产部署（`deploy-hailuo-workers.ps1`）按序 apply：`DB_IMPORT`（搬家 staging 全表）→ `IDENTITY_DB` / `GOVERNANCE_DB` / `CONTENT_DB` → messaging（**A7-DB-RETIRE：不再 apply 遗留 binding=DB**）。

### Secret / 变量说明（`package.json` → `cloudflare.bindings`）

Deploy 向导展示的中文说明来自各 Worker 的 `package.json`：

| Worker | 键 | 类型 | 说明摘要 |
|--------|-----|------|----------|
| A | `JWT_SECRET` | Secret | 站主 Web 登录 JWT |
| A | `TOTP_WRAP_SECRET` | Secret | M12-1：包裹站主 TOTP secret；启用二次验证前必须配置（部署脚本已自动生成） |
| A | `NODE_API_TOKEN_WRAP_SECRET` | Secret | R-MSG-1d：包裹 D1 中注册中心 `nat_`；≥16 字节；部署脚本已自动生成 |
| A | `GROUP_OWNER_KEY_WRAP_SECRET` | Secret | OWNER-KEY：包裹 `group_owner_epoch_keys.key_material`；≥32 字节；**仅 Worker A**；禁止与 JWT/HMAC/INTERNAL_FORWARD/TOTP/NODE_API_TOKEN wrap 复用。托管群密启用前必配（见 [`group-owner-held-key-2026-11-plan.md`](./group-owner-held-key-2026-11-plan.md)） |
| A | `ED25519_PRIVATE_KEY` | Secret | `npm run keys:generate` 私钥 |
| A | `INTERNAL_FORWARD_SECRET` | Secret | 与 B **相同**；B→A Service Binding 头 |
| A | `WORKER_B_URL` | Secret（P0-2：禁止硬编码，改为 secret 注入） | B 部署后 `wrangler secret put` |
| A | `WORKER_A_ORIGIN` | Secret（P0-2：禁止硬编码，改为 secret 注入） | Pages 域名，CORS |
| A | `BOOTSTRAP_HANDLE` | 变量 | **安全占位**（≠ 真 handle）；见下节「BOOTSTRAP_HANDLE 是什么」 |
| B | `INTERNAL_FORWARD_SECRET` | Secret | 与 A **相同** |
| B | `WORKER_A_ORIGIN` | Secret（P0-2：禁止硬编码，改为 secret 注入） | Pages 域名，供 B→A Service Binding |
| B | `BOOTSTRAP_HANDLE` / `ED25519_PUBLIC_KEY` | 变量 | 与 A 一致（同为占位语义） |
| B | `FOLLOWER_TOKEN_MODE` | 可选 vars | **SEC-AUDIT-ENFORCED-FORCE-2**：未配置默认 `token-required`；有 D1/KV 以节点 Settings 为准。站主可改档（含 `public-read`）。可选 env 仅作无 D1 时回落。媒体票据随保护档自动开（须 `MEDIA_TICKET_SECRET`）。 |
| B | `MEDIA_TICKET_SECRET` | Secret（**部署自动**） | SEC-6-SECRET + SEC-6-AUTO：媒体票据 HMAC；**必须独立于**其它密钥；**仅 Worker B**。`generate-deploy-secrets` / bootstrap / `deploy:ci` / 本机一键会生成并 **幂等 put**（`wrangler secret list` 已有则跳过，不覆盖）。站主不必手填；强制轮换设 `FORCE_MEDIA_TICKET_SECRET=1` |
| B | `MEDIA_TICKET_ENABLED` | 变量（**可选紧急关闸**） | `false`/`0`/`off` = 强制关；未设置不挡自动开。主闸=读帖档位 |

本地样板：`apps/worker-a/.dev.vars.example`、`apps/worker-b/.dev.vars.example`；仓库根 `.dev.vars.example` 为索引。

### BOOTSTRAP_HANDLE 是什么

> **F-07 / P2-4**：`wrangler.toml` 里的 `BOOTSTRAP_HANDLE` 是**未完成注册中心登记前**的对外 @handle **安全占位**，不是最终公开身份。

**正常工作流**

1. 首次部署 → A/B 的 `BOOTSTRAP_HANDLE` 生效（git 内为 `usr_*_placeholder`；`ci-bootstrap-resources.mjs` 可能在 production deploy 时覆盖为 `hailuo_<派生>`）→ 节点尚未在注册中心登记 → 对外暂时显示占位。
2. 站主在 Web「设置 → 注册中心」走完 bootstrap 登记 → D1 `users.handle` 写入**你选的**真 handle，并同步 `STATE_KV` `public:profile`。
3. 之后公开 API / Worker B `/users/:handle` 以 D1/KV 为准；**不要再把占位当真身份宣传或二次登记**。

**CI 路径的派生规则**：`hailuo_` + 10 位与同组码一样，由 Cloudflare account ID + 槽位确定性派生（`sha256("hailuo-node:<account_id>:<slot>:handle")` 前 10 位），不是每次随机；换账号或 `HAILUO_NODE_SLOT` 才会变。组码取 `...:group` 前 6 位。本地 PowerShell 部署会先探测 Account ID，再走同一派生；只有探测不到账号时才回退随机。

**为什么需要占位**

- 不设 → 未登记阶段易出现空 handle / 500，排障困难；
- 设成「打算以后用的真 handle」→ 未登记就占用命名，或与他人抢名；
- 设明显占位（`usr_*_placeholder` / deploy 派生的 `hailuo_*`）→ 一眼能看出「还没登记完」。

**硬禁止**

- ❌ 把 `BOOTSTRAP_HANDLE` 手写成真实人名/社交账号/已想好的生产 handle 并提交 git（反追查 + 命名空间污染）；
- ❌ 看到 production 上的 `hailuo_<随机>` 就当成「已在注册中心登记的正式身份」去 lookup / 宣传 / 再登记一遍；
- ✅ A 与 B 必须同值；改占位要两端一起改（deploy 脚本会同源覆盖）。

### INTERNAL_FORWARD_SECRET 同步（A = B = Pages）

> **F-05 / P2-2**：Worker B → Worker A（及 Pages Owner Gateway → Worker A）的 Service Binding 请求头带 HMAC（`X-Internal-Forward: hmac-v2` + `X-Timestamp` / `X-Nonce` / `X-Signature`）。**三端必须是同一字节串**；任一端漏配或值不一致，站主写层 / 粉丝 Token 签发会立刻失败。

**推荐路径（自动双端同值）**

1. `node scripts/generate-deploy-secrets.mjs`（或既有 `scripts/cloudflare-api-token.json`）生成一次 `INTERNAL_FORWARD_SECRET`（≥32 字节 hex）。
2. `node scripts/put-worker-secrets.mjs`：脚本会把**同一值**依次 `secret put` 到 Worker A 与 Worker B（见脚本内对 `INTERNAL_FORWARD_SECRET` 的双端循环）。
   - **瞬时网络失败自动重试**：`wrangler secret put` 走代理时可能只回 `TypeError: fetch failed`（`PUT /workers/scripts/<name>/secrets` 无响应）。脚本对 `fetch failed` / `ETIMEDOUT` / `ECONNRESET` / `75xx` 等瞬时错误重试 3 次（间隔 3s）。
   - **写后以 `wrangler secret list` 校验**：PUT 报错不代表没落盘、PUT 报成功也不代表线上一定有；脚本按线上名单只补写真缺的键。
   - **只有核心键缺失才 exit 1**（`JWT_SECRET` / `INTERNAL_FORWARD_SECRET` / `ED25519_PRIVATE_KEY` / `REGISTRY_URL`）；`TOTP_WRAP_SECRET` / `NODE_API_TOKEN_WRAP_SECRET` / `GROUP_OWNER_KEY_WRAP_SECRET` / `MEDIA_TICKET_SECRET` 缺失只告警（对应能力各自 fail-closed），不再让一把可选密钥把后续 Pages 部署整段中断。
3. `finalize-hailuo-deploy` / `deploy:ci` Phase 3：把**同一值** PATCH 进 Pages Production（Owner Gateway 与 A 对齐）。

**手工路径（一次生成，两端各 put 一次）**

```powershell
# 一次生成；不要写入 git、不要打进公开日志 / 截图
$secret = node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# Worker A
$env:HAILUO_SECRET_PUT_VALUE = $secret
node scripts/put-worker-secrets.mjs --one --worker-dir apps/worker-a --key INTERNAL_FORWARD_SECRET

# Worker B（必须同一值）
node scripts/put-worker-secrets.mjs --one --worker-dir apps/worker-b --key INTERNAL_FORWARD_SECRET

Remove-Item Env:HAILUO_SECRET_PUT_VALUE
```

等价的交互式 `wrangler secret put`（两端粘贴**同一**字符串）：

```powershell
npm exec -- wrangler secret put INTERNAL_FORWARD_SECRET --env production --config apps/worker-a/wrangler.toml
npm exec -- wrangler secret put INTERNAL_FORWARD_SECRET --env production --config apps/worker-b/wrangler.toml
```

**本地开发**：`apps/worker-a/.dev.vars` 与 `apps/worker-b/.dev.vars`（以及 Pages dev 网关）填**完全相同**的示例值；样板见各目录 `.dev.vars.example`。

**不一致时的症状**

- Worker A 返 `INTERNAL_FORWARD_REJECTED`（401/403，视路由而定），中文 message 多为「内部转发头验证失败」。
- Worker B 缺 secret 时公开转发可能先返 503 `INTERNAL_FORWARD_SECRET_MISSING`。
- 修复：用上面任一路经把 A、B（及 Pages）重新写成**同一值**即可，无需改代码。

**冒烟（部署后）**

```powershell
# 经 Worker B 公开端触发 B→A 内部转发；secret 一致时不应出现 INTERNAL_FORWARD_REJECTED
curl.exe -sS -X POST "https://<worker-b-host>/api/follower-tokens" `
  -H "Content-Type: application/json" -d "{}"
# 预期：业务侧校验错误（如缺字段 / 缺粉丝凭证），error_code 不是 INTERNAL_FORWARD_REJECTED
# 若见 INTERNAL_FORWARD_REJECTED → 立即按本节重 put 同值
```

### Pages（无 Deploy 按钮）

| 字段 | 值 |
|------|-----|
| Framework preset | None |
| Root directory | `/`（仓库根） |
| Build command | `npm ci && npm run build --workspace=web` |
| Build output directory | `web/dist` |
| `PUBLIC_WORKER_B_URL` | Production 环境变量 = Worker B https 地址（公开读/外部协议入口）；`finalize-hailuo-deploy` 会自动 PATCH；**M7-30g-2 起**仅为构建期/未绑 KV 时回落，运行时代理优先读 STATE_KV |
| `PUBLIC_HAILUO_ENDPOINT` | 可选旧部署 / 本地调试回退；生产默认不再填写 |
| `WORKER_A` | Pages Functions Service Binding，绑定同节点 Worker A；`finalize-hailuo-deploy` 会自动 PATCH |
| `STATE_KV` | Pages Functions KV Binding，**与 Worker A/B 同 namespace id**；读 `public:canonical_worker_b_url`（换域后公开代理免 redeploy）；`finalize-hailuo-deploy` 用 token `STATE_KV_ID` 自动 PATCH |
| `INTERNAL_FORWARD_SECRET` | Pages Production 环境变量/secret，与 Worker A 的 `INTERNAL_FORWARD_SECRET` 同值；`finalize-hailuo-deploy` 会自动 PATCH |

**M9-AUDIT-3（Pages 空配置 fail-closed）**：

- Cloudflare Pages 构建（`CF_PAGES=1`）或 `HAILUO_DEPLOY_STRICT=1` 时，`write-deploy-env.mjs` **缺少 `PUBLIC_WORKER_B_URL` 直接失败**，禁止产出空 `_worker-b-config.js` 当生产产物。
- `web/functions/_worker-b-config.js`、`public/site-version.json`、`public/deploy-env.json` 均为**构建生成**（已 gitignore）；形状见 `_worker-b-config.example.js`。
- 运行时公开读解析顺序：`STATE_KV` canonical → 构建期 config → `PUBLIC_WORKER_B_URL`；三者皆空返回 `PAGES_PROXY_NOT_CONFIGURED`。
- **生产必须**：Pages 绑定 `STATE_KV`（与 A/B 同 id）+ 构建变量含非空 `PUBLIC_WORKER_B_URL`（bootstrap 回落）。
- 本地故意空配置：`HAILUO_ALLOW_EMPTY_WORKER_B_CONFIG=1`。

本地开发复制 `web/.env.example` → `web/.env.local`，通常只填写 `PUBLIC_WORKER_B_URL`。

> **M9-23 已落地部署自动化**：生产 Web 的同源网关拆成两条通道：`/posts`、`/feed`、`/img/*`、`/users/*`、`/api/follower-tokens`、`/interactions/*` 继续转发到 Worker B；站主写层白名单经 **M9-24 SSOT**（`packages/shared-utils/owner-gateway-allowlist.json`）维护，由 Pages Owner Gateway 通过 `WORKER_A` Service Binding + `INTERNAL_FORWARD_SECRET` HMAC 直达 Worker A。缺少绑定或 secret 时返回 503，不回退公开 Worker A URL。旧的 `PUBLIC_HAILUO_ENDPOINT` 只保留本地调试或兼容迁移用途，并会被 finalize 从 Pages Production 环境删除。**M13-6**：同一 isolate 内 HMAC 签名密钥 `CryptoKey` 模块级缓存，避免每条站主写请求重复 `importKey`。
>
> **M12-1 注意**：站主 TOTP 管理接口已落地，`/auth/totp/*` 已进入 Owner Gateway SSOT 白名单；Worker A 须配置每节点独立的 `TOTP_WRAP_SECRET`。缺少该 secret 时 TOTP setup/enable/disable/rotate fail-closed，未启用 TOTP 的既有登录不受影响。本地开发在 `apps/worker-a/.dev.vars` 填随机 ≥16 字节 secret；生产由 `generate-deploy-secrets.mjs` / `put-worker-secrets.mjs` 注入。
>
> **R-MSG-1d 注意**：注册中心 `nat_` 落 D1 须经 `NODE_API_TOKEN_WRAP_SECRET`（≥16）AES-GCM 包裹为 `natw1:…`；与 `TOTP_WRAP_SECRET` **独立**。缺 secret 时新写入/rotate 落盘 fail-closed；读路径可双读 legacy 明文并懒迁移。部署脚本已纳入该 secret。
>
> **OWNER-KEY 注意**：群主节点持钥表 `group_owner_epoch_keys.key_material` 须经 `GROUP_OWNER_KEY_WRAP_SECRET`（≥32）AES-GCM 包裹；**仅 Worker A**；禁止与 JWT / HMAC / INTERNAL_FORWARD / TOTP / `NODE_API_TOKEN_WRAP_SECRET` 复用。缺 secret 时 OWNER-KEY-2+ 写持钥表应 fail-closed。本地填 `apps/worker-a/.dev.vars`；生产由 `generate-deploy-secrets.mjs` / bootstrap `Ensure-GroupOwnerKeyWrapSecret` / `put-worker-secrets.mjs` 注入。

Pages 绑定检查：
1. `.\scripts\deploy-all.ps1` **始终**部署 Pages（M9-23 起废止 `-SkipPages` / `PAGES_DEPLOY=false`）；Phase 3 调用 `finalize-hailuo-deploy`，自动 PATCH Pages Production：`PUBLIC_WORKER_B_URL`、`PUBLIC_REGISTRY_URL`、`INTERNAL_FORWARD_SECRET`、`WORKER_A` Service Binding、**`STATE_KV`（M7-30g-2，需 token 含 `STATE_KV_ID`）**，并删除旧 `PUBLIC_HAILUO_ENDPOINT`。
2. 如果 Cloudflare API PATCH 失败，控制台手工确认 Pages 项目 Production 环境存在 `PUBLIC_WORKER_B_URL`，值为 Worker B 公网地址。
3. 如果 Cloudflare API PATCH 失败，控制台手工确认 Pages Functions 绑定 `WORKER_A` 指向同节点 Worker A。
4. 如果 Cloudflare API PATCH 失败，控制台手工确认 Pages Production 环境存在 `INTERNAL_FORWARD_SECRET`，值与 Worker A/Worker B 同节点 secret 完全一致。
5. **M7-30g-2**：控制台确认 Pages Functions 已绑定 `STATE_KV`，namespace id 与 Worker A/B `wrangler.toml` 中 STATE_KV **完全一致**（一次性基建；换域后不再为代理目标 redeploy Web）。
6. 冒烟时登录、发帖、关注等站主请求命中 Pages 同源 `/auth/*` / `/api/*`，浏览器 Network 不应出现 Worker A 公网 URL。
7. 冒烟公开读：换域 confirm 后，无需改 `PUBLIC_WORKER_B_URL` / redeploy，Pages `/posts` 应在约 60s 内代理到新 Worker B 基址（依赖 STATE_KV 镜像已写入）。

Worker B 兼容开关：`OWNER_PROXY_MODE` 默认应保持 `"disabled"` 或未设置；只有旧 Web 尚未切到 Pages Owner Gateway 的迁移窗口，才临时设为 `"compat"`。迁移完成后改回默认值并重新部署 Worker B。

详见 [`部署指南.md` §3 步骤 3](./部署指南.md#步骤-3web-前端cloudflare-pages)。

契约自检：`npm run test:m8-5`、`npm run test:m9-23`、`npm run test:m9-24`。

**部署后 Owner Gateway 冒烟（M9-24）**（`PAGES_URL` 为 Pages 生产地址，需已登录 JWT）：

```powershell
curl.exe -s "%PAGES_URL%/auth/login-params?username=admin"
curl.exe -s -H "Authorization: Bearer %OWNER_JWT%" "%PAGES_URL%/api/node-settings/follower-token-mode"
# M12-1 落地后补充：
# curl.exe -s -H "Authorization: Bearer %OWNER_JWT%" "%PAGES_URL%/auth/totp/status"
```

预期：JSON `{ ok: true, ... }`；缺 binding/secret 时为 503 + `OWNER_GATEWAY_BINDING_MISSING` / `INTERNAL_FORWARD_SECRET_MISSING`。

---

## 升级与数据安全（M8-3）

站主重复部署（`git pull` + `npm run deploy:all`）**不会**删除 D1 数据或 Cloudflare Secret。详见 [`升级验证.md`](./升级验证.md)。

| 命令 | 用途 |
|------|------|
| `npm run smoke:remote` | 升级后 HTTP 冒烟 |
| `npm run smoke:m6-4-e2e` | M6-4 跨仓黑名单 E2E（registry 封禁 → Worker A 同步 → Worker B 403） |
| `npm run verify:upgrade:local` | 本地 D1 重复 migration 模拟 |
| `npm run test:m8-3` | 仓库「禁止删库」静态契约 + 可选本地模拟 |
| `npm run verify:url-change-notify` | 换域通知 outbox 真机 E2E（lease 租约 / 失败退避 / sent；结束自动清理 e2e_ 行） |
| `npm run test:migration-coverage` | 门禁：代码引用的表/列必须在该 binding 的 `db/migrations-*` 目录里（`deploy-all.ps1` Phase 3.5 已内置） |

### 进阶：PowerShell `deploy-all.ps1`（M8-6）

```powershell
Copy-Item scripts\cloudflare-api-token.example.json scripts\cloudflare-api-token.json
# 填写后：
.\scripts\deploy-all.ps1
```

子脚本：`bootstrap-hailuo-cloudflare.ps1`（资源 + Secret）、`deploy-hailuo-workers.ps1`（A→B）。  
详见 [`部署指南.md` §8](./部署指南.md#8-进阶powershell-一键部署m8-6可选)。  
契约：`npm run test:m8-6`。

**Cron 槽位（M9-22）**：Worker A 仅占用 **1 条**账号 Cron（`* * * * *`）；原每 5 分钟任务在 `scheduled` 内用 `minute % 5 === 0` 分支。同账号多节点时仍可用 `deploy-all-many-node.ps1` 的 `CRON_ENABLED=false` 进一步省槽；重复 `deploy-all.ps1 -New` 不删旧 Worker 仍会占槽，需手动清理废弃 Worker A。

**Cron 错峰与外部 fetch 预算（M13-2 + M13-10 + M13-19 / M13-19b）**：`runRotatedHourlyGc` 按 UTC 分钟切片——**0～5 纯 D1 GC（不占外部 50 池）**；**minute 7 = 存储用量校准**（Filebase/B2/R2 可能外部 HTTP，**禁止**再挂偶数分钟与 Feed 并行）。兼容入口仍保留 `runHourlyGcSerial`。重任务经 `runCronBudgeted` **串行**执行并打 `[cron/budget]` 日志（`externalBudgetProvenance=estimated_not_measured`）。进块条件：`minute % 2 === 0`（Feed）或 `minute % 5 === 0`（群/黑名单/探针等）；**禁止**把 Feed 与其它外部任务拆成并行 `waitUntil`（会叠加撞 50 子请求）。

**注册中心 daily-sync（M-DS-V2-1b）**：不再挂在 `cronBudget`；`scheduled` 在早退前每分钟读 `system_config.daily_sync_utc_second_of_day`，命中分配 UTC 分钟后 `waitUntil` 延迟到秒内执行 `syncRegistryDaily`（详见 [`m-ds-v2-daily-sync-schedule-plan.md`](./m-ds-v2-daily-sync-schedule-plan.md)）。错峰表：

| 任务 | 触发分钟 | 外部 fetch 估算 |
|---|---|---|
| feed 聚合 | `minute % 2 === 0`（每 2 分钟） | ≤40；`feed:latest` 内容指纹未变则跳过 KV put |
| **群专槽**（sync/outbox/mirror/GC/本地黑名单等） | `5/15/25/35/45`（`%5` 且奇数，**无 Feed**） | 群外部合计可吃满池，不再被 Feed defer |
| outbound 重试 / 推荐 TTL 兜底 | `:05` `:35` | 1～3 + 推荐 ≤1 |
| R2/B2/Filebase 探针 | `:10` `:40` | 3（与 Feed 同分钟时可 defer） |
| 纯 D1 GC 切片 | `:00`～`:05` | 0（不占外部池） |
| 存储用量校准（Filebase/B2/R2） | `:07`（非 heavy） | 视后端；B2 List 可多页，故独享分钟 |

验证：`node apps/worker-a/scripts/test-cron-budget-logic.mjs`；生产 `wrangler tail` 搜 `[cron/budget]`。M-DS-V2 operator 见 [`m-ds-v2-3-operator-e2e.md`](./m-ds-v2-3-operator-e2e.md) · `npm run test:m-ds-v2-3`。

**同账号互相关注拉 Feed（M9-18c）**：Worker A Cron 通过公网 `fetch()` 拉其它节点的 Worker B `/posts`。同一 Cloudflare 账号下默认同域 fetch 会触发平台 **1042**（日志表现为 HTTP 404 + 响应 `error code: 1042`，浏览器直访却正常）。`apps/worker-a/wrangler.toml` 已启用 `compatibility_flags = ["nodejs_compat", "global_fetch_strictly_public"]`；若你本地模板较旧，补上后 **仅 redeploy Worker A** 即可（不必 redeploy 被关注的 Worker B）。

**compatibility_date（EXP-COMPAT-1n）**：Worker A/B 与注册中心 gateway 对齐为 `2026-04-18`（原节点 `2024-09-23`，差 >90 天）。升级模板后 **redeploy Worker A 与 Worker B** 生效；**不要**为对齐日期而删掉 `global_fetch_strictly_public`。

**外部读鉴权（M14 五档）**：Worker B 读帖保护 canonical 为 `public-read` / `token-required` / `following-only` / `mutual-only` / `owner-only`（遗留 env `enforced` 读作 `following-only`）。`public-read` 下可匿名读 `/posts` 等端点；protected 档需有效粉丝 Token（含 `read_scope` claim）。升档前建议先开媒体票据（见上节「SEC-6-OPS」）。`mutual-only` 申请 Token 时须携带读者 Worker A 签发的 `read_mutual_proof`（Cron `feedFetch` 与 Web `ensureFollowerToken` 在 `NOT_MUTUAL_FOLLOW` 时自动重试）。站主 Web 在 protected 档下本节点 For you 本地帖走 Worker A JWT 直读。部署检查：protected 响应须 `private, no-store` + `Vary: Authorization`；黑名单命中 `BLACKLISTED`。详见 [`m14-read-protection-plan.md`](./m14-read-protection-plan.md)。

### M6-4 · 注册中心全局黑名单同步（跨仓 M24-1）

| 步骤 | 注册中心（hailuo-registry） | 海螺节点（本仓库） |
|------|---------------------------|-------------------|
| D1 migration | `0024_node_blacklist.sql` | Worker A `0032_registry_blacklist_sync.sql` |
| 部署 | `registry-gateway` wrangler deploy | Worker A + Worker B deploy |
| 验证 | `npm run smoke:m24-1:local`（管理 API） | `npm run test:m6-4` + `npm run smoke:m6-4-e2e`（跨仓 E2E） |

要点：
- **主路径（M-DS-1）**：Worker A `syncRegistryDaily` 响应中的 `blacklist` 块经 `applyRegistryBlacklistFromDailySync` 写入 `STATE_KV` 键 `blacklist:registry:<url>`（约每天一次；`unchanged`/etag 时跳过 KV 写）。
- **独立 `GET /api/blacklist`（`syncRegistryBlacklistToKv`）**：保留供手动/测试/调试，**不再**挂整点 Cron（避免与 daily-sync 双拉打爆注册中心与 KV 预算）。
- 与 M6-3 本地拉黑键 `blacklist:local:` **分离**；Worker B 读侧三前缀顺序探测（见 `docs/worker-b-api.md`）。
- 计划全文：[`m6-4-registry-blacklist-plan.md`](./m6-4-registry-blacklist-plan.md)（§4.2 Cron 已被 M-DS supersede）；注册中心 API：[`hailuo-registry/docs/admin-api.md`](../../hailuo-registry/docs/admin-api.md) §节点黑名单。

```powershell
# 节点侧（Worker A：A7-DB-RETIRE 后无 binding=DB；按需 apply 三库 + 搬家 staging）
npm exec -- wrangler d1 migrations apply IDENTITY_DB --remote --config apps/worker-a/wrangler.toml
npm exec -- wrangler d1 migrations apply GOVERNANCE_DB --remote --config apps/worker-a/wrangler.toml
npm exec -- wrangler d1 migrations apply CONTENT_DB --remote --config apps/worker-a/wrangler.toml
# 搬家 staging（可选）：npm exec -- wrangler d1 migrations apply DB_IMPORT --remote --config apps/worker-a/wrangler.toml

# 注册中心侧（在 hailuo-registry 仓库）
npm exec -- wrangler d1 migrations apply DB --remote --config workers/registry-gateway/wrangler.toml
```

---

## 首次部署步骤

### 1. 环境准备

```powershell
# 安装依赖
npm install

# 登录 Cloudflare（用户自己的账号）
npm exec -- wrangler login
```

### 2. 创建 Cloudflare 资源

#### 2.1 资源命名规则（binding vs Cloudflare 控制台名）

| 层级 | 示例 | 说明 |
|------|------|------|
| **binding**（代码/wrangler 固定） | `DB`、`MESSAGING_DB`、`POSTS_CACHE_KV` | 全节点统一；**不含** 6 位同组码 |
| **Cloudflare 资源名**（控制台可见） | `hailuo-node-db-8226e6` | bootstrap / 多节点脚本自动生成；**含** `DEPLOY_GROUP_CODE`（6 位 hex） |

**bootstrap / `deploy-all-many-node.ps1` 默认 Cloudflare 名称**（有 `DEPLOY_GROUP_CODE` 时）：

| 资源 | Cloudflare 名称模式 | 示例 |
|------|---------------------|------|
| 主 D1 | `hailuo-node-db-{同组码}` | `hailuo-node-db-8226e6` |
| 搬家 staging D1（M9-7-S2 · `DB_IMPORT`） | `hailuo-node-db-{同组码}-import` | `hailuo-node-db-8226e6-import` |
| 会话 D1（M16 · `MESSAGING_DB`） | `hailuo-node-db-{同组码}-messaging` | `hailuo-node-db-8226e6-messaging` |
| 群消息分片 D1（M16-P · `MESSAGING_SHARD_1`） | `hailuo-node-db-{同组码}-messaging-shard-1` | `hailuo-node-db-8226e6-messaging-shard-1` |
| KV posts | `worker-hailuo-node-{同组码}-posts-cache` | … |
| KV image | `worker-hailuo-node-{同组码}-image-kv` | … |
| KV state | `worker-hailuo-node-{同组码}-state-kv` | … |

> ⚠️ **历史例外（M-NAMING-D1-1）**：存量节点已用 `hailuo-node-messaging-db-{同组码}` / `hailuo-node-messaging-shard-1-{同组码}` 落地，**不 rename**（D1 无 rename API，全量迁移风险高）。**新拆分片**（`MESSAGING_SHARD_2` 起的 overflow）按上行新约定；bootstrap / `migrate-group-messages-to-shard.mjs` 同时兼容两种命名。
>
> 命名约定（**仅新**）：`<prefix>-db-<同组码>-<group>`，group 全小写连字符（`messaging` / `messaging-shard-1` / `import` …）；与 `binding` 名 `{GROUP}_DB` 大写下划线一一对应。

无同组码的手动部署可用短占位名（本地 dev）：`node-db`、`messaging-db`、`hailuo-node-posts-cache` 等。

```powershell
# 创建 D1 主库（Worker A · DB binding）
# bootstrap 生产名示例：hailuo-node-db-8226e6
npm exec -- wrangler d1 create node-db --config apps/worker-a/wrangler.toml
# 输出：database_id = "xxx"，回填 wrangler.toml [[d1_databases]] binding=DB

# 创建搬家 staging D1（M9-7-S2 · DB_IMPORT；正规 import 只写此库）
# 生产名示例：hailuo-node-db-8226e6-import
npm exec -- wrangler d1 create hailuo-node-db-8226e6-import --config apps/worker-a/wrangler.toml
# 回填 binding=DB_IMPORT 的 database_id；migrations 与主库相同：
# npm exec -- wrangler d1 migrations apply DB_IMPORT --local --config apps/worker-a/wrangler.toml
# npm exec -- wrangler d1 migrations apply DB_IMPORT --remote --env production --config apps/worker-a/wrangler.toml

# M9-7-S4：staging 对账通过（import_ready=true）后，本机切流（B1，不自动 deploy）
# powershell -NoProfile -ExecutionPolicy Bypass -File scripts/cutover-db-import.ps1
# 回滚：… -File scripts/cutover-db-import.ps1 -Rollback
# 已用 GET /api/node/import-status 确认时可加 -SkipReadyCheck；演练加 -DryRun

# 创建会话 D1（M16 · MESSAGING_DB = DM + 群聊）
# bootstrap 生产名示例：hailuo-node-db-8226e6-messaging（新约定）；历史 `hailuo-node-messaging-db-8226e6` 已落地不 rename
npm exec -- wrangler d1 create hailuo-node-db-8226e6-messaging --config apps/worker-a/wrangler.toml
# 输出：database_id = "yyy"，回填 wrangler.toml binding=MESSAGING_DB

# 群消息 overflow 分片 D1（M16-P · MESSAGING_SHARD_1）
# bootstrap 会自动创建并回填；生产名示例：hailuo-node-db-8226e6-messaging-shard-1（新约定）
# 历史 `hailuo-node-messaging-shard-1-8226e6` 已落地不 rename
# M16-P4（已落地）：primary 估算 ≥400 MB（hard）时 Worker A Cron 自动按群 batch 迁移至 MESSAGING_SHARD_1；
#   默认开启（有 binding 且 MESSAGING_AUTO_SHARD_ENABLED≠false）；可选手工插队：
#   node scripts/migrate-group-messages-to-shard.mjs --group-id grp_xxx --remote --env production
# 契约：npm run test:m16-p4；可选 local D1 向量：npm run test:m16-p4-local
# 详见 docs/m16-p4-auto-shard-plan.md

# 创建 KV namespace（两个 Worker 共享；bootstrap 用 worker-hailuo-node-{同组码}-* 长名）
npm exec -- wrangler kv namespace create "POSTS_CACHE_KV"
# 输出：id = "xxx"，回填到两个 wrangler.toml

npm exec -- wrangler kv namespace create "IMAGE_KV"
# 输出：id = "xxx"，回填到两个 wrangler.toml

npm exec -- wrangler kv namespace create "STATE_KV"
# 输出：id = "xxx"，回填到 worker-b 的 wrangler.toml
```

#### 2.2 可选图片对象库（M8-14 · 命名防误删 + 分流）

Workers Builds、GitHub Actions、本机 `deploy-all` 在 D1/KV 回填之后会**尝试**建一个 R2 桶，并只在本次部署的 `[env.production]` 里绑上。建不成就跳过，节点照常用 KV。仓库主分支 **不**把这个绑定写死；桶名和绑定真值不进 git。计划 SSOT：[`m8-14-optional-r2-bootstrap-plan.md`](./m8-14-optional-r2-bootstrap-plan.md)。

控制台里请认这三样，**前两样不要删**：

| 控制台里的名字 | 是什么 | 能不能删 |
|---|---|---|
| 绑定 `HAILUO_IMAGE_R2` | 海螺节点媒体库（图 / 视频 / 文件）。Worker A 与 Worker B 绑**同一个**桶 | **勿删**。删了之后大文件写不进去，已经记成 `r2:` 的对象也读不出来 |
| 桶 `hailuo-node-media-{6位组码}` | 同上。例：`hailuo-node-media-8226e6`。下次同组码部署会**复用**，不会另起新桶 | **勿删**。名字带 `hailuo-`，就是为了和别的桶分开，避免手滑删掉 |
| KV `…-image-kv` / 绑定 `IMAGE_KV` | 小图柜。多数帖子图在这里，不在 R2 | **勿删**。删了旧帖图片会丢 |

口诀：`HAILUO_IMAGE_R2` / `hailuo-node-media-*` = 海螺节点媒体库，**勿删**。桶名只用组码，不含站主真名或邮箱。

**什么时候进 KV、什么时候进 R2**（没绑上 R2 时，下面的「进 R2」不会发生；超过 KV 能收的文件会直接失败并提示去配云存储）：

| 条件 | 写到哪 |
|---|---|
| 图片，且不超过约 10 MB，KV 还没到高水位 | `IMAGE_KV`（键以 `kv:` 开头） |
| 更大的图，或视频 / 压缩包等非图片 | R2（键以 `r2:` 开头） |
| KV 用到约 90%，且 R2 可用 | 之后的新文件改写 R2（含小图）。**不会**把已经在 KV 里的旧图搬走 |
| R2 用到约 90% | 定时任务只删可回收的最旧对象，清到约 70%。仍被帖子或私信引用的不删 |
| 群图 | 只走云（R2 / B2 / Filebase），不进 KV |

阈值可以在设置页「媒体存储」改，保存后写进本节点数据库，立刻影响新上传和下一次清理，不必重新部署。部署脚本**不会**把存储模式写成「只用 R2」。

不想建桶：部署前设 `SKIP_R2=1`。已有桶、只复用不新建：`SKIP_CREATE=1`。探测或创建失败只记一条跳过，后面的 Worker / Pages 照常部署。

### 3. 生成密钥对

```powershell
node scripts/generate-keys.mjs
# 输出：ED25519_PRIVATE_KEY 和 ED25519_PUBLIC_KEY
# 将 PUBLIC_KEY 写入 wrangler.toml 的 [vars]
# 将 PRIVATE_KEY 通过 wrangler secret put 配置（下一步）
```

### 4. 配置 Secrets

> **必读**：[`INTERNAL_FORWARD_SECRET 同步（A = B = Pages）`](#internal_forward_secret-同步a--b--pages) —— 一次生成、双端（及 Pages）同值；推荐 `put-worker-secrets.mjs` 一键回填，避免只配 A 漏配 B。

```powershell
# Worker A Secrets
npm exec -- wrangler secret put ED25519_PRIVATE_KEY --env production --config apps/worker-a/wrangler.toml
npm exec -- wrangler secret put JWT_SECRET --env production --config apps/worker-a/wrangler.toml
# INTERNAL_FORWARD_SECRET：先生成一次，A/B 粘贴同一值（或走 put-worker-secrets.mjs）
npm exec -- wrangler secret put INTERNAL_FORWARD_SECRET --env production --config apps/worker-a/wrangler.toml
npm exec -- wrangler secret put TOTP_WRAP_SECRET --env production --config apps/worker-a/wrangler.toml
npm exec -- wrangler secret put NODE_API_TOKEN_WRAP_SECRET --env production --config apps/worker-a/wrangler.toml
npm exec -- wrangler secret put GROUP_OWNER_KEY_WRAP_SECRET --env production --config apps/worker-a/wrangler.toml

# P0-2（12-anti-deanonymization always-on）：生产子域禁止硬编码 wrangler.toml，改为 secret 注入
npm exec -- wrangler secret put WORKER_B_URL --env production --config apps/worker-a/wrangler.toml
# 值：本节点 Worker B 的 https 基址（部署后由 ci-finalize-urls / 控制台复制，勿提交 git）
npm exec -- wrangler secret put WORKER_A_ORIGIN --env production --config apps/worker-a/wrangler.toml
# 值：本节点 Pages https 基址（同上，勿提交 git）

# Worker B Secrets
# INTERNAL_FORWARD_SECRET 必须与 Worker A（及 Pages）完全相同 —— 见上一节「同步」
npm exec -- wrangler secret put INTERNAL_FORWARD_SECRET --env production --config apps/worker-b/wrangler.toml
# P0-2：Worker B 同样注入 WORKER_A_ORIGIN（与 A 同值）
npm exec -- wrangler secret put WORKER_A_ORIGIN --env production --config apps/worker-b/wrangler.toml

# MEDIA_TICKET_SECRET：正常走部署脚本幂等注入，无需手 put。
# 仅排障/轮换时：FORCE_MEDIA_TICKET_SECRET=1 或手动：
# npm exec -- wrangler secret put MEDIA_TICKET_SECRET --env production --config apps/worker-b/wrangler.toml
```

#### 升档与媒体票据（SEC-6-AUTO + SEC-6-SECRET）

> **部署自动注入密钥，切档自动开关能力**：`MEDIA_TICKET_SECRET` 由 `deploy:ci` / 本机一键（`put-worker-secrets` / bootstrap）**首次生成并 put 到 Worker B**；同账号再部署 **已存在则跳过**。Settings 切到保护三档 → 票据开；切回 `public-read` → 关。`owner-only` 不走 B 粉丝读图票据。约 45s 生效。  
> 读帖档默认 `token-required`（站主可在 Settings 放宽）；确认保护档下已注入 `MEDIA_TICKET_SECRET`。`MEDIA_TICKET_ENABLED=false` 仅紧急关闸。

1. 正常部署一次（Git `deploy:ci` 或本机一键）→ 自动确保 `MEDIA_TICKET_SECRET`。
2. 本地联调：`.dev.vars` 可填 `MEDIA_TICKET_SECRET=...`（与生产 Secret 分离）。
3. Web **设置 → 读帖保护** 选目标档。
4. 冒烟：保护档下 `POST /api/media/tickets` → 200；`public-read` → `MEDIA_TICKET_DISABLED`。

#### 站主凭证与密码重置（OWNER-RESET-GUARD）

> **部署永不改你已设置的站主密码**。`deploy-all` / `deploy-hailuo-workers` 里的播种只走 `seed-default-owner.mjs --if-empty`：`owner_credentials` 已有行就整段跳过；部署卡片上的 `admin/admin` 只是**首次**默认值。

- 部署前会跑 `verify-owner-login.mjs` 用 token 里的凭证试登录：
  - 通过 → 打印 `OK owner credentials seeded`；
  - 不通过（多半是你已改过密码、token 仍是 admin/admin）→ **只告警，不重置、不中断部署**。
- 确实忘记密码要重置时，二选一（都会**换全新 salt**）：
  ```powershell
  .\scripts\reset-owner-login.ps1                 # 显式重置为 token 里的凭证
  .\scripts\deploy-all.ps1 -ForceResetOwnerCredentials  # 授权本次部署重置
  ```
- 重置的后果（脚本已内置处理）：
  - `DELETE owner_credentials` + `DELETE owner_sessions` → 旧 JWT 立即失效；
  - `owner_must_change_credentials` 强制置 `true` → 下次登录必须改密；
  - **旧 `owner_wrapped_vault` 因 salt 变化永久解不开** → 登录或改密时客户端会**自动重建**保险箱，站主无需操作；仅自动重建遇到网络失败时设置页才出现一次「重试修复保险箱」。
- 能正常登录时**不要**重置；也不要把 `reset-owner-login.ps1` 放进任何自动流程。
- 你改过密码后，建议同步更新 `cloudflare-api-token.json` 的 `OWNER_LOGIN_PASSWORD`（只影响部署自检/冒烟，不影响站点）；不同步只会让每次部署打印一条"卡片凭证无法登录"的告警。

### 5. 配置 wrangler.toml

在两个 Worker 的 wrangler.toml 中回填真实的资源 id：

```toml
# apps/worker-a/wrangler.toml（示例）
[[d1_databases]]
binding = "DB"
database_name = "node-db"
database_id = "<真实 database_id>"

[[d1_databases]]
binding = "MESSAGING_DB"
database_name = "hailuo-node-messaging-db-<同组码>"
database_id = "<会话库 database_id>"
migrations_dir = "db/messaging-migrations"

[[kv_namespaces]]
binding = "POSTS_CACHE_KV"
id = "<真实 KV id>"

[[kv_namespaces]]
binding = "IMAGE_KV"
id = "<真实 KV id>"

[vars]
# F-07：此处填安全占位，禁止写成「你的真 handle」
BOOTSTRAP_HANDLE = "usr_alice_placeholder"
# WORKER_B_URL / WORKER_A_ORIGIN：经 wrangler secret put 注入（见上方 §4），禁止硬编码
REGISTRY_URL = "https://hailuo-registry.example.com"
# M9-PH-TA：REGISTRY_URL 仅为候选；落库 [0] 前须过钉死主中心公钥验签（见下文 §主中心信任锚）
# M9-PH-TA-3 / BI-6：勿设 BACKUP_REGISTRY_URL；未登记走入口；已登记联邦备用才消费 add_registry
ED25519_PUBLIC_KEY = "<公钥 hex>"
FEED_VIA_QUEUE = "false"
```

### 主中心信任锚（M9-PH-TA · 开源后必读）

> 计划 SSOT：[`m9-ph-trust-anchor-plan.md`](./m9-ph-trust-anchor-plan.md)  
> 代码常量：`apps/worker-a/src/lib/primaryRegistryTrustAnchor.ts`

开源后，任意人可改 `REGISTRY_URL` 冒充「官方主注册中心」。节点仓因此**钉死**官方主中心（`reg1`）Ed25519 **公钥**（仅公钥；私钥永不进仓）。

| 规则 | 说明 |
|------|------|
| `REGISTRY_URL` | 仅**候选**引导 URL；冷启动 / migrate / 改 URL 时必须 `GET /.well-known/hailuo-registry-identity`，用钉死公钥验 `REGISTRY_IDENTITY_V1`，且 `registry_id=reg1`、响应公钥与锚点一致；**contact 须落在 allowlist**（正式域或官方 workers.dev，见 M9-AUDIT-1） |
| 失败 | 拒绝落库为 `[0]`（`REGISTRY_TRUST_ANCHOR_MISMATCH` 等）；**禁止**官方链 HTTPS TOFU；**禁止**任意自定义域借官方签名 identity 过闸 |
| 备用中心 | **禁止** env 裸写备用 URL；**未登记**走海螺入口（`active_intake`），**不**用 `add_registry` 开窗；**已登记**联邦备用才消费主中心签名的 `add_registry`（`REGISTRY_DIRECTIVE_V1`），且 `[0].trust_pubkey` 须先等于锚点 |
| 序号 | 主中心固定 `reg1`；备用 `reg2+` 由主中心在 JOIN 批准时分配（注册中心配对 `M23-PH-TA-*`） |

**站主（跟随官方联邦）**：保持默认 `REGISTRY_URL=https://hailuo-registry.allovo.eu.org`；**不要**改源码里的锚点公钥 / allowlist。若曾误配非官方域并成功 migrate，应改回正式域并**轮换 `node_api_token`**。

**Fork 自建联邦（换锚）**：

1. 自建主注册中心，确认 `REGISTRY_ID=reg1`，并发布 `/.well-known/hailuo-registry-identity`  
2. 导出主中心 Ed25519 **公钥**（raw 32B base64）  
3. 在 fork 中整体替换 `PRIMARY_TRUST_PUBKEY_B64` / `PRIMARY_REGISTRY_DEFAULT_URL` / `PRIMARY_REGISTRY_WORKERS_DEV_URL` / `PRIMARY_REGISTRY_CONTACT_ALLOWLIST`（及钉死日注释）  
4. 将 `REGISTRY_URL` 指到自建主中心并 redeploy；首次 migrate 须过**新**锚点验签  
5. **不得**保留官方公钥却把 URL 指到自建中心（或反之）——那会验签失败；换锚 = **另起生态**，不得冒充官方 `reg1`

密钥轮换：官方更换主中心密钥时，须发**新版节点**（可过渡期双公钥，属后续步）；站主升级 Worker A 即可。

站主 FAQ 见 [`部署指南.md`](./部署指南.md)「注册中心信任锚是什么？改 REGISTRY_URL 够不够？」。

### 6. 应用 D1 Migration

```powershell
# 先 preview，验证通过再 production
# A7-DB-RETIRE：无 binding=DB；业务三库 + 搬家 staging
npm exec -- wrangler d1 migrations apply DB_IMPORT --remote --env preview --config apps/worker-a/wrangler.toml
npm exec -- wrangler d1 migrations apply IDENTITY_DB --remote --env preview --config apps/worker-a/wrangler.toml
npm exec -- wrangler d1 migrations apply GOVERNANCE_DB --remote --env preview --config apps/worker-a/wrangler.toml
npm exec -- wrangler d1 migrations apply CONTENT_DB --remote --env preview --config apps/worker-a/wrangler.toml
npm exec -- wrangler d1 migrations apply DB_IMPORT --remote --env production --config apps/worker-a/wrangler.toml
npm exec -- wrangler d1 migrations apply IDENTITY_DB --remote --env production --config apps/worker-a/wrangler.toml
npm exec -- wrangler d1 migrations apply GOVERNANCE_DB --remote --env production --config apps/worker-a/wrangler.toml
npm exec -- wrangler d1 migrations apply CONTENT_DB --remote --env production --config apps/worker-a/wrangler.toml

# 会话库 messaging-db（M10 dm_* + M16 group_* · messaging-migrations/）
npm exec -- wrangler d1 migrations apply MESSAGING_DB --remote --env preview --config apps/worker-a/wrangler.toml
npm exec -- wrangler d1 migrations apply MESSAGING_DB --remote --env production --config apps/worker-a/wrangler.toml
```

**Messaging Media 可选变量**（MM-2 编码后生效；默认见 [`m10-p2-dm-media-plan.md`](./m10-p2-dm-media-plan.md) v1.3）：

| 变量 / `system_config` 键 | 默认 | 说明 |
|---------------------------|------|------|
| `MESSAGING_MEDIA_MAX_BYTES` | `10485760`（10 MB） | 单图上限 |
| `MESSAGING_MEDIA_MAX_PER_MESSAGE` | `4` | 单条消息图片数 |

**M16-P4 自动分片可选变量**（默认见 [`m16-p4-auto-shard-plan.md`](./m16-p4-auto-shard-plan.md) §11）：

| 变量 | 默认 | 说明 |
|------|------|------|
| `MESSAGING_AUTO_SHARD_ENABLED` | 开启（有 `MESSAGING_SHARD_1` 且 ≠ `false`） | 设为 `false` 关闭 Cron/新群自动卸货 |
| `MESSAGING_AUTO_SHARD_TIER` | `hard`（400 MB） | 仅运维显式设 `warn` 可提前触发 |
| `MESSAGING_AUTO_SHARD_BATCH_ROWS` | `100` | Cron 每 tick 每群搬迁行数上限 |

群图发送须已配置 Filebase/B2/R2（probe=ok）；无云时 API 返回 `GROUP_MEDIA_CLOUD_REQUIRED`。

### 7. 部署顺序

```powershell
# 先 Worker A（写层）
npm exec -- wrangler deploy --env production --config apps/worker-a/wrangler.toml

# 再 Worker B（读层）
npm exec -- wrangler deploy --env production --config apps/worker-b/wrangler.toml

# 最后 Web 前端（构建后部署）
npm run build --workspace=web
npm exec -- wrangler pages deploy web/dist --project-name hailuo-web
```

---

## 部署前 Checklist

- [ ] `npm run typecheck` 全部通过
- [ ] **git 中的** Worker A/B `wrangler.toml` 仍是 `*-prod-placeholder`（`npm run check:wrangler-placeholders`）；**不要**手改成生产真值再提交。部署脚本会在现场 patch 真 id
- [ ] 所有 Migration 已在 preview 环境 apply
- [ ] Secrets 已通过 `wrangler secret put` 配置
- [ ] `WORKER_B_URL` 和 `REGISTRY_URL` 已填写（或由 finalize / secret 注入，勿硬编码进 git）
- [ ] 本地冒烟 `npm run smoke:local` 全部 PASS
- [ ] 若控制台已有 `hailuo-node-media-*` / 绑定 `HAILUO_IMAGE_R2`：**不要删**（见 §2.2）

### 部署后：还原占位，禁止把真值推进 GitHub（P1-4）

正式流程：**仓库占位 → bootstrap/deploy 现场 patch → 部署 → 工作区还原占位**。

**已自动**：下列入口在**部署成功收尾**会调用 `npm run restore:wrangler-placeholders`（真值进已 ignore 的 `*.bak`，工作区 toml 还原 git 占位）：

- `.\scripts\deploy-all.ps1`（Phase 7）
- `npm run deploy:ci`（`ci-deploy-all.mjs`）
- `npm run deploy:all`（`deploy-all.mjs`）

自动还原失败时**不回滚 Cloudflare**（资源已上线），只会警告；请立刻手动补跑：

```powershell
npm run restore:wrangler-placeholders
# 只检查（exit 1 = 仍有真值脏，勿 commit）
npm run check:wrangler-placeholders
```

- 脚本会把当前脏 `wrangler.toml` 备份到 `apps/worker-a/wrangler.toml.bak` / `apps/worker-b/wrangler.toml.bak`（已在 `.gitignore`），再 `git checkout HEAD` 还原占位。
- **永远不要** `git add` 这两个 toml 的真值 diff，也**不要**提交 `.bak`。
- 本机还要反复 redeploy：可保留 `.bak` 作对照；下次仍从占位起步，让脚本再 patch。
- 若你**只**跑了 bootstrap / 单独 `wrangler deploy` 而未走上述一键入口，仍须**手动**还原。

---

## BRAND-2：DID 前缀存量迁移（operator）

若节点曾以 `did:sayfree:` 写入 `system_config.did_v2`，在部署含 `did:hailuo:` 的 Worker 后执行：

```powershell
# 预览
node scripts/migrate-did-sayfree-to-hailuo.mjs
# 确认后写入
node scripts/migrate-did-sayfree-to-hailuo.mjs --apply
```

脚本读 `scripts/cloudflare-api-token.json`，对生产 D1 做远程 UPDATE。无 `did_v2` 或已是 `did:hailuo:` 时安全跳过。

---

## 部署后冒烟（M8-2）

### 一键脚本（推荐）

```powershell
$env:WORKER_B_URL = "https://hailuo-worker-b.<子域>.workers.dev"
$env:WORKER_A_URL = "https://hailuo-worker-a.<子域>.workers.dev"
$env:BOOTSTRAP_HANDLE = "<你的 handle>"
# 可选：Pages、注册中心、登录与发帖
$env:PAGES_URL = "https://<pages>.pages.dev"
$env:SMOKE_OWNER_SECRET = "<JWT_SECRET>"   # 或 SMOKE_OWNER_USERNAME + SMOKE_OWNER_PASSWORD
# $env:SMOKE_POST = "1"                      # 登录后发帖并在 B 读回（会写 D1）

npm run smoke:remote
```

> **OPS-REDEPLOY-AB-SMOKE-1（生产推荐）**：Worker A `workers.dev` 常关闭，直连 A 的 `smoke:remote` 段会假失败。已有本机 `wrangler.toml.bak` + `scripts/cloudflare-api-token.json` 时用：
>
> ```powershell
> npm run ops:redeploy-ab-smoke          # bak→deploy A/B→还原占位→冒烟
> npm run ops:redeploy-ab-smoke:smoke-only  # 仅冒烟（B 公开 + Pages 登录/发帖/读回）
> ```
>
> 冒烟断言：A 公网非 `worker-a` JSON 为通过；写层走 Pages Owner Gateway；读回认列表或 `GET /posts/:id`。

契约自检（无需真实 URL）：`npm run test:m8-2`

帮助：`node scripts/smoke-remote.mjs --help`

### 加好友 friend-requests（M17-3）

跨节点加好友依赖：**对端公开 Worker B**（`POST /friend-requests/inbox|outbox`）+ 对端本机 Worker A Service Binding（HMAC v2）。站主开关默认开：

- D1：`system_config.friend_requests_inbox_enabled`（缺省视为 `true`）
- 写层：`GET/PATCH /api/node-settings/friend-requests` → `{ allow_incoming }`
- Web：Settings「允许陌生人发起加好友请求」可一键关闭（`allow_incoming=false` → 对端 inbox 返 `INCOMING_DISABLED`）

**双节点联调 smoke**（假定两端已部署/已在跑，**不**自动起 wrangler）：

| 变量 | 含义 |
|------|------|
| `NODE_A_WORKER_A_URL` / `NODE_B_WORKER_A_URL` | 两端写层（JWT） |
| `NODE_A_WORKER_B_URL` / `NODE_B_WORKER_B_URL` | 两端公开 Worker B（须与各自 `/auth/me.worker_b_url` 一致） |
| `NODE_A_USERNAME` / `NODE_A_PASSWORD` | 节点 A 站主 |
| `NODE_B_USERNAME` / `NODE_B_PASSWORD` | 节点 B 站主 |

```powershell
# 可用「同账号批量部署多个测试节点」（下文）得到两套 URL；或两套远程生产节点
$env:NODE_A_WORKER_A_URL = "https://…-worker-a….workers.dev"
$env:NODE_B_WORKER_A_URL = "https://…-worker-a….workers.dev"
$env:NODE_A_WORKER_B_URL = "https://…-worker-b….workers.dev"
$env:NODE_B_WORKER_B_URL = "https://…-worker-b….workers.dev"
$env:NODE_A_USERNAME = "admin"
$env:NODE_A_PASSWORD = "…"
$env:NODE_B_USERNAME = "admin"
$env:NODE_B_PASSWORD = "…"

npm run smoke:m17-3
```

缺 env 时脚本 **exit 2**（不假装通过）。静态契约（无需双节点）：`npm run test:m17-3`。API 见 [`worker-a-api.md`](./worker-a-api.md)「加好友」与 [`worker-b-api.md`](./worker-b-api.md) inbox/outbox。

> **M17-FIX-5**：第 6 步互粉判定**必须**两端 `GET /api/local/mutual-follows` 的 `items` 都含对方节点才算通过；**禁止**用单边 `/api/follows` 作 `||` 兜底（假阳性）。outbox 投递延迟靠轮询等待，超时即失败。

### 多注册中心 E2E（M9-3-B6）

节点已在主注册中心登记、管理后台已配置「推荐备用中心」后：

```powershell
$env:REGISTRY_URL = "https://hailuo-registry.<domain>"
$env:NODE_API_TOKEN = "nat_..."
$env:NODE_USER_ID = "usr_..."
$env:ED25519_PRIVATE_KEY = "<节点私钥 hex>"
# 可选：管理后台 session Cookie → delivery_stats 观测
# $env:REGISTRY_ADMIN_COOKIE = "hailuo_admin_session=..."
# 可选：Worker B → 公开 registry 列表
# $env:WORKER_B_URL = "https://hailuo-worker-b.<subdomain>.workers.dev"

npm run smoke:m9-3-b-e2e
```

契约自检（无需真实 URL）：`npm run test:smoke-m9-3-b-e2e`  
帮助：`node scripts/smoke-m9-3-b-e2e.mjs --help`

脚本自动化注册中心 health directive 下发与 `known_registry_ids` 挡板；节点 Cron 落库 pending、Web append-complete 见脚本末尾人工清单。

---

## 节点换域部署清单（M7-30c）

> **业务 SSOT**：[`m7-30-node-url-change-plan.md`](./m7-30-node-url-change-plan.md) · **Settings 向导**：Web → 设置 → 节点换域  
> **运行时 SSOT（M7-30g）**：[`m7-30g-worker-b-url-d1-ssot-plan.md`](./m7-30g-worker-b-url-d1-ssot-plan.md) — confirm 后以 D1 + STATE_KV 为公开基址权威，**默认免 redeploy**  
> **粉丝感知（M7-30f）**：[`m7-30f-url-change-fan-notify-plan.md`](./m7-30f-url-change-fan-notify-plan.md) — 宽限期内**勿关**旧 Worker B 路由；旧址暴露 `GET /.well-known/hailuo-node-moved`（STATE_KV `node:url-moved`）；注册中心 lookup 仍即时切新，**不**存 `previous_node_url`  
> **注册中心契约**：[`hailuo-registry/docs/registry-api.md`](../../hailuo-registry/docs/registry-api.md) §`POST /api/node/url-change/*`

Phase 1 约定：`node_url` 与 `worker_b_url` **同值**（单一 HTTPS 公开读地址）；**不轮换** `node_api_token`；仅 **主注册中心** URL 更新，备用 registry 标记 `url_sync_state=stale`（Settings 成功页会提示）。

**M7-30g 目标态**：自定义域绑到**同一** Worker B → Settings 预检 → confirm → **结束**。不必改 toml、不必 `wrangler deploy`、不必 Pages 重新 build。本步 **不会自动改 wrangler** / Pages 环境变量——也不再需要为换域去改它们。

### Settings confirm 与 Cloudflare 部署的分工

| 阶段 | Settings / Worker A / 注册中心 | 仍须站主在 Cloudflare 做的 |
|------|------------------------------|------------------------------|
| **换域前** | — | 新 URL 已路由到 **同一** Worker B（自定义域或新 `*.workers.dev`） |
| **precheck** | 写 `REGISTRY_URL_CHANGE_PROOF_KV_KEY` | 可选：先验证 `GET {新URL}/health` |
| **confirm** | 注册中心 `users.node_url` + 本地 D1 `users` / `system_config` + STATE_KV canonical | **无**（已绑 Pages `STATE_KV` 时零 redeploy） |

### 公开基址权威 vs bootstrap env

| 层级 | 变量 / 配置 | 换域后 | 说明 |
|------|-------------|--------|------|
| **Worker A** D1 `system_config` | `node_url` / `worker_b_url` | confirm **已写入**（权威） | 热路径 `resolveLocalPublicBaseUrl` 读此，不信 wrangler |
| **STATE_KV** | `public:canonical_worker_b_url` | confirm **已写入** | Pages / Worker B 无 D1 时读此 key |
| **Worker A** `[env.production.vars]` | `WORKER_B_URL` | **可选对齐** | **仅 bootstrap / 灾难回落**；过时不更新也可运行 |
| **Cloudflare Pages** Production | `PUBLIC_WORKER_B_URL` | **可选对齐** | 构建期回落；已绑 `STATE_KV` 时公开代理不必改此变量或 redeploy Web |
| **部署 token**（可选） | `WORKER_B_URL` / `WORKER_B_HOST` | 下次 `deploy-all` / `finalize` 才需要 | finalize 写回的 `*.workers.dev` **仅 bootstrap**，不会覆盖 D1 SSOT |
| **本地 Web**（可选） | `web/.env.local` → `PUBLIC_WORKER_B_URL` | 新地址 | 本地 Pages gateway 联调 |

**换域后一般不改**（除非 Pages 本身也迁移域名）：

| 变量 | 原因 |
|------|------|
| `WORKER_A_ORIGIN` | 仍为 Pages 站点域名，供 Worker A CORS |
| `JWT_SECRET` / `ED25519_*` / `INTERNAL_FORWARD_SECRET` | 与域名无关 |
| `REGISTRY_URL` / `node_api_token` | Phase 1 不轮换 token；主 registry API 根不变 |
| D1 `database_id`、KV `id`、Service Binding **名称** | 资源 id 不变，只换公开 URL |

仍须 redeploy 的**例外**（不是每次换域）：

- 首次绑定 Pages `STATE_KV`（与 Worker A/B **同 namespace id**；属一次性基建，见上文 Pages 绑定检查）
- 修改 CORS `WORKER_A_ORIGIN`（仅当浏览器直连 A/B；现网 Owner Gateway 通常不必）
- 升级本计划相关代码版本本身
- **未绑** Pages `STATE_KV` 的旧部署：公开代理仍信构建期 `PUBLIC_WORKER_B_URL`，须改变量并 redeploy Web（一次性补绑后即免）

### confirm 前：Cloudflare 路由检查

1. **Worker B** 在 Cloudflare 控制台绑定**自定义域**，或确认目标 `https://<name>.<子域>.workers.dev` 即为新公开地址。
2. DNS / SSL 就绪后：`curl.exe -s "https://<新URL>/health"` → `{"ok":true,"service":"worker-b",...}`。
3. Settings **precheck 成功后**：`curl.exe -s "https://<新URL>/.well-known/hailuo-registry-proof"` → 纯文本 `<url_change_id>.<nonce>`（与 Settings 确认页一致）。
4. **confirm 成功后**（M7-30f-2）：`curl.exe -s "https://<旧URL>/.well-known/hailuo-node-moved"` → JSON `ok:true` + `data.new_node_url`；宽限期内旧路由勿关。
5. **Worker A** 仍不绑公网 Custom Domain；对外只宣传 Worker B / Pages。

### confirm 后：默认免 redeploy

confirm 成功即写入 D1 + `public:canonical_worker_b_url`。Worker A 热路径、Worker B `/users`/`/posts` 图片基址、Pages 公开代理（已绑 `STATE_KV`）均跟 SSOT，**不要**为换域再 `wrangler deploy`。

可选：下次整仓升级时再把 wrangler / token 里的 `WORKER_B_URL` 对齐新址，避免后人误把 bootstrap env 当权威。

> **自定义域注意**：`finalize-hailuo-deploy.mjs` 从 Cloudflare API 解析的 Worker B URL 默认为 `*.workers.dev`。该写入 **仅 bootstrap**；换域目标若是**自定义 HTTPS 域名**，以 Settings confirm 写入的 D1 / STATE_KV 为准，**不必**为换域再跑 finalize。若你仍想把 token 里的 bootstrap URL 改成自定义域，须**手工**写入 `$newB`，finalize **不会**自动推断自定义域。

### 换域后冒烟（最小集）

```powershell
$env:WORKER_B_URL = "https://node.example.com"
$env:BOOTSTRAP_HANDLE = "<登记后的 handle>"

# Worker B 健康 + 用户公开资料（worker_b_url 应为新址，不信请求 hostname）
curl.exe -s "$env:WORKER_B_URL/health"
curl.exe -s "$env:WORKER_B_URL/users/$env:BOOTSTRAP_HANDLE"

# 注册中心 lookup 应返回新 node_url（主 registry）
curl.exe -s "https://hailuo-registry.allovo.eu.org/lookup/$env:BOOTSTRAP_HANDLE" `
  -H "Authorization: Bearer <node_api_token>" `
  -H "X-Hailuo-Node-User-Id: <user_id>"

# Pages 登录 + Settings 登记信息「节点公开地址」只读字段应与 $newB 一致
# 已绑 STATE_KV 时，不必改 PUBLIC_WORKER_B_URL / redeploy Web
npm run smoke:remote
```

### 换域部署 Checklist（可复制）

- [ ] 新 URL 在 confirm **前**已指向 **同一** Worker B，`/health` 200
- [ ] Settings precheck → proof 端点返回正确 body
- [ ] Settings confirm 成功（D1 + STATE_KV canonical 已写）
- [ ] **不必**改 `apps/worker-a/wrangler.toml` 的 `WORKER_B_URL`，**不必** redeploy Worker A / Web（M7-30g）
- [ ] Pages Functions 已绑 `STATE_KV`（与 A/B 同 id；未绑则一次性补绑，属例外）
- [ ] 注册中心 lookup `node_url` = 新地址
- [ ] Settings 登记信息「节点公开地址」= 新地址
- [ ] `/users/<handle>` 的 `worker_b_url` = 新地址
- [ ] **M7-30g-op**：新发带图帖 / `GET /posts` 的 `image_urls` host = 新域（不必改 env）
- [ ] **M7-30g-op**：Pages `GET /posts`（未 redeploy）代理到新域
- [ ] 备用 registry 若存在，Settings 已提示「URL 未同步」
- [ ] `npm run smoke:remote` 或上方 curl 最小集通过
- [ ] （可选，下次升级）token / wrangler bootstrap `WORKER_B_URL` 对齐新址

**不自动迁移**（详见 [`m7-30d-url-change-follows-cache.md`](./m7-30d-url-change-follows-cache.md) 与 [`m7-30e-url-change-owner-faq.md`](./m7-30e-url-change-owner-faq.md)）：`follows` / lookup 缓存、粉丝 Token、互证 proof、私信 peer URL — 自然 TTL 或按文档手工处理。

契约自检（文档关键字）：`node scripts/test-m7-30c-deploy-url-change-logic.mjs`  
跨仓契约（M27-3）：`npm run test:url-change-cross-repo`（与 registry 双仓 fixture 字节一致）  
Operator E2E：[`m7-30-operator-e2e.md`](./m7-30-operator-e2e.md) · `npm run smoke:m7-30-url-change-e2e`  
零 redeploy 契约（M7-30g-op）：`npm run test:m7-30g-op`

### M33-h · 登记认证生产硬化（operator）

配对 registry **M33-h-op**：清号 Cron 与通道 A/B 按 registry `wrangler.toml`（**默认均开**；CERT 仍 `strict`）。  
节点侧：[`m33-h-operator-e2e.md`](./m33-h-operator-e2e.md) · 联合脚本 `.\scripts\run-m7-36-operator-deploy.ps1`（含 `smoke:m33-h-operator`）。

**M33-P10-n 生产闭环验收**：[`m33-p10-n-production-acceptance.md`](./m33-p10-n-production-acceptance.md)（权威开关 / **EXP-4 `CERT_INBOUND_EMAIL_AUTH_MODE=strict`** 在 registry [`m33-p10-production-acceptance.md`](../../hailuo-registry/docs/m33-p10-production-acceptance.md)；本仓只交叉引用）。门禁：`npm run test:m33-p10-n-production-acceptance`。

---

### 手动 curl 清单（与脚本等价）

```powershell
# 1. Worker B 健康探活
curl.exe https://<worker-b-host>/health
# 预期：{"ok":true,"service":"worker-b",...}

# 2. Worker A 健康探活
curl.exe https://<worker-a-host>/health
# 预期：{"ok":true,"service":"worker-a",...}

# 3. Worker B 用户信息（公钥）
curl.exe https://<worker-b-host>/users/<handle>
# 预期：{"ok":true,"data":{"handle":"...","pubkey":"...","worker_b_url":"..."}}

# 4. Worker B 帖子列表（FORCE token-required：无 Token 应 401；带合法粉丝 Token 应 200）
curl.exe "https://<worker-b-host>/posts?limit=5"
# 预期：{"ok":true,"data":{"items":[...],...}}

# 5. Worker A 登录（老节点：owner_credentials 为空时用 secret）
curl.exe -X POST https://<worker-a-host>/auth/login `
  -H "Content-Type: application/json" `
  -d "{\"secret\":\"<JWT_SECRET>\"}"
# 或 PBKDF2 路径：{\"username\":\"<handle>\",\"password\":\"<pass>\"}
# 预期：{"ok":true,"data":{"token":"..."}}

# 6. Worker A 发帖（可选）
curl.exe -X POST https://<worker-a-host>/api/posts `
  -H "Authorization: Bearer <jwt>" `
  -H "Content-Type: application/json" `
  -d "{\"content\":\"部署冒烟测试\"}"

# 7. 注册中心（节点默认 REGISTRY_URL）
curl.exe https://hailuo-registry.allovo.eu.org/health
# 预期：{"ok":true,"data":{"service":"registry-gateway"}}
```

---

## 节点搬家正规路径（M9-7）

> **计划 SSOT**：[`m9-7-staging-aes-gcm-plan.md`](./m9-7-staging-aes-gcm-plan.md)（A1 `DB_IMPORT` + B1 脚本切流）  
> **Settings**：Web → 设置 → 节点搬家（`NodeMigratePanel`）  
> **契约**：[`worker-a-api.md`](./worker-a-api.md) §节点搬家

### 正规路径（生产推荐）

1. **旧节点** Settings：设置搬家口令 → **加密导出**（落盘 `hailuo-node-export-v2-enc`；口令丢失不可恢复）。
2. **目标账号**（可同账号）创建 staging D1：`hailuo-node-db-{同组码}-import`，回填 wrangler `DB_IMPORT.database_id`，并对 `DB_IMPORT` 执行与主库相同的 migrations（见上文 §2.1 创建资源注释）。
3. **目标节点** Settings：口令导入 → Worker A **只写** `DB_IMPORT` → 自动对账；面板显示 `import_ready=true`（或 `GET /api/node/import-status`）。
4. **本机**（仓库根；**A7-DB-RETIRE**：灌入三库，**不再**交换旧 `DB` id；Web **绝不**改 Cloudflare binding）：

```powershell
# 需环境变量 WORKER_A_URL + OWNER_JWT；确认短语 CUTOVER
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/cutover-db-import.ps1
# 演练：… -DryRun
# 已确认 import_ready 时可：… -SkipReadyCheck
# 或手动：POST /api/node/import/promote-staging  {"confirm_promote":true}
```

5. Smoke：登录 / 发帖（Worker 已绑定三库，一般**不必**为切流再 deploy；若刚改 wrangler 才需 redeploy）。
6. **切流后**在 Settings **重新启用站主 TOTP**（TOTP 表不随包迁移）。
7. staging（`DB_IMPORT`）可保留作审计窗口；确认无误后再删物理库。

### 本路径不含

| 项 | 说明 |
|---|---|
| `IMAGE_KV` / `POSTS_CACHE_KV` 二进制 | 仍按 `image_manifest` 运维拷贝或重建 |
| `MESSAGING_DB` / 分片 | 私信/群聊用 M10-5b 等单独加密备份 |
| 浏览器 / Worker 自动切 binding | **禁止**把 CF API Token 放进 Web/Worker |
| 交换遗留 `DB`↔`DB_IMPORT` id | **已废除**（wrangler 已无 `binding=DB`） |

### 逃生口（紧急，非默认）

仅当无法创建 `DB_IMPORT` 时：环境变量 `NODE_INPLACE_IMPORT_ENABLED=true` + 请求体 `unsafe_inplace_import: true`（+ 目标已有数据时 `confirm_overwrite`）。**D1 无跨 batch 事务 → 仍有半库风险**；生产应优先正规路径。

### 回滚

```powershell
# SPLIT 时代无法靠对调 id 回滚；脚本仅打印恢复指引（exit 2）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/cutover-db-import.ps1 -Rollback
```

从加密导出包重新 import → promote，或恢复 D1 备份。

### 契约自检

```powershell
npm run test:m9-7
```

---

## 本地开发

**站主写层联调（M9-24 推荐，与生产同构）**：

```powershell
# Terminal 1/2：Worker A + Worker B
npm run dev:worker-a
npm run dev:worker-b

# Terminal 3：Pages Owner Gateway（默认 http://localhost:8789）
npm run dev:pages
```

浏览器打开 Pages dev URL 登录/发帖/设置；站主 API 走同源 Owner Gateway → Service Binding → Worker A，与生产 Pages Functions 路径一致。`INTERNAL_FORWARD_SECRET` 默认与 `apps/worker-a/.dev.vars.example` 示例值对齐，本地需在 Pages dev 与 Worker A/B secret 保持一致。

**仅 UI 样式调试（不含 Owner Gateway）**：

```powershell
npm run dev:web   # Astro :4321，站主写层不可用（Worker B owner-proxy 默认 disabled）
```

**不推荐作为主路径**：`OWNER_PROXY_MODE=compat`（旧迁移降级）、浏览器直连 Worker A（`PUBLIC_HAILUO_ENDPOINT` / 设置页手动填 8787）。

```powershell
# 应用本地 migration
npm run migrate:local --workspace=@hailuo/worker-a

# 启动 Worker A（端口 8787）
npm run dev:worker-a

# 启动 Worker B（端口 8788）
npm run dev:worker-b

# 启动 Web（端口 4321，仅 UI）
npm run dev:web
```

本地 `.dev.vars` 配置（`apps/worker-a/.dev.vars`）：

```ini
ED25519_PRIVATE_KEY=<私钥>
JWT_SECRET=dev-jwt-secret-change-me
WORKER_B_URL=http://localhost:8788
REGISTRY_URL=http://localhost:9000
# 占位示例，禁止真实人名/手柄（12-anti-deanonymization）
BOOTSTRAP_HANDLE=usr_alice_placeholder
```

---

## 进阶：同账号一键批量部署多个测试节点（M9-17）

用于 M9-18/M10 跨节点联调时，可在同一个 Cloudflare 账号里快速生成多个彼此独立的海螺节点：

```powershell
# 第一次使用前只需要准备一次基础账号配置：Cloudflare Account ID / API Token / 代理 / 注册中心等公共字段
Copy-Item scripts\cloudflare-api-token.example.json scripts\cloudflare-api-token.json

# 之后只敲这一条命令即可：脚本会自动复制随机配置、生成随机节点参数并逐个部署
.\scripts\deploy-all-many-node.ps1 -Count 3
```

脚本不会覆盖原始 `scripts/cloudflare-api-token.json`。每个节点会自动复制一份随机 6 位后缀配置，例如 `scripts/deployed-nodes/node-001-a1b2c3.json`，然后把该节点的 handle、Worker A/B、Pages、D1、KV、Secret 等随机参数写入当前配置文件并调用部署。配置文件包含 API Token、JWT secret、Ed25519 私钥等敏感字段，目录已加入 `.gitignore`，不要提交。每个节点都会生成独立 Worker A、Worker B、Pages、D1、KV 和 Secret；初始登录账号/密码统一为 `admin/admin`。

默认情况下，脚本部署每个节点时会临时改写 A/B 的 `wrangler.toml` 来配合现有 wrangler deploy 流程，结束后自动恢复本地文件；真实资源 ID 会写回各自节点 JSON。若需要保留最后一个节点的 toml，可显式加 `-KeepLastToml`。

可选：如果只想验证生成逻辑、不创建 Cloudflare 资源，可加 `-DryRun`：

```powershell
.\scripts\deploy-all-many-node.ps1 -Count 3 -DryRun
```
