-- M16-INVITE-SHORT：群邀请 8 位短码（分享别名；主键仍为 invite_token）
ALTER TABLE group_invites ADD COLUMN invite_code TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_group_invites_code
  ON group_invites (invite_code) WHERE invite_code IS NOT NULL;
