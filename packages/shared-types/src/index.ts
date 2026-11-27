// ============================================================
// 閫氱敤 API 鍝嶅簲缁撴瀯
// ============================================================

export interface ApiOk<T> {
  ok: true;
  data: T;
}

export interface ApiError {
  ok: false;
  error_code: string;
  message: string;
}

export type ApiResponse<T> = ApiOk<T> | ApiError;

// ============================================================
// M9-6：跨节点/跨服务协议版本 envelope（不污染 Post/User 等内部 DTO）
// ============================================================

/** 当前跨节点公开读与 outbound 上报 envelope 协议版本 */
export const HAILUO_PROTO_VERSION = '1.0' as const;

export type HailuoProtoVersion = typeof HAILUO_PROTO_VERSION;

/** 外层 envelope 必填 proto_version；items 等业务字段由具体端点扩展 */
export interface ProtoVersionedEnvelope {
  proto_version: HailuoProtoVersion;
}

// ============================================================
// 娉ㄥ唽涓績 proof 鍥炶锛圵orker A 鍐?STATE_KV锛學orker B 鍙鏆撮湶锛?// ============================================================

/** STATE_KV 閿細绾枃鏈?body 涓?`<challenge_id>.<nonce>`锛屼笌娉ㄥ唽涓績濂戠害涓€鑷?*/
export const REGISTRY_PROOF_KV_KEY = 'registry:proof:body';

/** M7-30：换域 proof 独立 KV key（body = `<url_change_id>.<nonce>`），禁止覆盖注册 proof。 */
export const REGISTRY_URL_CHANGE_PROOF_KV_KEY = 'registry:proof:url_change:body';

/** KV TTL锛堢锛夛紱椤昏鐩栨敞鍐屼腑蹇?challenge 鏈夋晥鏈燂紙10 鍒嗛挓锛夊強鍥炶缃戠粶浣欓噺 */
export const REGISTRY_PROOF_KV_TTL_SEC = 900;

/** STATE_KV 閿細Worker B 鍏紑璇诲彇鐨勭珯涓诲叕寮€璧勬枡蹇収 */
export const PUBLIC_PROFILE_KV_KEY = 'public:profile';

/** M7-30g-2：STATE_KV 纯文本公开基址镜像（无尾斜杠）；Pages / Worker B 无 D1 时读此 key。 */
export const PUBLIC_WORKER_B_URL_KV_KEY = 'public:canonical_worker_b_url';

/**
 * M7-30f-2：STATE_KV 换域「已迁址」声明（JSON，含 Ed25519 sig）。
 * Worker A confirm 成功写 1 次；Worker B `/.well-known/hailuo-node-moved` 只读。
 */
export const NODE_URL_MOVED_KV_KEY = 'node:url-moved';

/** M7-30h-6：链式迁址 index（JSON 列表，每项指向 entry key） */
export const NODE_URL_MOVED_INDEX_KV_KEY = 'node:url-moved:index';

/** entry key 前缀：`node:url-moved:entry:<16hex>` */
export const NODE_URL_MOVED_ENTRY_KEY_PREFIX = 'node:url-moved:entry:';

/** 粉丝侧链式解析最大跳数（防环） */
export const URL_MOVE_CHAIN_MAX_HOPS = 5;

/** 单节点 KV 内同时保留的迁址 entry 上限（宽限期内多次换域） */
export const URL_MOVE_CHAIN_MAX_ENTRIES = 12;

/** Service Binding 内部转发：v2 签名材料（method+path+body） */
export const INTERNAL_FORWARD_MARKER_V2 = 'hmac-v2';
/** Owner Gateway / compat owner-proxy：v3 签名材料（method+path+body+clientIp） */
export const INTERNAL_FORWARD_MARKER_V3 = 'hmac-v3';

/** 宽限期内可选响应头：值为新 node_url（无尾斜杠） */
export const NODE_URL_MOVED_HEADER = 'X-Hailuo-Node-Moved';

/** 迁址宽限期默认/上下限（天），存 `system_config.url_move_grace_days` */
export const URL_MOVE_GRACE_DAYS_DEFAULT = 14;
export const URL_MOVE_GRACE_DAYS_MIN = 7;
export const URL_MOVE_GRACE_DAYS_MAX = 30;

