-- M-VAULT-2：站主保险箱主密钥外层包裹（Worker 只存密文 JSON，不解密）
CREATE TABLE IF NOT EXISTS owner_wrapped_vault (
  owner_handle       TEXT PRIMARY KEY,
  wrapped_vault_json TEXT NOT NULL,
  key_version        INTEGER NOT NULL DEFAULT 1,
  updated_at         TEXT NOT NULL
);
