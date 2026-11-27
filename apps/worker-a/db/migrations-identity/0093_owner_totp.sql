-- M12-1-schema：站主 TOTP 表落到 IDENTITY_DB（与 ownerTotp / owner_credentials 同库）
-- 历史误放在 migrations-governance/0031；拆库后代码读 IDENTITY，缺表会导致 setup 失败。

CREATE TABLE IF NOT EXISTS owner_totp_settings (
  username TEXT PRIMARY KEY,
  secret_wrapped TEXT NOT NULL,
  issuer TEXT NOT NULL DEFAULT 'hailuo-node',
  label TEXT NOT NULL,
  period INTEGER NOT NULL DEFAULT 30,
  digits INTEGER NOT NULL DEFAULT 6,
  algorithm TEXT NOT NULL DEFAULT 'SHA1',
  enabled_at TEXT NOT NULL,
  last_used_counter INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS owner_totp_pending (
  username TEXT PRIMARY KEY,
  secret_wrapped TEXT NOT NULL,
  issuer TEXT NOT NULL DEFAULT 'hailuo-node',
  label TEXT NOT NULL,
  period INTEGER NOT NULL DEFAULT 30,
  digits INTEGER NOT NULL DEFAULT 6,
  algorithm TEXT NOT NULL DEFAULT 'SHA1',
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS owner_totp_recovery_codes (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  used_at TEXT,
  UNIQUE(username, code_hash)
);

CREATE INDEX IF NOT EXISTS idx_owner_totp_recovery_username
  ON owner_totp_recovery_codes(username, used_at);
