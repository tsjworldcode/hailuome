-- M5-FB：Filebase 凭证行 + 探针状态键
INSERT OR IGNORE INTO media_storage_config (id, config_json, updated_at)
VALUES ('filebase', '{}', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

INSERT OR IGNORE INTO system_config (key, value, updated_at)
VALUES ('filebase_probe_status', 'unconfigured', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
