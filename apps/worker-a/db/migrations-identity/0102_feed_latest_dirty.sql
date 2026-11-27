-- 0102_feed_latest_dirty.sql · IDENTITY_DB
-- M-F2：取关清缓存后置脏标记，由既有每分钟 Cron 刷 feed:latest KV（F-01：HTTP 路径零 KV.put）。
-- INSERT OR IGNORE：历史库若已有该 key 不覆盖；运行时 markFeedLatestDirty 用 INSERT OR REPLACE 自愈。

INSERT OR IGNORE INTO system_config (key, value, updated_at) VALUES
  ('feed_latest_dirty', 'false', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
