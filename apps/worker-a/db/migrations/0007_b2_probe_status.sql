-- M5-C8：B2 可用性探针状态字段
--
-- 与 0002 引入的 r2_probe_status 对称，用于 admin UI 监控 B2 健康度。
-- 探针由 worker-a/src/handlers/cron.ts probeB2 每 30 分钟（minute % 30 === 0）触发。
--
-- 状态取值：
--   'unknown'     — 初始值，B2 未配置或探针尚未运行
--   'ok'          — 探针成功（PUT + DELETE 均返回 2xx）
--   'unconfigured'— 5 个 B2 env vars 未齐全（用户未启用 B2）
--   'fail'        — 凭证错误 / 桶不存在 / 配额满 / 网络异常等
--
-- 注意：images.ts 上传热路径不强制依赖此字段，仍以 b2Ready（env 齐全）为唯一开关；
-- 探针仅用于监控/排障可见性，避免运行时反复连 B2。

INSERT OR IGNORE INTO system_config (key, value, updated_at) VALUES
  ('b2_probe_status', 'unknown', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
