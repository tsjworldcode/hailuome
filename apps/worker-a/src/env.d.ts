import type { OwnerJwtPayload } from '@hailuo/shared-types';

/** Hono context 变量（由 requireOwnerJWT 中间件注入） */
export interface AppVariables {
  ownerJwt: OwnerJwtPayload;
  internalForwardBody?: string;
}

export interface Env {
  /**
   * A7-DB-RETIRE：wrangler 已移除 `DB` binding。业务与切流均走
   * IDENTITY / GOVERNANCE / CONTENT + DB_IMPORT；勿再声明此字段为必填。
   * 类型保留可选仅为历史类型兼容，运行时不会注入。
   */
  DB?: D1Database;
  /**
   * 身份目录库 — users / credentials / system_config / follows / …
   * 表全清单见 `apps/worker-a/db/migrations-identity/`。
   * A7 Phase2：必填（无 env.DB fallback）。
   */
  IDENTITY_DB: D1Database;
  /**
   * 治理/运营库 — blacklist / revoked_tokens / feed_cache / likes/replies / …
   * 表全清单见 `apps/worker-a/db/migrations-governance/`。
   * A7 Phase2：必填（无 env.DB fallback）。
   */
  GOVERNANCE_DB: D1Database;
  /**
   * 用户内容库 — posts / private_notes / friend_requests / …
   * 表全清单见 `apps/worker-a/db/migrations-content/`。
   * A7 Phase2：必填（无 env.DB fallback）。
   */
  CONTENT_DB: D1Database;
  /**
   * M9-7-S2：安全搬家 staging D1（正规导入只写此库）。
   * A7-DB-RETIRE：切流用 POST /api/node/import/promote-staging 灌入三库，不再交换旧 DB id。
   * 未配置时 POST /api/node/import（非 unsafe）返回 NODE_IMPORT_STAGING_MISSING。
   */
  DB_IMPORT?: D1Database;
  /** M16-1a：私信 + 群聊 E2EE 密文（dm_* / group_*）；M16-1b 起 dm 读写切本 binding */
  MESSAGING_DB: D1Database;
  /** M16-P：群消息 overflow 分片（可选；仅 group_messages / member_group_messages） */
  MESSAGING_SHARD_1?: D1Database;
  POSTS_CACHE_KV: KVNamespace;
  IMAGE_KV: KVNamespace;
  STATE_KV: KVNamespace;
  /** M5-0/1：可选 R2 bucket（F-14 红线：主分支 wrangler.toml 不硬绑；绑卡用户通过部署脚本注入 [[r2_buckets]]） */
  HAILUO_IMAGE_R2?: R2Bucket;
  /**
   * M5-SR-P2c：R2 CF REST /usage 校准（可选；与 HAILUO_IMAGE_R2 同 bucket）。
   * R2_USAGE_API_TOKEN 走 wrangler secret；未配时回落 HAILUO_IMAGE_R2.list()。
   */
  R2_USAGE_ACCOUNT_ID?: string;
  R2_USAGE_BUCKET_NAME?: string;
  R2_USAGE_API_TOKEN?: string;
  FEED_QUEUE?: Queue;
  /**
   * M5-B2：Backblaze B2 配置（全部可选，迁移期 fallback）。
   * 权威配置来自 D1 `media_storage_config` + Web 设置页；env 仅在 D1 无配置时使用。
   * 不再要求 B2_PUBLIC_URL（私有读取走 Worker B 代理）。
   */
  B2_KEY_ID?: string;           // B2 Application Key ID（敏感，走 secret）
  B2_APP_KEY?: string;          // B2 Application Key（敏感，走 secret）
  B2_BUCKET_NAME?: string;      // B2 存储桶名称，如 hailuo-images
  B2_ENDPOINT?: string;         // S3 兼容端点，如 https://s3.us-west-004.backblazeb2.com
  B2_PUBLIC_URL?: string;       // 公开访问 URL 前缀，如 https://f004.backblazeb2.com/file/hailuo-images
  B2_REGION?: string;           // 可选 region 覆盖（M5-C6）：自定义域名 / CDN 前置场景下 B2_ENDPOINT 不含标准域名时必填，如 us-west-004
  JWT_SECRET: string;
  /**
   * M12-1：包裹 D1 中 TOTP secret 的 AES-GCM 密钥（≥16 字节）。
   * 只存 wrangler secret / .dev.vars，禁止写入 wrangler.toml 或公开文档示例值。
   */
  TOTP_WRAP_SECRET?: string;
  /** R-MSG-1d：包裹 D1 中 node_api_token（nat_）的 AES-GCM wrap secret；≥16 字节 */
  NODE_API_TOKEN_WRAP_SECRET?: string;
  /**
   * OWNER-KEY-1：包裹 `group_owner_epoch_keys.key_material` 的 AES-GCM secret（≥32 字节随机）。
   * 仅 Worker A / 群主节点；**禁止**与 JWT_SECRET / HMAC_SECRET / INTERNAL_FORWARD_SECRET /
   * TOTP_WRAP_SECRET / NODE_API_TOKEN_WRAP_SECRET 复用。只存 wrangler secret / `.dev.vars`。
   * 缺失时 OWNER-KEY-2+ 写持钥表应 fail-closed（本步仅声明类型与约定）。
   */
  GROUP_OWNER_KEY_WRAP_SECRET?: string;
  ED25519_PRIVATE_KEY: string;
  ED25519_PUBLIC_KEY: string;
  /**
   * F-04 / M-WORKFLOW-URL-1：生产子域不进 git 真值；`[env.production.vars]` 可留 placeholder，
   * 部署时由 finalize / ci-finalize-urls **upsertTomlVar** 写真实 URL 再 redeploy。
   * **禁止**对已在 production.vars 的同名再 `wrangler secret put`（Cloudflare 10053）。
   * 本地 wrangler dev 用 `.dev.vars`。读取点用 `?? ''` / `?.` / `||` 兼容 undefined。
   */
  WORKER_B_URL?: string;
  /**
   * SEC-AUDIT-2026-10：本地/测试放行私网 hostname（仅 hostname 层；**不**放 `http:`）。
   * 真值：`true` / `1` / `on` / `yes`。生产勿开。
   */
  PROOF_ALLOW_PRIVATE_TARGETS?: string;
  /**
   * @deprecated SEC-AUDIT-ENFORCED-FORCE-1：运行时恒强制 `following-only`，不再读取本字段。
   * 保留可选类型仅兼容存量部署注入。
   */
  FOLLOWER_TOKEN_MODE?: string;
  /**
   * 联邦全网黑名单写入 STATE_KV。
   * 生产默认开启；仅显式 `"false"` / `"0"` / `"off"` 关闭（紧急逃生）。
   */
  FEDERATION_BLACKLIST_ENFORCE?: string;
  /**
   * R-AUDIT-SEP-B2：每轮黑名单 KV 写（put+delete）上限，默认 100；非法回落默认，硬顶 500。
   */
  BLACKLIST_KV_WRITE_BUDGET?: string;
  REGISTRY_URL: string;
  /**
   * M9-PH-BI-1：可选覆盖入口镜像 URL 候选（逗号分隔 https）。
   * 未设则用源码钉死 `BOOTSTRAP_URL_CANDIDATES_PINNED`。设了则以本变量为准。
   */
  BOOTSTRAP_URL_CANDIDATES?: string;
  /** M7-24 / M-OPT-1qn：每日向注册中心 lookup 回源上限（默认 10，与注册中心 NODE_LOOKUP_DAY_LIMIT 对齐） */
  REGISTRY_LOOKUP_DAY_LIMIT?: string;
  /**
   * M-OPT-8b：L2 互粉协助开关。海螺节点**默认开**；显式 `"false"` 关闭。
   * 开启后 L1 miss 可向已关注联系人 Worker B `/lookup-assist/:handle` 询问（不计 lookup_day）。
   */
  LOOKUP_L2_MUTUAL_ASSIST_ENABLED?: string;
  /**
   * M-OPT-8c：L3 有限 FoF。海螺节点**默认开**；显式 `"false"` 关闭。
   * 开启后 L2 miss 可带 `?fof=1` 再问一层（对端最多扩其联系人 L1，禁止递归）。
   */
  LOOKUP_L3_FOF_ENABLED?: string;
  /** M-OPT-8b：本节点对外应答 assist 日上限（默认 200） */
  LOOKUP_ASSIST_IN_DAY_LIMIT?: string;
  /** M-OPT-8b：本节点发起 L2 协助轮次日上限（默认 50） */
  LOOKUP_ASSIST_OUT_DAY_LIMIT?: string;
  /** M-OPT-8c：FoF 入站日上限（默认 100） */
  LOOKUP_L3_FOF_IN_DAY_LIMIT?: string;
  /** M-OPT-8c：FoF 出站轮次日上限（默认 20） */
  LOOKUP_L3_FOF_OUT_DAY_LIMIT?: string;
  /**
   * M17-4-2b：右栏「好友的好友」小时刷新。默认开；显式 `"false"` / `"0"` / `"off"` 关闭。
   */
  FOOF_RECOMMENDATIONS_ENABLED?: string;
  /** 预留：每日 search 回源上限（默认 1000；search 未上线前仅配置占位） */
  REGISTRY_SEARCH_DAY_LIMIT?: string;
  /** 预留：每分钟 search 回源上限（默认 20） */
  REGISTRY_SEARCH_MINUTE_LIMIT?: string;
  FEED_VIA_QUEUE: string;
  /**
   * M5-SR：B2/R2/Filebase 单请求体上限（字节字符串）。
   * 未设默认 104857600（100 MB，Free/Pro）；Business 可设 209715200；Enterprise 可设 524288000。
   */
  MEDIA_MAX_REQUEST_BYTES?: string;
  /** MM-2：Messaging Media 单图上限（字节字符串；默认 10485760） */
  MESSAGING_MEDIA_MAX_BYTES?: string;
  /** MM-2：单条消息图片数上限（默认 4） */
  MESSAGING_MEDIA_MAX_PER_MESSAGE?: string;
  /** M16-5：Cron 每 tick 最多 sync 群数（默认 10，上限 50） */
  GROUP_SYNC_CRON_BATCH?: string;
  /**
   * 部署占位 handle（bootstrap 自动生成 `hailuo_` + 10 位）。
   * 登记注册中心后以 D1 `users.handle` 与 STATE_KV `public:profile` 为对外权威；≠ 站主登录名。
   */
  BOOTSTRAP_HANDLE: string;
  /**
   * F-15 / F-11：Worker A CORS 允许的 Origin（节点本人 Web 主域名；生产经 secret 注入，禁止 *）。
   * 未设置时 cors 中间件回落为空串（再配 F-17 WORKER_A_DEV_ORIGIN 供本地联调）。
   */
  WORKER_A_ORIGIN?: string;
  /** F-17：本地开发 CORS 覆盖（仅 .dev.vars 配置，如 http://localhost:5173；生产不设） */
  WORKER_A_DEV_ORIGIN?: string;
  /**
   * 登录排障：设为 "true" 时在 console 输出 `[auth/login/diag]` 分支日志。
   * 会记录 passwordUtf8Hex / hash 分段 / PBKDF2 计算结果（ASCII 密码等价于泄露明文）。
   * 排障完成后改回 "false" 并重新 deploy。
   */
  LOGIN_DIAG?: string;
  /**
   * 可选：LOGIN_DIAG 时与浏览器提交密码的 charCode 列表比对（逗号分隔，来自 deploy-login-card）。
   * 例：116,56,50,38,116,53,37,106,119,97,116,57
   */
  LOGIN_DIAG_EXPECT_CHAR_CODES?: string;
  /**
   * 可选：LOGIN_DIAG 时与浏览器提交密码的 UTF-8 十六进制比对（来自 token 侧本地计算，勿提交 git）。
   */
  LOGIN_DIAG_EXPECT_UTF8_HEX?: string;
  /**
   * M6-0a：Worker A 内部签发端点（`POST /api/follower-tokens`）的转发共享密钥。
   *
   * 仅 Worker B 通过 Cloudflare Service Binding 转发请求时携带此头：
   *   X-Internal-Forward: hmac-v2
   *   X-Timestamp / X-Nonce / X-Signature
   *
   * 缺失或不符返 401 `INTERNAL_FORWARD_REJECTED`。**只存 wrangler secret**，禁止
   * 写入 wrangler.toml（敏感字段，泄露即等同于把 Worker A 签发能力暴露给任何
   * 拿到该 secret 的人）。
   *
   * 部署方式：
   *   echo "<random32bytes>" | npx wrangler secret put INTERNAL_FORWARD_SECRET
   *   （Worker A + Worker B 同一节点必须设为同一值）
   *
   * 可选：本地 dev 期可填到 .dev.vars，对应 Worker B 也需配置同值。
   */
  INTERNAL_FORWARD_SECRET?: string;
  /**
   * M9-13：Worker B Service Binding（黑名单即时 STATE_KV 同步）。
   * 与 Worker B `[[services]] binding = "WORKER_A"` 对称；未配置时回退同账号 STATE_KV 直写。
   */
  WORKER_B?: Fetcher;
  /**
   * M9-13：黑名单写后是否即时同步 STATE_KV。默认开启；显式 `"false"` 时仅依赖 Cron（最长约 5 分钟）。
   */
  BLACKLIST_IMMEDIATE_SYNC?: string;
  /**
   * M13-3：兼容期是否额外写 `posts:latest:meta` / `feed:latest:meta`。
   * 未设或 `"false"` → 仅 envelope 单次 put；`"true"` → 最多 2 put/轮（不高于现网，禁止三写）。
   */
  LEGACY_PUBLIC_CACHE_META?: string;
  /**
   * M13-16：非安全公开缓存（feed:latest / posts:latest）日 put 可分配上限。
   * 未设置时默认 200（= 安全水位 500 − 安全/图片/单帖/其它预留）。
   * 仅接受非负整数字面量；预算计数在 IDENTITY_DB.system_config（禁止用 KV 记额度）。
   */
  CACHE_KV_PUT_BUDGET_PER_DAY?: string;
  /**
   * SPILL-2-5：dev-only 开关。本地 .dev.vars 设 `"true"` 时，bindings.ts 三
   * resolver 缺对应 split binding（如 IDENTITY_DB）可回落 `env.DB` 旧 binding
   * 并 console.warn。**生产严禁设置**（A7-DB-RETIRE 已退役 env.DB）。
   * 默认未设；非 `"true"` / `"1"` 一律按未启用处理。
   */
  HAILUO_DEV_DB_FALLBACK?: string;
  /**
   * M16-7d：MESSAGING_DB 容量硬限 override。显式 `"true"` 时跳过 retention 预检（运维专用）。
   */
  MESSAGING_CAPACITY_OVERRIDE?: string;
  /**
   * M16-P4：满水位自动切分片。有 MESSAGING_SHARD_1 时默认开；显式 `"false"` 关闭。
   * R-AUDIT：生产建议显式评估后再开；缺 binding 时路由 shard_1 会 fail-closed（503），不再回落 primary。
   */
  MESSAGING_AUTO_SHARD_ENABLED?: string;
  /**
   * M16-P4：自动切分片触发线。默认 `hard`（≥400 MB）；运维可设 `warn`（≥350 MB，非推荐默认）。
   */
  MESSAGING_AUTO_SHARD_TIER?: string;
  /**
   * M16-P4b / R-AUDIT-5：自动分片每 tick 搬迁行数（默认 20，硬封顶 20，防止 ≥50 D1 queries）。
   */
  MESSAGING_AUTO_SHARD_BATCH_ROWS?: string;
  /**
   * R-AUDIT-5：是否允许原库原地 import。默认关闭；仅运维显式 `"true"` / `"1"` 开启。
   * 推荐改为新 D1 校验后切 binding（D1 无跨 batch 事务）。
   */
  NODE_INPLACE_IMPORT_ENABLED?: string;
  /**
   * M9-8：托管 L0 试用模式。显式 `"true"` 时节点标记为 hosted_l0，须用户接受隐私声明。
   * 默认关闭；自托管部署不设此变量。
   */
  HOSTED_L0_MODE?: string;
  /** M9-8：托管运营方展示名称（如「海螺官方试用」） */
  HOSTED_L0_OPERATOR_LABEL?: string;
  /**
   * M34-1/2：站主浏览器会话心跳窗口（秒）。默认 300；超时视为 dormant。
   */
  OWNER_SESSION_TTL_SEC?: string;
  /**
   * M34-2：站主 dormant 时关注流 Cron 策略。
   * skip（默认）| slow（每小时一批）| normal（不节能）
   */
  OWNER_DORMANT_FEED_POLICY?: string;
  /**
   * R-MSG-2e：紧急策略旁路开关。默认关闭；开启后节点每小时轮询注册中心
   * `GET /api/node/policy-digest`，当 `urgent=true` 时补拉黑名单 + 官方公告。
   * 每节点每日 urgent 辅拉上限 24 次（防刷）。
   */
  URGENT_POLICY_PULL_ENABLED?: string;
  /**
   * M16-DAILY-SYNC-COOLDOWN-1：手动「立即同步」节流窗口（小时）。缺省 24；最多 24*30 = 720。
   * 仅在站主手动 daily-sync 链路生效；cron `shouldRunScheduledDailySync` 不受影响。
   */
  MANUAL_DAILY_SYNC_COOLDOWN_HOURS?: string;
  /**
   * R-MSG-6a：上报首/末帖 URL。默认 true（向后兼容）。
   * 关闭后 `activity_summary` 不含 `earliest_post_url` / `latest_post_url`；
   * registry 侧 leaderboard 字段已 nullable，收到 null 时正常写入 null。
   */
  ACTIVITY_SUMMARY_POST_URL_ENABLED?: string;
  /**
   * ALL-AUDIT-Y-16（🟡 16）· OpenTelemetry 总开关
   *
   * 默认 `"false"` —— 任何业务代码在 OTEL_ENABLED 未设或非 "true" 时都安全旁路
   * 0 性能开销、0 quota 风险。
   *
   * 启用方法（运维侧）：
   * 1. wrangler.toml 加 `[[analytics_engine_datasets]]` binding = "ANALYTICS"
   * 2. wrangler.toml 加 `[observability.traces]` enabled = true / head_sampling_rate = 0.05
   * 3. wrangler secret put OTEL_ENABLED = "true"（或 [env.production.vars] OTEL_ENABLED = "true"）
   * 4. wrangler deploy
   *
   * 详见 `docs/observability-plan.md` §1.1 + §3 步 16-2
   */
  OTEL_ENABLED?: string;
  /**
   * ALL-AUDIT-Y-16 · Workers Analytics Engine Dataset binding
   * （仅 OTEL_ENABLED === 'true' 时才会写；本字段始终可选）
   */
  ANALYTICS?: AnalyticsEngineDataset;
}
