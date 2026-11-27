-- M10-3: 私信收件限频桶（按 sender_worker_b_url 每小时 D1 计数，符合 Free Tier KV 禁写约束）

CREATE TABLE IF NOT EXISTS dm_rate_buckets (
  sender_worker_b_url TEXT NOT NULL,
  window_hour          TEXT NOT NULL,
  count                INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (sender_worker_b_url, window_hour)
);

CREATE INDEX IF NOT EXISTS idx_dm_rate_buckets_window
  ON dm_rate_buckets (window_hour);
