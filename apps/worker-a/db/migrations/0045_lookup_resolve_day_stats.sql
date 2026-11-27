-- M-OPT-8：节点侧 handle 解析分层命中日桶（L1/L4 占比排障；每请求写 → D1，禁止 KV）

CREATE TABLE IF NOT EXISTS lookup_resolve_day_stats (
  day         TEXT NOT NULL,  -- UTC YYYY-MM-DD
  source      TEXT NOT NULL,  -- l1_follows | l1_cache | l4_registry | l4_quota_exceeded | l4_not_found | l4_error
  count       INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (day, source)
);

CREATE INDEX IF NOT EXISTS idx_lookup_resolve_day_stats_updated
  ON lookup_resolve_day_stats (updated_at ASC);
