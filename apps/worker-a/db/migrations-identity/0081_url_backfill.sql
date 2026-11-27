-- M-OPT-SPLIT-B4 · B-4：users.worker_b_url 一次性回填。
--
-- 触发条件：
--   users.worker_b_url 为空（NULL 或 ''）且 system_config 中有 worker_b_url 记录。
--   仅影响开发期 / 早期部署遗留的空值行；生产正常流程不会产生空值。
--
-- 语义：
--   Phase 1：节点本地 users.worker_b_url 与 system_config.worker_b_url 必须一致，
--   均取自 env.WORKER_B_URL（注册完成前为 .dev.vars 注入的占位值）。
--   本次回填将 system_config 中登记的 worker_b_url 同步到 users 表。
--
-- 无匹配时：
--   若 system_config.key='worker_b_url' 不存在（未登记节点），本 SQL
--   的 UPDATE WHERE EXISTS 子查询命中 0 行，安全无副作用。
--
-- 执行前提（B-1 CHECK 已落地）：
--   回填目标值必须非空且以 http:// 或 https:// 开头；若 system_config
--   中的值本身不符合约束，则回填失败（SQLITE_CONSTRAINT），
--   operator 需先修正 system_config 再重跑。

-- 从 system_config 回填（仅影响空值行；非空值行不受影响）
UPDATE users
SET worker_b_url = (
    SELECT value FROM system_config
    WHERE key = 'worker_b_url'
    LIMIT 1
)
WHERE LENGTH(worker_b_url) = 0
  AND EXISTS (
    SELECT 1 FROM system_config WHERE key = 'worker_b_url'
  );
