-- M17-FIX-2：加好友频控表（plan §四.2.1）
-- M17-1b 阶段预留了函数替身（fail-open）；M17-FIX-2 落地真表，使频控真实生效。
-- M17 审查 P0-2：`ON CONFLICT WHERE count < ?` 在 D1/SQLite 中 WHERE 子句被忽略，频控形同虚设。
-- 修复：两步法（SELECT → UPSERT → 二次 SELECT 校验），详见 plan §四.2.2。
--
-- 窗口键格式：`${scope}:${nodeUrl}:${window}`
--   - origin:<origin_node_url>:2026-09-05T00:00:00.000Z  （小时桶）
--   - origin:<origin_node_url>:2026-09-05               （天桶）
--   - inbox:<source_node_url>:2026-09-05T00:00:00.000Z  （小时桶）
--
-- 限额常量（plan §九.2）：
--   - 发起方：20 次/小时/节点 + 100 次/天/节点
--   - 跨节点 inbox：100 次/小时/源节点

CREATE TABLE IF NOT EXISTS friend_request_rate_buckets (
  bucket_key    TEXT NOT NULL PRIMARY KEY,
  count         INTEGER NOT NULL DEFAULT 0 CHECK (count >= 0),
  window_start  TEXT NOT NULL
);

-- 按窗口时间扫描（GC 时按 window_start < now - N 清旧桶）
CREATE INDEX IF NOT EXISTS idx_friend_request_rate_window
  ON friend_request_rate_buckets (window_start);
