-- M5-B2：B2 凭证表（backend 权威源仍为 system_config.images_storage）
CREATE TABLE IF NOT EXISTS media_storage_config (
  id           TEXT PRIMARY KEY,
  config_json  TEXT NOT NULL DEFAULT '{}',
  updated_at   TEXT NOT NULL
);

INSERT OR IGNORE INTO media_storage_config (id, config_json, updated_at)
VALUES ('b2', '{}', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
