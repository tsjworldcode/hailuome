// M-REFACTOR-1b：Worker A 客户端 DTO / 接口类型
import type { GroupMessageEnvelope, GroupSyncDown } from '@hailuo/shared-types';

export interface OwnerLoginResponse {
  readonly token: string;
  /** ISO 8601 */
  readonly expires_at: string;
  /** M2-1b：当前节点还未完成用户名+密码迁移（owner_credentials 表为空，走老 secret 回落路径）时为 true */
  readonly legacy_mode?: boolean;
  /** M8-7：默认 admin/admin 首次登录后须修改用户名与密码 */
  readonly must_change_credentials?: boolean;
  /** M34-1：浏览器会话 ID，供心跳 / 登出 */
  readonly session_id?: string;
}

/** M34-1 心跳响应 */
export interface OwnerSessionHeartbeatResponse {
  readonly session_id: string;
  readonly owner_engagement: 'active';
  readonly last_seen_at: string;
}

/** M34-1 登出响应 */
export interface OwnerLogoutResponse {
  readonly ended: boolean;
  readonly owner_engagement: 'active' | 'dormant';
}

/** M2-1b POST /auth/login 请求体（password_hash 由浏览器 derive 后传入）。 */
export interface OwnerLoginInput {
  readonly username?: string;
  /** 老 secret 回落路径 */
  readonly password?: string;
  /** 客户端 PBKDF2 完整 v1 字符串 */
  readonly passwordHash?: string;
  /** M12-1：第二步登录 6 位 TOTP */
  readonly totpCode?: string;
  /** M12-1：或一次性恢复码 */
  readonly recoveryCode?: string;
}

export interface OwnerTotpStatus {
  readonly enabled: boolean;
  readonly enabled_at: string | null;
  readonly recovery_codes_remaining: number;
}

export interface OwnerTotpSetupResponse {
  readonly secret_base32: string;
  readonly otpauth_url: string;
  readonly expires_at: string;
}

export interface OwnerTotpEnableResponse {
  readonly enabled: boolean;
  readonly recovery_codes: readonly string[];
}

export interface OwnerTotpDisableResponse {
  readonly enabled: boolean;
  readonly disabled_at: string;
}

export interface OwnerTotpRotateRecoveryResponse {
  readonly recovery_codes: readonly string[];
}

/** M2-1b POST /auth/change-password 请求体。 */
export interface OwnerChangePasswordInput {
  readonly oldPassword?: string;
  readonly newPassword?: string;
  readonly oldPasswordHash?: string;
  readonly newPasswordHash?: string;
  /** M8-7：默认 admin 首次改密时必填 */
  readonly newUsername?: string;
}

/** M2-1b POST /auth/change-password 响应体。 */
export interface OwnerChangePasswordResponse {
  /** 仅迁移路径下为 true（老 secret 首次换为 PBKDF2 hash） */
  readonly migrated_from_legacy?: boolean;
  /** 纯旋转路径返回 ISO 8601 */
  readonly rotated_at?: string;
  /** 首次改密且更换了登录用户名 */
  readonly username_changed_to?: string;
  /** M10-3：D1 存在包裹会话密钥时需浏览器 re-wrap */
  readonly requires_dm_key_rewrap?: boolean;
  /** M11-6：D1 存在私有记录包裹主密钥时需浏览器 re-wrap */
  readonly requires_notes_key_rewrap?: boolean;
  /** 存在 group_wrapped_keys 时需浏览器 re-wrap（漏做则发群消息失败） */
  readonly requires_group_key_rewrap?: boolean;
}

export interface OwnerProfile {
  readonly handle: string;
  /** 正式名 `handle@registry_id`（登记后有；侧栏/主页优先展示） */
  readonly handle_qualified?: string | null;
  readonly display_name: string;
  readonly bio: string;
  readonly worker_b_url: string;
  readonly avatar_key: string;
  readonly contact_email: string;
  readonly created_at: string;
  readonly pubkey: string;
  readonly dm_pubkey?: string;
  readonly registry_user_id: string;
  readonly pubkey_fingerprint: string;
  /** DID v2：`did:hailuo:<64hex>`（登记后落库；缺失时可按公钥派生） */
  readonly did_v2?: string;
  /** 是否已在注册中心完成登记（D1 users 表有记录） */
  readonly registered?: boolean;
  /** M8-7：仍为默认 admin/admin 时 true，前端应引导改密 */
  readonly must_change_credentials?: boolean;
  /** 本节点正在关注的用户数（D1 follows 表） */
  readonly following_count?: number;
  /** M7-31b：登记邮箱是否已通过 /certify 验码 */
  readonly email_verified?: boolean;
  /** M7-34：登记邮箱（站主私人数据，仅本人可见；登记后写入） */
  readonly registration_email?: string;
}

export interface OwnerProfileUpdateInput {
  readonly display_name: string;
  readonly bio: string;
  readonly avatar_key: string;
  readonly contact_email: string;
}

export interface RegistryRegisterCompleteInput {
  readonly handle: string;
  readonly display_name?: string;
  readonly email?: string;
  readonly emailVerifyToken?: string;
  readonly turnstileToken: string;
  /** 2026-09-27：移除 age_over_18 字段 */
  readonly terms_accepted: boolean;
  readonly terms_version?: string;
  readonly browserRelay?: {
    readonly phase: 'prepare' | 'precheck_result' | 'verify_result';
    readonly upstreamStatus?: number;
    readonly upstreamBody?: unknown;
  };
}

export interface RegistryRegisterRelay {
  readonly step: 'precheck' | 'verify';
  readonly registry_url: string;
  readonly path: string;
  readonly body: Record<string, unknown>;
}

export interface RegistryRegisterCompleteResponse {
  readonly handle: string;
  readonly display_name: string;
  readonly user_id: string;
  readonly message: string;
  /** M33-4：认证收件域（登记成功时由注册中心 verify 返回并本地持久化） */
  readonly cert_inbound_host?: string | null;
  readonly cert_inbound_address_example?: string | null;
  readonly cert_inbound_purpose?: string | null;
  readonly relay?: RegistryRegisterRelay;
}

/** M9-PH-BO-1：路径 D 邮件模板（Worker A 加密签名后返回） */
export interface BootstrapOutboundTemplateInput {
  readonly handle: string;
  readonly email: string;
  readonly display_name?: string;
  readonly terms_accepted: boolean;
  readonly terms_version?: string;
}

export interface BootstrapOutboundTemplateResponse {
  readonly to: string;
  readonly subject: string;
  readonly body: string;
  readonly challenge_id: string;
  readonly browser_nonce: string;
  readonly issued_at: string;
  readonly fingerprint_short: string;
  readonly tag8: string;
  readonly claim_token: string;
  readonly cert_inbound_host: string;
  readonly ttl_hint_minutes: number;
}

/** M7-29：注册中心登记合规档案（GET/PATCH registration-profile）。SPILL-1c：无人口学字段。HANDLE-SLIM：无 user_name。 */
export interface RegistrationProfile {
  readonly user_id: string;
  /** 本中心短名（无 `@`） */
  readonly handle_local: string;
  /** 对外正式名（主中心裸名 / 其它中心 local@regN） */
  readonly handle_qualified: string;
  readonly email: string | null;
  /** M7-41b：登记邮箱是否已通过注册中心认证；认证后设置页只读 */
  readonly email_verified?: boolean;
  readonly terms_version: string | null;
  readonly terms_accepted_at: string | null;
  readonly registered_at: string;
  readonly updated_at: string;
  /** M33-4：登记时钉死的认证收件域（本地 system_config，只读） */
  readonly cert_inbound_host?: string | null;
  readonly cert_inbound_address_example?: string | null;
  readonly cert_inbound_purpose?: string | null;
}

export type RegistrationProfileUpdateInput = {
  readonly email?: string | null;
};

/** M7-35 / M33-5 / M33-h6b：未认证清号提醒状态（注册中心 cert-purge-status）。 */
/** `reminder_level`：`none` | `overdue` | 命中阈值的十进制字符串（如 `"90"`）。 */
export type CertPurgeReminderLevel = 'none' | 'overdue' | string;

export interface CertPurgeStatus {
  readonly applicable: boolean;
  readonly email_verified: boolean;
  readonly email_status: string;
  readonly registered_at: string | null;
  readonly purge_at: string | null;
  readonly days_until_purge: number | null;
  readonly reminder_level: CertPurgeReminderLevel;
  /** M33-h6b：当前命中的提醒阈值（天）；none/overdue 为 null。 */
  readonly reminder_threshold_days: number | null;
  readonly policy: {
    readonly uncertified_purge_months: number;
    readonly handle_freeze_days: number;
    readonly purge_reminder_days: readonly number[];
  };
}

/** M7-36 / M33-6：认证页上下文（通道开关 + 海螺币 + 认证域）。 */
export interface CertificationContext {
  readonly email_verified: boolean;
  readonly email_status: string;
  readonly channel_a_enabled: boolean;
  readonly channel_b_enabled: boolean;
  readonly hailuo_coins: number;
  readonly esp_verify_coin_cost: number;
  readonly cert_inbound_host: string;
  readonly cert_inbound_address_example: string;
  readonly cert_inbound_purpose: string;
  readonly cert_inbound_token_ttl_hours?: number;
}

/** M7-36：通道 A 一次性收件地址。 */
export interface CertInboundAddressResult {
  readonly cert_inbound_host: string;
  readonly cert_inbound_address: string;
  readonly cert_inbound_address_example: string;
  readonly cert_inbound_purpose: string;
  readonly expires_at: string;
  readonly expires_in: number;
}

