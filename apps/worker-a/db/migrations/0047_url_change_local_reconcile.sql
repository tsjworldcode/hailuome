-- M7-30h-5：换域 confirm 后本地 D1/KV 同步失败时的 reconcile 队列（attempts 走 D1，禁 KV）
CREATE TABLE IF NOT EXISTS url_change_local_reconcile (
  url_change_id TEXT PRIMARY KEY,
  node_url TEXT NOT NULL,
  worker_b_url TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  next_attempt_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_url_change_local_reconcile_pending
  ON url_change_local_reconcile(status, next_attempt_at);
