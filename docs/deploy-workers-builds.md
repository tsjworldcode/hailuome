# Workers Builds 部署（首次部署不可用 · 参考）

> ⚠️ **不要用本方式做首次部署**：Workers Builds / Deploy 按钮**不会**自动创建 D1、KV、Pages，直接点会失败。  
> 首次部署请用 [GitHub Actions](./deploy-github-actions.md) 或本地 [部署指南](./部署指南.md)。  
> 本文保留作 `npm run deploy:ci` 流水线与排障参考。  
> 本地 PowerShell：[`部署指南.md`](./部署指南.md) §8 · 技术附录：[`deploy.md`](./deploy.md)

## 机制说明（三条路径对比）

| 路径 | 凭证放哪 | 站主体验 |
|------|----------|----------|
| **Workers Builds（本文参考）** | Cloudflare 仪表盘（授权 GitHub + Builds Token） | 授权与部署都在 CF |
| GitHub Actions | GitHub Secrets 手贴 Token | 多跳一次 GitHub |
| 官方 Deploy 按钮 | CF OAuth | **不能**自动编排本仓 6×D1 + 3×KV + A/B + Pages 整包 |

`npm run deploy:ci` 在 Cloudflare 构建环境跑完整流水线。

## 你需要准备什么

| 项 | 说明 |
|---|---|
| GitHub 账号 | fork [`tsjworldcode/hailuo-node-cf`](https://github.com/tsjworldcode/hailuo-node-cf) |
| Cloudflare 账号 | Free Tier 即可；**勿与官方注册中心同账号**（见 [`deploy.md` 硬约束](./deploy.md#硬约束部署前必读--r-audit-sep-a2)） |

## 两步操作（仅在资源已建好后使用）

### 1. Fork 仓库

打开上游 → **Fork** → 选你的 GitHub 账号。

### 2. Cloudflare 连接 GitHub 并部署

1. 打开 [Workers & Pages](https://dash.cloudflare.com/?to=/:account/workers-and-pages)  
2. **Create** → **Worker**（名称随意，如 `hailuo-node-ci`；只作构建入口）  
3. **Settings → Builds → Connect** → **GitHub** → **Install & Authorize** → 选 fork，`main`  
4. 构建字段：

| 字段 | 值 |
|------|-----|
| Root directory | 留空（仓库根） |
| Install command | `npm ci` |
| Build command | 留空或 `echo skip` |
| Deploy command | `npm run deploy:ci` |

5. **API token**：用 Builds 自动创建的 Token（或自建一枚），打开 [API Tokens](https://dash.cloudflare.com/profile/api-tokens) 编辑该 Token，**补上**：
   - Account · **D1** · Edit  
   - Account · **Cloudflare Pages** · Edit  
   （其余 Workers / KV 等若已有可保留）  
6. 保存 → **Retry build** / push `main`，约 10～20 分钟。

构建日志末尾有 **Worker B**、**Pages**、占位 handle。**不会**打印 Worker A（私密写层）。

> **为何还要补 D1 / Pages？**  
> Cloudflare 默认 Build Token **故意不含**这两项；仓库无法替你改平台默认。OAuth 只负责连 GitHub，建库/Pages 仍靠这枚 Token。  
> **不必**再把同一枚 Token 粘贴成 Build Secret `CLOUDFLARE_API_TOKEN`（常规步骤已去掉）。

## 流水线做了什么

| 阶段 | 动作 |
|---|---|
| Credentials | 优先用环境 Token；Workers Builds 无 env Token 时依赖 Builds 已选 Token + `wrangler` |
| Bootstrap | 稳定身份（账号+槽位）+ 6 D1 + 3 KV + 回填 toml |
| 可选 R2 | 探测或创建桶 `hailuo-node-media-{组码}`，临时绑定 `HAILUO_IMAGE_R2`（A/B 同一个桶）。失败只跳过，继续用 KV。**勿删**这个桶和绑定。不想建：变量 `SKIP_R2=1` |
| Secrets | 首次注入；升级已有 Worker A 则保留 |
| Migrations / Deploy | 六库 apply → A → **seed 站主** → B → secrets（含 `REGISTRY_URL`）→ URL 回填 → redeploy → Pages：**先 PATCH** 绑定再 `pages deploy`（`WORKER_A`+`WORKER_B`+`PUBLIC_REGISTRY_URL`+`STATE_KV`） |
| Analytics Engine | 默认剥离 production `ANALYTICS`（防未开通 AE 时报 `10089`）；仅 `OTEL_ENABLED=true` 且已开 Dashboard 时保留 |

入口：`npm run deploy:ci` → `scripts/ci-deploy-all.mjs`。

### 部署身份怎么来的（组码 / 占位 handle / 资源名）

CI（Workers Builds 与 GitHub Actions 共用同一套）**不是每次随机**，而是按 Cloudflare 账号稳定派生：

| 字段 | 派生方式 |
|---|---|
| `DEPLOY_GROUP_CODE`（6 位 hex，如 `04c0c5`） | `sha256("hailuo-node:<CLOUDFLARE_ACCOUNT_ID>:<HAILUO_NODE_SLOT>:group")` 前 6 位 |
| `BOOTSTRAP_HANDLE`（`hailuo_` + 10 位） | 同前，`:handle` 种子取前 10 位 |
| Worker A/B、Pages 资源 ID | 同前，`:worker-a` / `:worker-b` / `:pages` 种子各取 32 位 |

含义：**同一账号 + 同一槽位反复部署会复用同一组资源**（不会重复建 D1/KV），换账号或 `HAILUO_NODE_SLOT` 才会换一套名字。组码是哈希后的指纹，不是账号 ID 原文——既稳定可复现，又不把账号 ID 直接公开。

> 本地 PowerShell 部署在解析到 `CLOUDFLARE_ACCOUNT_ID` 后也走同一派生（同一账号同一槽位同样复用）；只有账号 ID 尚未探测到时才回退随机。多节点脚本 `deploy-all-many-node.ps1` 用节点序号当槽位，节点之间不会撞名。

## 部署后

1. 打开日志里的 **Pages**  
2. 首次登录通常 `admin` / `admin`（随后强制改密）  
3. 设置 → 登记注册中心（`https://hailuo-registry.allovo.eu.org`）  
4. 可选：`npm run smoke:remote`（本机设 `WORKER_B_URL` / `PAGES_URL` / `BOOTSTRAP_HANDLE`）
5. 控制台若出现桶 `hailuo-node-media-*` 或绑定 `HAILUO_IMAGE_R2`：那是海螺媒体库（大图 / 视频 / 文件），**不要删**。小图默认仍在 KV。说明见 [`deploy.md` §2.2](./deploy.md#22-可选图片对象库m8-14--命名防误删--分流)

## 升级

再触发构建即可：D1/KV 按稳定名复用；默认不覆盖线上 Secrets。

可选变量：`HAILUO_NODE_SLOT`（同账号第二套节点）、`SKIP_PAGES=1`、`WORKER_SECRETS_JSON`、`FORCE_PUT_SECRETS=1`。

## 常见问题 / 排障

### Q：报 D1 / Pages 权限错误？

编辑 Builds 使用的那枚 Token → 补 **D1 Edit** + **Cloudflare Pages Edit** → Retry。

### Q：构建报缺 `CLOUDFLARE_API_TOKEN`，或 Pages 绑定未自动 PATCH？

多数情况 **不必**写 Build Secret。若仍失败：

1. Builds → **Build variables and secrets** → 新增 Secret  
   `CLOUDFLARE_API_TOKEN` = 与 Builds「API token」**同一枚**的值  
2. （可选）变量 `CLOUDFLARE_ACCOUNT_ID` = 仪表盘右侧 Account ID  
3. Retry  

无 env Token 时，脚本会跳过 Pages HTTP PATCH（可在 Pages 控制台手工绑 `PUBLIC_WORKER_B_URL` / `PUBLIC_REGISTRY_URL` / `WORKER_A` / `WORKER_B` / `STATE_KV`），URL 回填会尽量走 `wrangler deployments list`。

### Q：和官方 Deploy 按钮？

适合资源已齐、只更代码。**首次整包用本手册**。

### Q：OAuth 不够吗？

OAuth = 连仓库。建 D1 / 部署 Pages 仍要 Account API Token（默认缺 D1/Pages，需补权限）。Token 留在 Cloudflare，不用去 GitHub。

### Q：想用 GitHub Actions？

见 [`deploy-github-actions.md`](./deploy-github-actions.md)。

### Q：部署成功，但登记页报「节点配置不完整」？

常见于 **Fork + Workers Builds / Actions 重试（Retry）**：第一次已建出 Worker A 空壳，第二次走「升级保留 Secrets」却仍用仓库占位 `ED25519_PUBLIC_KEY=auto-generated-at-deploy` 去 redeploy，把线上公钥盖坏；或首次 `secret put` 失败后重试跳过注入。

**现已自愈（M-WORKFLOW-ED25519-1）**：bootstrap 会读线上 bindings——公钥齐全则写回 toml 再 deploy；缺私钥/公钥则当空壳重新生成并注入；`deploy:ci` 末尾硬校验三件套，不过检即失败（避免假绿）。

**新增密钥对门禁（M-WORKFLOW-ED25519-2）**：bootstrap 与本地 `deploy-hailuo-workers.ps1` 在部署前会从 `ED25519_PRIVATE_KEY` 推导公钥，并与 `ED25519_PUBLIC_KEY` / D1 `users.pubkey` 比对；不一致直接中止，不再出现「公钥正常、私钥签名验不过」。升级保留线上密钥但拿不到私钥时只告警；要轮换请走 `.github/workflows/rotate-ed25519.yml`（一次性、需输入 `ROTATE`）。

**换钥后还要同步公开资料快照**：Worker B `/users/:handle` 优先读 `STATE_KV` 的 `public:profile`，只改 Worker A/D1/注册中心会留下旧公钥。`rotate-ed25519.yml` 已内置同步；若只修快照，可单独跑 `.github/workflows/sync-public-profile-pubkey.yml`（输入 `SYNC`）。

你这边：在 Cloudflare Builds **再跑一次** `npm run deploy:ci`（或 Actions 再 Run）。若仍失败，Build 变量设 `FORCE_PUT_SECRETS=1` 后 Retry（会轮换节点密钥；**仅未发帖/未登记节点可用**）。

## 契约自检

```powershell
npm run test:deploy-workers-builds
```

这四条部署门禁（本页 + `test:deploy-github-actions` + `test:deploy-config-consistency` + `audit:deploy-shell-hazards`）已挂到 [`ci.yml`](../.github/workflows/ci.yml)，`push` / `pull_request` 自动跑；本地想提前自查仍可手动执行。

## 相关文档

| 文档 | 用途 |
|---|---|
| [`部署指南.md`](./部署指南.md) | 站主总览 |
| [`deploy.md`](./deploy.md) | 技术附录 |
| [`deploy-github-actions.md`](./deploy-github-actions.md) | 进阶 Actions |
| `scripts/ci-deploy-all.mjs` | 统一入口 |

---

*M8-13：Build Secret 仅排障；默认 Build Token 须补 D1/Pages（CF 平台限制）。首次部署请改用 [GitHub Actions](./deploy-github-actions.md)。*
