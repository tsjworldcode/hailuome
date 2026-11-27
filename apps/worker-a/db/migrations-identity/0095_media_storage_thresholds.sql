-- 0095_media_storage_thresholds.sql · IDENTITY_DB
-- M8-14-7：媒体存储大小阈值 + KV/R2 用量行软上限初始化。
-- 新增 system_config 键（M8-14-7）：
--   media_kv_preferred_max_bytes（默认 10 MiB）：≤此值且 image/* 优先写 KV
--   media_kv_high_watermark（默认 0.90）：KV 高水位线；≥此比例时新文件改道 R2
-- M8-14-8 预置：
--   media_r2_high_watermark（默认 0.90）：R2 高水位线；≥此比例时触发 GC
--   media_r2_target_watermark（默认 0.70）：R2 GC 目标水位（清到约 70%）
-- 初始化 media_storage_usage 行（M8-14-7 + M8-14-8 预备）：
--   kv.bytes_limit = 1 GiB（KV 软上限，与 Free Tier 平台约束对齐）
--   r2.bytes_limit = 10 GiB（R2 Free 存储约 10 GB-month）
-- INSERT OR IGNORE 不覆盖已存在的行；INSERT OR REPLACE 修复 bytes_limit 为正确值。

-- system_config 新增阈值键（INSERT OR IGNORE：新节点或未设置时不覆盖）
INSERT OR IGNORE INTO system_config (key, value, updated_at) VALUES
  ('media_kv_preferred_max_bytes', '10485760',           strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('media_kv_high_watermark',     '0.90',               strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('media_r2_high_watermark',      '0.90',               strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('media_r2_target_watermark',   '0.70',               strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

-- media_storage_usage：用量行 bytes_limit 初始化/修正
-- INSERT OR REPLACE 确保 kv/r2 行有正确软上限（已有行覆盖 null 值）
INSERT OR REPLACE INTO media_storage_usage
  (backend, bytes_used, object_count, bytes_limit, bytes_buffer, last_calibrated_at, updated_at)
VALUES
  ('kv', 0, 0, 1073741824, 0, NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

INSERT OR REPLACE INTO media_storage_usage
  (backend, bytes_used, object_count, bytes_limit, bytes_buffer, last_calibrated_at, updated_at)
VALUES
  ('r2', 0, 0, 10737418240, 0, NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
