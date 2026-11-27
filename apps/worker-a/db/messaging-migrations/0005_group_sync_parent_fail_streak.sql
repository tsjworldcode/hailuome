-- M16-7e：E-4 父节点连续 sync 失败计数（≥2 次降级 unsynced 直连群主）
ALTER TABLE group_sync_state ADD COLUMN parent_sync_fail_streak INTEGER NOT NULL DEFAULT 0;