/** M7-36：通道 B ESP 发码结果。 */
export interface EspVerifyRequestResult {
  readonly email: string;
  readonly expires_in: number;
  readonly hailuo_coins: number;
  readonly spent: number;
  /** 注册中心：10 分钟内已有未用码，未再发信 */
  readonly already_sent?: boolean;
}

/** M7-31a：email-certify 成功响应 */
export interface EmailCertifyResult {
  readonly email_status: 'verified';
  readonly email_verified_at: string;
  readonly email_verified: true;
}

/** M7-30a：换域 precheck 成功响应 */
export interface UrlChangePrecheckResult {
  readonly url_change_id: string;
  readonly nonce: string;
  readonly expires_at: string;
  readonly new_node_url: string;
  readonly new_worker_b_url: string;
}

/** M7-30a：换域 confirm 成功响应 */
export interface UrlChangeConfirmResult {
  readonly user_id: string;
  readonly node_url: string;
  readonly worker_b_url: string;
  readonly changed_at: string;
}

/** M7-30f-5：换域宽限期 / outbox 进度 */
export interface UrlChangeStatusResult {
  readonly active: boolean;
  readonly url_change_id: string | null;
  readonly from_handle: string | null;
  readonly old_node_url: string | null;
  readonly new_node_url: string | null;
  readonly changed_at: string | null;
  readonly grace_until: string | null;
  readonly grace_active: boolean;
  readonly days_remaining: number | null;
  readonly old_route_reachable: boolean | null;
  readonly notify: {
    readonly total: number;
    readonly pending: number;
    readonly sent: number;
    readonly failed: number;
    readonly dead: number;
    readonly skipped: number;
  };
  readonly checklist: {
    readonly keep_old_route_required: boolean;
    readonly may_close_old_route: boolean;
  };
}

export interface RegistryAppendRegisterCompleteInput {
  readonly registryId: string;
  readonly turnstileToken: string;
  readonly email?: string;
  readonly emailVerifyToken?: string;
}

export interface RegistryAppendRegisterCompleteResponse {
  readonly registry_id: string;
  readonly registry_url: string;
  readonly handle: string;
  readonly display_name: string;
  readonly user_id: string;
  readonly message: string;
}

/**
 * `POST /api/posts` 响应中的本人帖子；与 `GET /api/local/posts` 列表项不同：
 * - 本类型用于「发帖即返回」场景，已在 Worker A 侧拼好 `image_urls`（前缀 `WORKER_B_URL`）。
 * - 列表场景请用 `LocalPost`，那边返回 raw `image_keys` 与 `deleted_at`，前端自己拼 URL。
 */
export interface OwnerPost {
  readonly id: string;
  readonly content: string;
  readonly sig: string;
  readonly created_at: string;
  readonly image_urls: readonly string[];
}

/** M9-1：POST /api/posts/repost 请求体 */
export interface RepostPostInput {
  readonly origin_node_url: string;
  readonly origin_post_id: string;
  readonly origin_author_handle?: string;
}

/** M9-1：POST /api/posts/repost 成功响应 data */
export interface RepostPostResponse {
  readonly id: string;
  readonly post_kind: 'repost';
  readonly repost_of: {
    readonly node_url: string;
    readonly post_id: string;
    readonly author_handle: string;
  };
  readonly sig: string;
  readonly created_at: string;
}

/**
 * `GET /api/local/posts` 列表项（M3-1a 站主直读 D1）。
 * 字段与 `docs/worker-a-api.md` L259 实装对齐：
 * - `image_keys`：raw key 数组（如 `"kv:img_xxx"` / `"r2:..."` / `"b2:..."`），前端用
 *   `PUBLIC_WORKER_B_URL` 拼出可访问 URL（与 Worker B `GET /posts` 拼法一致）。
 * - `deleted_at`：软删除时间（一般为 `null`，路由层已过滤掉 `deleted_at IS NOT NULL`）。
 *
 * 历史踩坑：M7-1 误把列表项类型也写为 `OwnerPost`（含 `image_urls`），M7-4 首次消费
 * `getMyPosts()` 时才暴露契约 mismatch，故拆分为独立类型。
 */
export interface LocalPost {
  readonly id: string;
  readonly content: string;
  readonly sig: string;
  readonly image_keys: readonly string[];
  readonly created_at: string;
  readonly deleted_at: string | null;
  /** M9-1：原创 / 纯转发 */
  readonly post_kind?: 'original' | 'repost';
  readonly repost_of?: {
    readonly node_url: string;
    readonly post_id: string;
    readonly author_handle: string;
  } | null;
}

export interface OwnerPostListResponse {
  readonly items: readonly LocalPost[];
  readonly next_cursor: string | null;
}

/** M14-10：站主直读 D1 feed_cache（与 Worker B GET /feed 字段对齐） */
export interface LocalFeedItem {
  readonly id: string;
  readonly node_url: string;
  readonly post_id: string;
  readonly content: string;
  readonly sig: string;
  readonly image_urls: readonly string[];
  readonly created_at: string;
  readonly author_handle?: string;
  readonly source_type?: 'official';
  /** M9-1-4：纯转发 */
  readonly post_kind?: 'original' | 'repost';
  readonly repost_of?: {
    readonly node_url: string;
    readonly post_id: string;
    readonly author_handle: string;
  } | null;
}

export interface LocalFeedListResponse {
  readonly items: readonly LocalFeedItem[];
  readonly has_more: boolean;
  readonly cursor: string | null;
}

export interface FollowItem {
  readonly id: string;
  readonly node_url: string;
  readonly handle: string;
  readonly display_name: string;
  readonly avatar_key: string;
  readonly worker_b_url: string;
  readonly user_id: string;
  readonly registry_status: string;
  readonly health_status: string;
  readonly pubkey_fingerprint: string;
  readonly followed_at: string;
  readonly last_active: string | null;
  readonly fail_count: number;
}

export interface FollowListResponse {
  readonly items: readonly FollowItem[];
  readonly total: number;
}

export interface FollowCreateResponse {
  readonly id: string;
  readonly node_url: string;
  readonly handle: string;
  readonly display_name: string;
  readonly avatar_key: string;
  readonly worker_b_url: string;
  readonly followed_at: string;
}

export interface FollowProfileInput {
  readonly handle?: string;
  readonly display_name?: string;
  readonly avatar_key?: string;
  readonly worker_b_url?: string;
  /** SEC-AUDIT-2026-10-13：权威 Ed25519 公钥（64 hex），写入 follows.followed_pubkey */
  readonly pubkey?: string;
}

export interface BlacklistItem {
  readonly node_url: string;
  readonly reason: string;
  readonly created_at: string;
}

export interface BlacklistListResponse {
  readonly items: readonly BlacklistItem[];
  readonly total: number;
}

export interface BlacklistCreateResponse {
  readonly node_url: string;
  readonly reason: string;
  readonly created_at: string;
}

export interface LookupResponse {
  readonly handle: string;
  readonly pubkey: string;
  readonly user_id?: string;
  readonly node_url?: string;
  readonly worker_b_url?: string | null;
  readonly dm_pubkey?: string | null;
  readonly registry_status?: string | null;
  readonly health_status?: string | null;
  readonly pubkey_fingerprint?: string;
}

/** DM-PEER-PUBKEY-1：本机 Worker A 服务端解析出的对端私信公钥（只两字段）。 */
export interface DmPeerPubkeyResponse {
  readonly dm_pubkey: string;
  readonly worker_b_url: string;
}

export interface MediaUsageAfterSnapshot {
  readonly bytes_used: number;
  readonly bytes_threshold: number | null;
}

export interface ImageUploadResponse {
  readonly key: string;
  readonly url: string;
  readonly storage: 'kv' | 'r2' | 'b2' | 'filebase';
  /** router 模式下上传成功后返回；manual 模式也可能带 */
  readonly size_bytes?: number;
  readonly usage_after?: MediaUsageAfterSnapshot;
}

export interface MessagingMediaUploadResponse {
  readonly storage_key: string;
  readonly backend: string;
  readonly size_bytes: number;
  readonly media_id: string;
}

export interface RegistryOfficialFeedStatus {
  readonly registry_url: string;
  readonly node_credentials_configured: boolean;
  readonly node_signature_configured: boolean;
  readonly last_status: string | null;
  readonly last_checked_at: string | null;
  readonly last_source_url: string | null;
  readonly last_fetched_count: number;
  readonly last_insert_count: number;
  readonly last_error: string | null;
  readonly cached_official_count: number;
  readonly latest_official_created_at: string | null;
}

/** M9-3-CL4：联邦诊断（无 peer 拓扑）。 */
export interface FederationDiagnostics {
  readonly home_registry_id: string | null;
  readonly endpoints_count: number;
  readonly endpoints_cap: number;
  readonly last_lookup: {
    readonly handle: string;
    readonly home_registry_id: string | null;
    readonly resolved_via_registry_id: string | null;
    readonly route_version: number | null;
    readonly route_stale: boolean | null;
    readonly error_code: string | null;
    readonly http_status: number;
    readonly at: string;
  } | null;
  readonly federated_blacklist: {
    readonly etag: string | null;
    readonly cert_epoch: number | null;
    readonly item_count: number | null;
    readonly updated_at: string | null;
    readonly enforce: boolean;
  };
}