/** Worker B 公开迁址声明（与 KV JSON 同形） */
export interface NodeUrlMovedDeclaration {
  old_node_url: string;
  new_node_url: string;
  changed_at: string;
  grace_until: string;
  handle: string;
  /** Ed25519 hex，对 `buildNodeUrlMovedCanonical` 原文签名 */
  sig: string;
}

/** M7-30h-6：链式 index 中单条 entry 元数据 */
export interface NodeUrlMovedIndexEntry {
  key: string;
  old_node_url: string;
  grace_until: string;
}

export interface NodeUrlMovedIndex {
  entries: NodeUrlMovedIndexEntry[];
  updated_at: string;
}

/** 验签/签名共用的 canonical 字节（UTF-8 原文，换行分隔） */
export function buildNodeUrlMovedCanonical(
  fields: Omit<NodeUrlMovedDeclaration, 'sig'>,
): string {
  return [
    'HAILUO_NODE_MOVED_V1',
    fields.old_node_url,
    fields.new_node_url,
    fields.changed_at,
    fields.grace_until,
    fields.handle,
  ].join('\n');
}

/** 将配置值夹到 7～30；非法则默认 14 */
export function clampUrlMoveGraceDays(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number.parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(n)) return URL_MOVE_GRACE_DAYS_DEFAULT;
  return Math.min(
    URL_MOVE_GRACE_DAYS_MAX,
    Math.max(URL_MOVE_GRACE_DAYS_MIN, Math.floor(n)),
  );
}

/**
 * M7-30f-4：已知联系人通道③投递体（Worker B `POST /api/node/events`）。
 * 与 well-known 迁址声明不同：多 `type`/`nonce`，字段名前缀 `from_`。
 */
export interface NodeUrlChangedEvent {
  type: 'node_url_changed';
  from_handle: string;
  from_node_url_old: string;
  from_node_url_new: string;
  changed_at: string;
  grace_until: string;
  nonce: string;
  /** Ed25519 hex，对 `buildNodeUrlChangedCanonical` 原文签名 */
  sig: string;
}

/** 通道③验签/签名共用 canonical（UTF-8，换行分隔） */
export function buildNodeUrlChangedCanonical(
  fields: Omit<NodeUrlChangedEvent, 'sig' | 'type'> & { type?: 'node_url_changed' },
): string {
  return [
    'HAILUO_NODE_URL_CHANGED_V1',
    fields.from_handle,
    fields.from_node_url_old,
    fields.from_node_url_new,
    fields.changed_at,
    fields.grace_until,
    fields.nonce,
  ].join('\n');
}

/** STATE_KV 閿細鑴辨晱 registry_endpoints锛堜笉鍚?node_api_token / owner_user_id锛孧9-3-5锛?*/
export const REGISTRY_ENDPOINTS_KV_KEY = 'node:registry_endpoints';

export type PublicRegistryEndpointStatus = 'active' | 'pending' | 'unreachable';

/** Worker B / Web 鍙锛涗笉寰楀惈 node_api_token / owner_user_id */
export interface PublicRegistryEndpoint {
  registry_id: string;
  registry_url: string;
  trust_pubkey: string;
  status: PublicRegistryEndpointStatus;
  added_at: string;
  last_ok_at?: string;
  last_fail_at?: string;
  fail_streak: number;
  /** M7-30b：备用注册中心在节点换域后未同步 node_url 时为 stale */
  url_sync_state?: 'synced' | 'stale';
}

export interface PublicOwnerProfile {
  handle: string;
  display_name: string;
  bio: string;
  pubkey: string;
  /** M10: X25519 public key hex for DM key agreement; empty means DM not enabled. */
  dm_pubkey?: string;
  worker_b_url: string;
  avatar_key: string;
  contact_email: string;
  created_at: string;
  updated_at: string;
  /** M7-31b：登记邮箱是否已通过 /certify 验码（Worker B 公开可读）。 */
  email_verified?: boolean;
}

export interface PaginatedData<T> {
  items: T[];
  has_more: boolean;
  cursor?: string;
  total?: number;
}

// ============================================================
// Worker B 鍏紑璇荤紦瀛樺厓淇℃伅锛圡9-12 / M9-14锛?// ============================================================

