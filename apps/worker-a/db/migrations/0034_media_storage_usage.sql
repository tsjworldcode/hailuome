-- M5-SR：各后端用量计数（上传自记账 + Filebase Platform API 校准）
CREATE TABLE IF NOT EXISTS media_storage_usage (
  backend            TEXT PRIMARY KEY,
  bytes_used         INTEGER NOT NULL DEFAULT 0,
  object_count       INTEGER NOT NULL DEFAULT 0,
  bytes_limit        INTEGER,
  bytes_buffer       INTEGER NOT NULL DEFAULT 0,
  last_calibrated_at TEXT,
  updated_at         TEXT NOT NULL
);

INSERT OR IGNORE INTO media_storage_usage (backend, bytes_limit, bytes_buffer, updated_at)
VALUES
  ('filebase', 5368709120, 52428800, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('b2',       10737418240, 104857600, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('r2',       NULL, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('kv',       NULL, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

INSERT OR IGNORE INTO system_config (key, value, updated_at)
VALUES
  ('media_storage_mode', 'manual', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('media_active_write_backend', 'kv', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
