-- 0030_user_country.sql
-- 注册中心登记时同步写入国家代码，供备用注册中心 append 复用。
ALTER TABLE users ADD COLUMN country TEXT NOT NULL DEFAULT 'US';