/** POSTS_CACHE_KV 鍏冧俊鎭敭锛堜笌 posts:latest 閰嶅锛?*/
export const POSTS_CACHE_META_KV_KEY = 'posts:latest:meta';

/** POSTS_CACHE_KV feed 鍏冧俊鎭敭锛堜笌 feed:latest 閰嶅锛?*/
export const FEED_CACHE_META_KV_KEY = 'feed:latest:meta';

/**
 * M34-OPT-1：POSTS_CACHE_KV 单帖独立 key 前缀（`post:{id}`）。
 * Worker A 发帖/删帖时经 waitUntil 异步写/删；
 * Worker B GET /posts/:id 优先直接 get，miss 回落 posts:latest 全量列表。
 */
export const POST_INDIVIDUAL_KV_PREFIX = 'post:';

/**
 * M34-OPT-2：POSTS_CACHE_KV 列表分页快照 key 前缀（`posts:page:{version}:{scope}:{cursor}:{limit}`）。
 * Worker B GET /posts 翻页时 lazy populate：首次请求计算全量分页后写入 KV；
 * `version` 取自 `posts:latest` 的 `generated_at`，新帖写入后版本变化，旧缓存自然失效。
 * TTL 与边缘缓存 TTL 同为 30 秒。
 */
export const POSTS_PAGE_KV_PREFIX = 'posts:page:';

/**
 * audit-v3 P1-2 / 步骤 2.2：`posts:latest` 分桶 key 前缀（`posts:latest:bucket:{i}`，i≥1）。
 * 主 key `posts:latest` 持有第 0 桶 + meta.bucket_count；Worker B 读时按 count 合并。
 */
export const POSTS_LATEST_BUCKET_PREFIX = 'posts:latest:bucket:';

/** 单 KV value 安全上限（字节）；Cloudflare 硬限 25 MB，留约 5 MB 余量 */
export const POSTS_LATEST_MAX_BYTES = 20 * 1024 * 1024;

/**
 * 单次刷新最多分桶数（含主 key 的第 0 桶）。
 * Free Tier KV 写 ≤1000/天；Cron 刷新 ≤288/天 × 3 = 864，仍在限额内。
 */
export const POSTS_LATEST_MAX_BUCKETS = 3;

/**
 * M34-OPT-4：POSTS_CACHE_KV Feed 分页快照 key 前缀（`feed:page:{version}:{cursor}:{limit}`）。
 * Worker B GET /feed 翻页时 lazy populate：首次请求计算全量分页后写入 KV；
 * `version` 取自 `feed:latest` 的 `generated_at`，新 feed 写入后版本变化，旧缓存自然失效。
 * TTL 与边缘缓存 TTL 同为 30 秒。
 * feed:latest 由 D1 LIMIT 50 约束，分页缓存每天最多 864 次写（3页×288次/天），远在 Free Tier 1K/天限额内。
 */
export const FEED_PAGE_KV_PREFIX = 'feed:page:';

/**
 * M13-15 起废弃写入：历史 `feed:sorted:{generated_at}` 前缀仅保留给有界 delete 清理。
 * cursor 翻页改走 Worker B 对 feed:latest（≤50）的有界 findIndex，不再第二键 put/get。
 */
export const FEED_SORTED_KV_PREFIX = 'feed:sorted:';

/** @deprecated M13-15 起不再写入；保留类型供迁移期排障 */
export type FeedSortedIndex = Record<string, number>;

/** Worker B GET /posts|/feed 响应附带的韧性元信息 */
export interface PublicReadCacheMeta {
  /** 最近一次 Worker A 写入 KV 的时间；miss 时为 null */
  generated_at: string | null;
  /** KV miss 或数据陈旧 / 部分拉取失败时为 true */
  stale?: boolean;
  /** 上一轮 Feed Cron 拉取失败的关注节点数（仅 /feed） */
  partial_failed_count?: number;
  /**
   * audit-v3 步骤 2.2：`posts:latest` 分桶总数（含主 key 第 0 桶）。
   * 缺省 / 1 = 未分桶；>1 时 Worker B 还需读 `posts:latest:bucket:1..n-1`。
   */
  bucket_count?: number;
}

/** M13-3：posts:latest / feed:latest KV envelope（items + meta 单次 get） */
export interface PublicReadCacheEnvelope<T> {
  items: T[];
  meta: PublicReadCacheMeta;
}

