-- SEC-AUDIT-2026-10-16：下一 epoch wrap 同源指纹，防分批中断/并发混钥。
-- Worker 不持明文 group_key；仅存浏览器上报的 SHA-256(group_key) hex。
ALTER TABLE group_wrapped_keys ADD COLUMN key_fingerprint TEXT;