/** 注册中心 presence + policy-digest 诊断（Settings 展示）。 */
export interface RegistryDailySyncDiagnostics {
  readonly last_success_at: string | null;
  readonly last_status: string | null;
  readonly last_error: string | null;
  /** M16-DAILY-SYNC-COOLDOWN-1：手动「立即同步」最近成功时间；与 cron 锚点独立。 */
  readonly last_manual_at: string | null;
  /** presence 间隔（日），默认 30 */
  readonly sync_interval_days?: number;
  readonly policy_poll?: {
    readonly last_status: string | null;
    readonly last_at: string | null;
    readonly last_error: string | null;
    readonly policy_etag: string | null;
    readonly policy_poll_interval_days: number;
  };
  readonly official_feed: RegistryOfficialFeedStatus;
  readonly blacklist: {
    readonly remote_etag: string | null;
    readonly last_sync_at: string | null;
  };
  readonly recommendations: {
    readonly last_checked_at: string | null;
    readonly last_status: string | null;
    readonly last_fetched_count: number;
    readonly last_error: string | null;
  };
  readonly endpoints: ReadonlyArray<{
    readonly registry_id: string;
    readonly status: string;
    readonly fail_streak: number;
    readonly consecutive_fail_days: number;
    readonly last_ok_at: string | null;
    readonly last_fail_at: string | null;
  }>;
  /** M9-3-CL4 */
  readonly federation?: FederationDiagnostics;
}

export interface PublicHealthProbeResult {
  readonly worker_b_url: string;
  readonly ok: boolean;
  readonly http_status: number | null;
  readonly latency_ms: number;
  readonly error: string | null;
  readonly checked_at: string;
}

export interface RegistryDailySyncRunResult {
  readonly message: string;
  readonly diagnostics: RegistryDailySyncDiagnostics;
}

export interface OperationLogItem {
  readonly id: string;
  readonly source: string;
  readonly level: 'debug' | 'info' | 'warn' | 'error' | string;
  readonly event: string;
  readonly message: string;
  readonly details: unknown;
  readonly created_at: string;
}

export interface OperationLogListResponse {
  readonly items: readonly OperationLogItem[];
}

export interface RegistryOfficialFeedPullResult {
  readonly fetched_count: number;
  readonly inserted_count: number;
  readonly remaining_today: number;
  readonly quota_date: string;
}

export interface FollowPullProbeItem {
  readonly fetch_url: string;
  readonly posts_url: string;
  readonly ok: boolean;
  readonly post_count: number;
  readonly error: string | null;
  readonly http_status: number | null;
  readonly response_url: string | null;
  readonly body_snippet: string | null;
  readonly token_retry: boolean;
}

export interface FollowPullProbeResult {
  readonly items: readonly FollowPullProbeItem[];
}

/** M34-2：站主分层在线 + 关注流自动同步状态 */
export type OwnerEngagementStatus = 'active' | 'dormant' | 'unknown';
/** M34-6：`floor` = dormant+skip 但已触发 24h 全量扫 */
export type FeedAutoSyncStatus = 'running' | 'paused' | 'slow' | 'floor';
export type OwnerDormantFeedPolicy = 'skip' | 'slow' | 'normal';

export interface OnlineStatusSnapshot {
  readonly owner_engagement: OwnerEngagementStatus;
  readonly owner_last_seen_at: string | null;
  readonly feed_auto_sync: FeedAutoSyncStatus;
  readonly feed_pull_last_ok_at: string | null;
  /** M34-6：上次全关注扫完（可空） */
  readonly feed_pull_cycle_ok_at?: string | null;
  /** M34-6：24h 地板扫尾进行中 */
  readonly feed_dormant_sweep_active?: boolean;
  readonly owner_dormant_feed_policy: OwnerDormantFeedPolicy;
}

/** M34-4：Settings 最近登录设备（无完整明文 IP；M34-4b 可含脱敏 ip_masked） */
export interface OwnerSessionListItem {
  readonly session_id: string;
  readonly created_at: string;
  readonly last_seen_at: string;
  readonly ended_at: string | null;
  readonly ip_country: string | null;
  /** M34-4b：脱敏 IP，如 203.0.113.* */
  readonly ip_masked: string | null;
  readonly user_agent_family: string | null;
  readonly channel: string;
  readonly is_current: boolean;
  readonly is_active: boolean;
  readonly can_revoke_jwt: boolean;
}

export interface OwnerSessionListResponse {
  readonly items: readonly OwnerSessionListItem[];
}

export interface OwnerSessionRevokeResult {
  readonly ended: boolean;
  readonly jwt_revoked: boolean;
  readonly is_current: boolean;
  readonly owner_engagement: OwnerEngagementStatus;
}

export interface FeedAggregateRunResult {
  readonly status: string;
  readonly fetched: number;
  readonly failed: number;
  readonly next_cursor: string | null;
  readonly kv_publish: 'skipped' | 'ok' | 'failed' | unknown;
}

export interface RegistryRecommendedUser {
  readonly user_id: string;
  readonly handle: string;
  readonly node_url: string;
  readonly worker_b_url: string;
  readonly health_status: string;
  readonly profile_status: string;
  readonly pubkey_fingerprint: string;
  readonly registered_at: string;
  readonly last_health_at: string | null;
  readonly reason: string;
  readonly fetched_at: string;
}

/** M17-4-2c：右栏「好友的好友」行（无邮箱/公钥/共同好友名单） */
export interface FofRecommendedUser {
  readonly handle: string;
  readonly node_url: string;
  readonly worker_b_url: string;
  readonly display_name: string;
  readonly mutual_count: number;
  readonly reason: 'friend_of_friend';
  readonly fetched_at: string;
}

export interface RegistryRecommendedUsersResponse {
  readonly items: readonly RegistryRecommendedUser[];
  readonly last_checked_at: string | null;
  readonly last_status: string | null;
  readonly last_error: string | null;
  readonly last_fetched_count: number;
  readonly next_refresh_after: string | null;
  /** M9-3-9：实际成功响应的注册中心 registry_id */
  readonly last_source_registry_id: string | null;
  /** M32-1：因已关注而从展示列表隐藏的条数 */
  readonly hidden_following_count: number;
  /** M32-1：过滤后实际展示的条数 */
  readonly displayed_count: number;
  /** M17-4-2c：官方推荐之后的 FoF（≤5） */
  readonly fof_items: readonly FofRecommendedUser[];
  readonly fof_last_refreshed_at: string | null;
  readonly fof_next_refresh_after: string | null;
}

export interface DmSendTicket {
  readonly sender_handle: string;
  readonly recipient_handle: string;
  readonly recipient_worker_b_url: string;
  readonly exp: number;
  readonly nonce: string;
  readonly sig: string;
}

export interface DmMessagingMediaSigned {
  readonly media_id: string;
  readonly sender_storage_key: string;
  readonly sender_worker_b_url: string;
  readonly size_bytes: number;
  readonly ciphertext_sha256: string;
  readonly alg: string;
}

export interface DmEnvelope {
  readonly v: 1;
  readonly conversation_id: string;
  readonly message_id: string;
  readonly sender_handle: string;
  readonly sender_worker_b_url: string;
  readonly recipient_handle: string;
  readonly created_at: string;
  readonly nonce: string;
  readonly key_epoch: number;
  readonly ephemeral_pubkey: string;
  readonly ciphertext: string;
  readonly aad_version: 1;
  readonly send_ticket: DmSendTicket;
  readonly media?: DmMessagingMediaSigned;
  readonly sig: string;
}

export interface DmMessageItem {
  readonly message_id: string;
  readonly conversation_id: string;
  readonly direction: 'inbox' | 'outbox';
  readonly peer_handle: string;
  readonly peer_worker_b_url: string;
  readonly envelope: DmEnvelope;
  readonly created_at: string;
  readonly read_at: string | null;
  readonly delivery_status: string;
}

export interface DmMessageListResponse {
  readonly items: readonly DmMessageItem[];
  readonly has_more: boolean;
  readonly cursor: string | null;
}

export interface DmWrappedKeyItem {
  readonly conversation_id: string;
  readonly key_epoch: number;
  readonly peer_handle: string;
  readonly wrapped_key_json: string;
  readonly updated_at: string;
}

export interface DmWrappedIdentityRecord {
  readonly owner_handle: string;
  readonly public_key_hex: string;
  readonly wrapped_identity_json: string;
  readonly updated_at: string;
}

/** M-VAULT-2：D1 owner_wrapped_vault 行（Worker 不解密） */
export interface OwnerWrappedVaultRecord {
  readonly wrapped_vault_json: string;
  readonly key_version: number;
  readonly updated_at: string;
}

export interface PrivateNoteAttachmentItem {
  readonly id: string;
  readonly storage: string;
  readonly mime: string;
  readonly size_bytes: number | null;
  readonly name: string | null;
  readonly created_at: string;
}

export interface PrivateNoteItem {
  readonly id: string;
  readonly content: string;
  readonly kind: string;
  readonly attachments: readonly PrivateNoteAttachmentItem[];
  readonly created_at: string;
  readonly updated_at: string;
}

export interface PrivateNoteListResponse {
  readonly items: readonly PrivateNoteItem[];
  readonly cursor: string | null;
  readonly has_more: boolean;
}

export interface PrivateNoteAttachmentUploadInput {
  readonly file: Blob;
  readonly name?: string;
}

export interface PrivateNotesExportAttachment extends PrivateNoteAttachmentItem {
  readonly note_id: string | null;
  readonly object_key: string;
  readonly deleted_at: string | null;
}

export interface PrivateNotesExportNote {
  readonly id: string;
  readonly content: string;
  readonly kind: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly deleted_at: string | null;
}

