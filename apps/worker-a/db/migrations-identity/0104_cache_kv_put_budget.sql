-- 0104_cache_kv_put_budget.sql · IDENTITY_DB
-- M13-16：非安全公开缓存（feed:latest / posts:latest）日 put 预算计数器。
-- 计数在 D1（禁止用 KV 记额度）；UTC 日界滚动；安全路径（删帖等）不消耗本计数。

INSERT OR IGNORE INTO system_config (key, value, updated_at) VALUES
  ('cache_kv_budget_utc_day', '',  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('cache_kv_budget_used',    '0', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
