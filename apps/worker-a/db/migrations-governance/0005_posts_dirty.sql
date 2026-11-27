-- posts_latest_dirty 初始配置（M2-0）
-- 序号更正：原计划 0004，因 M1-3a cache_entries 已占用 0004，顺延为 0005。
--
-- M-OPT-SPLIT A-2：原 `INSERT INTO system_config` 已迁至 IDENTITY_DB
-- `0090_system_config_initial_keys.sql`（system_config 表已不在本库）。
-- 本文件不再执行 INSERT；本地 apply 不再依赖 system_config。
--
-- 业务含义（仍有效，路由层 / cron 仍读写 system_config 在 IDENTITY_DB）：
--   posts_latest_dirty            — Worker A 发帖/删帖后置 'true'；Cron 刷 KV 后置 'false'
--   posts_latest_last_refresh_at  — 最后一次成功刷新 POSTS_CACHE_KV 的时间（ISO 8601）
--
-- M2-2 发帖接口会将 posts_latest_dirty 置 'true'（D1 UPDATE，非 KV 写）。
-- M3-4 Cron refreshPostsCacheIfDirty 读取这两行（IDENTITY_DB），决定是否刷新 POSTS_CACHE_KV。

SELECT 1;
