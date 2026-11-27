 -- 0068_follows_followed_pubkey.sql · DB_IMPORT / staging 搬家镜像
 -- SEC-AUDIT-2026-10-7 · P1-1 第二刀：存储级 pin（follows.followed_pubkey）
 
 ALTER TABLE follows ADD COLUMN followed_pubkey TEXT;
