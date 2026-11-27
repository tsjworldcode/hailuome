-- 0090_system_config_initial_keys.sql · IDENTITY_DB
-- M-OPT-SPLIT A-2：所有跨库到 system_config 的 INSERT 初始键汇总（统一在 IDENTITY_DB 初始化）。
-- 触发场景（部分对应原 governance/identity migration 文件中已注释掉 / 已迁出的 INSERT 行）：
--   0002_node_metadata        → images_storage / r2_probe_status
--   0005_posts_dirty          → posts_latest_dirty / posts_latest_last_refresh_at
--   0007_b2_probe_status      → b2_probe_status
--   0009_blacklist_sync       → blacklist_dirty / blacklist_last_sync_at
--   0010_owner_credentials    → 凭证相关（已有 owner_credentials 表，system_config 不再额外）
--   0020_registry_endpoints   → registry_endpoints / registry_directive_nonces
--   0025_dm_e2ee              → dm_retention_days
--   0032_registry_blacklist_sync → blacklist_remote_etag / blacklist_remote_last_sync_at
--   0033_media_storage_filebase  → filebase_probe_status
--   0034_media_storage_usage  → media_storage_mode / media_active_write_backend
--
-- INSERT OR IGNORE 不覆盖已存在的行；与原文件行为完全一致。

INSERT OR IGNORE INTO system_config (key, value, updated_at) VALUES
  ('images_storage',                 'kv',          strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('r2_probe_status',                'unknown',     strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('posts_latest_dirty',             'false',       strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('posts_latest_last_refresh_at',   '',            strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('b2_probe_status',                'unknown',     strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('blacklist_dirty',                'false',       strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('blacklist_last_sync_at',         '',            strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('blacklist_remote_etag',          '',            strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('blacklist_remote_last_sync_at',  '',            strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('blacklist_remote_sync_pending',  'false',       strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('federated_blacklist_sync_pending','false',      strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('federated_blacklist_sync_pending_payload','',   strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('registry_endpoints',             '[]',          strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('registry_directive_nonces',      '[]',          strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('dm_retention_days',              '180',         strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('filebase_probe_status',          'unconfigured',strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('media_storage_mode',             'manual',      strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('media_active_write_backend',     'kv',          strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));