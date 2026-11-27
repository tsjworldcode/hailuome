-- M17 · local_notifications 扩展三枚举（friend_request_received / _accepted / _rejected）
-- 详见 docs/m17-add-friend-plan.md §4.2 — 不新建 friend_notifications 表，避免站主看到两套通知流；
-- 迁移方式：rename → recreate + 扩展 CHECK → 回填数据 → drop 旧表 → 重建新索引。
-- 加好友类型不绑定帖子，post_id / reply_id 允许 NULL；
-- 新增 related_node_url（= actor_node_url 语义冗余，避免前端把 actor 当 handle 来源解错）
-- + request_id 关联 friend_requests.id，便于通知一键跳转。

-- 1) 重命名旧表保数据
ALTER TABLE local_notifications RENAME TO local_notifications_old;

-- 2) 用扩展后的 type CHECK 建新表
CREATE TABLE local_notifications (
  id               TEXT PRIMARY KEY,
  type             TEXT NOT NULL CHECK (type IN (
                     'like',
                     'reply',
                     'friend_request_received',
                     'friend_request_accepted',
                     'friend_request_rejected'
                   )),
  -- 旧 like / reply 仍 NOT NULL；加好友类型下允许 NULL
  post_id          TEXT,
  actor_handle     TEXT NOT NULL,
  actor_node_url   TEXT NOT NULL,
  reply_id         TEXT,
  content_preview  TEXT,
  -- 加好友专用字段（向下兼容 nullable）
  related_node_url TEXT,                                   -- 关联对方节点；与 actor_node_url 同义
  request_id       TEXT,                                   -- 关联 friend_requests.id
  created_at       TEXT NOT NULL,
  read_at          TEXT
);

-- 3) 老数据全量回填（like / reply 行 post_id NOT NULL → 带过来；其它字段照原样）
INSERT INTO local_notifications
  (id, type, post_id, actor_handle, actor_node_url, reply_id, content_preview, created_at, read_at)
SELECT id, type, post_id, actor_handle, actor_node_url, reply_id, content_preview, created_at, read_at
  FROM local_notifications_old;

-- 4) drop 旧表
DROP TABLE local_notifications_old;

-- 5) 重建索引（旧索引已随旧表 drop；新增 request_id 维度以支持加好友跳转）
CREATE INDEX IF NOT EXISTS idx_local_notifications_created
  ON local_notifications (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_local_notifications_unread
  ON local_notifications (read_at, created_at DESC);

-- 加好友通知按 (对方节点, type, created_at) 维度查询 / 去重
CREATE INDEX IF NOT EXISTS idx_local_notifications_related
  ON local_notifications (related_node_url, type, created_at DESC);