/** 扩展分页响应：公开读韧性字段 + M9-6 proto_version（向后兼容，均为可选顶层字段） */
export interface PublicReadPaginatedData<T> extends PaginatedData<T>, Partial<ProtoVersionedEnvelope> {
  generated_at?: string | null;
  stale?: boolean;
  partial_failed_count?: number;
}

// ============================================================
// 鐢ㄦ埛锛堣妭鐐规墍鏈夎€咃級
// ============================================================

export interface User {
  handle: string;
  display_name: string;
  bio: string;
  pubkey: string;         // Ed25519 公钥 hex（32 字节 = 64 字符）
  dm_pubkey?: string;     // X25519 公钥 hex（32 字节 = 64 字符）
  worker_b_url: string;
  avatar_key?: string;
  created_at: string;     // ISO 8601
}

// ============================================================
// 帖子
// ============================================================

/** M9-1：帖子类型（原创 / 纯转发） */
export type PostKind = 'original' | 'repost';

/** M9-1：转发帖引用的原帖元数据 */
export interface RepostOf {
  node_url: string;
  post_id: string;
  author_handle: string;
}

export interface Post {
  id: string;             // 格式：post_<ulid>
  content: string;
  sig: string;            // 原创：id+content+created_at；转发：signRepost 载荷
  image_keys: string[];   // IMAGE_KV 中的 key 列表（Worker A 内部）
  created_at: string;     // ISO 8601
  deleted_at?: string;    // 软删除
  /** M9-1：默认 original；转发帖为 repost */
  post_kind?: PostKind;
  repost_of_node_url?: string | null;
  repost_of_post_id?: string | null;
  repost_of_author_handle?: string | null;
}

/** Worker B 向外暴露的帖子（image_keys → image_urls） */
export interface PublicPost {
  id: string;
  content: string;
  sig: string;
  image_urls: string[];   // 完整图片 URL（含 Worker B 前缀）
  created_at: string;
  /** M9-1：省略或 original；转发帖为 repost */
  post_kind?: PostKind;
  repost_of?: RepostOf | null;
}

// ============================================================
// 鍏虫敞
// ============================================================

export interface Follow {
  id: string;
  follower_node_url: string;  // 琚叧娉ㄨ妭鐐圭殑 Worker B 鍦板潃
  followed_at: string;
  last_active?: string;
  fail_count: number;
}

// ============================================================
// 榛戝悕鍗?// ============================================================

export interface BlacklistEntry {
  node_url: string;
  reason: string;
  created_at: string;
}

// ============================================================
// 宸插悐閿€ Token
// ============================================================

export interface RevokedToken {
  token_hash: string;   // SHA-256 hex
  node_url: string;
  revoked_at: string;
}

// ============================================================
// Feed 鑱氬悎缂撳瓨
// ============================================================

export interface FeedCacheItem {
  id: string;               // <node_url>#<post_id>
  node_url: string;
  content: string;
  sig: string;
  image_urls: string[];
  post_id: string;
  created_at: string;
  fetched_at: string;
}

// ============================================================
// Token Payload（粉丝 Token / 所有者 JWT）
// ============================================================

/** M14-1 + M14-TOKEN-REQUIRED：读帖保护五档（canonical；读路径 `enforced` 映射为 `following-only`） */
export type FollowerTokenMode =
  | 'public-read'
  | 'token-required'
  | 'following-only'
  | 'mutual-only'
  | 'owner-only';

/** protected 档 Token 签发时的 scope claim（高等级可向下兼容低档节点） */
export type FollowerReadScope = 'token-required' | 'following-only' | 'mutual-only';

/** 粉丝 Token payload（Ed25519 签发，Worker A → 粉丝节点） */
export interface FollowerTokenPayload {
  sub: string;    // 粉丝节点的 Worker B URL（已 normalizeWorkerBOrigin）
  iss: string;    // 发行者（被读节点的 BOOTSTRAP_HANDLE / 部署占位 handle）
  /** 粉丝节点站主的注册 handle；互动 actor 身份用此字段，不用 iss */
  fan?: string;
  /** protected 档必填；高档 scope（如 mutual-only）可访问更松节点（如 token-required） */
  read_scope?: FollowerReadScope;
  iat: number;    // 签发时间（Unix 秒）
  exp: number;    // 过期时间（Unix 秒，24h TTL）
}

