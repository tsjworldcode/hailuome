-- M16-1a 续：标记 dm_* 表权威 DDL 已迁至 MESSAGING_DB（db/messaging-migrations/0001_messaging_dm.sql）
--
-- 0025/0026/0027 历史 migration 曾在主库创建同名表；存量节点在 M16-1b 完成前仍暂留主库副本。
-- M16-1b 须先 migrate-dm-to-messaging-db.mjs 校验 COUNT 一致，再执行 0042_drop_dm_tables.sql。
-- 本步无 schema 变更（SELECT 1 占位，满足 wrangler migration 非空要求）。

SELECT 1;
