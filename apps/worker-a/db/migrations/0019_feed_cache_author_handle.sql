-- M9-18d：Following feed 展示关注对象真实 handle
-- Cron 拉取关注节点原创帖时，把 follows.followed_handle 写入 feed_cache，
-- 经 feed:latest KV 传给 Worker B GET /feed，避免前端从 worker-b 域名派生错误 @handle。

ALTER TABLE feed_cache ADD COLUMN author_handle TEXT;
