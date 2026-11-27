/**
 * @hailuo/otel · 共享包入口
 *
 * 设计原则（详见 `docs/observability-plan.md` §1 + §2）：
 * 1. 0 OTel SDK 依赖 —— Cloudflare Workers runtime 2026 已原生支持 OTel 协议
 *    （`[observability.traces]` + `ctx.tracing.enterSpan(name, callback)`），
 *    引入 `@opentelemetry/sdk-trace` 反而拖入 `async_hooks` 兼容风险。
 * 2. **env 开关默认关** —— 所有 trace / metric helper 内置 `OTEL_ENABLED` 检查，
 *    未启用时直接旁路（0 性能开销、0 quota 风险）。按 01-project-core 硬约束。
 * 3. **0 PII** —— `setAttribute` / `writeDataPoint` 字段白名单，不带客户端 IP、
 *    邮箱、token、handle 等可关联信息（12-anti-deanonymization 硬约束）。
 * 4. **跨子请求自动 trace propagation** —— 通过 Cloudflare `fetch()` / Service
 *    Binding 自动传 `traceparent` header，无需手动管理。
 */

// 域标准 span 名常量（按 `docs/observability-plan.md` §2.2 域路径）
// 防止业务代码字符串漂移；新增域路径必须先在此加常量。
export const SpanName = {
  // HTTP 入口
  HttpHandle: 'http.handle',
  HealthCheck: 'health.check',

  // 黑名单域
  BlacklistSync: 'blacklist.sync',
  BlacklistAdd: 'blacklist.add',
  BlacklistRemove: 'blacklist.remove',
  BlacklistImmediateSync: 'blacklist.immediate_sync',

  // 帖子域
  PostCreate: 'post.create',
  PostDelete: 'post.delete',

  // 关注域
  FollowAdd: 'follow.add',
  FollowRemove: 'follow.remove',
  FeedFetch: 'feed.fetch',

  // 鉴权域
  AuthLogin: 'auth.login',
  AuthTotp: 'auth.totp',
  OwnerSession: 'owner.session',

  // 跨域路径
  RegistryHealthReport: 'registry.health.report',
  /** Worker A → Worker B Service Binding 出站 */
  WorkerBServiceCall: 'worker_b.service_call',
  /** Worker B 接收 A 侧 internal 同步入站 */
  WorkerBInternalSync: 'worker_b.internal_sync',


  // Cron
  CronRun: 'cron.run',
} as const;

export type SpanNameValue = (typeof SpanName)[keyof typeof SpanName];

// 共享类型：Cloudflare Analytics Engine Dataset binding
// （避免在每个 worker 重复声明 env.X: AnalyticsEngineDataset 类型）
export interface AnalyticsEnv {
  // ANALYTICS binding（env 开关默认关；启用时由 wrangler.toml 注入）
  // 注意：本类型**不**强制存在 —— 调用方必须先 `if (env.ANALYTICS)` 检查
  readonly ANALYTICS?: AnalyticsEngineDataset;
}

// span 属性值类型（与 Cloudflare Span.setAttribute 签名一致）
export type SpanAttributeValue = string | number | boolean;

// trace 状态码（span.recordException 配套）
export const TraceStatus = {
  OK: 'ok',
  ERROR: 'error',
} as const;
export type TraceStatusValue = (typeof TraceStatus)[keyof typeof TraceStatus];