export interface PrivateNotesExportSnapshot {
  readonly meta: {
    readonly schema_version: 1;
    readonly exported_at: string;
    readonly attachments_included: false;
    readonly counts: {
      readonly notes: number;
      readonly attachments: number;
    };
  };
  readonly notes: readonly PrivateNotesExportNote[];
  readonly attachments: readonly PrivateNotesExportAttachment[];
}

export interface PrivateNotesImportResult {
  readonly imported_notes: number;
  readonly skipped_notes: number;
  readonly imported_attachments: number;
  readonly skipped_attachments: number;
  readonly attachments_included: false;
}

export interface PrivateNotesWrappedKeyState {
  readonly enabled: boolean;
  readonly key_epoch?: number;
  readonly wrapped_key_json?: string;
  readonly updated_at?: string;
}

export interface PrivateNotesWrappedKeyPutInput {
  readonly wrapped_key_json: string;
  readonly key_epoch: number;
}

/** M16-4d：本节点已加入群（GET /api/groups/local）。 */
export interface LocalGroupItem {
  readonly group_id: string;
  readonly name: string;
  readonly announcement: string | null;
  readonly owner_worker_b_url: string;
  readonly epoch: number;
  readonly tree_id: number;
  readonly dissolved_at: string | null;
  readonly role: string;
  readonly key_state: string;
  readonly status: string;
  readonly sync_tier: string | null;
  readonly local_retention_days: number | null;
  /** 在册人数（active + pending）。旧接口可能缺省。 */
  readonly member_count?: number | null;
  /**
   * REL-FIX-5：待审批入群申请数（仅本机为群主时 > 0）。
   * 入群 pending 行只落群主库 → 成员节点恒为 0；跨节点管理员待审批列表走 REL-FIX-6 按需代理拉取。
   * 仅供 UI 角标显示**数量**，不含申请人 handle / URL（防身份关联）。
   */
  readonly pending_join_count?: number | null;
  /** 群默认：需群主同意才入群（仅权威库有值；成员侧可能缺省） */
  readonly join_requires_approval?: number | boolean | null;
  /** M16-JOIN-POLICY：closed | approval | open */
  readonly join_policy?: 'closed' | 'approval' | 'open' | string | null;
  /** M16-GROUP-MOD：1/true=仅群主与管理员可发言 */
  readonly members_muted?: number | boolean | null;
  /** M16-GROUP-MOD：本节点是否群管理（群主行通常为 false） */
  readonly is_admin?: number | boolean | null;
  /** EPOCH-UX-1：踢人隔绝后待真换钥；旧 epoch 仍可发信直至 rekey-commit */
  readonly rekey_scheduled?: number | boolean | null;
  /** EPOCH-UX-1：仅主/管 — 留下 active 人数（密封分母） */
  readonly rekey_members_total?: number | null;
  /** EPOCH-UX-1：仅主/管 — 已登记 member_dh_pubkey 的 active 数 */
  readonly rekey_dh_ready?: number | null;
  /** EPOCH-UX-1：仅主/管 — 下一 epoch 已有非空 wrap 的 active 数 */
  readonly rekey_wraps_ready?: number | null;
}

export type GroupJoinPolicy = 'closed' | 'approval' | 'open';

export interface GroupJoinRequestItem {
  readonly member_worker_b_url: string;
  readonly member_handle: string;
  readonly member_pubkey: string;
  readonly key_state: string;
  readonly joined_at: string;
}

export interface GroupMemberItem {
  readonly member_worker_b_url: string;
  readonly member_handle: string;
  readonly role: string;
  readonly is_admin: boolean;
  readonly status: string;
  readonly key_state: string;
  readonly joined_at: string;
  /** REKEY-2：X25519 raw hex；未登记则为 null */
  readonly member_dh_pubkey?: string | null;
}

export interface LocalGroupListResponse {
  readonly items: readonly LocalGroupItem[];
}

export interface GroupCreateResponse {
  readonly group_id: string;
  readonly name: string;
  readonly announcement: string | null;
  readonly owner_worker_b_url: string;
  readonly epoch: number;
  readonly tree_id: number;
  readonly created_at: string;
  readonly message_shard_id?: 'primary' | 'shard_1' | string;
  readonly join_policy?: string;
  /** OWNER-KEY-2：建群时服务端已写入持钥表 */
  readonly owner_key_held?: boolean;
  /**
   * OWNER-KEY-2：仅建群响应一次性下发（群主 JWT）；用于本机 vault wrap。
   * 禁止写入长期存储 / 日志。
   */
  readonly group_key_hex?: string;
  readonly key_fingerprint?: string;
}

/** OWNER-KEY-2：持钥表元数据（无明文） */
export interface GroupOwnerEpochKeyStatus {
  readonly group_id: string;
  readonly epoch: number;
  readonly held: boolean;
  readonly key_fingerprint: string | null;
  readonly updated_at: string | null;
}

export interface GroupOwnerEpochKeyPutResult {
  readonly group_id: string;
  readonly epoch: number;
  readonly key_fingerprint: string;
  readonly created: boolean;
}

/** OWNER-KEY-4：批量代封 pending_key 结果 */
export interface GroupOwnerSealPendingResult {
  readonly group_id: string;
  readonly epoch: number;
  readonly sealed: number;
  readonly skipped_no_dh: number;
  readonly failed: number;
  readonly remaining_pending_key: number;
  readonly batch_limit: number;
}

/** OWNER-KEY-5：服务端换钥（生成 next + 分批代封 + 齐备后可选 commit） */
export interface GroupOwnerRekeyResult {
  readonly group_id: string;
  readonly previous_epoch: number;
  readonly next_epoch: number;
  readonly key_fingerprint: string;
  readonly sealed: number;
  readonly deferred_count: number;
  /** 仍缺同源 wrap 的 sealable 人数；>0 时须继续轮询 owner-rekey */
  readonly remaining_unsealed: number;
  readonly committed: boolean;
  readonly new_epoch: number | null;
  readonly rekey_scheduled: boolean;
  readonly wrapped_count: number;
  readonly batch_limit: number;
}

export interface GroupInviteCreateOptions {
  /** 白名单：7 / 30 / 365 / 3650；缺省 7 */
  readonly ttl_days?: 7 | 30 | 365 | 3650;
  /** 是否需群主同意；缺省由服务端读群默认 */
  readonly requires_approval?: boolean;
}

export interface GroupInviteCreateResponse {
  readonly group_id: string;
  readonly group_name?: string;
  readonly owner_worker_b_url: string;
  readonly invite_token: string;
  /** M16-INVITE-SHORT：8 位分享短码；缺省时前端回落 #i/ 长链 */
  readonly invite_code?: string;
  readonly expires_at: string;
  readonly requires_approval?: boolean;
  readonly ttl_days?: number;
}

export interface GroupInviteAcceptResponse {
  readonly group_id: string;
  readonly epoch: number;
  readonly tree_id: number;
  readonly name: string;
  readonly owner_worker_b_url: string;
  /** active=已入群；pending=等待群主同意（LIFE-3） */
  readonly membership_status?: 'active' | 'pending';
  /** JOIN-POLICY-2 按群号加入时带回 */
  readonly join_policy?: GroupJoinPolicy | string;
}

/** M16-4f：退出群聊响应。 */
export interface GroupLeaveResponse {
  readonly group_id: string;
  readonly status: string;
  readonly left_at: string;
}

/** M16-7a：群主解散群响应。 */
export interface GroupDissolveResponse {
  readonly group_id: string;
  readonly dissolved_at: string;
}

/** M16-4f：本节点群本地设置响应。 */
export interface GroupLocalSettingsResponse {
  readonly group_id: string;
  readonly local_retention_days: number;
  readonly sync_tier: string;
}

/** M16-7d + M16-P4c/e：MESSAGING_DB 容量粗算与自动分片可观测。 */
export interface MessagingDbCapacityResponse {
  readonly estimated_bytes: number;
  readonly estimated_mb: number;
  readonly tier: 'normal' | 'warn' | 'hard';
  readonly total_estimated_bytes: number;
  readonly total_estimated_mb: number;
  readonly total_tier: 'normal' | 'warn' | 'hard';
  readonly warn_threshold_mb: number;
  readonly hard_threshold_mb: number;
  readonly limit_mb: number;
  readonly capacity_override: boolean;
  readonly shard_available: boolean;
  readonly shard_routed_groups: number;
  readonly auto_shard_enabled: boolean;
  readonly auto_shard_tier_trigger: 'hard' | 'warn';
  readonly auto_shard_last_migrated_group_id: string | null;
  readonly auto_shard_last_migrated_at: string | null;
  readonly auto_shard_pending_groups_on_primary: number;
  readonly auto_shard_last_error: string | null;
  readonly auto_shard_last_error_at: string | null;
  readonly breakdown: {
    readonly dm_message_bytes: number;
    readonly group_member_message_bytes: number;
    readonly group_owner_message_bytes: number;
    readonly group_member_message_bytes_primary: number;
    readonly group_owner_message_bytes_primary: number;
    readonly media_local_bytes: number;
    readonly fixed_overhead_bytes: number;
    readonly index_overhead_factor: number;
  };
}

export interface GroupLocalMessageItem {
  readonly message_id: string;
  readonly group_id: string;
  readonly epoch: number;
  readonly sender_worker_b_url: string;
  readonly sender_handle: string;
  readonly msg_kind: string;
  readonly ciphertext: string;
  readonly created_at: string;
  readonly media?: DmMessagingMediaSigned;
}

