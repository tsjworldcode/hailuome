-- REL-FIX-3 · local_notifications 扩 type=group_join_request_received
-- 入群 pending → 群主站内通知（P0）。沿用 rename → recreate → 回填 → drop → 重建索引手法（同 0061/0063）。
-- 零加列：复用 related_node_url=申请人 Worker B URL、request_id=group_id（群申请无 friend_requests.id，
-- 跨类型复用列便于前端一键跳转群设置页；like/reply 行 request_id 仍 NULL）。

ALTER TABLE local_notifications RENAME TO local_notifications_old;

CREATE TABLE local_notifications (
  id               TEXT PRIMARY KEY,
  type             TEXT NOT NULL CHECK (type IN (
                     'like',
                     'reply',
                     'friend_request_received',
                     'friend_request_accepted',
                     'friend_request_rejected',
                     'friend_request_cancelled',
                     'group_join_request_received'
                   )),
  post_id          TEXT,
  actor_handle     TEXT NOT NULL,
  actor_node_url   TEXT NOT NULL,
  reply_id         TEXT,
  content_preview  TEXT,
  related_node_url TEXT,
  request_id       TEXT,
  created_at       TEXT NOT NULL,
  read_at          TEXT
);

INSERT INTO local_notifications
  (id, type, post_id, actor_handle, actor_node_url, reply_id, content_preview,
   related_node_url, request_id, created_at, read_at)
SELECT id, type, post_id, actor_handle, actor_node_url, reply_id, content_preview,
       related_node_url, request_id, created_at, read_at
  FROM local_notifications_old;

DROP TABLE local_notifications_old;

CREATE INDEX IF NOT EXISTS idx_local_notifications_created
  ON local_notifications (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_local_notifications_unread
  ON local_notifications (read_at, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_local_notifications_related
  ON local_notifications (related_node_url, type, created_at DESC);
