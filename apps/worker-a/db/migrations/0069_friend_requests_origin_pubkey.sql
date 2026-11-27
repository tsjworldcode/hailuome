-- 0069_friend_requests_origin_pubkey.sql · DB_IMPORT staging 镜像
-- 与 CONTENT_DB 0064 同语义：friend_requests.origin_pubkey（inbox 已验签公钥）。

ALTER TABLE friend_requests ADD COLUMN origin_pubkey TEXT;
