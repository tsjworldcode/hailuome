/**
 * M-OPT-SPLIT-3 · A-3：binding 解析器 + lib→库 分配速查表。
 *
 * 为什么需要本文件：
 *   A-1 在 wrangler.toml 加了三 binding（IDENTITY/GOVERNANCE/CONTENT），但
 *   既有的 ~100 个 lib / services / routes 文件还在用 `env.DB.prepare(...)`
 *   全栈串一个 binding。plan §3.4 设想由 `repos/` 一层收敛，但这层不存在。
 *
 *   A-3 不做"100 文件全改签名"（爆炸半径），本文件先建**单点解析器**——
 *   - resolveIdentityDb(env) / resolveGovernanceDb(env) / resolveContentDb(env)
 *     三 binding 直接返回，env.DB 已退役（A-7 Phase3）。
 *   - `BINDING_TABLE` 给出"哪个 lib 文件改完后用哪个 binding"指路标。
 *
 * 使用：
 *   ```typescript
 *   import { resolveIdentityDb } from './db/bindings';
 *
 *   // 在 routes/auth.ts / services 入口：
 *   const db = resolveIdentityDb(c.env);
 *   const row = await db.prepare('SELECT ... FROM users WHERE id = ?').bind(id).first();
 *   ```
 *
 * 不做什么：
 *   - 不做长事务 / 跨库 JOIN（数据库层面不可行；应用层做两库两次查询）。
 *   - 不做"自动选择 binding"（应让路由 / 服务层显式选择，本文件不替调用
 *     方判断）。
 *   - 不改既有函数签名（签名改造是 A-4 的工作，A-3 试点仅在
 *     `lib/loginAttempts.ts` 一文件示范）。
 *
 * 已知陷阱（09 沉淀）：
 *   - 路由层传 `c.env.IDENTITY_DB` 时 TypeScript 类型来自 env.d.ts；三
 *     binding 都声明为可选 `IDENTITY_DB?: D1Database`，resolver 内部强
 *     制窄化为 `D1Database`，落空会抛清晰错（不是 undefined.prepare
 *     报雪崩堆栈）。
 */

import type { Env } from '../env';

/** SPILL-2-5：dev fallback 开关（仅本地 .dev.vars 设，生产不设）。
 *  设 'true' 时，若对应 split binding 缺失但 env.DB（旧 binding）存在，
 *  resolver 回落 env.DB 并 console.warn。本开关避免本地老 wrangler.toml
 * 仍在 A7-DB-RETIRE 之前导致路由雪崩堆栈。 */
const DEV_DB_FALLBACK_VAR = 'HAILUO_DEV_DB_FALLBACK';

function isDevFallbackEnabled(env: Env): boolean {
  const flag = env.HAILUO_DEV_DB_FALLBACK;
  return flag === 'true' || flag === '1';
}

/** SPILL-2-5：dev fallback 解析 — 仅 HAILUO_DEV_DB_FALLBACK=true 且 env.DB 存在时生效。 */
function resolveWithDevFallback(
  env: Env,
  primaryKey: 'IDENTITY_DB' | 'GOVERNANCE_DB' | 'CONTENT_DB',
): D1Database {
  const primary = env[primaryKey];
  if (primary) return primary;
  // 仅 dev 显式开启 fallback 时回落旧 env.DB；A7-DB-RETIRE 后生产绝不允许
  if (isDevFallbackEnabled(env) && env.DB) {
    console.warn(
      `[bindings] ${primaryKey} 缺失 → dev fallback 回落 env.DB（仅 ${DEV_DB_FALLBACK_VAR}=true 时启用；生产环境切勿设置此变量）`,
    );
    return env.DB;
  }
  throw new Error(
    `[bindings] 缺少 ${primaryKey}；请检查 wrangler.toml d1_databases。生产环境必须显式绑定三 split 库（IDENTITY_DB / GOVERNANCE_DB / CONTENT_DB）。`,
  );
}

/**
 * 三 binding 解析器（互不同形 / 不同语义）。
 * M-OPT-SPLIT-A7 Phase3（真退役）：必须显式绑定
 * IDENTITY_DB / GOVERNANCE_DB / CONTENT_DB。
 * `env.DB` 退役（A7-DB-RETIRE：wrangler 已无 binding=DB）。
 * 搬家 staging 用 `DB_IMPORT`（`db/migrations/` 全表）；切流用 promote-staging 灌入三库。
 *
 * SPILL-2-5：缺 binding 时优先抛清晰错误（生产）；若 HAILUO_DEV_DB_FALLBACK=true
 * 且 env.DB 存在，回落到旧 env.DB 并 console.warn（仅本地开发用）。
 */
export function resolveIdentityDb(env: Env): D1Database {
  return resolveWithDevFallback(env, 'IDENTITY_DB');
}

export function resolveGovernanceDb(env: Env): D1Database {
  return resolveWithDevFallback(env, 'GOVERNANCE_DB');
}

export function resolveContentDb(env: Env): D1Database {
  return resolveWithDevFallback(env, 'CONTENT_DB');
}

/**
 * A-3 试点 → A-4～A-7 推进顺序所用的 lib→库 分配速查表。
 *
 * 状态：
 *   ✅  A-3 试点已切到显式 (db, ...) 签名 — 配套路由/服务层同步
 *   ⏳  A-4 ～  待切（lib 文件名 → 目标 binding 调用约定）
 *
 * 选 binding 依据：`db/migrations-{identity,governance,content}/` 目录
 * 名 + plan §3.3 三库 33/24/5 表分配表 + M-OPT-SPLIT-2 A-2 commit
 * `1b473cc5` 落定的归属。任何新 lib 文件加表，先在本表登记再开工。
 */
