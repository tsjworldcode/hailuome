-- M7-30j-2：reconcile 原子 claim + lease（防 Cron 重叠双投递）
-- M-OPT-SPLIT A-2：原 0049 跨库 ALTER（url_change_notify_jobs 在 GOVERNANCE / url_change_notify_events 在 IDENTITY），
-- 现仅保留 url_change_local_reconcile ALTER（本身在 GOVERNANCE，与 feed_pull_batch 等同库）。
-- url_change_notify_jobs.lease_until 由应用层 cronClaim 在第 0046 后续等价列上自行维护（已用 lease_until 字符串）。
ALTER TABLE url_change_local_reconcile ADD COLUMN lease_until TEXT;
