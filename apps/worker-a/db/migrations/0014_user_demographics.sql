-- 0014: 用户公开资料补充出生年月与性别。
-- birth_date 使用 YYYY-MM-DD；gender 允许 male/female/other/private 或空字符串。
ALTER TABLE users ADD COLUMN birth_date TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN gender TEXT NOT NULL DEFAULT '';
