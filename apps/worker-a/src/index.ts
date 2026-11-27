import { Hono } from 'hono';
import type { Env, AppVariables } from './env.d';
import { workerACors } from './middleware/cors';
import { requireOwnerJWT } from './middleware/auth';
// ALL-AUDIT-Y-16（🟡 16-2）：OpenTelemetry 轻量 API-only 包装（0 SDK 依赖）
// 详见 `docs/observability-plan.md` + `packages/otel/`
import { withSpan, SpanName, writeCounter } from '@hailuo/otel';
import { registerApp, wellKnownApp } from './routes/register';
import { lookupApp } from './routes/lookup';
import { authApp } from './routes/auth';
import { postsApp } from './routes/posts';
import { imagesApp } from './routes/images';
import { localReadsApp } from './routes/local-reads';
import { internalOperationLogsApp } from './routes/internal-operation-logs';
import { internalCacheSnapshotApp } from './routes/internal-cache-snapshot';
import { internalLookupAssistApp } from './routes/internal-lookup-assist';
import { internalFriendsProjectionApp } from './routes/internal-friends-projection';
import { followsApp } from './routes/follows';
import { followerTokensApp } from './routes/follower-tokens';
import { nodeEventsApp } from './routes/node-events';
import { blacklistApp } from './routes/blacklist';
import { nodeSettingsApp } from './routes/node-settings';
import { readMutualProofApp } from './routes/read-mutual-proof';
import { interactionsApp } from './routes/interactions';
import { interactionSignApiApp } from './routes/interaction-sign-api';
import { dmApp, dmInternalApp, dmMeApp } from './routes/dm';
import { groupsApp, groupsInternalApp } from './routes/groups';
import { friendRequestsApp } from './routes/friend-requests';
import { friendRequestsInternalApp } from './routes/friend-requests-internal';
import { privateNotesApp } from './routes/private-notes';
import { ownerVaultApp } from './routes/owner-vault';
import { messagingMediaApp } from './routes/messaging-media';
import { messagingCapacityApp } from './routes/messaging-capacity';
import { messagingEventsApp } from './routes/messaging-events';
import { nodeMigrateApp } from './routes/node-migrate';
import { nodeHostedL0App } from './routes/node-hosted-l0';
import { refreshPostsCacheIfDirty, refreshFeedLatestIfDirty } from './handlers/cron';
import {
  buildCronBudgetTasks,
  runCronBudgeted,
  runRotatedHourlyGc,
} from './handlers/cronBudget';
import { maybeScheduleRegistryDailySync } from './handlers/registryDailySyncCron';

const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

// F-15/F-17：Worker A CORS 中间件（所有路由生效）
app.use('*', workerACors());

// 健康探活（公开）—— ALL-AUDIT-Y-16 示范：withSpan 包装 + writeCounter 1 条 metric
// 业务逻辑 0 变化：env 开关关闭时 helper 内部旁路（0 性能开销、0 quota 风险）
app.get('/health', (c) =>
  withSpan(c, SpanName.HealthCheck, async (span) => {
    span.setAttribute('http.method', c.req.method);
    span.setAttribute('http.path', new URL(c.req.url).pathname);
    // 写 1 条 metric：health check counter（OTEL_ENABLED === 'true' 时才实际写）
    writeCounter(c.env, 'health.check', { path: '/health' });
    return c.json({ ok: true, service: 'worker-a', version: '0.1.0' });
  }),
);

// 注册相关接口（M1-0a）：email 验证码 + 登记；站主 JWT 鉴权（写层地址虽绑定 Pages，仍防滥用）
// NCF-INGRESS-1：禁止对本前缀挂 JWT star（会吞掉 setup-proof / save-node-creds）；仅精确路径。
app.use('/api/local/email-verify-request', requireOwnerJWT());
app.use('/api/local/email-verify-confirm', requireOwnerJWT());
// Hono 路径：`posts*` 不匹配精确 `/posts`；须用精确路径或 `/*` 子路径语法
// NCF-INGRESS-1：register 已升格 owner-gateway（JWT + allowlist）
app.use('/api/local/register', requireOwnerJWT());
app.use('/api/local/register/bootstrap-targets', requireOwnerJWT());
app.use('/api/local/register/intake', requireOwnerJWT());
app.use('/api/local/register/complete', requireOwnerJWT());
app.use('/api/local/register/append-complete', requireOwnerJWT());
app.use('/api/local/register/bootstrap-outbound-template', requireOwnerJWT());
app.route('/api/local', registerApp);

