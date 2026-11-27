-- M7-30k-1：链式迁址 entry D1 SSOT；STATE_KV index/entry 由 confirm 后快照同步。

CREATE TABLE IF NOT EXISTS node_url_moved_entries (
  entry_key TEXT PRIMARY KEY,
  old_node_url TEXT NOT NULL,
  new_node_url TEXT NOT NULL,
  declaration_json TEXT NOT NULL,
  grace_until TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_node_url_moved_old ON node_url_moved_entries(old_node_url);
CREATE INDEX IF NOT EXISTS idx_node_url_moved_grace ON node_url_moved_entries(grace_until);
