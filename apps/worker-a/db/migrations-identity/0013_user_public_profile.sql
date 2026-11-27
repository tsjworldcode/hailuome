-- 0013: 用户公开资料补充字段。
-- contact_email 是站主主动填写的公开联系邮箱，不自动公开注册邮箱。
ALTER TABLE users ADD COLUMN contact_email TEXT NOT NULL DEFAULT '';
