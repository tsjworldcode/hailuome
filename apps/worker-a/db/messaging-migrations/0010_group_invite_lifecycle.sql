-- M16-INVITE-LIFE-1：可复用邀请 + 审批快照列 + 群默认审批开关
-- SSOT：docs/m16-invite-lifecycle-plan.md §三

-- 邀请行：创建时快照「是否需群主同意」（0=自动入群，1=需同意）
ALTER TABLE group_invites ADD COLUMN requires_approval INTEGER NOT NULL DEFAULT 0;

-- 群主主动作废时间；非空则 accept 一律拒绝
ALTER TABLE group_invites ADD COLUMN revoked_at TEXT;

-- 群默认：下次创建邀请预填（单次邀请仍以 group_invites.requires_approval 为准）
ALTER TABLE groups ADD COLUMN join_requires_approval INTEGER NOT NULL DEFAULT 0;
