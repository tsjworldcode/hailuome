-- 0097_clear_bootstrap_inbound_pending_sync_state.sql
-- REG-BO-0c 配对 · 清理登记阶段路径 B syncState 遗留行
--
-- 删除 phase = 'registry_bootstrap_inbound_pending' 的 registration_sync_state 行。
-- 保留 registry_challenge_pending / registry_accepted / registry_verified（路径 A / REG-BR）。
--
-- 0096 文档注释 migration 文件保留（已 apply 不可改写）；运行时不再识别 inbound phase。

DELETE FROM registration_sync_state
WHERE phase = 'registry_bootstrap_inbound_pending';
