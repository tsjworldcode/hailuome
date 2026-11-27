-- M9-3-2：多注册中心有序列表 system_config 初始键（INSERT OR IGNORE，不覆盖已有登记数据）
INSERT OR IGNORE INTO system_config (key, value, updated_at) VALUES
  ('registry_endpoints', '[]', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('registry_directive_nonces', '[]', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