export interface GroupLocalMeta {
  readonly group_id: string;
  readonly name: string;
  readonly announcement: string | null;
  readonly owner_worker_b_url: string;
  readonly epoch: number;
  readonly tree_id: number;
  readonly dissolved_at: string | null;
  readonly members_muted?: boolean | number | null;
  readonly role: string;
  readonly is_admin?: boolean | number | null;
  readonly key_state: string;
  readonly status: string;
  readonly sync_tier: string;
  readonly sync_cursor: string | null;
  readonly local_retention_days: number;
  readonly last_sync_at: string | null;
}

export interface GroupLocalMessagesResponse {
  readonly group: GroupLocalMeta;
  readonly items: readonly GroupLocalMessageItem[];
  readonly has_more: boolean;
  readonly cursor: string | null;
}

export interface GroupWrappedKeyItem {
  readonly epoch: number;
  readonly member_worker_b_url: string;
  readonly wrapped_key_json: string;
  readonly updated_at: string;
}

export interface GroupSendMessageResponse {
  readonly message_id: string;
  readonly duplicate?: boolean;
  readonly outbox_state?: string;
}

// =====================================================================
// 客户端构造
// =====================================================================

export interface WorkerAClientOptions {
  /** Worker A 基址；调用方运行时注入（§F-02：不读 env / localStorage） */
  readonly baseUrl: string;
  /**
   * JWT 取回回调；返回 null 表示未登录，请求会直接抛 UNAUTHORIZED。
   * 调用方通常传 `() => getOwnerJwt()`。
   */
  readonly getJwt: () => string | null;
  /** 可选 fetch 注入，测试时使用 */
  readonly fetchFn?: typeof fetch;
}

export interface FollowerTokenModeSetting {
  readonly mode: import('@hailuo/shared-types').FollowerTokenMode;
  /** program = SEC-AUDIT-ENFORCED-FORCE-1 程序恒强制，不可 PATCH */
  readonly source: 'd1' | 'env' | 'program';
}

export interface MediaStorageB2PublicConfig {
  readonly key_id: string;
  readonly app_key_set: boolean;
  readonly bucket_name: string;
  readonly endpoint: string;
  readonly region?: string;
}

export type MediaStorageFilebasePublicConfig = MediaStorageB2PublicConfig;

export interface MediaStorageUsageEntry {
  readonly configured: boolean;
  readonly bytes_used: number;
  readonly bytes_limit: number | null;
  readonly bytes_buffer: number;
  readonly bytes_threshold: number | null;
  readonly percent_of_threshold: number | null;
  readonly object_count: number;
  readonly last_calibrated_at: string | null;
  readonly status: 'ok' | 'warn' | 'full' | 'unconfigured';
}

export interface MediaStorageSetting {
  readonly mode?: 'router' | 'manual';
  readonly write_priority?: readonly string[];
  readonly active_write_backend?: 'filebase' | 'b2' | 'r2' | 'kv';
  readonly backend: 'kv' | 'b2' | 'filebase' | 'r2';
  readonly b2: MediaStorageB2PublicConfig | null;
  readonly filebase: MediaStorageFilebasePublicConfig | null;
  readonly usage?: {
    /** M8-14-10：IMAGE_KV 自记账用量（软上限约 1 GiB） */
    readonly kv?: MediaStorageUsageEntry;
    readonly filebase?: MediaStorageUsageEntry;
    readonly b2?: MediaStorageUsageEntry;
    readonly r2?: MediaStorageUsageEntry;
  };
  readonly probe_status: string;
  readonly b2_probe_status?: string;
  readonly filebase_probe_status?: string;
  readonly updated_at: string | null;
  /** M8-14-9：R2 是否已绑定（env.HAILUO_IMAGE_R2 存在） */
  readonly r2_bound: boolean;
  /** M8-14-9：当前阈值配置 */
  readonly thresholds?: {
    readonly kv_high_watermark: number;        // 0.01~0.99，默认 0.90
    readonly kv_preferred_max_bytes: number; // 字节数，默认 10 MiB
    readonly r2_high_watermark: number;      // 0.01~0.99，默认 0.90
    readonly r2_target_watermark: number;   // 0.01~0.99，默认 0.70
  };
}

export interface MediaStoragePatchInput {
  readonly mode?: 'router' | 'manual';
  readonly backend?: 'kv' | 'b2' | 'filebase';
  readonly b2?: {
    readonly key_id: string;
    readonly app_key?: string;
    readonly bucket_name: string;
    readonly endpoint: string;
    readonly region?: string;
  };
  readonly filebase?: {
    readonly key_id: string;
    readonly app_key?: string;
    readonly bucket_name: string;
    readonly endpoint: string;
    readonly region?: string;
  };
  readonly clear_b2?: boolean;
  readonly clear_filebase?: boolean;
  readonly recalibrate_filebase?: boolean;
  readonly recalibrate_b2?: boolean;
  readonly recalibrate_r2?: boolean;
  /** M8-14-10b：列举 IMAGE_KV 校准 KV 自记账 */
  readonly recalibrate_kv?: boolean;
  /** M8-14-10c：清理无帖引用的 kv: 孤儿图 */
  readonly gc_orphan_kv?: boolean;
  readonly backfill_usage?: boolean;
  /** M8-14-9：阈值配置 */
  readonly thresholds?: {
    readonly kv_high_watermark?: number;
    readonly kv_preferred_max_bytes?: number;
    readonly r2_high_watermark?: number;
    readonly r2_target_watermark?: number;
  };
}

export interface WorkerAClient {
  // ── 鉴权 ────────────────────────────────────────────────────────
  /**
   * M2-1b：登录，返回的 token 由调用方保存（一般写入 sessionStorage）。
   *
   * 该接口同时兼容两种入参形式以避免多个调用点一起改：
   *   - {OwnerLoginInput} `{ username, password }`（新路径，节点已运行 owner-bootstrap）
   *   - {string} `secret`（老路径，Worker A `owner_credentials` 表未初始化仅 fallback）
   * 老路径仅为过渡，Worker A 会在 response 里返 `legacy_mode=true` 提示前端提醒用户迁移。
   */
  login(input: OwnerLoginInput | string): Promise<OwnerLoginResponse>;
  /** M34-1：站主会话心跳 */
  sessionHeartbeat(input?: { sessionId?: string }): Promise<OwnerSessionHeartbeatResponse>;
  /** M34-1：结束浏览器会话（best-effort） */
  logout(input?: { sessionId?: string }): Promise<OwnerLogoutResponse>;
  /** 取当前登录所有者信息（需 JWT） */
  getMe(): Promise<OwnerProfile>;
  /** 更新站主公开资料（昵称、简介、头像、公开联系邮箱） */
  updateProfile(input: OwnerProfileUpdateInput): Promise<OwnerProfile>;
  /** M2-1b：修改当前账号密码（需 JWT + 旧密码二次验证） */
  changePassword(input: OwnerChangePasswordInput): Promise<OwnerChangePasswordResponse>;
  /** M12-1：TOTP 状态 */
  getTotpStatus(): Promise<OwnerTotpStatus>;
  setupTotp(passwordHash: string): Promise<OwnerTotpSetupResponse>;
  enableTotp(input: { passwordHash: string; totpCode: string }): Promise<OwnerTotpEnableResponse>;
  disableTotp(input: { passwordHash: string; totpCode?: string; recoveryCode?: string }): Promise<OwnerTotpDisableResponse>;
  rotateTotpRecoveryCodes(input: {
    passwordHash: string;
    totpCode?: string;
    recoveryCode?: string;
  }): Promise<OwnerTotpRotateRecoveryResponse>;

  // ── 注册中心 ────────────────────────────────────────────────────
  /** 向注册邮箱发送 6 位验证码 */
  requestEmailVerify(email: string): Promise<void>;
  /** 校验验证码，换取 email_verify_token */
  confirmEmailVerify(email: string, code: string): Promise<{ emailVerifyToken: string }>;
  /** 完成注册中心登记（JWT + 服务端签名 challenge） */
  completeRegistryRegister(input: RegistryRegisterCompleteInput): Promise<RegistryRegisterCompleteResponse>;
  completeRegistryAppendRegister(
    input: RegistryAppendRegisterCompleteInput,
  ): Promise<RegistryAppendRegisterCompleteResponse>;
  /** M9-PH-BO-1：路径 D 邮件模板（Worker A 持钥加密） */
  buildBootstrapOutboundTemplate(
    input: BootstrapOutboundTemplateInput,
  ): Promise<BootstrapOutboundTemplateResponse>;
  /** 入口公开地址列表。浏览器自己去拉，不带浏览器地址字段。 */
  fetchBootstrapTargets(): Promise<string[]>;
  /** 把浏览器验过签的入口原文交给节点再验。 */
  submitBootstrapIntake(input: {
    manifest: string;
    avoidRegistryId?: string;
  }): Promise<{ registry_id: string; registry_url: string }>;

  // ── 帖子 ────────────────────────────────────────────────────────
  /** 取本人帖子（站主直读 D1，per M3-站主直读路径） */
  getMyPosts(params?: { before?: string }): Promise<OwnerPostListResponse>;
  /** M14-10：取关注流（站主直读 D1 feed_cache，protected 档 Following 用） */
  getLocalFeed(params?: { cursor?: string; limit?: number }): Promise<LocalFeedListResponse>;
  /** 发帖；返回完整帖子 */
  createPost(input: { content: string; images?: readonly string[] }): Promise<OwnerPost>;
  /** M9-1：纯转发（只存原帖引用） */
  repostPost(input: RepostPostInput): Promise<RepostPostResponse>;
  /** 软删除帖子 */
  deletePost(id: string): Promise<void>;

