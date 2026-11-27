-- M6-4：注册中心全局黑名单 Cron 同步元数据（ETag / 上次成功同步时间）。
-- 写入方：syncRegistryBlacklistToKv（minute === 0 整点分支）。
-- 实际写入 IDENTITY_DB；本文件不执行 INSERT（见 0090_system_config_initial_keys.sql）。

SELECT 1;
