-- M9-3-8：outbound_events 增加 registry router 审计字段
-- registry_id：本次通信成功的注册中心实例
-- router_attempts：最终成功 endpoint 上的尝试次数
-- router_detail：failover / 重试摘要（截断至 500 字符由应用层保证）

ALTER TABLE outbound_events ADD COLUMN registry_id TEXT;
ALTER TABLE outbound_events ADD COLUMN router_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE outbound_events ADD COLUMN router_detail TEXT;

CREATE INDEX IF NOT EXISTS idx_outbound_registry_created
  ON outbound_events (registry_id, created_at DESC);
