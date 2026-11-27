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

// 类型 + 常量
export {
  SpanName,
  TraceStatus,
  type SpanNameValue,
  type TraceStatusValue,
  type SpanAttributeValue,
  type AnalyticsEnv,
} from './types';

// trace helper
export {
  withSpan,
  isOtelEnabled,
  type SpanLike,
  type OtelContext,
} from './spans';

// metric helper
export {
  writeMetric,
  writeCounter,
  writeHistogram,
} from './metrics';

// W3C traceparent（跨 Service Binding）
export {
  createTraceparent,
  parseTraceparent,
  childTraceparent,
  injectTraceparent,
  readTraceparent,
  type ParsedTraceparent,
} from './traceContext';
