-- REL-FIX-7：群主侧入群审批结果回推 outbox（可重投）。
-- 群主同意/拒绝后向申请人节点投递 GROUP_JOIN_DECISION_V1；对方不可达时落 pending，
-- 由既有群外部任务槽（5/15/25/35/45）重投，失败超限置 dead。
-- 纯 D1（禁 KV 计数）；不新增 binding，不新增 Cron 槽。

CREATE TABLE IF NOT EXISTS group_join_decision_outbox (
  id                   TEXT PRIMARY KEY,
  group_id             TEXT NOT NULL,
  member_worker_b_url  TEXT NOT NULL,
  decision             TEXT NOT NULL CHECK (decision IN ('approved', 'rejected')),
  envelope_json        TEXT NOT NULL,
  state                TEXT NOT NULL DEFAULT 'pending'
                         CHECK (state IN ('pending', 'sent', 'failed', 'dead')),
  retry_count          INTEGER NOT NULL DEFAULT 0,
  next_retry_at        TEXT NOT NULL,
  last_error           TEXT,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_group_join_decision_outbox_retry
  ON group_join_decision_outbox (state, next_retry_at);
