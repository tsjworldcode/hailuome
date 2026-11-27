-- M11：站主私有记录（给自己发消息）
-- 仅 Worker A JWT 私有接口读写；不进入 Worker B 公开读层。
CREATE TABLE IF NOT EXISTS private_notes (
  id          TEXT PRIMARY KEY,
  content     TEXT NOT NULL DEFAULT '',
  kind        TEXT NOT NULL DEFAULT 'note',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  deleted_at  TEXT
);

CREATE INDEX IF NOT EXISTS idx_private_notes_created
  ON private_notes (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_private_notes_deleted_created
  ON private_notes (deleted_at, created_at DESC);

CREATE TABLE IF NOT EXISTS private_note_attachments (
  id          TEXT PRIMARY KEY,
  note_id     TEXT,
  storage     TEXT NOT NULL,
  object_key  TEXT NOT NULL,
  mime        TEXT NOT NULL,
  size_bytes  INTEGER,
  name        TEXT,
  created_at  TEXT NOT NULL,
  deleted_at  TEXT,
  FOREIGN KEY (note_id) REFERENCES private_notes(id)
);

CREATE INDEX IF NOT EXISTS idx_private_note_attachments_note
  ON private_note_attachments (note_id, created_at);
