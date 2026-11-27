-- 节点元数据扩展：为 users / system_config 加上"协议层 + 运行时变量"字段
-- 对应方案优化.md §3.1（users 元数据）与 §3.7（R2 探针运行时变量）
--
-- 设计约定：
-- 1. 只新增列与新增 system_config 行，绝不 DROP，向前兼容旧代码（旧代码读不到列也不会报错）
-- 2. 所有新增字段都有默认值，老查询不需要改
-- 3. 单条 migration 内同时覆盖三个下游建议的地基：
--    - §3.3 DID 包装层 → users.did
--    - §7 机器节点（M2M / AI Agent） → users.node_type
--    - §3.7 + §4.3 R2 探针 + IMAGE_KV 回退 → system_config.images_storage / r2_probe_status
-- 4. 协议版本号 users.node_proto_version 给以后 worker-b feed 接口的"按版本投影"留接口

-- 给 users 表追加三列：节点类型、DID、协议版本
-- - node_type ∈ {human, machine, agent, org}，默认 'human' 兼容旧行为
-- - did       = 'did:hailuo:<SHA-256(pubkey_hex_string) 前 16 hex 字符>'，与注册中心 ids.ts 的 fingerprint 算法对齐（不带 key_ 前缀）；由 worker-a 启动时按规则生成；为空表示尚未生成
-- - node_proto_version 默认 '1.0'，未来 worker-b feed 可按版本做兼容投影
ALTER TABLE users ADD COLUMN node_type           TEXT NOT NULL DEFAULT 'human';
ALTER TABLE users ADD COLUMN did                 TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN node_proto_version  TEXT NOT NULL DEFAULT '1.0';

-- node_type 不建索引：当前节点表只有 owner 一行；将来若拆多用户表再加
-- did 也不建唯一索引：允许暂时为空（未生成时为 ''），生成后由应用层保证唯一性

-- 写入 system_config 的运行时变量（R2 探针，方案优化.md §3.7）
-- - images_storage   ∈ {kv, r2}        ：图片上传热路径直接读它决定写哪侧；默认 'kv'（最安全：不依赖 R2）
-- - r2_probe_status  ∈ {unknown, ok, missing, error}：上次探针结果，admin/UI 可见
-- 使用 INSERT OR IGNORE 防止已有节点重复执行报错
INSERT OR IGNORE INTO system_config (key, value, updated_at) VALUES
  ('images_storage',   'kv',      strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('r2_probe_status',  'unknown', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

-- 校验提示（人工执行用，不在迁移内运行）：
--   SELECT name FROM pragma_table_info('users') WHERE name IN ('node_type','did','node_proto_version');
--   SELECT key, value FROM system_config WHERE key IN ('images_storage','r2_probe_status');
