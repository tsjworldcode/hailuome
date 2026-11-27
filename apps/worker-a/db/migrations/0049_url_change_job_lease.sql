-- M7-30j-2：outbox / reconcile 原子 claim + lease（防 Cron 重叠双投递）
ALTER TABLE url_change_notify_jobs ADD COLUMN lease_until TEXT;
ALTER TABLE url_change_local_reconcile ADD COLUMN lease_until TEXT;
