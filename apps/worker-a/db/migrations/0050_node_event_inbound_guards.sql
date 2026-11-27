-- M7-30j-3：入站 node_url_changed — nonce 去重、来源限频、验签短缓存（全 D1，禁 KV）
CREATE TABLE IF NOT EXISTS node_event_nonces (
  nonce TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS node_event_rate (
  bucket_key TEXT PRIMARY KEY,
  window_start TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS node_event_verify_cache (
  cache_key TEXT PRIMARY KEY,
  ok INTEGER NOT NULL,
  pubkey TEXT,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_node_event_verify_cache_expires
  ON node_event_verify_cache(expires_at);