  // ── 关注 ────────────────────────────────────────────────────────
  listFollows(): Promise<FollowListResponse>;
  createFollow(nodeUrl: string, profile?: FollowProfileInput): Promise<FollowCreateResponse>;
  deleteFollow(nodeUrl: string): Promise<void>;

  /** 读取 / 切换 Worker B 粉丝 Token 强制校验模式（D1 → STATE_KV） */
  getFollowerTokenMode(): Promise<FollowerTokenModeSetting>;
  setFollowerTokenMode(
    mode: import('@hailuo/shared-types').FollowerTokenMode,
  ): Promise<FollowerTokenModeSetting>;
  createReadMutualProof(input: {
    owner_worker_b_url: string;
    owner_handle?: string;
  }): Promise<{ proof: import('@hailuo/shared-types').ReadMutualProof }>;

  /** M5-B2：媒体存储 backend（KV / B2）与 B2 私有桶配置 */
  getMediaStorageSetting(): Promise<MediaStorageSetting>;
  setMediaStorageSetting(input: MediaStoragePatchInput): Promise<MediaStorageSetting>;

  // ── 黑名单 ──────────────────────────────────────────────────────
  listBlacklist(): Promise<BlacklistListResponse>;
  createBlacklist(input: { nodeUrl: string; reason?: string }): Promise<BlacklistCreateResponse>;
  deleteBlacklist(nodeUrl: string): Promise<void>;

  // ── 查询 / 图片 ─────────────────────────────────────────────────
  /** 查询其他节点资料（通过注册中心代理 / 本地缓存） */
  lookup(handle: string): Promise<LookupResponse>;
  /**
   * DM-PEER-PUBKEY-1：由本机 Worker A 服务端去对端 `/users/:handle` 取 `dm_pubkey`。
   * 浏览器不再直接跨域访问对端 Worker B，绕开 workers.dev 网络阻断与 CORS。
   */
  getDmPeerPubkey(handle: string, nodeUrl?: string): Promise<DmPeerPubkeyResponse>;
  /**
   * 上传图片或媒体；body 为原始二进制（File / Blob / ArrayBuffer），
   * Content-Type 必填；浏览器会自行处理 Content-Length，前端不可手动设置受限请求头。
   */
  uploadImage(input: {
    body: Blob | ArrayBuffer | ReadableStream<Uint8Array>;
    contentType: string;
    contentLength?: number;
  }): Promise<ImageUploadResponse>;

  // ── 运维诊断 ───────────────────────────────────────────────────────
  getRegistryOfficialFeedStatus(): Promise<RegistryOfficialFeedStatus>;
  /** M-DS-2a：读取上次日同步与各块摘要。 */
  getRegistryDailySyncStatus(): Promise<RegistryDailySyncDiagnostics>;
  /** M-DS-2 联调：站主手动触发一次 daily-sync。 */
  runRegistryDailySync(): Promise<RegistryDailySyncRunResult>;
  /** M-DS-3：自测 Worker B 公开 /health。 */
  probePublicHealth(): Promise<PublicHealthProbeResult>;
  pullRegistryOfficialFeedNow(): Promise<RegistryOfficialFeedPullResult>;
  probeFollowNodePulls(): Promise<FollowPullProbeResult>;
  /** M34-2：站主参与度与关注流自动同步是否暂停 */
  getOnlineStatus(): Promise<OnlineStatusSnapshot>;
  /** M34-2：手动跑一轮关注流聚合（绕过 dormant skip） */
  runFeedAggregateNow(): Promise<FeedAggregateRunResult>;
  /** M34-4：最近登录设备列表 */
  listOwnerSessions(input?: { limit?: number }): Promise<OwnerSessionListResponse>;
  /** M34-4：注销指定会话（可踢掉其它设备 JWT） */
  revokeOwnerSession(sessionId: string): Promise<OwnerSessionRevokeResult>;
  getRegistryRecommendedUsers(): Promise<RegistryRecommendedUsersResponse>;
  /** M7-29b/c：读取/更新注册中心登记合规档案 */
  getRegistrationProfile(): Promise<RegistrationProfile>;
  updateRegistrationProfile(input: RegistrationProfileUpdateInput): Promise<RegistrationProfile>;
  /** M7-31a：登记邮箱验码认证 */
  certifyEmail(input: { email: string; emailVerifyToken: string }): Promise<EmailCertifyResult>;
  /** M7-35：未认证清号提醒状态 */
  getCertPurgeStatus(): Promise<CertPurgeStatus>;
  /** M7-36：认证页上下文 */
  getCertificationContext(): Promise<CertificationContext>;
  /** M7-36：通道 A 签发收件地址 */
  issueCertInboundAddress(): Promise<CertInboundAddressResult>;
  /** M7-36：通道 B ESP 发码（扣海螺币） */
  requestEspVerify(options?: { readonly request_id?: string }): Promise<EspVerifyRequestResult>;
  /** R-MSG-1b：自助轮换注册中心 node_api_token（本地落盘；响应仅 display） */
  rotateRegistryToken(): Promise<{
    user_id: string | null;
    node_api_token_display: string;
    rotated_at: string;
  }>;
  /** M7-30a：换域 precheck（代理注册中心 + 写入 url_change proof KV） */
  precheckUrlChange(input: {
    newNodeUrl: string;
    newWorkerBUrl: string;
  }): Promise<UrlChangePrecheckResult>;
  /** M7-30a/b + M7-30f-1：换域 confirm（nonce 代签 + step_up） */
  confirmUrlChange(input: {
    urlChangeId: string;
    nonce: string;
    passwordHash: string;
    totpCode?: string;
  }): Promise<UrlChangeConfirmResult>;
  /** M7-30f-5：换域宽限期与联系人推送进度 */
  getUrlChangeStatus(options?: { probeOld?: boolean }): Promise<UrlChangeStatusResult>;
  listOperationLogs(params?: { limit?: number; source?: string }): Promise<OperationLogListResponse>;
  cleanupOperationLogs(): Promise<{ deleted: number }>;

  /** M9-19：站主 JWT 签发跨节点互动 envelope */
  signInteractionEnvelope(input: InteractionSignEnvelopeInput): Promise<InteractionEnvelope>;

  /** M9-20：站主互动通知（轮询） */
  listNotifications(params?: { limit?: number; before?: string }): Promise<LocalNotificationListResponse>;
  markNotificationsRead(ids?: readonly string[]): Promise<{ marked: number; unread_count: number }>;

  /** M17-2：加好友 */
  listFriendRequests(params?: {
    direction?: 'incoming' | 'outgoing';
    /**
     * REL-FIX-11：新增 `resolved` —— **已处理但回执未确认送达对方**
     * （仅 `direction=incoming` 有效；outgoing 传它后端返 400）。
     */
    status?: 'pending' | 'accepted' | 'rejected' | 'cancelled' | 'expired' | 'all' | 'resolved';
    limit?: number;
    cursor?: string;
  }): Promise<FriendRequestListResponse>;
  sendFriendRequest(input: {
    target_node_url: string;
    target_handle: string;
    message?: string;
  }): Promise<FriendRequestSendResult>;
  acceptFriendRequest(id: string): Promise<{ id: string; status: string }>;
  rejectFriendRequest(id: string, reason?: string): Promise<{ id: string; status: string }>;
  cancelFriendRequest(id: string): Promise<void>;
  getFriendRequestsSetting(): Promise<FriendRequestSetting>;
  setFriendRequestsSetting(allowIncoming: boolean): Promise<FriendRequestSetting>;
  listMutualFollows(): Promise<MutualFollowListResponse>;

