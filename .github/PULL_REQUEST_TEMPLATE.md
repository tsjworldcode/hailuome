## 变更说明

<!-- 说明这次改了什么、为什么改、影响范围 -->

## 关联 Issue

<!-- Closes #123 -->

## 检查清单

- [ ] 我已阅读并同意 [贡献者许可协议（CLA）](./CLA.md)，并有权授予其中所列的著作权与专利许可
- [ ] 我的贡献是原创的，或已注明第三方来源与许可证
- [ ] 我的贡献不包含真实密钥、Token、个人身份信息或他人隐私
- [ ] 我的贡献不包含真实节点 handle、真实 `workers.dev` 子域或生产 D1/KV ID
- [ ] 我已运行相关门禁（按改动范围选择）：
  - [ ] `npm run test:deploy-github-actions`
  - [ ] `npm run test:deploy-config-consistency`
  - [ ] `npm run test:ed25519-key-consistency`
  - [ ] `npm run audit:deploy-shell-hazards`
  - [ ] `npm run typecheck`
- [ ] 涉及 Worker A/B API 时，已同步 `docs/worker-a-api.md` / `docs/worker-b-api.md`
- [ ] 涉及部署、binding、migration 时，已同步对应部署文档

## 补充说明

<!-- 截图、验证方式、回滚方案等 -->