// 站主直读接口（M3-1a）：GET /api/local/posts（JWT 鉴权 + 直读 D1，发完即见）
app.use('/api/local/posts', requireOwnerJWT());
app.use('/api/local/feed', requireOwnerJWT());
app.use('/api/local/notifications', requireOwnerJWT());
app.use('/api/local/notifications/mark-read', requireOwnerJWT());
app.use('/api/local/registry-official-feed-status', requireOwnerJWT());
app.use('/api/local/registry-official-feed/pull', requireOwnerJWT());
// R-AUDIT-1：M-DS 诊断/手动同步/公开探活必须 JWT（与 Owner Gateway allowlist 同步）
app.use('/api/local/registry-daily-sync-status', requireOwnerJWT());
app.use('/api/local/registry-daily-sync/run', requireOwnerJWT());
app.use('/api/local/public-health-probe', requireOwnerJWT());
app.use('/api/local/registry/registration-profile', requireOwnerJWT());
app.use('/api/local/registry/email-certify', requireOwnerJWT());
// M7-36-h1：双通道认证代理须 JWT + Owner Gateway allowlist 同步
app.use('/api/local/registry/cert-purge-status', requireOwnerJWT());
app.use('/api/local/registry/certification-context', requireOwnerJWT());
app.use('/api/local/registry/cert-inbound-address', requireOwnerJWT());
app.use('/api/local/registry/esp-verify-request', requireOwnerJWT());
app.use('/api/local/registry/url-change/precheck', requireOwnerJWT());
app.use('/api/local/registry/url-change/confirm', requireOwnerJWT());
app.use('/api/local/registry/url-change/status', requireOwnerJWT());
app.use('/api/local/registry/rotate-token', requireOwnerJWT());
// R-MSG-2e：urgent 策略旁路
app.use('/api/local/registry-urgent-policies/status', requireOwnerJWT());
app.use('/api/local/registry-urgent-policies/run', requireOwnerJWT());
app.use('/api/local/registry-recommended-users', requireOwnerJWT());
app.use('/api/local/follows/pull-probe', requireOwnerJWT());
app.use('/api/local/online-status', requireOwnerJWT());
app.use('/api/local/feed-aggregate/run', requireOwnerJWT());
app.use('/api/local/owner-sessions', requireOwnerJWT());
app.use('/api/local/owner-sessions/*', requireOwnerJWT());
app.use('/api/local/operation-logs', requireOwnerJWT());
app.use('/api/local/operation-logs/cleanup', requireOwnerJWT());
app.use('/api/local/mutual-follows', requireOwnerJWT());
app.route('/api/local', localReadsApp);

// M10-2：站主私信密文读写与包裹密钥接口，走 JWT + Pages Owner Gateway。
app.use('/api/dm/*', requireOwnerJWT());
app.route('/api/dm', dmApp);
app.use('/api/me/dm-pubkey', requireOwnerJWT());
app.route('/api/me', dmMeApp);

// M11：站主私有记录，只走 Worker A JWT，不进入 Worker B 公共读层。
app.use('/api/private-notes', requireOwnerJWT());
app.use('/api/private-notes/*', requireOwnerJWT());
app.route('/api/private-notes', privateNotesApp);

// M-VAULT-2：保险箱外层包裹（IDENTITY_DB，Worker 不解密）
app.use('/api/owner/*', requireOwnerJWT());
app.route('/api/owner', ownerVaultApp);

// Worker B 内部诊断写入：仅接受 Service Binding + INTERNAL_FORWARD_SECRET 签名请求。
app.route('/api/internal', internalOperationLogsApp);
// M9-12：只读 KV 快照（Service Binding + HMAC，默认由 B 侧 READ_SNAPSHOT_ON_MISS 控制）
app.route('/internal', internalCacheSnapshotApp);
// M-OPT-8b：lookup 协助应答（Service Binding + HMAC；公开入口在 Worker B）
app.route('/internal', internalLookupAssistApp);
// M17-4-2a：互粉投影（Service Binding + HMAC；公开入口 Worker B GET /users/:handle/friends）
app.route('/internal', internalFriendsProjectionApp);

// 注册中心回访验证端点（M1-0a）
app.route('/.well-known', wellKnownApp);

// 认证接口（M2-1）：POST /auth/login（公开）+ GET /auth/me（JWT 鉴权）
app.route('/auth', authApp);

