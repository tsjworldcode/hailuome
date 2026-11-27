-- M34-4：owner_sessions 存完整 token_hash，供「注销会话」写入 revoked_tokens
-- 与 middleware/auth 的 SHA-256(token) 对齐；禁止回显给客户端。

ALTER TABLE owner_sessions ADD COLUMN token_hash TEXT;

CREATE INDEX IF NOT EXISTS idx_owner_sessions_token_hash
  ON owner_sessions (token_hash);
