-- M2-1b 安全补强：站主用户名+密码鉴权 + 登录失败频控。
--
-- 起因：M5-M7 代码 review 报告 §3.4 指出 M2-1 登录是整套改动里唯一明显的安全
-- 降级——用 `body.secret === env.JWT_SECRET` 明文等值为唯一凭据，同一密钥
-- 身兼登录密码与 HMAC 签名双职责，无用户名、无密码哈希、无失败频控、无 IP
-- 锁定。本 migration 引入两张表把这一缺口补上：
--
--   1. owner_credentials  — 站主登录凭证（用户名 + PBKDF2-SHA256 600k 哈希）
--   2. login_attempts     — 登录失败 IP 频控（rule 11 / F-01 硬约束：走 D1 不走 KV）
--
-- 兼容回落：M2-1b-3 实装的 `POST /auth/login` 在 owner_credentials 表为空时
-- 回落到旧的 `body.secret === JWT_SECRET` 等值路径 + `console.warn`，便于存量
-- 节点平滑升级；用户跑过 `scripts/owner-bootstrap.mjs` 写入凭证后自动切到密码
-- 哈希路径。
--
-- 时间字段统一 ISO 8601（与 0001_init.sql 保持一致）。

-- ---------------------------------------------------------------------------
-- 站主登录凭证表
--
-- 单节点单所有者设计：本表最多一行（username 为站主登录名，与 BOOTSTRAP_HANDLE / 登记 handle 可不同）。多管理员设计
-- 留给 M10+，到时改 PK 为复合主键并加 role 列即可。
--
-- password_hash 存储格式（来自 hailuo-registry workers/registry-gateway/src/lib/crypto.ts）：
--   v1:PBKDF2:<iterations>:SHA256:<saltHex>:<hashHex>
-- 例：v1:PBKDF2:600000:SHA256:<32 hex chars salt>:<64 hex chars hash>
--
-- 之所以把 algo / iterations / salt 同时存到独立列又一起拼进 password_hash：
--   - 独立列方便管理后台/排障 SQL 直接 SELECT 查阅；
--   - password_hash 字段一体保留以便未来如换算法（如 Argon2id），脚本可整体替换。
--
-- 算法升级路径（未来如要换 Argon2id）：
--   1. 改 hashPassword 写新格式 `v2:Argon2id:...`
--   2. verifyPassword 按 v1/v2 前缀分发
--   3. 用户下次 change-password 自动写 v2
--   4. 旧 v1 仍可登录，向后兼容无影响
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS owner_credentials (
  username       TEXT PRIMARY KEY,
  password_hash  TEXT NOT NULL,
  algo           TEXT NOT NULL DEFAULT 'PBKDF2-SHA256',
  iterations     INTEGER NOT NULL DEFAULT 600000,
  salt           TEXT NOT NULL,                    -- saltHex（也存在 password_hash 字段里，独立列方便 SQL 排障）
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- ---------------------------------------------------------------------------
-- 登录失败 IP 频控表
--
-- 设计：5 次失败 / 15 分钟窗口 → 锁定 5 分钟；锁定期间一律 429 LOGIN_LOCKED。
-- 正确登录后 DELETE 该 IP 的行（清计数）。
--
-- 为什么走 D1 不走 KV：
--   - KV Free Tier 写 1,000/天硬上限；登录失败频控写频次可能很高（攻击者会刷）
--   - D1 写 100,000/天，余量充足；而且本表行数最多约 1k 量级（IPv4 数量），
--     cron 半小时清理一次过期行即可
--
-- 字段语义：
--   - ip                : 客户端 IP（从 CF-Connecting-IP / X-Forwarded-For 头读）
--   - fail_count        : 当前窗口内累计失败次数
--   - locked_until      : 锁定到期时间（ISO 8601）；NULL 表示当前未锁定；
--                         locked_until > now() 时拒绝任何登录尝试（无论用户名/密码对错）
--   - first_attempt_at  : 当前窗口起点（用于 15 分钟窗口判定）
--   - last_attempt_at   : 最近一次尝试时间（cron 清理 last_attempt_at < now - 1d 的过期行）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS login_attempts (
  ip                TEXT PRIMARY KEY,
  fail_count        INTEGER NOT NULL DEFAULT 0,
  locked_until      TEXT,
  first_attempt_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_attempt_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- 索引：cron 清理时按 last_attempt_at 倒序扫
CREATE INDEX IF NOT EXISTS idx_login_attempts_last_attempt ON login_attempts (last_attempt_at);