/** 所有者 JWT payload（HS256，Worker A login） */
export interface OwnerJwtPayload {
  sub: string;    // 节点 JWT sub / 部署占位 handle（BOOTSTRAP_HANDLE）；登记后以 D1 users.handle 为准
  iat: number;
  exp: number;
  /** 站主登录用户名（owner_credentials.username），与 sub 可不同（如默认 admin） */
  oun?: string;
}

// ============================================================
// M9-19：跨节点互动签名 envelope
// ============================================================

/** 互动类型 */
export type InteractionType = 'like' | 'unlike' | 'reply' | 'delete_reply';

/** 互动 envelope actor 信息 */
export interface InteractionActor {
  handle: string;           // 粉丝节点的注册 handle
  node_url: string;         // 粉丝节点的 Worker B URL
  pubkey?: string;          // 粉丝节点的 Ed25519 公钥 hex（可选，M9-19 硬化时使用）
}

/**
 * 跨节点互动签名 envelope（M9-19）。
 * 
 * 签名输入格式：
 *   type:post_id:actor_handle:actor_node_url:created_at:nonce:body_hash
 * 
 * body_hash 为 content 的 SHA-256 hex（回复时填写），点赞/unlike 时为空串。
 */
export interface InteractionEnvelope {
  type: InteractionType;
  post_id: string;
  actor: InteractionActor;
  created_at: string;       // ISO 8601
  nonce: string;            // 16 字节 hex，防重放
  body_hash?: string;       // SHA-256 hex（回复 content 的哈希）
  sig: string;              // Ed25519 签名 hex
}

// ============================================================
// M10：互粉私信 E2EE envelope
// ============================================================

export interface DmSendTicket {
  sender_handle: string;
  recipient_handle: string;
  recipient_worker_b_url: string;
  exp: number;
  nonce: string;
  sig: string;
}

/** M14-3：互粉读帖证明（读者节点签发，供向互粉节点申领读帖 Token） */
export interface ReadMutualProof {
  reader_worker_b_url: string;
  owner_worker_b_url: string;
  purpose: 'read-token';
  exp: number;
  nonce: string;
  sig: string;
}

/** MM-3：DM 媒体拉取 ticket（请求方 Worker A 签发，发送方 Worker A 验签） */
export interface DmMediaFetchTicket {
  v: 1;
  message_id: string;
  media_id: string;
  conversation_id: string;
  sender_storage_key: string;
  sender_worker_b_url: string;
  requester_worker_b_url: string;
  exp: number;
  nonce: string;
  sig: string;
}

/** MM-5：群媒体拉取 ticket（请求方 Worker A 签发，发送方 Worker A 验签） */
export interface GroupMediaFetchTicket {
  v: 1;
  group_id: string;
  message_id: string;
  media_id: string;
  sender_storage_key: string;
  sender_worker_b_url: string;
  requester_worker_b_url: string;
  exp: number;
  nonce: string;
  sig: string;
}

export interface DmEnvelope {
  v: 1;
  conversation_id: string;
  message_id: string;
  sender_handle: string;
  sender_worker_b_url: string;
  recipient_handle: string;
  created_at: string;
  nonce: string;
  key_epoch: number;
  ephemeral_pubkey: string;
  ciphertext: string;
  aad_version: 1;
  send_ticket: DmSendTicket;
  media?: MessagingMediaSigned;
  sig: string;
}

export interface DmMessageItem {
  message_id: string;
  conversation_id: string;
  direction: 'inbox' | 'outbox';
  peer_handle: string;
  peer_worker_b_url: string;
  envelope: DmEnvelope;
  created_at: string;
  read_at: string | null;
  delivery_status: string;
}

/** MM-1：signed media 块（DM/群共用，进 envelope 签名）。 */
export interface MessagingMediaSigned {
  media_id: string;
  sender_storage_key: string;
  sender_worker_b_url: string;
  size_bytes: number;
  ciphertext_sha256: string;
  alg: string;
}

/** @deprecated 使用 MessagingMediaSigned */
export type GroupMessageMedia = MessagingMediaSigned;

/** @deprecated 使用 MessagingMediaSigned */
export type DmMessageMedia = MessagingMediaSigned;

