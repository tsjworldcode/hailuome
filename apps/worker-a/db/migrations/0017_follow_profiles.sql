-- 关注列表展示资料缓存。
-- 这些字段只服务站主管理页展示；拉取 Feed 仍以 follower_node_url 为唯一权威入口。
ALTER TABLE follows ADD COLUMN followed_handle TEXT;
ALTER TABLE follows ADD COLUMN followed_display_name TEXT NOT NULL DEFAULT '';
ALTER TABLE follows ADD COLUMN followed_avatar_key TEXT NOT NULL DEFAULT '';
ALTER TABLE follows ADD COLUMN followed_worker_b_url TEXT NOT NULL DEFAULT '';

