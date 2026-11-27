-- 0036_register_phone.sql
-- 注册中心登记时同步写入手机号（E.164），供备用注册中心 append 复用。
ALTER TABLE users ADD COLUMN phone TEXT NOT NULL DEFAULT '';
