# GitHub Actions 一键部署（推荐）

> **首次部署推荐本路径**：GitHub Actions 会自动创建 D1 / KV / Pages，再部署 Worker A/B 与前端。  
> Cloudflare Workers Builds / Deploy 按钮**不会**自动创建这些资源，首次部署会失败；仅作背景参考 → [`deploy-workers-builds.md`](./deploy-workers-builds.md)  
> 本地 PowerShell 一键（无需 GitHub）见 [`部署指南.md`](./部署指南.md) §8  
> 官方裸 Deploy 按钮（不能自动建 D1/KV）见 [`deploy.md`](./deploy.md) §Deploy 按钮

## 为什么还有 GitHub Actions？

与 Workers Builds **共用同一套脚本**（`ci-bootstrap-resources` / `ci-deploy-all` 等价流水线）。  
差别只在凭证存放位置：

| | Workers Builds（首次部署不可用） | GitHub Actions（推荐） |
|--|------------------------|-------------------------|
| 跑在哪 | Cloudflare 构建环境 | GitHub-hosted runner |
| Token 配哪 | CF 仪表盘 Build secrets | GitHub → Settings → Secrets |

## 你需要准备什么

| 项 | 说明 |
|---|---|
| GitHub 账号 | fork [`tsjworldcode/hailuo-node-cf`](https://github.com/tsjworldcode/hailuo-node-cf) 到你名下 |
| Cloudflare 账号 | Free Tier 即可；**必须与官方注册中心账号分开**（见 [`deploy.md` 硬约束](./deploy.md#硬约束部署前必读--r-audit-sep-a2)） |
| API Token | 权限至少：Edit Cloudflare Workers、D1、Workers KV Storage、Cloudflare Pages、Account Settings:Read |
| Account ID | Cloudflare Dashboard 右侧 Account ID（Token 仅一账号时可省略，脚本会探测） |

## 三步操作

### 1. Fork 仓库

打开上游仓库 → **Fork** → 选你的 GitHub 账号。

### 2. 配置 GitHub Secrets

在你的 fork 仓库：

**Settings → Secrets and variables → Actions → New repository secret**

| Secret 名 | 必填 | 说明 |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | ✅ | 上表 API Token |
| `CLOUDFLARE_ACCOUNT_ID` | 建议 | 账号 ID；可省略若 Token 只可见一个账号（省略时由 bootstrap 探测并经 `$GITHUB_ENV` 传到后续 step；**不要**在未配时依赖 step 级空 env 覆盖） |
| `WORKER_SECRETS_JSON` | 可选 | 若省略，首次自动生成；升级默认保留线上密钥 |
| `OWNER_SEED_USERNAME` / `OWNER_SEED_PASSWORD` | 可选 | 首次 seed 自定义站主账密；省略则默认 `admin` / `admin`（仅空表写入） |
| `REGISTRY_URL` | 可选 | 覆盖默认注册中心 |

可选 `WORKER_SECRETS_JSON` 格式（本机生成）：

```powershell
node scripts/generate-deploy-secrets.mjs
```

输出一整行 JSON，粘贴为 Secret 值。**勿提交到 git、勿发到公开聊天。**

### 3. 运行工作流

1. 打开 fork 仓库 → **Actions**
2. 左侧选 **Deploy hailuo node**
3. **Run workflow** → 分支选 `main` → Run
4. 等待约 10～20 分钟（首次创建资源较慢）
5. 打开本次 run 底部的 **Summary**：可见 Worker B 公开地址、Pages 地址、占位 handle

> **不会**在 Summary 里显示 Worker A 地址（私密写层；站主写请求走 Pages Owner Gateway）。

> **这些名字不是每次随机**：组码（如 `04c0c5`）与占位 handle（`hailuo_` + 10 位）都由 `CLOUDFLARE_ACCOUNT_ID` + `HAILUO_NODE_SLOT` 确定性派生（sha256），同账号同槽位重复部署复用同一套资源。派生细节见 [`deploy-workers-builds.md`](./deploy-workers-builds.md#部署身份怎么来的组码--占位-handle--资源名)。Summary 里新增「身份派生」一行，换账号或槽位时先看这行解释。

## 工作流做了什么

| 阶段 | 动作 |
|---|---|
| Bootstrap | **稳定身份**（同账号同槽位）+ 创建 6 D1 + 3 KV；回填 `wrangler.toml`；上传 artifact `ci-deploy-bootstrap`（state + patched toml；**必须** `include-hidden-files: true`） |
| 可选 R2 | 与 Workers Builds 相同：尝试建 `hailuo-node-media-{组码}` 并临时绑 `HAILUO_IMAGE_R2`；失败不阻断。**勿删**。`SKIP_R2=1` 可跳过 |
| Deploy Workers | 下载 bootstrap → **`ci-prepare-cf-env`** → migrations → deploy A → **seed 默认站主** → deploy B → put secrets（含 `REGISTRY_URL`）→ finalize → redeploy → 上传 `ci-deploy-final` |
| Pages | 下载 **final** → prepare-cf-env → build → **先 PATCH**（`WORKER_A`/`WORKER_B`/`STATE_KV`/`PUBLIC_*`；缺 `INTERNAL_FORWARD_SECRET` 时自愈同步 A/B/Pages）→ 再 **`cd web` + `pages deploy dist`**（禁止仓库根 `pages deploy web/dist`，否则漏 Functions） |
| Summary | checkout → 写 `GITHUB_STEP_SUMMARY` + 落盘 `scripts/ci-deploy-summary.md` → artifact **`hailuo-deploy-summary`**（站主可反复下载） |

> **为何 migrations / deploy 曾 10000**：Secrets 省略 `CLOUDFLARE_ACCOUNT_ID` 时，job2 若不从 state 恢复，wrangler 会调 `GET /memberships`；Account-scoped Token 常在此鉴权失败。Bootstrap 能建库是因为同 job 内已探测到 Account ID。**另**：Prepare 已把探测值写入 `$GITHUB_ENV` 后，后续 step 若再写 `CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}` 且 secret 未配，空串会盖掉已探测值（M-WORKFLOW-ENV-1）。
>
> **与本地 `deploy-all.ps1` 对齐要点**：seed 站主（可选 `OWNER_SEED_*`）、`REGISTRY_URL`、Pages `WORKER_B` Service Binding、`PUBLIC_REGISTRY_URL`；可选 Secret `REGISTRY_URL` 覆盖默认注册中心。
>
> **可选 R2**：`ci-optional-r2` 钉 `wrangler@3.114.17`（与 deploy 同钉）；勿裸 `npx wrangler`——Node 20 CI 会拉 4.x 并静默 skipped 退 KV。
>
> **Analytics Engine / 10089**：默认 **不**开 OTEL。Bootstrap 会从 production toml **剥离** `ANALYTICS` 绑定——账号未开通 Workers Analytics Engine 时，即便 `OTEL_ENABLED=false`，带绑定的 `wrangler deploy` 仍会报 `10089`。需要指标时：先 Dashboard 开通 AE，再设 Variable/Secret `OTEL_ENABLED=true`。

脚本入口（与 Workers Builds 共用）：

| 脚本 | 用途 |
|---|---|
| `scripts/ci-deploy-all.mjs` | 本地/ Builds 统一入口（`npm run deploy:ci`） |
| `scripts/ci-bootstrap-resources.mjs` | 身份 + 资源 + patch toml |
| `scripts/patch-wrangler-toml.mjs` | 幂等回填 database_id / KV id / service |
| `scripts/ci-put-secrets.mjs` | Secret 注入 |
| `scripts/ci-apply-migrations.mjs` | 六库 migration |
| `scripts/ci-finalize-urls.mjs` | URL 写回 toml production vars（对齐本地 finalize；勿 secret put） |
| `scripts/ci-patch-pages-bindings.mjs` | Pages Production 绑定 |

状态文件：`scripts/.ci-deploy-state.json`（含密钥，**已 gitignore**，仅 CI 临时使用）。

## 重复部署安全（不会删已有数据）

同一个仓库可以反复跑部署，每次都是「先复用、缺了才建」：

- **D1 / KV / Pages**：按名字先列举；已有就复用原 ID，不重建、不删除。列举失败时直接**停止部署**，绝不「猜没有」然后建一个空库/空 KV 把节点指过去。
- **Migrations**：只 apply 还没应用的记录。若库里有业务表却没有 `d1_migrations` 记录，直接拒跑——防止重放 `DROP TABLE` / `DELETE FROM` 清掉现有数据。
- **站主凭证**：`--if-empty`，已有站主不会被重置。
- **Secrets**：线上已有就保留，不会重新生成覆盖。
- 唯一会变的是代码版本、URL 变量和 Pages 部署产物，不涉及业务数据。

## 云端部署需要本机装 wrangler 吗？

不需要。GitHub runner 上由 `npm ci` 安装仓库锁定版本的 wrangler，部署脚本直接调用 runner 内的 `node_modules/wrangler`。使用者本机有没有 wrangler 完全不影响云端部署。

## 部署后 / 升级 / FAQ

部署后步骤、升级幂等、D1 配额、Pages 503 等与推荐路径相同，见：

→ [`deploy-workers-builds.md`](./deploy-workers-builds.md)「部署后」「升级」「常见问题」

### Q：Actions 报 `CLOUDFLARE_API_TOKEN` 缺失？

Secret 必须配在**你的 fork**（不是上游仓）。名称必须完全一致（大小写敏感）。

### Q：更想少配 Secrets？

改用推荐路径 [`deploy-workers-builds.md`](./deploy-workers-builds.md)。

### Q：`Apply D1 migrations` 报 `exit=null signal=SIGTERM` / 跑到一半被杀？

不是 SQL 报错，也不是鉴权失败：wrangler 进程被外部信号终止（GitHub runner / npm 包装层回收进程时会出现）。脚本现在**直接调用仓库内 wrangler**（不再经 `npx`），并且每个库最多重试 3 次；已 apply 的 migration 会记录在 `d1_migrations`，重跑从断点继续。

**全新账号首次部署**要从空库跑完 173 条 migration（DB_IMPORT 66 + IDENTITY 49 + GOVERNANCE 29 + CONTENT 8 + MESSAGING 19 + SHARD 2），比升级已有节点慢得多；`Deploy Workers` 超时已放宽到 45 分钟，几分钟到十几分钟都属正常。

处理方式：**直接重跑一次 Deploy 工作流**即可。若连续在同一处被信号杀，再查 runner 日志与 Cloudflare 状态。

### Q：日志里全是 `create D1` / 新的 Pages 项目名，是正常的吗？

**正常。** 本仓是公开的：谁填上自己账号的 `CLOUDFLARE_API_TOKEN`，就在谁自己的账号里从零部署。`bootstrap` 只按 Token 所在账号操作——找不到同名 D1/KV/Worker/Pages 就新建一整套（空库）并生成节点密钥；全新账号第一次部署必然走这条路径。

只有一种情况需要核对：你**以为在升级某个已有节点**，日志却是全新建库——那说明 Token 属于另一个账号（工作流不会跨账号找旧资源），换 Token 即可。

### Q：全新账号第一次部署，`bootstrap` 为什么自动注册 `workers.dev` 子域？

wrangler 在账号还没有 `workers.dev` 子域时会直接拒绝部署（CI 里不会交互式注册，错误码 10007）。`bootstrap` 会先检查子域：已有就跳过；没有就用 `hailuo-<组码>` 注册一个（被占用自动换后缀）。所以 Token 里要包含 **Workers Scripts:Edit**（含 subdomains）权限。子域名称不写进日志（Worker A 地址不公开）。

## 契约自检

```powershell
npm run test:deploy-github-actions
npm run test:deploy-config-consistency
npm run audit:deploy-shell-hazards
```

这三条已挂到 [`.github/workflows/ci.yml`](../.github/workflows/ci.yml)：`push`（main）与 `pull_request` 自动跑，改部署脚本/文档后不必再靠手动记着跑。它们只读仓库文件、做本地 dry-run，不接 Cloudflare 凭证，也不会写任何线上资源。

## 相关文档

| 文档 | 用途 |
|---|---|
| [`deploy-workers-builds.md`](./deploy-workers-builds.md) | 背景参考（首次部署不可用） |
| [`部署指南.md`](./部署指南.md) | 站主总览（含本地 PowerShell） |
| [`deploy.md`](./deploy.md) | 技术附录、冒烟、换域、搬家 |
| [`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml) | 工作流定义 |

---

*M8-12 引入 Actions；首次部署以 GitHub Actions 为准。*