  /** M10-2：私信密文投递低层接口，UI 与浏览器加密层在 M10-4 接入。 */
  setDmPubkey(dmPubkey: string): Promise<{ dm_pubkey: string }>;
  issueDmSendTicket(input: { recipient_handle: string; recipient_worker_b_url: string }): Promise<DmSendTicket>;
  /**
   * DM-PEER-PUBKEY-1：由本机 Worker A 服务端转发到收件节点 Worker B `/dm/inbox`。
   * 浏览器不再直连对端 workers.dev；envelope 仍是发送方 Worker A 签好的原文。
   */
  deliverDmEnvelope(recipientWorkerBUrl: string, envelope: DmEnvelope): Promise<{ message_id: string }>;
  /** MSG-FIX-2：`delivery_status` 默认 pending；投递成功写 sent。 */
  saveDmOutbox(
    envelope: DmEnvelope,
    opts?: { delivery_status?: 'pending' | 'sent' | 'failed' },
  ): Promise<{ message_id: string; delivery_status: string }>;
  /** MSG-FIX-2：按 message_id 取回本机出件箱 envelope（同信封重试）。 */
  getDmOutboxMessage(messageId: string): Promise<DmMessageItem>;
  /** MSG-FIX-2：仅更新投递态。 */
  patchDmOutboxDeliveryStatus(
    messageId: string,
    deliveryStatus: 'pending' | 'sent' | 'failed',
  ): Promise<{ message_id: string; delivery_status: string }>;
  listDmInbox(params?: { limit?: number; cursor?: string }): Promise<DmMessageListResponse>;
  listDmOutbox(params?: { limit?: number; cursor?: string }): Promise<DmMessageListResponse>;
  listDmWrappedKeys(): Promise<{ items: readonly DmWrappedKeyItem[] }>;
  putDmWrappedKey(input: {
    conversation_id: string;
    key_epoch?: number;
    peer_handle: string;
    wrapped_key_json: string | Record<string, unknown>;
  }): Promise<{ conversation_id: string; key_epoch: number }>;
  /** M10-5c：登录 hydrate 读取 D1 包裹身份私钥。 */
  getDmWrappedIdentity(): Promise<DmWrappedIdentityRecord | null>;
  putDmWrappedIdentity(input: {
    public_key_hex: string;
    wrapped_identity_json: string;
  }): Promise<{ owner_handle: string; public_key_hex: string; updated_at: string }>;
  /** M-VAULT-2：读取/写入保险箱外层包裹；无行时 GET 客户端返回 null。 */
  getOwnerWrappedVault(): Promise<OwnerWrappedVaultRecord | null>;
  putOwnerWrappedVault(input: {
    wrapped_vault_json: string;
    key_version?: number;
  }): Promise<OwnerWrappedVaultRecord>;
  /** M10-3：收件箱未读数（红点轮询）。 */
  getDmUnreadCount(): Promise<{ unread_count: number }>;
  markDmMessageRead(messageId: string): Promise<{ message_id: string; read_at: string }>;
  deleteDmMessage(messageId: string): Promise<{ message_id: string; deleted: boolean }>;
  deleteDmConversation(conversationId: string): Promise<{ conversation_id: string; deleted_messages: number }>;
  /** M10-5b：合并导入备份中的 dm_messages 副本（INSERT OR IGNORE）。 */
  importDmMessages(
    items: readonly {
      message_id: string;
      conversation_id: string;
      direction: 'inbox' | 'outbox';
      peer_handle: string;
      peer_worker_b_url: string;
      envelope_json: string;
      created_at: string;
      read_at: string | null;
      delivery_status: string;
    }[],
  ): Promise<{ inserted: number; skipped: number; invalid: number; errors: readonly string[] }>;
  signDmEnvelope(envelope: Omit<DmEnvelope, 'sig'> & { ciphertext: string }): Promise<DmEnvelope>;
  /** MM-4：Messaging Media 密文上传（purpose=dm|group）。 */
  uploadMessagingMedia(input: {
    purpose: 'dm' | 'group';
    plainMime: string;
    mediaId?: string;
    body: Blob | ArrayBuffer | Uint8Array;
  }): Promise<MessagingMediaUploadResponse>;
  fetchMessagingMediaByStorageKey(storageKey: string): Promise<ArrayBuffer>;
  fetchMessagingMediaProxy(input: {
    message_id: string;
    media_id: string;
    conversation_id?: string;
    group_id?: string;
  }): Promise<ArrayBuffer>;
  getMessagingCloudCapability(): Promise<{
    can_send_group_media: boolean;
    can_mirror_group_media: boolean;
    default_view_mode: 'mirror' | 'stream_only';
  }>;

  /** M16-4d：群聊低层接口（经 Owner Gateway → Worker A）。 */
  listLocalGroups(): Promise<LocalGroupListResponse>;
  createGroup(input: { name: string; announcement?: string }): Promise<GroupCreateResponse>;
  /** OWNER-KEY-2：查群主持钥是否已落盘（仅群主） */
  getGroupOwnerEpochKey(groupId: string, epoch?: number): Promise<GroupOwnerEpochKeyStatus>;
  /** OWNER-KEY-2：老群一次性上传明文群钥到持钥表（仅群主；需 wrap secret） */
  putGroupOwnerEpochKey(
    groupId: string,
    input: { epoch: number; group_key_hex: string },
  ): Promise<GroupOwnerEpochKeyPutResult>;
  /** OWNER-KEY-4：群主节点批量代封仍 pending_key 且已有 DH 的成员 */
  sealGroupPendingKeys(
    groupId: string,
    opts?: { limit?: number },
  ): Promise<GroupOwnerSealPendingResult>;
  /** OWNER-KEY-5：群主节点服务端换钥（默认代封后 commit） */
  ownerGroupRekey(
    groupId: string,
    input?: { expected_epoch?: number; commit?: boolean },
  ): Promise<GroupOwnerRekeyResult>;
  createGroupInvite(
    groupId: string,
    opts?: GroupInviteCreateOptions,
  ): Promise<GroupInviteCreateResponse>;
  acceptGroupInvite(
    groupId: string | null | undefined,
    input: {
      owner_worker_b_url: string;
      invite_token: string;
      /** SEC-AUDIT-2026-10-15：入群强制 X25519 DH */
      member_dh_pubkey: string;
      wrapped_key_json?: string;
    },
  ): Promise<GroupInviteAcceptResponse>;
  listGroupJoinRequests(groupId: string): Promise<{ items: readonly GroupJoinRequestItem[] }>;
  approveGroupJoinRequest(
    groupId: string,
    memberWorkerBUrl: string,
  ): Promise<{ group_id: string; member_worker_b_url: string; status: string }>;
  rejectGroupJoinRequest(
    groupId: string,
    memberWorkerBUrl: string,
  ): Promise<{ group_id: string; member_worker_b_url: string; status: string }>;
  revokeGroupInvite(
    groupId: string,
    input: { invite_token?: string; invite_code?: string },
  ): Promise<{ group_id: string; invite_token: string; revoked_at: string }>;
  putGroupJoinPolicy(
    groupId: string,
    policy: GroupJoinPolicy | boolean,
  ): Promise<{ group_id: string; join_policy?: GroupJoinPolicy; join_requires_approval?: boolean }>;
  putGroupMute(
    groupId: string,
    membersMuted: boolean,
  ): Promise<{ group_id: string; members_muted: boolean }>;
  putGroupName(
    groupId: string,
    name: string,
  ): Promise<{ group_id: string; name: string }>;
  putGroupAnnouncement(
    groupId: string,
    announcement: string,
  ): Promise<{ group_id: string; announcement: string | null }>;
  putGroupAdmin(
    groupId: string,
    input: { member_worker_b_url: string; is_admin: boolean },
  ): Promise<{ group_id: string; member_worker_b_url: string; is_admin: boolean }>;
  listGroupMembers(
    groupId: string,
    params?: { readonly limit?: number; readonly offset?: number; readonly includeDh?: boolean },
  ): Promise<{
    readonly items: readonly GroupMemberItem[];
    /** GRP-MEMBER-PAGE-1：群成员总数（含 pending）。 */
    readonly total?: number;
    readonly has_more?: boolean;
  }>;
  kickGroupMember(
    groupId: string,
    memberWorkerBUrl: string,
    options?: {
      expected_epoch?: number;
      /** @deprecated REKEY-1：客户端不再发送；服务端非空即 400 */
      wrapped_keys?: readonly {
        member_worker_b_url: string;
        wrapped_key_json: string;
      }[];
    },
  ): Promise<{
    group_id: string;
    member_worker_b_url: string;
    status: string;
    new_epoch?: number;
    rekey_scheduled?: boolean;
  }>;
  joinGroup(input: {
    owner_worker_b_url: string;
    group_id: string;
    /** SEC-AUDIT-2026-10-15：入群强制 X25519 DH */
    member_dh_pubkey: string;
    wrapped_key_json?: string;
  }): Promise<GroupInviteAcceptResponse>;
  listLocalGroupMessages(
    groupId: string,
    params?: { limit?: number; cursor?: string },
  ): Promise<GroupLocalMessagesResponse>;
  fastPullGroupKey(
    groupId: string,
    epoch: number,
  ): Promise<{
    group_id: string;
    epoch: number;
    member_worker_b_url: string;
    wrapped_key_json: string;
  }>;
  listGroupWrappedKeys(
    groupId: string,
    epoch?: number,
  ): Promise<{ group_id: string; key_state: string; items: readonly GroupWrappedKeyItem[] }>;
  putGroupWrappedKey(
    groupId: string,
    input: {
      epoch: number;
      wrapped_key_json: string | Record<string, unknown>;
      member_worker_b_url?: string;
      /** 下一 epoch 必填：SHA-256(group_key) hex */
      key_fingerprint?: string;
    },
  ): Promise<{ group_id: string; epoch: number; member_worker_b_url: string }>;
  /** SEC-AUDIT-2026-10-16：真 batch 上传 wraps（≤32）+ 同源 fingerprint */
  putGroupWrappedKeysBatch(
    groupId: string,
    input: {
      epoch: number;
      key_fingerprint: string;
      replace_key?: boolean;
      items: readonly {
        member_worker_b_url: string;
        wrapped_key_json: string | Record<string, unknown>;
      }[];
    },
  ): Promise<{
    group_id: string;
    epoch: number;
    written: number;
    key_fingerprint: string | null;
    replaced: boolean;
  }>;
  /** REKEY-2：本机登记群成员 X25519 DH 公钥 */
  putGroupMemberDhPubkey(
    groupId: string,
    memberDhPubkey: string,
  ): Promise<{ group_id: string; member_worker_b_url: string; member_dh_pubkey: string }>;
  /** REKEY-2：next-epoch wraps 齐备后 CAS epoch++ */
  commitGroupRekey(
    groupId: string,
    input: { expected_epoch: number },
  ): Promise<{
    group_id: string;
    previous_epoch: number;
    new_epoch: number;
    rekey_scheduled: false;
    wrapped_count: number;
    deferred_count?: number;
  }>;
  signGroupEnvelope(
    envelope: Omit<GroupMessageEnvelope, 'sig'> & { ciphertext: string },
  ): Promise<GroupMessageEnvelope>;
  sendGroupMessage(groupId: string, envelope: GroupMessageEnvelope): Promise<GroupSendMessageResponse>;
  syncGroup(
    groupId: string,
    input?: { cursor?: string | null; acks?: readonly string[]; heartbeat?: boolean },
  ): Promise<GroupSyncDown>;
  leaveGroup(groupId: string): Promise<GroupLeaveResponse>;
  dissolveGroup(groupId: string): Promise<GroupDissolveResponse>;
  putGroupLocalSettings(
    groupId: string,
    input: { local_retention_days: number },
  ): Promise<GroupLocalSettingsResponse>;
  getMessagingDbCapacity(): Promise<MessagingDbCapacityResponse>;

