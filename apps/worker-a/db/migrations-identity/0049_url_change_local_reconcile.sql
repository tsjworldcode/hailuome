-- M-OPT-SPLIT-5c-2 补漏：url_change_local_reconcile 实际由 resolveIdentityDb(env) 读写
-- （见 src/lib/urlChangeLocalReconcile.ts），但拆分时只把建表放进了 GOVERNANCE/DB_IMPORT 目录，
-- IDENTITY 目录缺 0049 → 线上换域 confirm 后本地重试队列一直报 no such table。
-- 本 migration 在 IDENTITY_DB 建表并直接带 lease_until（应用层 cronClaim 使用）。
CREATE TABLE IF NOT EXISTS url_change_local_reconcile (
  url_change_id TEXT PRIMARY KEY,
  node_url TEXT NOT NULL,
  worker_b_url TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  next_attempt_at TEXT,
  lease_until TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_url_change_local_reconcile_pending
  ON url_change_local_reconcile(status, next_attempt_at);
