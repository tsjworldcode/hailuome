-- M9-3-R1：已登记注册中心权威表（始终 ≤1 条；含 URL/token，供 health/daily-sync 直连）
-- registry_endpoints 仍作地址簿（含 pending 备用）；登记会员以本键为准。
INSERT OR IGNORE INTO system_config (key, value, updated_at) VALUES
  ('registered_registries', '[]', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