  /** M11：站主私有记录（给自己发消息） */
  listPrivateNotes(params?: { limit?: number; before?: string; q?: string }): Promise<PrivateNoteListResponse>;
  createPrivateNote(input: { content: string; attachmentIds?: readonly string[] }): Promise<PrivateNoteItem>;
  updatePrivateNote(id: string, input: { content: string }): Promise<PrivateNoteItem>;
  deletePrivateNote(id: string): Promise<{ id: string; deleted: boolean }>;
  uploadPrivateNoteAttachment(input: PrivateNoteAttachmentUploadInput): Promise<PrivateNoteAttachmentItem>;
  fetchPrivateNoteAttachment(id: string): Promise<Blob>;
  deletePrivateNoteAttachment(id: string): Promise<{ id: string; deleted: boolean }>;
  exportPrivateNotes(): Promise<PrivateNotesExportSnapshot>;
  importPrivateNotes(snapshot: unknown): Promise<PrivateNotesImportResult>;
  getPrivateNotesWrappedKey(): Promise<PrivateNotesWrappedKeyState>;
  putPrivateNotesWrappedKey(input: PrivateNotesWrappedKeyPutInput): Promise<PrivateNotesWrappedKeyState>;

  /** M9-7：节点搬家 export / import */
  exportNodeBundle(): Promise<ArrayBuffer>;
  importNodeBundle(
    bundle: unknown,
    confirmOverwrite: boolean,
    unsafeInplaceImport?: boolean,
  ): Promise<NodeImportResult>;
  /** M9-7-S3：读取 staging import_ready */
  getNodeImportStatus(): Promise<NodeImportStatus>;

  /** M9-8：托管 L0 状态 / 隐私 / 删号 */
  getHostedL0Status(): Promise<HostedL0Status>;
  getHostedL0Privacy(): Promise<HostedL0PrivacyDocument>;
  acceptHostedL0Privacy(privacyVersion?: string): Promise<HostedL0PrivacyAcceptResult>;
  deleteOwnerAccount(input: {
    confirmPhrase: string;
    exportAcknowledged: boolean;
  }): Promise<AccountDeleteResult>;
}

export interface HostedL0Status {
  readonly deployment_mode: 'self_hosted' | 'hosted_l0';
  readonly hosted_l0_enabled: boolean;
  readonly operator_label: string;
  readonly privacy_version: string;
  readonly privacy_accepted: boolean;
  readonly privacy_accepted_at: string | null;
  readonly data_retention_days: number;
  readonly export_available: boolean;
  readonly account_deleted: boolean;
  readonly account_deleted_at: string | null;
  readonly requires_privacy_acceptance: boolean;
}

export interface HostedL0PrivacySection {
  readonly id: string;
  readonly title: string;
  readonly body: string;
}

export interface HostedL0PrivacyDocument {
  readonly version: string;
  readonly sections: readonly HostedL0PrivacySection[];
  readonly updated_at: string;
}

export interface HostedL0PrivacyAcceptResult {
  readonly privacy_version: string;
  readonly privacy_accepted_at: string;
}

export interface AccountDeleteResult {
  readonly deleted_tables: Readonly<Record<string, number>>;
  readonly skipped_tables: readonly string[];
  readonly account_deleted_at: string;
  readonly operator_steps: readonly string[];
}

export interface NodeImportResult {
  readonly imported_tables: Readonly<Record<string, number>>;
  readonly skipped_tables: readonly string[];
  readonly image_manifest_count: number;
  readonly posts_cache_dirty: boolean;
  /** M9-7-S2：staging = DB_IMPORT；inplace = 主库 DB */
  readonly import_target?: 'DB_IMPORT' | 'DB';
  /** M9-7-S3 */
  readonly import_ready?: boolean;
  readonly reconcile?: NodeImportReconcileReport | null;
  readonly operator_steps: readonly string[];
}

export interface NodeImportReconcileReport {
  readonly ok: boolean;
  readonly reconciled_at: string;
  readonly table_counts: Readonly<Record<string, { readonly expected: number; readonly actual: number; readonly ok: boolean }>>;
  readonly sample_hashes: Readonly<
    Record<string, { readonly ok: boolean; readonly bundle_hash: string; readonly db_hash: string; readonly sample_rows: number }>
  >;
  readonly mismatches: readonly string[];
}

export interface NodeImportStatus {
  readonly import_target: 'DB_IMPORT';
  readonly import_ready: boolean;
  readonly reconcile: NodeImportReconcileReport | null;
}

export interface LocalNotificationItem {
  readonly id: string;
  readonly type:
  | 'like'
  | 'reply'
  | 'friend_request_received'
  | 'friend_request_accepted'
  | 'friend_request_rejected'
  | 'friend_request_cancelled'
  /** REL-FIX-11：发起方撤回加好友请求后，本端站主自己的可见性通知 */
  | 'friend_request_withdrawn'
  | 'group_join_request_received'
  | 'group_join_approved'
  | 'group_join_rejected';
  readonly post_id: string | null;
  readonly actor_handle: string;
  readonly actor_node_url: string;
  readonly reply_id: string | null;
  readonly content_preview: string | null;
  readonly related_node_url?: string | null;
  readonly request_id?: string | null;
  readonly created_at: string;
  readonly read_at: string | null;
}

export interface LocalNotificationListResponse {
  readonly items: readonly LocalNotificationItem[];
  readonly unread_count: number;
  readonly has_more: boolean;
  readonly cursor: string | null;
}

/**
 * M17-2：加好友请求行
 *
 * REL-FIX-4：`inbox_status` / `inbox_error` 是**发起方**本行的投递回执
 * （对端是否真的收下了这条请求）；接收方（incoming）本行恒为空。
 */
export interface FriendRequestItem {
  readonly id: string;
  readonly origin_node_url: string;
  readonly origin_handle: string;
  readonly origin_display_name?: string;
  readonly origin_avatar_key?: string;
  readonly target_node_url: string;
  readonly target_handle: string;
  readonly status: 'pending' | 'accepted' | 'rejected' | 'cancelled' | 'expired';
  readonly message?: string | null;
  readonly created_at: string;
  readonly updated_at?: string;
  readonly accepted_at?: string | null;
  /**
   * REL-FIX-11：撤回时间（status='cancelled' 时有值）—— 撤回深链高亮行用。
   */
  readonly cancelled_at?: string | null;
  /**
   * REL-FIX-4：投递状态 — `''`（投递中/未知）/ `acked`（已送达）/
   * `pending_retry`（失败重试中）/ `giveup`（已放弃，对端大概率没收到）。
   */
  readonly inbox_status?: string;
  /**
   * REL-FIX-4：最近一次投递失败的短错误码（脱敏，无 URL / 邮箱原文）。
   * 常见可行动值：`INCOMING_DISABLED` / `BLACKLISTED` / `RATE_LIMITED`。
   */
  readonly inbox_error?: string;
  /**
   * REL-FIX-11：回执状态（**接收方**本行 = 「我回给发起方的 accepted / rejected
   * 结果，对方有没有确认收到」）。
   *   `''`（初始/投递中）/ `acked`（对方已知结果）/ `pending_retry`（重试中）/
   *   `giveup`（已放弃 → **发起方很可能还在干等**）。
   *
   * 与 `inbox_status` 严格对称：`inbox_status` 回答「我发的请求对方收没收到」，
   * `outbox_status` 回答「我回的结果对方知不知道」。
   */
  readonly outbox_status?: string;
  /**
   * REL-FIX-11：回执投递最近一次失败的短错误码（脱敏）。
   */
  readonly outbox_error?: string;
  /** SEC-AUDIT-2026-10-7: 接收方（incoming）本端是否已固化该节点公钥 Pin */
  readonly has_pin?: boolean;
  /** SEC-AUDIT-2026-10-7: 接收方（incoming）是否属于首见 / 未 Pin 节点 */
  readonly first_seen?: boolean;
}

export interface FriendRequestListResponse {
  readonly items: readonly FriendRequestItem[];
  readonly has_more?: boolean;
  readonly cursor?: string | null;
  /**
   * REL-FIX-11：该方向的**待处理**行数 —— 未读角标数据源（对齐 REL-FIX-5 群主角标）。
   */
  readonly pending_count?: number;
}

export interface FriendRequestSendResult {
  readonly id: string;
  readonly status: string;
}

export interface FriendRequestSetting {
  readonly allow_incoming: boolean;
}

export interface MutualFollowItem {
  readonly node_url: string;
  readonly handle: string;
  readonly display_name: string;
  readonly avatar_key: string;
  readonly request_id: string;
  readonly accepted_at: string | null;
}

export interface MutualFollowListResponse {
  readonly items: readonly MutualFollowItem[];
}

export interface InteractionSignEnvelopeInput {
  readonly type: InteractionType;
  readonly post_id: string;
  readonly content?: string;
  readonly reply_id?: string;
}

export interface InteractionEnvelope {
  readonly type: InteractionType;
  readonly post_id: string;
  readonly actor: {
    readonly handle: string;
    readonly node_url: string;
    readonly pubkey?: string;
  };
  readonly created_at: string;
  readonly nonce: string;
  readonly body_hash?: string;
  readonly sig: string;
}


/** 内部：互动类型（不对外 export） */
export type InteractionType = 'like' | 'unlike' | 'reply' | 'delete_reply';
