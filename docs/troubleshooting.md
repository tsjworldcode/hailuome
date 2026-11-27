# 排障手册 — 海螺节点（hailuo-node-cf）

## 快速诊断流程

1. **Worker A 或 Worker B 接口返回非 JSON 响应**（`NON_JSON_RESPONSE` / HTML 404）
   → 检查路由是否正确挂载（三处一致：文档 / 代码 / 前端调用）
   → 未登录时打目标 URL 如果返回 `{"ok":false,"error_code":"UNAUTHORIZED"}` 则路由正确

2. **接口返回 500**
   → 检查 D1 binding 是否正确，migration 是否已 apply
   → 检查 Secrets 是否配置（`wrangler secret list --env production`）

3. **本地接口返回 `no such table`**
   → 新增了 migration 但未在本地 apply → 执行：
   ```powershell
   npm exec -- wrangler d1 migrations apply node-db --local --config apps/worker-a/wrangler.toml
   ```

4. **Worker B Token 校验失败**
   → 检查 Worker B 的 `ED25519_PUBLIC_KEY` 与 Worker A 的 `ED25519_PRIVATE_KEY` 是否匹配
   → 检查 Token 是否过期（24h TTL）
   → 检查黑名单：`STATE_KV.get('blacklist:<nodeUrl>')`

5. **信息流不完整（关注节点帖子丢失）**
   → 先查游标/Cron 是否在跑、对方 Worker B 是否可达、Token/黑名单是否拦读
   → **不要**再按「关注数 >50 且未开 Queue → 静默截断」排障：现网是批大小+游标轮转，>50 仍正确，只是更慢
   → Queues 仅作 overflow 评估（默认关）；开启前见 NCF-2 §9 延迟/预算指标与 ops 公式

---

## 错误码速查

### Worker A 错误码

| 错误码 | 含义 | 处理建议 |
|---|---|---|
| `UNAUTHORIZED` | 未登录或 JWT 无效 | 重新登录获取 JWT |
| `AUTH_INVALID` | 登录凭证错误 | 检查密钥/密码 |
| `POST_NOT_FOUND` | 帖子不存在或已删除 | 正常情况，无需处理 |
| `CONTENT_TOO_LONG` | 内容超 500 字符 | 截断内容后重试 |
| `ALREADY_FOLLOWING` | 已关注该节点 | 无需重复关注 |
| `FOLLOW_LIMIT_EXCEEDED` | 超过关注上限 | 取关一些再关注 |
| `BLACKLISTED` | 目标节点在黑名单中 | 无法为其签发 Token |
| `INTERNAL_ERROR` | 服务器内部错误 | 检查 Cloudflare Workers 日志 |

### Worker B 错误码

| 错误码 | 含义 | 处理建议 |
|---|---|---|
| `TOKEN_MISSING` | 未携带粉丝 Token | 需先向 Worker A 获取 Token |
| `TOKEN_INVALID` | Token 签名无效 | 检查 PUBLIC_KEY 配置，或重新获取 Token |
| `TOKEN_EXPIRED` | Token 已过期 | 重新获取 Token（24h TTL） |
| `TOKEN_REVOKED` | Token 已吊销（黑名单） | 被封禁，无法访问 |
| `BLACKLISTED` | 请求者已被封禁 | 被封禁，无法访问 |
| `POST_NOT_FOUND` | 帖子不存在 | 正常情况 |
| `IMAGE_NOT_FOUND` | 图片不存在 | 检查 IMAGE_KV 中是否有对应 key |
| `MEDIA_TICKET_INVALID` | 媒体票据过期 / 签名无效 / 与当前 key 不匹配 | 重新调用 `POST /api/media/tickets` 取新票据（TTL 60s）；票据与图片 key 必须一一对应 |
| `MEDIA_TICKET_DISABLED` | 媒体票据未启用 | 确认当前为保护三档之一；Worker B 已有 `MEDIA_TICKET_SECRET`（部署应幂等注入，可用 `wrangler secret list --env production -c apps/worker-b/wrangler.toml`）；未设 `MEDIA_TICKET_ENABLED=false` |
| `MEDIA_TICKET_KEY_INVALID` | `storage_key` 不在媒体前缀白名单 | 只允许 `kv:` / `r2:` / `b2:` / `filebase:` 前缀 |
| `STORAGE_KEY_REQUIRED` | 缺少 `storage_key` | 请求体补 `storage_key` |

### 群密钥补拉（SEC-5 / EPOCH NET-2）

