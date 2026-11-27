-- MM-1：media_object_registry 扩展 — 公开帖 scope=public_post；私信/群图 scope=messaging
-- SSOT：docs/m10-p2-dm-media-plan.md §6.1

ALTER TABLE media_object_registry ADD COLUMN scope TEXT NOT NULL DEFAULT 'public_post';
ALTER TABLE media_object_registry ADD COLUMN owner_kind TEXT;
ALTER TABLE media_object_registry ADD COLUMN group_id TEXT;
ALTER TABLE media_object_registry ADD COLUMN owner_id TEXT;
ALTER TABLE media_object_registry ADD COLUMN message_id TEXT;
ALTER TABLE media_object_registry ADD COLUMN media_id TEXT;
ALTER TABLE media_object_registry ADD COLUMN storage_state TEXT NOT NULL DEFAULT 'active';
ALTER TABLE media_object_registry ADD COLUMN mirror_of_key TEXT;
ALTER TABLE media_object_registry ADD COLUMN sender_worker_b_url TEXT;
ALTER TABLE media_object_registry ADD COLUMN retain_until TEXT;

CREATE INDEX IF NOT EXISTS idx_media_object_registry_scope_state
  ON media_object_registry (scope, storage_state);
CREATE INDEX IF NOT EXISTS idx_media_object_registry_message_media
  ON media_object_registry (message_id, media_id);
