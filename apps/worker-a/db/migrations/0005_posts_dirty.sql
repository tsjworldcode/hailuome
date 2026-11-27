-- posts_latest_dirty 初始配置（M2-0）
-- 序号更正：原计划 0004，因 M1-3a cache_entries 已占用 0004，顺延为 0005。
--
-- 不建新表，仅向 system_config 插入两行初始配置（INSERT OR IGNORE，已存在则不覆盖）：
--   posts_latest_dirty            — Worker A 发帖/删帖后置 'true'；Cron 刷 KV 后置 'false'
--   posts_latest_last_refresh_at  — 最后一次成功刷新 POSTS_CACHE_KV 的时间（ISO 8601）
--
-- M2-2 发帖接口会将 posts_latest_dirty 置 'true'（D1 UPDATE，非 KV 写）。
-- M3-4 Cron refreshPostsCacheIfDirty 读取此两行，决定是否刷新 POSTS_CACHE_KV。

INSERT OR IGNORE INTO system_config (key, value) VALUES ('posts_latest_dirty', 'false');
INSERT OR IGNORE INTO system_config (key, value) VALUES ('posts_latest_last_refresh_at', '');
