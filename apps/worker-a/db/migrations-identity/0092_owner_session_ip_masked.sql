-- M34-4b：站主会话列表展示用脱敏 IP（如 203.0.113.*）
-- 仅存脱敏形态；禁止完整明文 IP；ip_hash 仍用于频控比对。

ALTER TABLE owner_sessions ADD COLUMN ip_masked TEXT;
