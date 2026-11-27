-- 0098_bootstrap_intake_system_config_keys.sql · IDENTITY_DB
-- M9-PH-BI-2：海螺入口当前接待窗（B）与 manifest 缓存键文档化。
-- system_config 为 KV 行表，无需 ALTER；INSERT OR IGNORE 仅占位，不覆盖已有值。
-- 语义（见 docs/m9-ph-bootstrap-intake-plan.md §3.1）：
--   active_intake                 — JSON：registry_id / registry_url / trust_pubkey / source / updated_at
--   bootstrap_manifest_version  — 最近成功验签的单调版本（防 rollback）
--   bootstrap_manifest_cached_at — ISO 8601
--   bootstrap_manifest_json     — 可选全文（排障；生产日志勿 dump）
-- 与 registered_registries（home / C）严格分离；本 migration 不触碰后者。

INSERT OR IGNORE INTO system_config (key, value, updated_at) VALUES
  ('active_intake', '', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('bootstrap_manifest_version', '0', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('bootstrap_manifest_cached_at', '', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('bootstrap_manifest_json', '', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
