-- M9-14：Feed 分批游标 + 关注节点拉取退避
-- feed_pull_cursor / feed_pull_last_ok_at：Cron 轮转 batch 与上次全 batch 成功时间
-- follows.next_retry_at：单节点拉取失败后的退避截止时间（D1 写，禁止 KV）

ALTER TABLE follows ADD COLUMN next_retry_at TEXT;

INSERT OR IGNORE INTO system_config (key, value) VALUES ('feed_pull_cursor', '');
INSERT OR IGNORE INTO system_config (key, value) VALUES ('feed_pull_last_ok_at', '');
