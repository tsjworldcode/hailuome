-- 0015: 站主可见的关键运行日志。
-- 只记录低频关键阶段与错误，避免把每次请求都写入 D1。
CREATE TABLE IF NOT EXISTS operation_logs (
  id          TEXT PRIMARY KEY,
  source      TEXT NOT NULL,
  level       TEXT NOT NULL,
  event       TEXT NOT NULL,
  message     TEXT NOT NULL,
  details     TEXT NOT NULL DEFAULT '{}',
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_operation_logs_created_at ON operation_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_operation_logs_source_created_at ON operation_logs (source, created_at DESC);