// lookup 缓存接口（M1-3）：GET /api/lookup/:handle（M2-1 补 JWT 鉴权）
app.use('/api/lookup/*', requireOwnerJWT());
app.route('/api/lookup', lookupApp);

// 关注/取关接口（M4-0）：GET/POST/DELETE /api/follows（JWT 鉴权 + D1 写，禁 KV.put）
app.use('/api/follows/*', requireOwnerJWT());
app.route('/api/follows', followsApp);

// 黑名单接口（M6-1）：GET/POST/DELETE /api/blacklist（JWT 鉴权 + D1 写，禁 KV.put）
// 与 follows 同模式：D1 写 blacklist 表，M6-3 Cron 每 5 分钟同步 dirty 部分到 STATE_KV。
app.use('/api/blacklist/*', requireOwnerJWT());
app.route('/api/blacklist', blacklistApp);

// 站主节点设置（D1 + STATE_KV 同步，供 Worker B 运行时读取）
app.use('/api/node-settings/*', requireOwnerJWT());
app.route('/api/node-settings', nodeSettingsApp);

// M14-3：互粉读帖证明（JWT + Owner Gateway）
app.use('/api/read/*', requireOwnerJWT());
app.route('/api/read', readMutualProofApp);

// 粉丝 Token 签发接口（M6-0 + M6-0a）：POST /api/follower-tokens
// **内部专属端点**（M6-0a 架构修正）：仅 Worker B 通过 Cloudflare Service Binding
// (`env.WORKER_A.fetch(...)`) 转发并携带 `X-Internal-Forward: hmac-v2`
// + `X-Timestamp` / `X-Nonce` / `X-Signature` 才会被接受；缺失/不符即返 401
// `INTERNAL_FORWARD_REJECTED`，不对公网暴露。
// 公开入口在 Worker B `POST /api/follower-tokens`，遵守 §F-02 "Worker A 地址永不对外暴露"。
app.route('/api/follower-tokens', followerTokensApp);

// M7-30f-4：节点事件入站（内部专属）；公开入口在 Worker B POST /api/node/events
app.route('/api/node/events', nodeEventsApp);

// 帖子接口（M2-2/M2-3）：POST /api/posts + DELETE /api/posts/:id（JWT 鉴权 + D1 写 + dirty 置 true）
app.use('/api/posts/*', requireOwnerJWT());
// M9-18：公开互动权威写入端，仅接受 Worker B Service Binding + HMAC 转发。
app.route('/interactions', interactionsApp);
// M10-2：Worker B `POST /dm/inbox` 经 Service Binding + HMAC 转发到本内部入口。
app.route('/dm', dmInternalApp);
// M16-1c：Worker B `POST /groups/invite-accept` 转发到本内部入口。
// M16-2：Worker B `POST /groups/inbound|relay` 转发到本内部入口。
// M16-3：Worker B `POST /groups/sync-with-parent` 转发到本内部入口。
app.route('/groups', groupsInternalApp);
// M17-1e：Worker B `POST /friend-requests/inbox|outbox` 转发到本内部入口（HMAC v2 + Service Binding）
app.route('/friend-requests', friendRequestsInternalApp);

// M16-1c：站主群聊管理（建群 / 邀请 / 本地列表 / accept）
app.use('/api/groups/*', requireOwnerJWT());
app.use('/api/groups', requireOwnerJWT());
app.route('/api/groups', groupsApp);

// M17-1e：站主加好友（GET 列表 / POST 发起 / :id/accept / :id/reject / DELETE 撤回）
// JWT 鉴权 + Owner Gateway allowlist（M17-1f 待办）
// 与 groups 同模式：精确路径 + /* 子路径都挂 JWT（Hono `/*` 不匹配精确 `/api/friend-requests`）
app.use('/api/friend-requests', requireOwnerJWT());
app.use('/api/friend-requests/*', requireOwnerJWT());
app.route('/api/friend-requests', friendRequestsApp);

// M9-19：站主 JWT 签发互动 envelope（浏览器写层）
app.use('/api/interactions/*', requireOwnerJWT());
app.route('/api/interactions', interactionSignApiApp);

app.route('/api/posts', postsApp);

// 图片上传接口（M2-5）：POST /api/images（JWT 鉴权 + 仅 IMAGE_KV.put）
app.use('/api/images/*', requireOwnerJWT());
app.route('/api/images', imagesApp);

// MM-2：Messaging Media 上传 / 云能力 / 本节点 blob 读取
app.use('/api/messaging/media/*', requireOwnerJWT());
app.use('/api/messaging/media', requireOwnerJWT());
app.route('/api/messaging/media', messagingMediaApp);

