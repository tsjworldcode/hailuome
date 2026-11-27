-- M33-P8-n：登记跨系统恢复 — registry verify 成功后、本地落库前暂存凭证。
-- 单行表（scope=home）；含 node_api_token 明文，仅 Worker A 私有 D1，禁止暴露给 Worker B / 公开 API。

CREATE TABLE IF NOT EXISTS registration_sync_state (
  scope TEXT PRIMARY KEY NOT NULL,
  phase TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
