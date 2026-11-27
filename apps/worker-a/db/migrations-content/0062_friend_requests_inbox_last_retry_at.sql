-- 0062_friend_requests_inbox_last_retry_at.sql · CONTENT_DB
-- M-F3b：打破 inbox pending_retry 队头阻塞（Head-of-Line Blocking）。
--
-- 背景：M-F3 失败重试故意不刷新 updated_at（保住 24h giveup 窗），但扫描又是
-- ORDER BY updated_at ASC LIMIT 10 → 最老一批离线目标会霸占窗口，后续请求饿死。
--
-- 解法：单独记 inbox_last_retry_at（最近一次重投尝试时间）；失败只刷本列 + inbox_error，
-- 不动 updated_at。扫描按 COALESCE(NULLIF(inbox_last_retry_at,''), updated_at) ASC，
-- 刚失败的行沉到队尾，其它 pending_retry 有机会被选中。

ALTER TABLE friend_requests ADD COLUMN inbox_last_retry_at TEXT NOT NULL DEFAULT '';

-- 覆盖旧索引：按 last_retry 排队（空值在查询侧 COALESCE 回落到 updated_at）
DROP INDEX IF EXISTS idx_friend_requests_inbox_retry;
CREATE INDEX IF NOT EXISTS idx_friend_requests_inbox_retry
  ON friend_requests (inbox_status, inbox_last_retry_at, updated_at)
  WHERE inbox_status = 'pending_retry';
