-- M7-24：本节点调用注册中心 lookup/search 的本地日/分钟配额（D1 计数，禁止 KV）。
-- 仅在实际回源注册中心前扣减；cache_entries 命中不计入。
-- Feed Cron 拉关注者帖子不走本表。

CREATE TABLE IF NOT EXISTS registry_quota_buckets (
  scope       TEXT NOT NULL,  -- lookup_day | search_day | search_minute（后两者预留给 search）
  bucket      TEXT NOT NULL,  -- 日桶 YYYY-MM-DD；分钟桶 YYYY-MM-DDTHH:MM（UTC）
  count       INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (scope, bucket)
);

CREATE INDEX IF NOT EXISTS idx_registry_quota_updated
  ON registry_quota_buckets (updated_at ASC);
