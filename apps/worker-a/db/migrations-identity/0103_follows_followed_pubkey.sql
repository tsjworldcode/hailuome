 -- 0103_follows_followed_pubkey.sql · IDENTITY_DB
 -- SEC-AUDIT-2026-10-7 · P1-1 第二刀：存储级 pin（follows.followed_pubkey）
 -- 为关注表新增对方节点 Ed25519 权威公钥（64 hex），用于好友/关注链路防换钥顶替与 TOFU pin。
 -- 历史存量数据为 NULL（冷启动），新关注与新好友接受时写入 pin。
 
 ALTER TABLE follows ADD COLUMN followed_pubkey TEXT;
