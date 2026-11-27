-- M-RegBootstrapResilience / REG-BR-2a：registration_sync_state 第三 phase
-- registry_challenge_pending：precheck 已成功、verify 未完成时的续跑 phase；
-- 双仓配对字段严格同源（registry 仓权威值，本仓镜像）——
-- phase 字面量 'registry_challenge_pending' 已在 hailuo-registry/docs/m-reg-bootstrap-resilience-plan.md §五 登记。
-- 不在远程 D1 上加 CHECK（0052 已创建表，本步不改现有行）。

-- 文档注释：registration_sync_state.phase 期望值
--   - registry_challenge_pending：precheck 已成功、verify 未完成；可续跑（DDoS 期免重打 precheck）
--   - registry_accepted：中心已受理，待轮询 status 领取凭证（REG-ASYNC）
--   - registry_verified：已领取凭证，本地尚未落库（M33-P8-n）

-- 允许的 phase（应用层写入时保证，不在 D1 上加 CHECK）：
--   registry_challenge_pending / registry_accepted / registry_verified
--
-- 远程 D1 会把表级 CHECK 编译成 sqlite_fail，然后拒绝执行
-- （not authorized to use function: sqlite_fail，code 7500）。
-- 因此这里不建约束，只做一次无写入的确认查询，让迁移能在远程标记完成。
SELECT 'registry_challenge_pending' AS allowed_phase
UNION ALL SELECT 'registry_accepted'
UNION ALL SELECT 'registry_verified';
