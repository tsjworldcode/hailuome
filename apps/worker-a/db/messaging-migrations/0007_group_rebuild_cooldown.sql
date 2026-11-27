-- M16-SLA §20：重建冷却 ≥10s
-- 为 groups 表增加 last_rebuilt_at，记录最近一次整表重建完成时间。
-- 入口检查：距 last_rebuilt_at < GROUP_REBUILD_COOLDOWN_MS(10s) 时跳过本次重建。

ALTER TABLE groups ADD COLUMN last_rebuilt_at TEXT;
-- 旧数据：将 last_rebuilt_at 设为 1970-01-01T00:00:00.000Z，视为「无重建历史」，首次触发无冷却。
UPDATE groups SET last_rebuilt_at = '1970-01-01T00:00:00.000Z' WHERE last_rebuilt_at IS NULL;
