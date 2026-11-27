-- M-OPT-SPLIT-5c-2 补漏：url_change_notify_jobs 在 GOVERNANCE_DB（0046 建表），
-- 但拆库时 0049 只保留了 url_change_local_reconcile 的 ALTER，漏掉本表的 lease_until，
-- 导致 deliverUrlChangeNotifyJobs 的 claim/查询全部报 no such column: lease_until。
-- 应用层 cronClaim 需要该列做 processing 租约。
ALTER TABLE url_change_notify_jobs ADD COLUMN lease_until TEXT;
