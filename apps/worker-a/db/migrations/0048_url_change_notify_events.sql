-- M7-30j-1：换域通知事件按 url_change_id 固化（禁止 Cron 只读全局 system_config 串信封）
CREATE TABLE IF NOT EXISTS url_change_notify_events (
  url_change_id TEXT PRIMARY KEY,
  event_json TEXT NOT NULL,
  grace_until TEXT NOT NULL,
  created_at TEXT NOT NULL
);
