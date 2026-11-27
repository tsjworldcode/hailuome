-- M16-GROUP-MOD-1：全员禁言 + 群管理标记
-- SSOT：docs/m16-group-moderation-plan.md §一
-- 不定案改 role CHECK（仍为 owner/member/seed）；管理用 is_admin 旁路列

ALTER TABLE groups ADD COLUMN members_muted INTEGER NOT NULL DEFAULT 0
  CHECK (members_muted IN (0, 1));

ALTER TABLE group_members ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0
  CHECK (is_admin IN (0, 1));

CREATE INDEX IF NOT EXISTS idx_group_members_admins
  ON group_members (group_id, is_admin)
  WHERE is_admin = 1;