export type MessagingMediaStorageState =
  | 'active'
  | 'mirror_pending'
  | 'mirrored'
  | 'stream_only'
  | 'release_pending'
  | 'released'
  | 'missing';

export type MessagingMediaViewMode = 'mirror' | 'stream_only';

export type MessagingMediaOwnerKind =
  | 'dm_sender'
  | 'dm_mirror'
  | 'group_sender'
  | 'group_mirror';

export type MessagingMediaRegistryScope = 'public_post' | 'messaging';

/** MM-1：本节点 messaging_media_local 行（MESSAGING_DB）。 */
export interface MessagingMediaLocalRecord {
  message_id: string;
  media_id: string;
  group_id: string | null;
  local_storage_key: string | null;
  mirror_of_key: string;
  storage_state: MessagingMediaStorageState;
  media_view_mode: MessagingMediaViewMode;
  retry_at: string | null;
  created_at: string;
  updated_at: string;
}

/** MM-1 契约常量默认值（与 wrangler / system_config 对齐，MM-2 读取 env）。 */
export const MESSAGING_MEDIA_MAX_BYTES = 10_485_760;
export const MESSAGING_MEDIA_MAX_PER_MESSAGE = 4;
export const MESSAGING_MEDIA_ALG = 'aes-256-gcm+hkdf-media-v1';

export interface GroupMessageEnvelope {
  v: 1;
  kind: 'GROUP_MESSAGE';
  group_id: string;
  message_id: string;
  epoch: number;
  sender_handle: string;
  sender_worker_b_url: string;
  owner_worker_b_url: string;
  created_at: string;
  expires_at: string;
  nonce: string;
  msg_kind: 'chat' | 'system';
  ciphertext: string;
  media?: MessagingMediaSigned;
  sig: string;
}

/**
 * GRP-RELAY-AUTH：群主对已受理群消息的短时副签回执（Ed25519）。
 * 密文仍只在浏览器用群密钥解密；本结构不含明文正文。
 */
export interface OwnerReceiptV1 {
  v: 1;
  group_id: string;
  message_id: string;
  epoch: number;
  sender_worker_b_url: string;
  sender_handle: string;
  /** 对 envelope.ciphertext 的 SHA-256 hex，防「旧回执 + 新密文」 */
  ciphertext_sha256: string;
  owner_worker_b_url: string;
  issued_at: string;
  exp: string;
  /**
   * MSG-FIX-5：群主权威入库时分配的**单调入库序**（`group_messages.recv_seq`）。
   *
   * 为什么必须由群主签名背书：relay 中继节点是任意的第三方，若允许 relay 载荷
   * 自带 `recv_seq`，恶意中继即可伪造序号，制造乱序 / 空洞（把真实消息挤出
   * sync 游标窗口）。因此序号**只**从群主签名回执里取，中继只负责透传。
   *
   * 可选字段（老节点签发的回执没有它）：缺失时收端按「无权威序号」处理，
   * 落库 `recv_seq = NULL`，仍可经 sync 下行补齐。
   */
  recv_seq?: number;
  sig: string;
}

export type OwnerReceiptUnsigned = Omit<OwnerReceiptV1, 'sig'>;

/** 树内正向 relay 载荷（Worker-to-Worker）。 */
export interface GroupRelayPayload {
  envelope: GroupMessageEnvelope;
  hop_count: number;
  /** 与群主权威树一致的版本；仅观测/校验，fanout 可不强依赖 */
  tree_id?: number;
  /**
   * M16-RELAY-PIGGYBACK（Header Piggybacking）：
   * 本收件人应立刻 POST 的子节点 Worker B URL 列表（≤ 8）。
   * 中继节点收到后优先使用此字段向下 fanout，无需依赖本地 D1 边表已同步。
   */
  next_hops?: string[];
  /**
   * 可选：以 parent_url 为键的子树切片，供本跳在向下 fanout 时
   * 为每个 child 填入其 next_hops（避免 child 再查 D1）。
   */
  route_slice?: Array<{
    parent_worker_b_url: string;
    child_worker_b_url: string;
  }>;
  /**
   * GRP-RELAY-AUTH-2：群主 inbound 成功后签发的 owner_receipt；
   * AUTH-3 起收端强制校验；此前影子携带（缺省不拒收）。
   */
  owner_receipt?: OwnerReceiptV1;
}

