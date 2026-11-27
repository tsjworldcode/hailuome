-- M5-SR-P2：公开媒体对象登记（上传记账 + 删帖释放减计数）
CREATE TABLE IF NOT EXISTS media_object_registry (
  object_key   TEXT PRIMARY KEY,
  backend      TEXT NOT NULL,
  size_bytes   INTEGER NOT NULL,
  created_at   TEXT NOT NULL,
  released_at  TEXT
);

CREATE INDEX IF NOT EXISTS idx_media_object_registry_released
  ON media_object_registry (released_at);
