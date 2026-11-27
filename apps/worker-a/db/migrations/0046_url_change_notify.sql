-- M7-30f-4：换域已知联系人尽力推送 outbox（attempts / next_attempt_at 走 D1，禁止 KV）
CREATE TABLE IF NOT EXISTS url_change_notify_jobs (
  id TEXT PRIMARY KEY,
  url_change_id TEXT NOT NULL,
  target_node_url TEXT NOT NULL,
  source TEXT NOT NULL,           -- mutual | dm | group（历史行可能仍为 follows | interaction）
  status TEXT NOT NULL,           -- pending | sent | failed | dead | skipped
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  next_attempt_at TEXT,           -- ISO8601
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (url_change_id, target_node_url)
);

CREATE INDEX IF NOT EXISTS idx_url_change_notify_due
  ON url_change_notify_jobs (status, next_attempt_at);