/** M16-3：反向 sync-with-parent 上行请求（GROUP_SYNC_V1）。 */
export interface GroupSyncRequest {
  v: 1;
  kind: 'GROUP_SYNC';
  group_id: string;
  sender_handle: string;
  sender_worker_b_url: string;
  owner_worker_b_url: string;
  epoch: number;
  created_at: string;
  expires_at: string;
  nonce: string;
  cursor: string | null;
  acks: string[];
  heartbeat?: boolean;
  sig: string;
}

/**
 * REL-FIX-6：跨节点管理员代理拉取群主待审批入群申请（GROUP_ADMIN_JOIN_REQUEST_V1）。
 * 群主侧以**群主库** `group_members.is_admin=1` 权威判定请求方身份，不采信自证。
 */
export interface GroupAdminJoinRequestEnvelope {
  v: 1;
  kind: 'GROUP_ADMIN_JOIN_REQUEST_V1';
  /** 管理员可代理的动作：列出待审批 / 同意 / 拒绝 */
  action: 'list' | 'approve' | 'reject';
  group_id: string;
  requester_worker_b_url: string;
  requester_handle: string;
  /** 审批目标成员 URL；action=list 时为空串 */
  target_member_worker_b_url: string;
  timestamp: string;
  nonce: string;
  sig: string;
}

/**
 * REL-FIX-6：待审批入群申请条目。
 * 字段与本机群主路径**完全一致**（避免代理拉取后前端契约分叉）；
 * 不含邮箱等 PII。
 */
export interface GroupJoinRequestSummary {
  member_worker_b_url: string;
  member_handle: string;
  member_pubkey: string;
  key_state: string;
  joined_at: string;
}

/**
 * REL-FIX-7：群主把入群审批结果回推给申请人节点（GROUP_JOIN_DECISION_V1）。
 * 申请人节点以本地 `group_members` 里 role='owner' 的 pin 公钥验签（不采信信封自带公钥）。
 */
export interface GroupJoinDecisionEnvelope {
  v: 1;
  kind: 'GROUP_JOIN_DECISION_V1';
  group_id: string;
  /** 审批结果：approved / rejected */
  decision: 'approved' | 'rejected';
  group_name: string;
  owner_worker_b_url: string;
  owner_handle: string;
  /** 群主公钥（信息位；验签以接收端本地 pin 为准） */
  owner_pubkey: string;
  /** 申请人节点 Worker B URL（决策只对此节点生效） */
  member_worker_b_url: string;
  timestamp: string;
  nonce: string;
  sig: string;
}

/** sync 下行单条消息（密文行 + 可选 envelope_json 供群图 ticket/proxy）。 */
export interface GroupSyncMessage {
  message_id: string;
  group_id: string;
  epoch: number;
  sender_worker_b_url: string;
  sender_handle: string;
  msg_kind: 'chat' | 'system';
  ciphertext: string;
  created_at: string;
  /**
   * MSG-FIX-4：群主权威入库单调序（每 group_id 从 1 递增）。
   * sync 过滤主用此字段；对外 cursor 仍可回写 message_id，服务端再翻译为 after_seq。
   */
  recv_seq?: number;
  /** M16-7c：完整 GROUP_MESSAGE envelope JSON（含 signed media）；sync 补拉路径群图依赖此字段。 */
  envelope_json?: string | null;
}

/** sync 下行 relay_tree 快照。 */
export interface GroupRelayTreeDown {
  tree_id: number;
  seeds: string[];
  edges: { parent_worker_b_url: string; child_worker_b_url: string }[];
}

/** sync 下行合并响应。 */
export interface GroupSyncDown {
  group_id: string;
  epoch: number;
  tree_id: number;
  cursor: string | null;
  dissolved_at?: string | null;
  messages: GroupSyncMessage[];
  relay_tree?: GroupRelayTreeDown;
  wrapped_key?: { epoch: number; wrapped_key_json: string };
  /**
   * GRP-RELAY-AUTH-PIN-1：群主节点 pubkey pin（64hex）。
   * 存量成员经 sync 回填本地 `group_members`（role=owner），供 owner_receipt 验签。
   */
  owner_handle?: string;
  owner_pubkey?: string;
}
