-- 外出请求回执表（outbound_events）
-- M1-2 提前建表（方案优化.md §5.3，原计划 0005 但 M1-2 需要此表，提前至 0003）
-- M4-2 步骤变更为：在此表上实装 index/post、index/comment 的重试扫描逻辑（不再建表）
--
-- kind 枚举（当前仅 M1-2 使用 registry/health）：
--   registry/health   — POST /api/node/health 上报
--   index/post        — POST /api/posts/index 帖子索引上报（M4-2 实装）
--   index/comment     — POST /api/comments/index 评论索引上报（M4-2 实装）
--
-- status 枚举：pending / ok / failed
-- retries：失败后重试次数，上限 3 次（Cron 每 15 分钟扫一次，M4-2 实装完整重试）

CREATE TABLE IF NOT EXISTS outbound_events (
  id           TEXT PRIMARY KEY,            -- evt_<uuid_no_hyphen>
  kind         TEXT NOT NULL,               -- registry/health | index/post | index/comment
  target_url   TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'ok',  -- ok | failed
  http_code    INTEGER,                     -- HTTP 响应状态码，网络失败时为 NULL
  err_code     TEXT,                        -- 注册中心 / 索引中心错误码
  err_message  TEXT,                        -- 错误描述（截断至 500 字符）
  payload_hash TEXT NOT NULL DEFAULT '',    -- SHA-256(canonical_json)，health 事件为空
  retries      INTEGER NOT NULL DEFAULT 0,  -- 已重试次数（上限 3）
  created_at   TEXT NOT NULL,               -- 首次请求时间（ISO 8601）
  finished_at  TEXT                         -- 最后一次请求完成时间（ISO 8601）
);

-- 按 kind + 时间查询（前端展示历史、排障）
CREATE INDEX IF NOT EXISTS idx_outbound_kind_created ON outbound_events (kind, created_at DESC);
-- 按 status 查询（Cron 重试扫描）
CREATE INDEX IF NOT EXISTS idx_outbound_status_created ON outbound_events (status, created_at ASC);
