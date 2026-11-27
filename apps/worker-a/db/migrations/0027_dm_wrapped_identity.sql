-- M10-5c：站主密码包裹的 X25519 身份私钥（Worker 只见密文 JSON，不解密）。
CREATE TABLE IF NOT EXISTS dm_wrapped_identity (
  owner_handle          TEXT PRIMARY KEY,
  public_key_hex        TEXT NOT NULL,
  wrapped_identity_json TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);
