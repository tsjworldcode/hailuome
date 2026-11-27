-- M5-P9：补齐 gcFeedCache 缺失的 fetched_at 索引。
--
-- 背景：
--   gcFeedCache 每整点执行 `DELETE FROM feed_cache WHERE fetched_at < ?`（48h cutoff）。
--   0001_init.sql 中 feed_cache 仅建了 idx_feed_cache_created_at 与 idx_feed_cache_node_url，
--   按 fetched_at 过滤会退化为全表扫描。关注节点越多、Cron 周期越久，feed_cache 行数
--   越大（每节点最多 20 条 × N 个关注 × 48h 周转），全表扫描代价随之线性放大。
--
-- 审查结论（M5-P9 阶段）：
--   - outbound_events 的 retry 扫描原计划新建 idx_outbound_events_retry(status, created_at)，
--     审查发现 0003_outbound_events.sql 已有 idx_outbound_status_created(status, created_at ASC)，
--     完美命中 retryFailedOutboundEvents 的 WHERE+ORDER BY，**无需新增**。
--   - cache_entries.fetched_at 索引在 0004 已存在，无需新增。
--   - 仅 feed_cache.fetched_at 缺索引，本 migration 单独补齐。
--
-- 影响范围：
--   - DDL 仅 CREATE INDEX IF NOT EXISTS，幂等，可重入。
--   - 现有读路径不变；写路径每次 INSERT/UPDATE/DELETE 多维护一个 B-tree 节点，开销可忽略。
--   - 索引大小约为表行数 × 32 字节量级（ISO8601 字符串 + rowid），feed_cache 量级上不会撑爆。

CREATE INDEX IF NOT EXISTS idx_feed_cache_fetched_at
  ON feed_cache (fetched_at);
