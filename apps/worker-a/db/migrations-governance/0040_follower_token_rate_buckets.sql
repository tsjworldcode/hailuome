-- SDH-5：粉丝 Token 签发限频（按 follower_node_url 每小时 D1 计数，禁止 KV 写）

CREATE TABLE IF NOT EXISTS follower_token_rate_buckets (
  follower_node_url TEXT NOT NULL,
  window_hour          TEXT NOT NULL,
  count                INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (follower_node_url, window_hour)
);

CREATE INDEX IF NOT EXISTS idx_follower_token_rate_buckets_window
  ON follower_token_rate_buckets (window_hour);
