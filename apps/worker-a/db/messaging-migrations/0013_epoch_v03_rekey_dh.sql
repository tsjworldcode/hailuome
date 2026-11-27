-- EPOCH v0.3：rekey_scheduled 标记；可选 member_dh_pubkey（X25519，禁用签名钥做 DH）
ALTER TABLE groups ADD COLUMN rekey_scheduled INTEGER NOT NULL DEFAULT 0;

ALTER TABLE group_members ADD COLUMN member_dh_pubkey TEXT;
