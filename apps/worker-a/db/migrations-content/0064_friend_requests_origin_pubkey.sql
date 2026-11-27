-- 0064_friend_requests_origin_pubkey.sql · CONTENT_DB
-- SEC-AUDIT-2026-10-14 · 专家复核 #4：固化 inbox 已验签的发起方公钥
-- accept 写 follows.followed_pubkey 时优先读本列，禁止在站主点击路径同步外网取档。
-- 历史 pending 行为 NULL；新 inbox / 本机发起写入 64-hex；缺省由 accept waitUntil 或 Repair 异步补齐。

ALTER TABLE friend_requests ADD COLUMN origin_pubkey TEXT;
