-- M6-4：注册中心全局黑名单 Cron 同步元数据（ETag / 上次成功同步时间）。
-- 写入方：syncRegistryBlacklistToKv（minute === 0 整点分支）。

INSERT OR IGNORE INTO system_config (key, value) VALUES ('blacklist_remote_etag', '');
INSERT OR IGNORE INTO system_config (key, value) VALUES ('blacklist_remote_last_sync_at', '');
