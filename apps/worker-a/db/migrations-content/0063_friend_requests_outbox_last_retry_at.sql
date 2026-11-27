-- 0063_friend_requests_outbox_last_retry_at.sql · CONTENT_DB
-- REL-FIX-1：outbox pending_retry 真重投 + 对齐 M-F3b 队尾沉没。
--
-- outbox_error：最近一次失败短码（禁 URL/邮箱原文）。
-- outbox_last_retry_at：最近一次 cron/重投尝试时间；失败只刷本列，不动 updated_at（保住 24h giveup 窗）。
-- 扫描按 COALESCE(NULLIF(outbox_last_retry_at,''), updated_at) ASC。

ALTER TABLE friend_requests ADD COLUMN outbox_error TEXT NOT NULL DEFAULT '';
ALTER TABLE friend_requests ADD COLUMN outbox_last_retry_at TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_friend_requests_outbox_retry
  ON friend_requests (outbox_status, outbox_last_retry_at, updated_at)
  WHERE outbox_status = 'pending_retry';