| 错误码 / 状态 | 含义 | 处理建议 |
|---|---|---|
| `GROUP_WRAP_FORBIDDEN` / 403 | 签名、时钟、成员资格或群主权威校验未通过；不区分群/包是否存在 | 两端升级签名协议、校准时钟、核对本机私钥与群内固定成员公钥；不要关闭验签或回退旧请求 |
| `GROUP_NONCE_REPLAY` / 409 | 同一个签名请求已处理 | 重试必须重新生成时间、nonce 和签名，不复用旧信封 |
| `GROUP_WRAP_RATE_LIMITED` / 429 | 每群每成员 UTC 整点小时 30 次额度用尽 | 停止密集重试，下一小时再试；换 epoch 不会增加额度 |
| `GROUP_KEY_PENDING` / 404 | 已通过身份校验，但该 epoch 的本人包尚未分发 | 等群主/管理员浏览器分发真实密钥包，不要上传占位包 |
| `GROUP_WRAP_UNAVAILABLE` / 503 | 权威存储或内部转发暂不可用 | 核查绑定、密钥配置与 D1 状态；恢复后使用新信封重试，禁止打印私钥、签名或完整成员 URL |
| `GROUP_MODERATION_FORBIDDEN` / 403 | 跨节点管理签名、活跃管理员资格或本机群主权威不符 | 以群主成员表为准核对 pin 和 is_admin，不依赖管理员本地镜像授权 |
| `GROUP_MODERATION_UNAVAILABLE` / 503 | 管理请求出站、内部转发或权威存储失败 | 刷新成员名单确认是否已生效；恢复后用新 nonce 重试，不透传原始异常 |
| `GROUP_RATE_LIMITED` / 429（管理信令） | 每群每管理员 UTC 小时 30 次独立额度用尽 | 停止密集重试，等待下个小时；nonce 重放不扣额度 |

无需先启用 `enforced` 或获取粉丝 Token；内部 HMAC 不能代替成员签名。频控桶和 nonce 不写 KV，清理规则与资源预算见 [`epoch-offline-rotate-2026-10-plan.md`](./epoch-offline-rotate-2026-10-plan.md)「NET-2 落地」。

---

## 常见问题

### Q: Worker B 如何获取黑名单？

Worker B 没有 D1 binding，黑名单通过 `STATE_KV.get('blacklist:<nodeUrl>')` 检查。黑名单数据由 Worker A Cron（每 5 分钟）同步写入 `STATE_KV`，最长 5 分钟延迟。

封禁后粉丝最多 5 分钟内仍可访问（STATE_KV 未同步），这是正常设计权衡。

### Q: posts_cache KV 更新失败怎么办？

发帖时 Worker A 向 KV 写入帖子缓存，若失败，帖子已写入 D1（安全），但 Worker B 暂时看不到新帖。下次 Cron 运行时会修复（Cron 会重新从 D1 同步到 KV）。

### Q: 关注的节点 Worker B 地址失效了怎么办？

Cron 检测到节点 `/health` 连续失败后，按指数退避减少拉取频率：1h → 6h → 24h → 停止拉取。节点重新上线后，下次 Cron 成功时自动恢复正常频率，并更新 `last_active`。

### Q: D1 写入行数快超限怎么办？

1. 检查 `feed_batches` 临时表是否未清理（聚合后应立即 DELETE）
2. 检查是否有异常的批量写入操作
3. 等到次日额度重置（UTC 00:00 重置）
4. 清理命令：
   ```powershell
   npm exec -- wrangler d1 execute node-db --env production --command "DELETE FROM feed_batches WHERE created_at < datetime('now', '-1 hour')" --config apps/worker-a/wrangler.toml
   ```

### Q: 本地 wrangler dev 启动失败

优先使用项目本地 wrangler：
```powershell
# 不用全局 wrangler
npm run dev:worker-a    # 等价于 npm exec wrangler dev
```

全局安装的 wrangler 可能缺失依赖模块，在 Windows 下尤其常见。

### Q: D1 system_config（如果有）覆盖默认值

如果通过管理接口保存过配置，D1 中的记录会覆盖代码的硬编码默认值。先查 D1 再判断：
```powershell
npm exec -- wrangler d1 execute node-db --env production --command "SELECT * FROM system_config" --config apps/worker-a/wrangler.toml
```

### Q: 手动写 `STATE_KV` 的 JSON 后，页面一直显示「待认证」

常见原因是 JSON 文件带了 UTF-8 BOM。Worker 的 `STATE_KV.get(key, 'json')` 不容忍 BOM，会返回 `null`，`public:profile.email_verified` 就被当成 `false`。

不要用 PowerShell `Set-Content -Encoding UTF8` / `Out-File` 直接生成 JSON 再 `wrangler kv key put`。统一用：

```powershell
node scripts/kv-put-json.mjs --namespace-id <namespace-id> --key public:profile --file profile.json
```

脚本会去 BOM、`JSON.parse` + `JSON.stringify`、检查首字符是否为 `{`（数组需显式 `--allow-array`），再用 `wrangler kv key put --path` 写入。先看结果可加 `--dry-run`。

---

## Cloudflare 日志查看

```powershell
# 实时日志（Worker A）
npm exec -- wrangler tail --env production --config apps/worker-a/wrangler.toml

# 实时日志（Worker B）
npm exec -- wrangler tail --env production --config apps/worker-b/wrangler.toml
```
