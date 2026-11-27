-- 0101_add_registration_email.sql · IDENTITY_DB
-- M7-34 / M9-REG-EMAIL-1：节点本地存储登记邮箱（站主私人数据）。
-- 登记邮箱是站主自己的数据，必须落在本节点 D1；外人/lookup/Worker B 不可见。
-- 已登记节点可在设置页补填（PATCH registration-profile 同步本列）。

ALTER TABLE users ADD COLUMN registration_email TEXT;
