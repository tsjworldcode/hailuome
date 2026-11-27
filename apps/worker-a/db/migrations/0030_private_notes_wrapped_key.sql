-- M11-6：站主密码包裹的私有记录主密钥（Worker 只存包裹密文，不解密正文）
CREATE TABLE IF NOT EXISTS private_notes_wrapped_key (
  id                TEXT PRIMARY KEY,
  key_epoch         INTEGER NOT NULL DEFAULT 1,
  wrapped_key_json  TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