export const BINDING_TABLE = {
  // ── IDENTITY_DB ─────────────────────────────────────────
  'lib/loginAttempts.ts': {
    binding: 'IDENTITY_DB' as const,
    status: '✅' as const,
    step: 'M-OPT-SPLIT-3',
    note: 'login_attempts 表在 0011（IDENTITY 库）；A-3 试点签名改造',
    callers: ['lib/urlChangeStepUp.ts', 'services/auth/adapters/production.ts'],
  },
  // 剩余 IDENTITY_DB lib：A-4 起按本表依次推进 ★
  'lib/ownerCredentials.ts': {
    binding: 'IDENTITY_DB' as const,
    status: '✅' as const,
    step: 'M-OPT-SPLIT-4',
    note: 'owner_credentials + system_config.owner_must_change_credentials',
    callers: ['services/auth/adapters/production.ts'],
  },
  'lib/ownerTotp.ts': {
    binding: 'IDENTITY_DB' as const,
    status: '✅' as const,
    step: 'M-OPT-SPLIT-4',
    note: 'owner_totp_settings / _pending / _recovery_codes + 复用 owner_credentials',
    callers: [
      'services/auth/adapters/production.ts',
      'lib/urlChangeStepUp.ts',
    ],
  },

  // ── GOVERNANCE_DB ───────────────────────────────────────
  // A-5 推进：黑名单 / 风控 / 频控 / 审计 / 通知 / 媒体 / Feed 缓存 /
  // 推荐治理 / 换域通知 / cron 元数据
  'lib/blacklistLookup.ts': {
    binding: 'GOVERNANCE_DB' as const,
    status: '✅' as const,
    step: 'M-OPT-SPLIT-5',
    note: '黑名单跨模块共用 helper（blacklist 表读，fail-soft）；follower-tokens 签发路径另走 resolveGovernanceDb fail-closed',
    callers: [
      'routes/dm.ts',
      'services/dm/adapters/production.ts',
      'services/groups/adapters/production.ts',
      'lib/friendRequests.ts',
      'lib/friendRequestInbox.ts',
      'lib/interactionEnvelope.ts',
    ],
  },
  'routes/blacklist.ts': {
    binding: 'GOVERNANCE_DB' as const,
    status: '✅' as const,
    step: 'M-OPT-SPLIT-5',
    note: '黑名单 CRUD — blacklist 表（NCF-AUDIT-OR-6 · 🟠 6 修后已去除 system_config.blacklist_dirty 写入）',
    callers: [],
  },
  'handlers/blacklistSync.ts': {
    binding: 'GOVERNANCE_DB' as const,
    status: '✅' as const,
    step: 'M-OPT-SPLIT-5',
    note: '黑名单 D1 → STATE_KV Cron（黑名单 KV 同步）',
    callers: [],
  },
  'handlers/registryBlacklistSync.ts': {
    binding: 'GOVERNANCE_DB' as const,
    status: '✅' as const,
    step: 'M-OPT-SPLIT-5',
    note: '注册中心全局黑名单 D1 → KV Cron',
    callers: [],
  },
  'lib/blacklistImmediateSync.ts': {
    binding: 'GOVERNANCE_DB' as const,
    status: '✅' as const,
    step: 'M-OPT-SPLIT-5',
    note: '黑名单写后即时同步 STATE_KV',
    callers: [],
  },
  'lib/operationLog.ts': {
    binding: 'GOVERNANCE_DB' as const,
    status: '✅' as const,
    step: 'M-OPT-SPLIT-5',
    note: 'operation_logs 表写入 + 清理',
    callers: [],
  },
  'services/local-reads/operationLogsQuery.ts': {
    binding: 'GOVERNANCE_DB' as const,
    status: '✅' as const,
    step: 'M-OPT-SPLIT-5',
    note: 'operation_logs 查询（站主直读）',
    callers: [],
  },
  'lib/localNotifications.ts': {
    binding: 'GOVERNANCE_DB' as const,
    status: '✅' as const,
    step: 'M-OPT-SPLIT-5',
    note: 'local_notifications 表写入 + 查询 + 标记已读',
    callers: ['routes/interactions.ts', 'lib/friendRequestInbox.ts', 'lib/friendRequestOutbox.ts'],
  },
  'lib/friendRequestNotify.ts': {
    binding: 'GOVERNANCE_DB' as const,
    status: '✅' as const,
    step: 'M-OPT-SPLIT-5',
    note: '加好友通知写入（friend_request_* 类型）',
    callers: [],
  },
  'handlers/feedFetch.ts': {
    binding: 'GOVERNANCE_DB' as const,
    status: '✅' as const,
    step: 'M-OPT-SPLIT-5',
    note: 'A-5：feed_cache 读/写/GC/refreshLatestFeedKv → GOVERNANCE；system_config（官方公告状态/配额）+ follows（probeFollowNodePulls）→ IDENTITY。跨库禁止单 batch。',
    callers: [],
  },
  'services/local-reads/feedQuery.ts': {
    binding: 'MIXED' as const,
    status: '✅' as const,
    step: 'M-F2',
    note: 'M-F2：feed_cache 读 GOVERNANCE；活跃关注 follows + 官方源 system_config → IDENTITY；读时 JS 可见性过滤。跨库禁 JOIN/batch。',
    callers: [],
  },
  'lib/followFeedVisibility.ts': {
    binding: 'NONE' as const,
    status: '✅' as const,
    step: 'M-F2',
    note: '纯函数：活跃关注 URL ∪ 官方源 → feed 行可见性；无 D1 接触。',
    callers: ['services/local-reads/feedQuery.ts', 'lib/followCacheCleanup.ts'],
  },
  'lib/followCacheCleanup.ts': {
    binding: 'MIXED' as const,
    status: '✅' as const,
    step: 'M-F2',
    note: '取关后串行：GOVERNANCE(feed_cache) → IDENTITY(cache_entries + system_config.feed_latest_dirty)。HTTP 零 KV.put（F-01）；禁跨库 batch。',
    callers: ['routes/follows.ts'],
  },
  'lib/publicCacheMeta.ts': {
    binding: 'GOVERNANCE_DB' as const,
    status: '✅' as const,
    step: 'M-OPT-SPLIT-5',
    note: 'posts:latest / feed:latest 内容指纹去重 + meta key 写（KV-only，无 D1 接触；登记便于扫描）',
    callers: [],
  },
  'lib/mediaStorage.ts': {
    binding: 'IDENTITY_DB' as const,
    status: '✅' as const,
    step: 'M-OPT-SPLIT-5',
    note: 'media_storage_config 在 GOVERNANCE_DB；system_config（含 images_storage / probe_status 等 key）在 IDENTITY_DB。A-5 改签：governance 函数（读 probe_status）改 (env) 内部 resolveGovernanceDb；IDENTITY 写改内部 resolveIdentityDb。persistB2ConfigD1/clearB2ConfigD1 跨库 batch 拆为顺序写（GOVERNANCE 先，IDENTITY 后）。',
    callers: [
      'routes/images.ts',
      'routes/node-settings-media-storage.ts',
      'lib/mediaStorageUsage.ts',
    ],
  },
  'lib/mediaStorageUsage.ts': {
    binding: 'IDENTITY_DB' as const,
    status: '✅' as const,
    step: 'M-OPT-SPLIT-5',
    note: 'media_storage_usage + system_config 都在 IDENTITY_DB；aggregateRegistryUsage 读 media_object_registry（IDENTITY）；bootstrapWritePriorityFromConfig 读 media_storage_config（GOVERNANCE）。A-5 改签：helper 改 (env: Env) 内部 resolveIdentityDb；tryPickBackend 等内部用 governanceDb 参数 resolveGovernanceDb；顶层导出函数不变 (env: Env)。',
    callers: ['routes/images.ts', 'routes/node-settings-media-storage.ts'],
  },
  'lib/mediaObjectRegistry.ts': {
    binding: 'IDENTITY_DB' as const,
    status: '✅' as const,
    step: 'M-OPT-SPLIT-5',
    note: 'media_object_registry 表在 IDENTITY_DB；A-5 改签：内部 resolveIdentityDb。',
    callers: ['routes/images.ts'],
  },
  'lib/mediaStorageGc.ts': {
    binding: 'MIXED' as const,
    status: '✅' as const,
    step: 'M8-14-8' as 'M-OPT-SPLIT-MESSAGING',
    note: 'M8-14-8 R2 GC：扫 media_object_registry（IDENTITY）+ 跨 CONTENT_DB 校验 posts.image_keys；R2 delete 走 binding 不计外部子请求；slots 共用 isGroupExternalSlotMinute（5/15/25/35/45），不增新 Cron 槽。',
    callers: ['handlers/cronBudget.ts'],
  },
  'lib/b2upload.ts': {
    binding: 'GOVERNANCE_DB' as const,
    status: '✅' as const,
    step: 'M-OPT-SPLIT-5',
    note: 'B2 上传 helper（probe_status 读写）',
    callers: [],
  },
  'lib/filebaseupload.ts': {
    binding: 'GOVERNANCE_DB' as const,
    status: '✅' as const,
    step: 'M-OPT-SPLIT-5',
    note: 'Filebase 上传 helper（probe_status 读写）',
    callers: [],
  },
  'routes/images.ts': {
    binding: 'GOVERNANCE_DB' as const,
    status: '✅' as const,
    step: 'M-OPT-SPLIT-5',
    note: '媒体上传 — images_storage / media_object_registry',
    callers: [],
  },
  'routes/node-settings-media-storage.ts': {
    binding: 'GOVERNANCE_DB' as const,
    status: '✅' as const,
    step: 'M-OPT-SPLIT-5',
    note: '媒体 Web 配置 — media_storage_config / usage / probe',
    callers: [],
  },
  'lib/followerTokenRateLimit.ts': {
    binding: 'GOVERNANCE_DB' as const,
    status: '✅' as const,
    step: 'M-OPT-SPLIT-5',
    note: 'follower_token_rate_buckets 频控 + follower_token_usage',
    callers: ['routes/follower-tokens.ts'],
  },
  'lib/friendRequestRateLimit.ts': {
    binding: 'GOVERNANCE_DB' as const,
    status: '✅' as const,
    step: 'M-OPT-SPLIT-5',
    note: 'friend_request_rate_buckets 频控（origin / inbox 双窗口）',
    callers: ['lib/friendRequests.ts', 'lib/friendRequestInbox.ts', 'lib/friendRequestOutbox.ts'],
  },
  'lib/dmRateLimit.ts': {
    binding: 'MESSAGING_DB' as const,
    status: '✅' as const,
    step: 'M-OPT-SPLIT-MESSAGING',
    note: 'dm_rate_buckets 频控（messagingDb 显式分库，非 env.DB 隐式）',
    callers: ['services/dm/adapters/production.ts'],
  },
  'lib/groupRateLimit.ts': {
    binding: 'MESSAGING_DB' as const,
    status: '✅' as const,
    step: 'M-OPT-SPLIT-MESSAGING',
    note: 'group_rate_buckets 频控（messagingDb 显式分库）',
    callers: ['services/groups/adapters/production.ts'],
  },
  'lib/interactionEnvelope.ts': {
    binding: 'GOVERNANCE_DB' as const,
    status: '✅' as const,
    step: 'M-OPT-SPLIT-5',
    note: 'interaction_nonces 频控 + 验签',
    callers: ['routes/interactions.ts'],
  },
  'routes/interactions.ts': {
    binding: 'MIXED' as const,
    status: '✅' as const,
    step: 'M-OPT-SPLIT-7',
    note: 'A7 Phase1：posts→resolveContentDb（ensurePostExists）；post_likes/post_replies→resolveGovernanceDb；禁跨库 JOIN/batch。interaction_nonces 仍经 interactionEnvelope→GOVERNANCE。',
    callers: [],
  },
  'routes/friend-requests.ts': {
    binding: 'MIXED' as const,
    status: '✅' as const,
    step: 'M-OPT-SPLIT-7',
    note: 'A7 Phase1：users→resolveIdentityDb；friend_requests→resolveContentDb；业务双写仍委托 friendRequests lib（方案 C 两步串行）。',
    callers: [],
  },
  'db/ownerSessionsRepo.ts': {
    binding: 'MIXED' as const,
    status: '✅' as const,
    step: 'M-OPT-SPLIT-7',
    note: 'A7 Phase1：owner_sessions/owner_login_events/system_config→resolveIdentityDb；revoked_tokens→resolveGovernanceDb；跨库禁止单 batch（revoke 单独写 Governance）。',
    callers: [
      'services/ownerEngagement/sessionLifecycle.ts',
      'services/ownerEngagement/sessionAdmin.ts',
      'services/ownerEngagement/cronEngagement.ts',
    ],
  },
  'lib/registryRouter.ts': {
    binding: 'IDENTITY_DB' as const,
    status: '✅' as const,
    step: 'M-OPT-SPLIT-7',
    note: 'A7 Phase1：registry_endpoints + system_config 凭证 + registered_registries 读写全切 resolveIdentityDb。',
    callers: [],
  },
  'routes/register.ts': {
    binding: 'IDENTITY_DB' as const,
    status: '✅' as const,
    step: 'M-OPT-SPLIT-7',
    note: 'A7 Phase1：system_config/users/registry_endpoints helpers 传 resolveIdentityDb(c.env)；同库 batch 保留。',
    callers: [],
  },
  'services/registration/adapters/production.ts': {
    binding: 'IDENTITY_DB' as const,
    status: '✅' as const,
    step: 'M-OPT-SPLIT-7',
    note: 'A7 Phase1：users/system_config/registration_sync_state/registry_endpoints 全切 resolveIdentityDb；同库 batch 保留。',
    callers: ['services/registration/index.ts'],
  },
  'services/auth/ownerIdentityUtils.ts': {
    binding: 'IDENTITY_DB' as const,
    status: '✅' as const,
    step: 'M-OPT-SPLIT-7',
    note: 'A7 Phase1：system_config + registered_registries → resolveIdentityDb。',
    callers: ['services/auth/adapters/production.ts'],
  },
  'services/auth/adapters/production.ts': {
    binding: 'IDENTITY_DB' as const,
    status: '✅' as const,
    step: 'M-OPT-SPLIT-7',
    note: 'A7 Phase1：users/follows/private_notes_wrapped_key 残留散点全切 resolveIdentityDb；loginAttempts/ownerCredentials 经既有 IDENTITY helpers。',
    callers: ['services/auth/index.ts'],
  },
  'lib/localNodeResolve.ts': {
    binding: 'IDENTITY_DB' as const,
    status: '✅' as const,
    step: 'M-OPT-SPLIT-7',
    note: 'A7 Phase1：cache_entries/follows/users/system_config → resolveIdentityDb。',
    callers: [],
  },
  'routes/node-settings.ts': {
    binding: 'IDENTITY_DB' as const,
    status: '✅' as const,
    step: 'M-OPT-SPLIT-7',
    note: 'A7 Phase1：system_config / users 节点设置 → resolveIdentityDb。',
    callers: [],
  },
  'handlers/feedPullBatch.ts': {
    binding: 'IDENTITY_DB' as const,
    status: '✅' as const,
    step: 'M-OPT-SPLIT-7',
    note: 'A7 Phase1：follows / system_config 拉帖批游标 → resolveIdentityDb。',
    callers: [],
  },
  'lib/nodeUrlMoved.ts': {
    binding: 'IDENTITY_DB' as const,
    status: '✅' as const,
    step: 'M-OPT-SPLIT-7',
    note: 'A7 Phase1：follows / cache_entries 换域 → resolveIdentityDb。',
    callers: [],
  },
  'services/feed/adapters/production.ts': {
    binding: 'MIXED' as const,
    status: '✅' as const,
    step: 'M-OPT-SPLIT-7',
    note: 'A7 Phase1：follows/users→resolveIdentityDb；feed_cache.batch→resolveGovernanceDb；runFeedAggregation 拆 followsRepo.batchMarks 与 feedCache.batch 两步串行，禁跨库单 batch。',
    callers: [],
  },
  'services/feed/runFeedAggregation.ts': {
    binding: 'MIXED' as const,
    status: '✅' as const,
    step: 'M-OPT-SPLIT-7',
    note: 'A7 Phase1：先 feedCache.batch(GOVERNANCE) 再 followsRepo.batchMarks(IDENTITY)；error_code 仍 FEED_CACHE_BATCH_FAILED。',
    callers: ['services/feed/adapters/production.ts'],
  },
  'lib/registryFetch.ts': {
    binding: 'IDENTITY_DB' as const,
    status: '✅' as const,
    step: 'M-OPT-SPLIT-7',
    note: 'A7 Phase1：outbound_events（insertOutboundEvent）→ resolveIdentityDb。',
    callers: [],
  },
  'routes/follows.ts': {
    binding: 'MIXED' as const,
    status: '✅' as const,
    step: 'M-F2',
    note: 'A7 Phase1：follows CRUD → resolveIdentityDb；M-F2 DELETE 后串行调 followCacheCleanup（GOVERNANCE feed_cache + IDENTITY cache_entries/dirty）。禁跨库 batch；HTTP 零 KV.put。',
    callers: [],
  },
  'lib/followUrlMigrate.ts': {
    binding: 'IDENTITY_DB' as const,
    status: '✅' as const,
    step: 'M-OPT-SPLIT-7',
    note: 'A7 Phase1：follows + cache_entries 换域迁移 → resolveIdentityDb。',
    callers: [],
  },
  'lib/localPublicBaseUrl.ts': {
    binding: 'IDENTITY_DB' as const,
    status: '✅' as const,
    step: 'M-OPT-SPLIT-7',
    note: 'A7 Phase1：system_config.worker_b_url + users.worker_b_url → resolveIdentityDb。',
    callers: [],
  },
  'lib/readProtectionMode.ts': {
    binding: 'IDENTITY_DB' as const,
    status: '✅' as const,
    step: 'M-OPT-SPLIT-7',
    note: 'A7 Phase1：system_config 读保护模式 + follows → resolveIdentityDb。',
    callers: [],
  },
  'routes/read-mutual-proof.ts': {
    binding: 'IDENTITY_DB' as const,
    status: '✅' as const,
    step: 'M-OPT-SPLIT-7',
    note: 'A7 Phase1：users/follows 签发互粉证明 → resolveIdentityDb。',
    callers: [],
  },
  'lib/nodeUrlChangedInbound.ts': {
    binding: 'IDENTITY_DB' as const,
    status: '✅' as const,
    step: 'M-OPT-SPLIT-7',
    note: 'A7 Phase1：follows/cache_entries/users 入站换域 → resolveIdentityDb。',
    callers: [],
  },
  'lib/lookupAssist.ts': {
    binding: 'IDENTITY_DB' as const,
    status: '✅' as const,
    step: 'M-OPT-SPLIT-7',
    note: 'MIGRATION-COVERAGE：registry_quota_buckets 与 follows 都在 IDENTITY_DB（migrations-identity/0012、0001）；旧注释写 GOVERNANCE 是拆库勘误。',
    callers: [],
  },
  'lib/registryQuota.ts': {
    binding: 'IDENTITY_DB' as const,
    status: '✅' as const,
    step: 'M-OPT-SPLIT-5c',
    note: 'registry_quota_buckets 频控（MIGRATION-COVERAGE：表在 IDENTITY_DB/0012，已由 resolveGovernanceDb 改回 resolveIdentityDb）',
    callers: [],
  },
  'lib/lookupResolveStats.ts': {
    binding: 'IDENTITY_DB' as const,
    status: '✅' as const,
    step: 'M-OPT-SPLIT-5c',
    note: 'lookup_resolve_day_stats 聚合统计（MIGRATION-COVERAGE：表在 IDENTITY_DB/0045，已改回 resolveIdentityDb）',
    callers: [],
  },
  'lib/readMutualProofGate.ts': {
    binding: 'MIXED' as const,
    status: '✅' as const,
    step: 'M-OPT-SPLIT-7',
    note: 'A7 Phase1：follows→resolveIdentityDb；read_proof_nonces→resolveGovernanceDb。',
    callers: [],
  },
  'routes/node-hosted-l0.ts': {
    binding: 'IDENTITY_DB' as const,
    status: '✅' as const,
    step: 'M-OPT-SPLIT-7',
    note: 'A7 Phase1：托管 L0 helpers 传入 resolveIdentityDb(c.env)。',
    callers: [],
  },
  'lib/messagingGroupShardMigrate.ts': {
    binding: 'MIXED' as const,
    status: '✅' as const,
    step: 'M-OPT-SPLIT-7a',
    note: 'A7 Phase1 messaging：system_config 水位/错误键→resolveIdentityDb；分片数据仍 messagingDb。',
    callers: [],
  },
  'lib/messagingDbCapacity.ts': {
    binding: 'MIXED' as const,
    status: '✅' as const,
    step: 'M-OPT-SPLIT-7a',
    note: 'A7 Phase1 messaging：system_config 水位日志→resolveIdentityDb；容量统计仍 messagingDb。',
    callers: [],
  },
  'lib/messagingMediaLimits.ts': {
    binding: 'IDENTITY_DB' as const,
    status: '✅' as const,
    step: 'M-OPT-SPLIT-7a',
    note: 'A7 Phase1 messaging：system_config 媒体限额→resolveIdentityDb。',
    callers: [],
  },
  'lib/dmGc.ts': {
    binding: 'MIXED' as const,
    status: '✅' as const,
    step: 'M-OPT-SPLIT-7a',
    note: 'A7 Phase1 messaging：dm_retention_days system_config→resolveIdentityDb；消息清理仍 messagingDb。',
    callers: [],
  },
  'routes/dm.ts': {
    binding: 'MIXED' as const,
    status: '✅' as const,
    step: 'M-OPT-SPLIT-7a',
    note: 'A7 Phase1 messaging：users/dm_pubkey→resolveIdentityDb；dm_* 表仍 messagingDb。',
    callers: [],
  },
  'routes/groups.ts': {
    binding: 'MIXED' as const,
    status: '✅' as const,
    step: 'M-OPT-SPLIT-7a',
    note: 'A7 Phase1 messaging：users→resolveIdentityDb；群表仍 messagingDb。',
    callers: [],
  },
  'lib/groupCron.ts': {
    binding: 'MIXED' as const,
    status: '✅' as const,
    step: 'M-OPT-SPLIT-7a',
    note: 'A7 Phase1 messaging：users→resolveIdentityDb；群 cron 数据仍 messagingDb。',
    callers: [],
  },
  'lib/groupGc.ts': {
    binding: 'MIXED' as const,
    status: '✅' as const,
    step: 'M-OPT-SPLIT-7a',
    note: 'A7 Phase1 messaging：users.worker_b_url→resolveIdentityDb；群 GC 仍 messagingDb。',
    callers: [],
  },
  'lib/groupKick.ts': {
    binding: 'MIXED' as const,
    status: '✅' as const,
    step: 'M-OPT-SPLIT-7a',
    note: 'A7 Phase1 messaging：users→resolveIdentityDb；踢人写 messagingDb。',
    callers: [],
  },
  'lib/dmMediaMirror.ts': {
    binding: 'MIXED' as const,
    status: '✅' as const,
    step: 'M-OPT-SPLIT-7a',
    note: 'A7 Phase1 messaging：media_object_registry→resolveIdentityDb；dm 媒体元数据仍 messagingDb。',
    callers: [],
  },
  'lib/groupMediaMirror.ts': {
    binding: 'MIXED' as const,
    status: '✅' as const,
    step: 'M-OPT-SPLIT-7a',
    note: 'A7 Phase1 messaging：media_object_registry→resolveIdentityDb；群媒体元数据仍 messagingDb。',
    callers: [],
  },
  'services/messaging-media/adapters/production.ts': {
    binding: 'MIXED' as const,
    status: '✅' as const,
    step: 'M-OPT-SPLIT-7a',
    note: 'A7 Phase1 messaging：media_object_registry→resolveIdentityDb；消息 envelope 仍 messagingDb。',
    callers: [],
  },
  'lib/friendRequests.ts': {
    binding: 'MIXED' as const,
    status: '✅' as const,
    step: 'M-OPT-SPLIT-6-3',
    note: '跨库契约：CONTENT(friend_requests · migration 0060) + IDENTITY(follows · migration 0001) + IDENTITY(system_config · migration 0090, allow_incoming 开关) + GOVERNANCE(friend_request_rate_buckets · migration 0062, 经 friendRequestRateLimit helper)。acceptRequest 双写 A-6-3 落方案 C 拆两步串行（先 CONTENT UPDATE friend_requests → 后 IDENTITY INSERT OR IGNORE INTO follows）；由 friendRequestRetention.repairFriendRequestFollows ≤10min cron 兜底补 INSERT OR IGNORE。语义等价 M17-FIX-3 P0-3 守护（eventual atomicity ≤10min）；禁止改回单 binding batch。A-7 Phase3 真退役：整文件已切 CONTENT/IDENTITY 显式 resolver，binding MIXED（多库设计）升 ✅（alias 已退役，多库设计本身是正确的）',
    callers: ['routes/friend-requests.ts'],
  },
  'lib/friendRequestInbox.ts': {
    binding: 'MIXED' as const,
    status: '✅' as const,
    step: 'M-OPT-SPLIT-6-2',
    note: '跨库契约：CONTENT(friend_requests · migration 0060 INSERT 本地副本) + IDENTITY(system_config · migration 0090 读 allow_incoming) + GOVERNANCE(friend_request_rate_buckets · migration 0062 频控 helper)。本文件无 env.DB.batch 跨库单 batch，三表均为单条单表单库；A-6-2 已切显式 resolver。A-7 Phase3 真退役：binding MIXED 升 ✅（多库设计本身正确；alias 已退役）',
    callers: [],
  },
  'lib/friendRequestOutbox.ts': {
    binding: 'MIXED' as const,
    status: '✅' as const,
    step: 'M-OPT-SPLIT-6-3',
    note: '跨库契约：CONTENT(friend_requests) + IDENTITY(follows)。A-6-2 rejected→CONTENT；A-6-3 accepted 方案 C 两步串行 + Repair≤10min。A-7 Phase3 真退役：binding MIXED 升 ✅（多库设计正确；alias 已退役；禁止改回单 binding batch）',
    callers: [],
  },
  'lib/friendRequestRetention.ts': {
    binding: 'MIXED' as const,
    status: '✅' as const,
    step: 'M-F3',
    note: '跨库契约：CONTENT(friend_requests) + IDENTITY(follows/users) + GOVERNANCE(rate_buckets)。A-6-2 按表真切；A-6-3 Repair=方案 C 兜底。M-F3：gcFriendRequestInbox 读 IDENTITY pubkey + CONTENT 行，经 friendRequestDelivery 重投；禁跨库 batch。',
    callers: ['handlers/cronBudget.ts'],
  },
  'middleware/auth.ts': {
    binding: 'GOVERNANCE_DB' as const,
    status: '✅' as const,
    step: 'M-OPT-SPLIT-5',
    note: 'revoked_tokens 站主 JWT 吊销',
    callers: [],
  },
  'handlers/registryRecommendations.ts': {
    binding: 'MIXED' as const,
    status: '✅' as const,
    step: 'M-OPT-SPLIT-5c-4a',
    note: '双库串行：registry_recommended_users+fof_recommended_users→GOVERNANCE；元数据 system_config→IDENTITY；M17-4-2c 读 FoF 并入 local API；禁跨库单 batch',
    callers: ['routes/local-reads/registry-sync.ts'],
  },
  'handlers/registryDailySync.ts': {
    binding: 'GOVERNANCE_DB' as const,
    status: '✅' as const,
    step: 'M-OPT-SPLIT-5',
    note: 'daily-sync 元数据（registry_daily_sync_* key + blacklist 同步）',
    callers: [],
  },
  'handlers/registryDailySyncCron.ts': {
    binding: 'GOVERNANCE_DB' as const,
    status: '✅' as const,
    step: 'M-OPT-SPLIT-5',
    note: 'daily-sync 错峰秒级 + daily_sync_utc_second_of_day 落库',
    callers: [],
  },
  'handlers/registryPolicyPoll.ts': {
    binding: 'GOVERNANCE_DB' as const,
    status: '✅' as const,
    step: 'M-OPT-SPLIT-5',
    note: 'policy-digest ETag/304 元数据',
    callers: [],
  },
  'handlers/registryUrlChange.ts': {
    binding: 'IDENTITY_DB' as const,
    status: '✅' as const,
    step: 'M-OPT-SPLIT-5c-2',
    note: '换域 confirm 与本地 D1 同步（users + system_config 走 IDENTITY 库 batch；registry_endpoints 通过 markBackupRegistryEndpointsUrlStale 走 resolveGovernanceDb 拆分；A-5c-2 修复原 GOVERNANCE_DB 误归类）',
    callers: [],
  },
  'handlers/registryRegistrationProfile.ts': {
    binding: 'IDENTITY_DB' as const,
    status: '✅' as const,
    step: 'M-OPT-SPLIT-5c',
    note: '登记资料本地同步（users 表 → IDENTITY_DB；A-5c-1 修正原 GOVERNANCE_DB 误归类 + 函数内 resolveIdentityDb(env)）',
    callers: [],
  },
  'lib/registryEndpoints.ts': {
    binding: 'IDENTITY_DB' as const,
    status: '✅' as const,
    step: 'M-OPT-SPLIT-7',
    note: 'A7 Phase1 勘误：原误标 GOVERNANCE；registry_endpoints + system_config + registered_registries 均在 IDENTITY；migrate/sync 全切 resolveIdentityDb(env)',
    callers: [],
  },
  'handlers/registryEndpointsKvSync.ts': {
    binding: 'GOVERNANCE_DB' as const,
    status: '✅' as const,
    step: 'M-OPT-SPLIT-5',
    note: 'registry_endpoints D1 → STATE_KV 同步（5c-5 勘误：原表行 path 误写 lib/registryEndpointsKvSync.ts，磁盘实文件在 handlers/registryEndpointsKvSync.ts；scan-a5-leftover.mjs 一直报 NOT FOUND 已修复）',
    callers: [],
  },
  'lib/urlChangeNotify.ts': {
    binding: 'MIXED' as const,
    status: '✅' as const,
    step: 'M-OPT-SPLIT-5c-6',
    note: '换域通知 — IDENTITY(system_config · migration 0001/0090 + url_change_notify_events · migration 0048 + follows · migration 0001) + GOVERNANCE(url_change_notify_jobs · migration 0046 + post_likes/post_replies · migration 0018) + MESSAGING(dm_messages · env.MESSAGING_DB 直读)。跨库禁止单 batch；5c-6 9 散点已全部切 resolveIdentityDb / resolveGovernanceDb / env.MESSAGING_DB；0 处 env.DB 残留',
    callers: ['handlers/registryUrlChange.ts', 'handlers/cron.ts'],
  },
  'lib/urlChangeLocalReconcile.ts': {
    binding: 'IDENTITY_DB' as const,
    status: '✅' as const,
    step: 'M-OPT-SPLIT-5c-2',
    note: 'url_change_local_reconcile 处理队列 + lease（A-5c-2：5 函数内 resolveIdentityDb(env) 共享 identityDb 变量；表在 IDENTITY migration 0049）',
    callers: [],
  },
  'lib/federationLastLookup.ts': {
    binding: 'IDENTITY_DB' as const,
    status: '✅' as const,
    step: 'M-OPT-SPLIT-5c-2',
    note: 'federation_last_lookup_json 写 system_config（IDENTITY_DB；A-5c-2 修正原 GOVERNANCE_DB 误归类 + 两函数内 resolveIdentityDb(env)）',
    callers: [],
  },
  'lib/dailySyncScheduleConfig.ts': {
    binding: 'GOVERNANCE_DB' as const,
    status: '✅' as const,
    step: 'M-OPT-SPLIT-5',
    note: 'daily_sync_utc_second_of_day 错峰秒级落库（system_config INSERT 由 0090 汇总）',
    callers: [],
  },
  'lib/registryCronSchedule.ts': {
    binding: 'IDENTITY_DB' as const,
    status: '✅' as const,
    step: 'M-OPT-SPLIT-4',
    note: 'registry cron 调度纯函数（不读写 D1；仅被 dailySyncScheduleConfig 等调用方使用）',
    callers: [],
  },
  'lib/followIdentityRows.ts': {
    binding: 'IDENTITY_DB' as const,
    status: '✅' as const,
    step: 'M-OPT-SPLIT-5c-4a',
    note: 'follows + cache_entries 同在 IDENTITY；A-5c-4a 显式 resolveIdentityDb(env)，去 env.DB 隐式 binding（同库可读保留单查询）',
    callers: ['handlers/registryRecommendations.ts'],
  },
  'lib/activitySummary.ts': {
    binding: 'MIXED' as const,
    status: '✅' as const,
    step: 'M-OPT-SPLIT-6-5',
    note: 'A-6-5：users→IDENTITY；posts→CONTENT；post_likes/post_replies→GOVERNANCE 单表 COUNT（禁跨库 JOIN posts，可能轻微高估含已删帖互动，M32 fail-soft）。整文件 env.DB 清零。',
    callers: [],
  },
  'lib/groupLifecycleSummary.ts': {
    binding: 'MESSAGING_DB' as const,
    status: '✅' as const,
    step: 'M16-GROUP-GOV-5' as 'M-OPT-SPLIT-MESSAGING',
    note: '近 30 天群主侧创建/解散群号 → daily-sync.group_lifecycle；仅 messagingDb.groups；无群名/成员',
    callers: ['handlers/registryDailySync.ts'],
  },
  'lib/nodeExport.ts': {
    binding: 'MIXED' as const,
    status: '✅' as const,
    step: 'M-OPT-SPLIT-6-5',
    note: 'A-6-5：buildNodeExportBundle(env) 按 NODE_EXPORT_TABLE_BINDING 选库 dump；buildImageManifest posts→CONTENT + users/registry→IDENTITY。staging import 写 DB_IMPORT；A7-DB-RETIRE：promoteStagingImportToSplit 灌入三库。owner_totp_* 按运行时 IDENTITY；quota/stats 按运行时 GOVERNANCE。',
    callers: ['routes/node-migrate.ts'],
  },
  // posts 端点同时读 posts（CONTENT_DB）与 feed_cache（GOVERNANCE_DB），
  // 每次请求各自显式解析自己的 binding，两个查询保持串行，不跨库 batch。
  'routes/internal-cache-snapshot.ts': {
    binding: 'MIXED' as const,
    status: '✅' as const,
    step: 'M-OPT-SPLIT-6',
    note: 'A-6-1：cache-snapshot/posts 切 resolveContentDb，cache-snapshot/feed 切 resolveGovernanceDb；两表查询保持独立，禁止跨库 batch。A-7 Phase3 真退役：升 ✅（alias 已退役；多库设计正确）',
    callers: [],
  },
  'routes/posts.ts': {
    binding: 'MIXED' as const,
    status: '✅' as const,
    step: 'M-OPT-SPLIT-6-6',
    note: 'A-6-6：发帖/转发/删帖三处跨库 batch 落方案 C — 先 CONTENT 写/软删 posts → 后 IDENTITY 置 posts_latest_dirty；dirty 失败 waitUntil(refreshPostsCacheIfDirty({force:true})) 兜底。删帖前置 SELECT 仍 A-6-1 CONTENT。A-7 Phase3 真退役：升 ✅（alias 已退役；方案 C 跨库两步串行正确；禁止改回单 binding batch）',
    callers: [],
  },
  'routes/local-reads/mutual-follows.ts': {
    binding: 'MIXED' as const,
    status: '✅' as const,
    step: 'M-OPT-SPLIT-6-6',
    note: 'A-6-6：users/follows→resolveIdentityDb；friend_requests→resolveContentDb；禁 friend_requests JOIN follows，JS 交集。整文件 env.DB 清零。A-7 Phase3 真退役：升 ✅；M17-4-2a 查询下沉 mutualFriendsProjection',
    callers: ['routes/local-reads/app.ts'],
  },
  'lib/mutualFriendsProjection.ts': {
    binding: 'MIXED' as const,
    status: '✅' as const,
    step: 'M-OPT-SPLIT-6-6',
    note: 'M17-4-2a：friend_requests→CONTENT；users/follows→IDENTITY；公开投影三字段；禁跨库 batch',
    callers: [
      'routes/local-reads/mutual-follows.ts',
      'routes/internal-friends-projection.ts',
    ],
  },
  'routes/internal-friends-projection.ts': {
    binding: 'MIXED' as const,
    status: '✅' as const,
    step: 'M-OPT-SPLIT-6-6',
    note: 'M17-4-2a：HMAC 内部入口；委托 mutualFriendsProjection；无直写',
    callers: ['index.ts'],
  },
  'lib/fofRecommendations.ts': {
    binding: 'MIXED' as const,
    status: '✅' as const,
    step: 'M-OPT-SPLIT-6-6',
    note: 'M17-4-2b：fof_recommended_users→GOVERNANCE；system_config 元数据→IDENTITY；follows 读 IDENTITY；禁跨库 batch；出站拉好友投影',
    callers: ['handlers/cronBudget.ts'],
  },
  'services/local-reads/postsQuery.ts': {
    binding: 'CONTENT_DB' as const,
    status: '✅' as const,
    step: 'M-OPT-SPLIT-6',
    note: 'A-6-1：posts 列表、cursor 查询全部走 resolveContentDb(env)；posts 单表单库已完成改签。',
    callers: ['routes/local-reads/posts.ts'],
  },
  'handlers/cron.ts': {
    binding: 'MIXED' as const,
    status: '✅' as const,
    step: 'M-F2',
    note: 'A-5b 推进 refreshPostsCacheIfDirty posts→CONTENT_DB + system_config→IDENTITY_DB 两步串行；A-5c-3 勘误：outbound_events 表在 IDENTITY_DB（migration-identity/0003），retryFailedOutboundEvents + retryDailySyncEvent + retryIndexEvent + gcOutboundEvents 已从 A-5b 误归 GOVERNANCE_DB 改为 IDENTITY_DB（避免未来分库 split-brain）。gcRevokedTokens → GOVERNANCE_DB；gcCacheEntries + gcLoginAttempts → IDENTITY_DB；probeR2/B2/Filebase 的 system_config 写已在 A-5 切 IDENTITY_DB。M-F2：refreshFeedLatestIfDirty 读 IDENTITY system_config.feed_latest_dirty → 刷 GOVERNANCE feed_cache→KV → 清 dirty。',
    callers: [],
  },
  'lib/d1Gc.ts': {
    binding: 'IDENTITY_DB' as const,
    status: '✅' as const,
    step: 'M-OPT-SPLIT-4',
    note: 'D1 GC 水位 — cache_entries / outbound_events / system_config 清理（全部 IDENTITY）',
    callers: [],
  },

  // ── GOVERNANCE_DB ───────────────────────────────────────

  // ── CONTENT_DB ──────────────────────────────────────────
  // A-6 起按 plan §3.4 依次切；现阶段首批 ✅：
  //   - lib/repostOrigin.ts（A-6 起步 · 2 处 posts 散点；users/follows 留 A-6-5）
  //   - services/private-notes/adapters/*（A-6-4 · notes+attachments CONTENT；wrapped_key IDENTITY）
  'lib/repostOrigin.ts': {
    binding: 'MIXED' as const,
    status: '✅' as const,
    step: 'M-OPT-SPLIT-6-5',
    note: 'A-6 起步 posts→CONTENT；A-6-5 resolveRepostAuthorHandle + fetchRemoteOriginPost 的 users/follows → resolveIdentityDb。整文件 env.DB 清零；cross-node fetch 走 Worker B。',
    callers: ['routes/posts.ts'],
  },
  'services/private-notes/adapters/production.ts': {
    binding: 'MIXED' as const,
    status: '✅' as const,
    step: 'M-OPT-SPLIT-6-4',
    note: 'A-6-4：private_notes + private_note_attachments → resolveContentDb（同库 FK / notes↔attachments batch 保留，禁拆跨 binding）；private_notes_wrapped_key → resolveIdentityDb（migration-identity/0030）。整文件 env.DB.prepare/batch 已清零；与 MESSAGING_DB 隔离。',
    callers: [
      'services/private-notes/index.ts',
      'routes/private-notes.ts',
    ],
  },
  'services/private-notes/adapters/attachmentProduction.ts': {
    binding: 'CONTENT_DB' as const,
    status: '✅' as const,
    step: 'M-OPT-SPLIT-6-4',
    note: 'A-6-4：private_note_attachments 元数据 CRUD 全切 resolveContentDb；blob 仍走 IMAGE_KV / Filebase / B2；用量走 mediaStorageUsage（非 D1 binding 切库）。整文件 env.DB.prepare 已清零。',
    callers: [
      'services/private-notes/index.ts',
      'routes/private-notes.ts',
    ],
  },
} as const satisfies Record<string, LibBindingAllocation>;

export type LibBindingAllocation = {
  /** NONE = 纯函数 / 无 D1（如可见性过滤） */
  binding: 'IDENTITY_DB' | 'GOVERNANCE_DB' | 'CONTENT_DB' | 'MESSAGING_DB' | 'DB_IMPORT' | 'MIXED' | 'NONE';
  status: '✅' | '⏳';
  /** 含 M-OPT-SPLIT-* 与后续好友/Feed 修复步（M-F2 / M-F3 / M-F3b…） */
  step:
    | `M-OPT-SPLIT-${number}`
    | `M-OPT-SPLIT-${number}${string}`
    | 'M-OPT-SPLIT-MESSAGING'
    | `M-F${number}`
    | `M-F${number}${string}`;
  note: string;
  callers: readonly string[];
};

/**
 * 不变量（生产校验）：每个 lib 文件（lib/services/handlers/routes/**）调用
 * `env.DB` / `env.IDENTITY_DB` 等点必须在本表登记对应 binding。A-4 起
 * CI 脚本可遍历本表断言每条 ✅ lib 的实际 env 解析器调用已切对。
 */
