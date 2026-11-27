-- M34-1：站主浏览器会话 + 登录审计（D1 only；禁止明文 IP）

CREATE TABLE IF NOT EXISTS owner_login_events (
  id TEXT PRIMARY KEY NOT NULL,
  logged_in_at TEXT NOT NULL,
  success INTEGER NOT NULL,
  login_method TEXT NOT NULL,
  ip_hash TEXT,
  ip_country TEXT,
  user_agent_family TEXT,
  session_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_owner_login_events_at
  ON owner_login_events (logged_in_at DESC);

CREATE TABLE IF NOT EXISTS owner_sessions (
  session_id TEXT PRIMARY KEY NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  ended_at TEXT,
  jwt_fingerprint TEXT NOT NULL,
  ip_hash TEXT,
  ip_country TEXT,
  user_agent_family TEXT,
  channel TEXT NOT NULL DEFAULT 'web'
);

CREATE INDEX IF NOT EXISTS idx_owner_sessions_open_seen
  ON owner_sessions (last_seen_at DESC)
  WHERE ended_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_owner_sessions_jwt_fp
  ON owner_sessions (jwt_fingerprint);
