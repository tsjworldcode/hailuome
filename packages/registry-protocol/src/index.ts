/**
 * R-MSG-4a：跨仓注册协议 DTO。
 *
 * 本包承载节点与注册中心共享的协议类型定义。
 * DTO 为纯数据契约，无依赖（无 Web Crypto、无 Node fs）。
 *
 * 迁移历史：
 * - R-MSG-4a（本章）：迁出 ActivitySummary。
 * - R-MSG-4b（本章）：迁出 GroupLifecycleSummary / GroupLifecycleItem。
 * - R-MSG-4c（本章）：迁出 PresenceRequestEnvelope / OwnerActivityHint。
 * - REG-AUDIT-Y-17：迁出管理 API 信封 AdminApiSuccessBody / AdminApiFailureBody 等。
 */

export type {
  AdminApiSuccessBody,
  AdminApiFailureBody,
  AdminApiClientErrorShape,
  AdminApiPaginatedData,
} from './adminApi';

/**
 * R-MSG-4a：daily-sync `activity_summary` 块（节点自报近 30 天活跃度）。
 *
 * 防身份关联：只上报聚合整数，不上传 IP / UA。
 *
 * 字段语义：
 * - `period_days` = 固定 30，与 ACTIVITY_SUMMARY_PERIOD_DAYS 常量对齐
 * - `posts_count` / `likes_count` / `replies_count`：近 30 天计数
 * - `login_count`：近 30 天站主成功登录次数（节点源端 cap 10 000）
 * - `earliest_post_url` / `latest_post_url`：近 30 天首/末帖的公开 URL（Worker B `/posts/{id}`）
 * - `computed_at`：节点本地计算时间（ISO 8601）
 */
export interface ActivitySummary {
  period_days: number;
  posts_count: number;
  likes_count: number;
  replies_count: number;
  /** 近 30 天站主成功登录次数（节点源端 cap 10 000） */
  login_count: number;
  earliest_post_url?: string;
  latest_post_url?: string;
  computed_at: string;
}

// ============================================================
// R-MSG-4b：group_lifecycle 块
// ============================================================

/** daily-sync `group_lifecycle` 中单条群号事件（created / dissolved 共用）。 */
export interface GroupLifecycleItem {
  group_id: string;
  at: string;
}

/**
 * R-MSG-4b：daily-sync `group_lifecycle` 块（节点自报近窗群号）。
 *
 * - created：近 30 天群主侧创建的群（全量，最多 100）
 * - dissolved：近 30 天解散的群（中心据此删 created 行）
 * 防身份关联：只报 group_id + 事件时间；不报群名/成员/内容。
 */
export interface GroupLifecycleSummary {
  period_days: number;
  computed_at: string;
  created: GroupLifecycleItem[];
  dissolved: GroupLifecycleItem[];
}

// ============================================================
// R-MSG-4c：presence 请求 envelope
// ============================================================

/** M34-3：站主参与度提示（daily-sync presence 可选附随）。防身份关联：无 IP/UA。 */
export interface OwnerActivityHint {
  /** 参与层级：active / dormant / unknown */
  engagement: 'active' | 'dormant' | 'unknown';
  /** 末次登录时间（ISO 8601），可为 null */
  last_owner_seen_at: string | null;
}

/**
 * R-MSG-4c：daily-sync presence 请求 envelope（节点 POST /api/node/daily-sync 的 body）。
 *
 * 字段语义：
 * - `channel` = 固定 'presence'
 * - `known_registry_ids`：节点已知的注册中心 ID 列表（用于中心下发 add_registry 指令去重）
 * - `force`：站主手动 / 登记后立即同步；放宽中心最小间隔（仍受 10 分钟防连点）
 * - `policy_etag` / `blacklist_etag` / `recommendations_etag`：客户端游标（条件块）
 * - `owner_activity_hint`：站主参与度提示（可选）
 * - `activity_summary`：近 30 天活跃度聚合（可选；见 ActivitySummary）
 * - `group_lifecycle`：近 30 天群号生命周期（可选；见 GroupLifecycleSummary）
 * - `interval_days`：带 `group_lifecycle` 时必填；回显中心缓存的 INTERVAL_DAYS（V2-14）
 * - `proto_version`：由 withProtoVersion 注入，本包不定义
 */
export interface PresenceRequestEnvelope {
  known_registry_ids: string[];
  channel: 'presence';
  force?: boolean;
  policy_etag?: string;
  blacklist_etag?: string;
  recommendations_etag?: string;
  owner_activity_hint?: OwnerActivityHint;
  activity_summary?: unknown; // ActivitySummary 已在同包定义，caller 可进一步断言
  group_lifecycle?: unknown; // GroupLifecycleSummary 已在同包定义，caller 可进一步断言
  /** M16-GROUP-LIFECYCLE-V2：带 group_lifecycle 时回显中心 INTERVAL_DAYS */
  interval_days?: number;
}
