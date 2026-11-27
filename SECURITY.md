# 安全政策（Security Policy）

海螺节点是**自部署**软件：每个站主在自己的 Cloudflare 账号里运行，安全边界同时取决于代码和站主的部署配置。我们重视安全报告，并会尽快处理。

## 支持的版本

只维护 `main` 分支的最新快照。旧快照不单独修复；发现问题请先确认能否在最新 `main` 上复现。

## 报告漏洞

**请不要开公开 Issue、Discussion 或 PR。** 公开细节会立刻暴露给所有已部署节点。

首选渠道：

> **GitHub 仓库 → Security → Report a vulnerability**（私密 Security Advisory）

备用渠道：通过 GitHub 账号 [@tsjworldcode](https://github.com/tsjworldcode) 联系，并在消息里注明「安全报告」。

如果仓库的「Report a vulnerability」入口不可用，说明维护者尚未开启 Private vulnerability reporting，请先用备用渠道联系。

## 报告里请包含

1. 受影响组件：Worker A / Worker B / Web / `packages/*` / 部署脚本 / 文档
2. 版本或 commit（`git rev-parse HEAD`）
3. 最小复现步骤或 PoC
4. 影响判断：读取他人数据、绕过鉴权、伪造签名、RCE、SSRF、密钥泄露等
5. 是否在真实节点验证；如涉及真实用户数据，请先脱敏，只提供必要片段

## 响应时间

| 阶段 | 目标 |
|---|---|
| 确认收到 | 72 小时内 |
| 初步判断（有效 / 无效 / 需补充） | 7 天内 |
| 有效漏洞的修复计划 | 30 天内；严重问题优先 |
| 协调披露 | 修复发布后 90 天内公开细节，除非双方另行约定 |

如果 7 天内没有收到回复，可以再发一次，或在原 Advisory 里补充。

## 范围

- **Worker A 写层**：JWT、站主会话、粉丝 Token、Ed25519 签名、黑名单、注册中心鉴权
- **Worker B 读层**：读帖鉴权、缓存、媒体票据、跨节点转发
- **跨节点信任**：bootstrap 入口、注册中心、好友/群/私信信封、URL 迁移
- **Web 前端**：XSS、CSRF、敏感信息进入 bundle、IndexedDB / 加解密处理
- **部署脚本**：密钥处理、命令注入、权限边界、CI 凭证
- **加密实现**：`packages/shared-crypto` 的 DM、群聊、票据、包裹密钥

## 不在范围

- 站主自己的配置错误，例如公开 Worker A 地址、Token 权限过大、关闭鉴权、使用弱密码
- Cloudflare 平台自身的问题（请直接报给 Cloudflare）
- 免费额度耗尽、账号封禁、计费争议等运营问题
- 社会工程、物理访问、对自有测试环境的拒绝服务
- 依赖库漏洞：请提供上游 CVE 编号与实际影响路径

## 安全港

对善意的安全研究，我们不会采取法律行动，前提是：

- 不访问、修改、泄露他人数据
- 不破坏服务可用性，不进行大规模扫描或压测
- 只在你自己的节点或明确授权的环境测试
- 给合理的时间修复后再公开

## 致谢

修复发布后，可以在 Security Advisory 中致谢。默认匿名，除非你明确要求署名。

---

## English summary

Please report vulnerabilities privately via **GitHub → Security → Report a vulnerability**. Do not open public issues with exploit details. We aim to acknowledge within 72 hours, triage within 7 days, and coordinate disclosure within 90 days after a fix. Testing must be limited to your own deployment, must not access or modify other users' data, and must not degrade availability. Good-faith research is safe-harbored.
