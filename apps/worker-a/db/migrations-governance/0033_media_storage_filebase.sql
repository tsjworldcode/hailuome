-- M5-FB：Filebase 凭证行 + 探针状态键
--
-- M-OPT-SPLIT A-2：
--   - media_storage_config.id='filebase' 保留在本库（GOVERNANCE_DB 媒体后端治理）
--   - `INSERT INTO system_config ('filebase_probe_status', ...)` 已迁至
--     IDENTITY_DB `0090_system_config_initial_keys.sql`（跨库 INSERT 不可行）

INSERT OR IGNORE INTO media_storage_config (id, config_json, updated_at)
VALUES ('filebase', '{}', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
