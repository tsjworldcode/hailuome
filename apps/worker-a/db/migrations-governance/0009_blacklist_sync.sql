-- M6-3：黑名单 D1 → STATE_KV Cron 同步 dirty 节流配置。
-- 新增 system_config 两行（INSERT OR IGNORE，已存在则不覆盖）：
--   blacklist_dirty           — M6-1 POST/DELETE 写完 D1 blacklist 表时置 'true'；
--                               M6-3 syncBlacklistToKvIfDirty Cron 同步成功后置 'false'
--   blacklist_last_sync_at    — 最后一次成功同步到 STATE_KV 的时间（ISO 8601）
--
-- 节流模式与 posts_latest_dirty（M2-0 / M3-5）同形：
--   - cron tick 大多数情况下 dirty='false'，单次 SELECT 即返回（无 KV 写）
--   - 仅在 M6-1 路由写完 D1 后才置 dirty='true'，下次 Cron 才执行全量 diff sync
--   - Free Tier KV 写 1,000 次/天硬约束下，本机制确保只在真有变化时才写 KV
--
-- 启用时机：M6-3 接入 cron */5 调度后 syncBlacklistToKvIfDirty 才会读取这两行
-- （实际从 IDENTITY_DB 读，本库不再 INSERT）。

-- M-OPT-SPLIT A-2：原 `INSERT INTO system_config` 已迁至 IDENTITY_DB
-- `0090_system_config_initial_keys.sql`。本文件不执行 INSERT。

SELECT 1;
