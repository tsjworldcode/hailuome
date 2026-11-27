-- 0061_friend_requests_inbox_status.sql · CONTENT_DB
-- M-F3：发起端跨节点 inbox 投递跟踪（与 outbox_status 对称）。
--   ''            — 未投递 / 初始
--   'acked'       — 对端已接收
--   'pending_retry' — 投递失败，cron 24h 内重试
--   'giveup'      — 超过 24h 放弃（本地 pending 行仍在，对方可能永远收不到）
-- inbox_error：最近一次失败的 error_code（脱敏短码，不含 URL/邮箱原文）。

ALTER TABLE friend_requests ADD COLUMN inbox_status TEXT NOT NULL DEFAULT '';
ALTER TABLE friend_requests ADD COLUMN inbox_error TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_friend_requests_inbox_retry
  ON friend_requests (inbox_status, updated_at)
  WHERE inbox_status = 'pending_retry';
