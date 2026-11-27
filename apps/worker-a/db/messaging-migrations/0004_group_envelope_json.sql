-- MM-5：群消息 envelope_json 本地副本（signed media 块供 ticket/proxy/mirror）
-- SSOT：docs/m10-p2-dm-media-plan.md §4.4

ALTER TABLE member_group_messages ADD COLUMN envelope_json TEXT;
ALTER TABLE group_messages ADD COLUMN envelope_json TEXT;
