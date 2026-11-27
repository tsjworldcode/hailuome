-- 0091_blacklist_kv_sync_budget.sql · IDENTITY_DB
-- R-AUDIT-SEP-B2：黑名单 KV 分轮 pending 游标键（冷启动/大变更集不打穿 Free 1K/天）

INSERT OR IGNORE INTO system_config (key, value, updated_at) VALUES
  ('blacklist_remote_sync_pending',           'false', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('federated_blacklist_sync_pending',        'false', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('federated_blacklist_sync_pending_payload','',      strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
