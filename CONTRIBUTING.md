# 参与贡献

感谢你愿意为海螺节点（Hailuo Node）做贡献。这个项目是「每个人在自己的 Cloudflare 账号里部署一个节点」，所以代码质量、部署可靠性和隐私边界比功能数量更重要。

## 先读这几份

| 文档 | 用途 |
|---|---|
| [`README.md`](./README.md) | 项目定位与部署入口 |
| [`docs/deploy-github-actions.md`](./docs/deploy-github-actions.md) | 首次部署推荐路径 |
| [`docs/worker-a-api.md`](./docs/worker-a-api.md) / [`docs/worker-b-api.md`](./docs/worker-b-api.md) | API 契约 |
| [`LICENSE`](./LICENSE) / [`NOTICE`](./NOTICE) | AGPL-3.0 与版权说明 |
| [`COMMERCIAL_LICENSE.md`](./COMMERCIAL_LICENSE.md) | 闭源商用授权说明 |

## 贡献流程

1. **先开 Issue 说明要做什么**，避免大改动方向不一致。
2. Fork 仓库，从 `main` 拉一个分支，例如 `fix/feed-cache-ttl`。
3. 改动尽量小而完整：一个 PR 只做一件事。
4. 提交前跑相关门禁（见下）。
5. 提 PR，按模板填写说明，并勾选 CLA 确认。

### 提交信息

使用中文，格式：

```text
<模块>：<动作> <对象> — <具体做了什么 / 带来什么效果>
```

示例：

```text
worker-a：修复 Feed 缓存 TTL 过期判断 — 避免旧帖在时间线重复出现
web：调整登录页错误提示 — 网络失败时给出可理解的文案
```

## CLA（必须）

首次提交 PR 前，请阅读 [`.github/CLA.md`](./.github/CLA.md)。

你需要在 PR 模板中勾选：

> 我已阅读并同意 CLA，并有权授予其中所列的著作权与专利许可

为什么需要 CLA：本项目采用 **AGPL-3.0 + 商业授权** 双许可。只有你明确授予项目版权方再许可的权利，贡献的代码才能同时以 AGPL 和商业许可分发。你仍然保留自己贡献的著作权。

如果代表公司贡献，请由有权代表公司的人确认，并在 PR 中注明公司名称。

## 开发与验证

```bash
npm ci
npm run typecheck

# 部署契约门禁（只读，不访问 Cloudflare）
npm run test:deploy-github-actions
npm run test:deploy-config-consistency
npm run test:ed25519-key-consistency
npm run audit:deploy-shell-hazards
```

涉及具体模块时，再跑对应测试（见各目录 `AGENTS.md` 或 `docs/` 里的契约清单）。

## 代码约定

- 新增或调整的关键逻辑，补简洁中文注释。
- 不做无关重构；一个 PR 不混入格式化全仓之类的改动。
- Worker A 是私密写层：不要把 Worker A 地址写进前端、CORS、公开文档或注册中心字段。
- D1 查询使用 prepared statements；时间比较从 JS 传 ISO 字符串。
- 高频写入的计数、限流、会话一律用 D1，不用 KV（Free Tier KV 只有 1000 写/天）。
- 前端用户可见文案走 i18n catalog，不直接写死中英文。

## 不要提交的内容

- 真实密钥、Token、`.dev.vars`、`cloudflare-api-token.json`
- 真实节点 handle、真实 `workers.dev` 子域、生产 D1/KV ID
- 真实 IP、邮箱、聊天记录、截图里的个人信息
- `node_modules/`、`dist/`、`.wrangler/`、日志文件

## 安全问题

**不要开公开 Issue。** 请先阅读 [`SECURITY.md`](./SECURITY.md)，然后通过仓库的 **Security → Report a vulnerability** 私下报告，或直接联系维护者。我们会尽快确认并修复。

## 许可证

提交贡献即表示你同意你的贡献按 [AGPL-3.0](./LICENSE) 发布，并已按 [CLA](./.github/CLA.md) 授予项目版权方商业再许可的权利。
