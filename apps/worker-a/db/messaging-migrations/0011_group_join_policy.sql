-- M16-JOIN-POLICY-1：群加群策略枚举（closed / approval / open）
-- SSOT：docs/m16-group-join-policy-plan.md §四
-- 不做 public_no；新群短 group_id 由应用层生成

ALTER TABLE groups ADD COLUMN join_policy TEXT NOT NULL DEFAULT 'approval'
  CHECK (join_policy IN ('closed', 'approval', 'open'));

-- 回填：旧布尔 → 枚举（列来自 0010）
UPDATE groups SET join_policy = CASE
  WHEN join_requires_approval = 1 THEN 'approval'
  ELSE 'open'
END;
