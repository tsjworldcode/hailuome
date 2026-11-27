-- 注册中心推荐用户缓存。仅 Worker A 写入/读取，避免 Web 每次打开都打注册中心。
CREATE TABLE IF NOT EXISTS registry_recommended_users (
  user_id TEXT PRIMARY KEY,
  handle TEXT NOT NULL,
  node_url TEXT NOT NULL,
  worker_b_url TEXT NOT NULL,
  health_status TEXT NOT NULL,
  profile_status TEXT NOT NULL,
  pubkey_fingerprint TEXT NOT NULL,
  registered_at TEXT NOT NULL,
  last_health_at TEXT,
  reason TEXT NOT NULL,
  fetched_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_registry_recommended_users_fetched_at
  ON registry_recommended_users(fetched_at DESC);
