-- M16-1b：主库移除已迁至 MESSAGING_DB 的 dm_* 表。
-- 硬前置：scripts/migrate-dm-to-messaging-db.mjs 校验每表 COUNT(*) 一致 + Worker 已切 MESSAGING_DB 读写。
-- 保留：users.dm_pubkey、system_config.dm_retention_days（仍在主库 DB）。

DROP INDEX IF EXISTS idx_dm_messages_conv_created;
DROP INDEX IF EXISTS idx_dm_messages_created;
DROP INDEX IF EXISTS idx_dm_rate_buckets_window;

DROP TABLE IF EXISTS dm_messages;
DROP TABLE IF EXISTS dm_wrapped_keys;
DROP TABLE IF EXISTS dm_nonces;
DROP TABLE IF EXISTS dm_rate_buckets;
DROP TABLE IF EXISTS dm_wrapped_identity;