// MM-2 cloud-capability + M16-7d db-capacity（挂 /api/messaging，勿挂到 /media）
app.use('/api/messaging/cloud-capability', requireOwnerJWT());
app.use('/api/messaging/db-capacity', requireOwnerJWT());
// M-RT-1：消息 SSE（只推 id/cursor）
app.use('/api/messaging/events', requireOwnerJWT());
app.route('/api/messaging', messagingEventsApp);
app.route('/api/messaging', messagingCapacityApp);

// M9-7：节点搬家 export / import（站主 JWT）
app.use('/api/node/export', requireOwnerJWT());
app.use('/api/node/import', requireOwnerJWT());
app.use('/api/node/import/promote-staging', requireOwnerJWT());
app.use('/api/node/import-status', requireOwnerJWT());
app.route('/api/node', nodeMigrateApp);

// M9-8：托管 L0 隐私 / 账号删除（站主 JWT）
app.use('/api/node/hosted-l0/*', requireOwnerJWT());
app.use('/api/node/account/delete', requireOwnerJWT());
app.route('/api/node', nodeHostedL0App);

// SPILL-1b-6-a：M9-9 机器节点 invite 管理已退役（plan §6.5.4 第四步）
// 历史挂载点（GET/POST /api/node/machine-invites）已下线，registry 仓已返 410
// 并 DROP machine_registration_invites 表 + users/challenges 机器列；本端 `route` / `use` 同步移除。

export default {
  fetch: app.fetch,

  // Cron 触发器（wrangler.toml 仅 * * * * *；重任务进块用 minute 门控，省 1 条账号槽位）
  // M13-2：整点 GC 串行 + runCronBudgeted 错峰（方案 B）
  // M13-10：Feed 偶数分钟拉取；其它任务仍主要挂在 %5 分钟；统一走 budget 共享外部 50 池
  // M-DS-V2-1b：daily-sync 改每分钟 UTC gate + 秒级 delay（在重任务早退之前）
  // ALL-AUDIT-Y-16-5：scheduled 入口 root span（OTEL_ENABLED 默认关 → 旁路）
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    // Cron 无 Hono Context：用鸭子类型 { env, executionCtx } 喂 withSpan
    return withSpan({ env, executionCtx: ctx }, SpanName.CronRun, async (span) => {
      const scheduledDate = new Date(event.scheduledTime);
      const minute = scheduledDate.getUTCMinutes();
      const hour = scheduledDate.getUTCHours();
      const cronCtx = { minute, hour };
      // 可检索、无 PII：只记 UTC 时钟位
      span.setAttribute('cron.minute', minute);
      span.setAttribute('cron.hour', hour);

      // ── 每分钟（早退前）──
      // R-MSG-2c：日常只跑 presence；停周期 policy-digest / 推荐门闩（force/urgent 另路径）
      ctx.waitUntil(refreshPostsCacheIfDirty(env));
      // M-F2：取关清缓存后置 feed_latest_dirty，由本 cron 刷 feed:latest KV
      //      （F-01：HTTP 路径零 KV.put；dirty=false 时仅 1 次 SELECT，0 KV 写）
      ctx.waitUntil(refreshFeedLatestIfDirty(env));
      await maybeScheduleRegistryDailySync(env, cronCtx, ctx);

      // M13-19/19b：D1 GC 0～5（纯 D1，不占外部池）+ calibrate@7（可能外部 HTTP，避开 Feed heavy）
      ctx.waitUntil(runRotatedHourlyGc(env, minute, hour));
      // 可检索、无 PII：只记有切片的 UTC 分钟（含错峰后的 7）
      if (minute <= 5 || minute === 7) {
        span.setAttribute('cron.hourly_gc_slice_minute', minute);
      }

      // ── 重任务块：偶数分钟（Feed）或 %5 分钟（群/黑名单/探针等）──
      // 禁止把 Feed 与 runCronBudgeted 拆成并行 waitUntil（会叠加撞 50 子请求）
      const heavyBlock = minute % 2 === 0 || minute % 5 === 0;
      span.setAttribute('cron.heavy_block', heavyBlock);
      if (!heavyBlock) {
        writeCounter(env, 'cron.run', { heavy_block: '0' });
        return;
      }

      ctx.waitUntil(runCronBudgeted(env, cronCtx, buildCronBudgetTasks()));
      writeCounter(env, 'cron.run', { heavy_block: '1' });
    });
  },
};
