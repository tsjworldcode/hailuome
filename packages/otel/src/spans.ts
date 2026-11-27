/**
 * @hailuo/otel · trace 包装层
 *
 * 包装 Cloudflare Workers runtime `ctx.tracing.enterSpan(name, callback)`：
 * - span 自动 end（runtime 处理）—— 业务代码不需要手动 .end()
 * - env 开关 `OTEL_ENABLED` 默认 false —— 未启用时直接旁路 callback
 * - 异常自动 `recordException`
 *
 * ⚠️ 本包**不**依赖 hono —— 只要求调用方传入带 `env` + `executionCtx` 的鸭子类型
 * （Hono Context 天然满足）。详见 `docs/observability-plan.md` §1.1 + §3 步 16-2
 */

import {
  SpanNameValue,
  SpanAttributeValue,
  TraceStatus,
} from './types';

/**
 * 最小 context 形状（Hono Context / 自写对象均可）
 * —— 故意不 import hono，避免共享包硬依赖
 */
export interface OtelContext {
  env: { OTEL_ENABLED?: string };
  executionCtx?: unknown;
}

/**
 * otel 是否启用（env 开关）
 * 默认 false —— 任何业务代码都可在 OTEL_ENABLED 未设时安全调用
 */
export function isOtelEnabled(env: { OTEL_ENABLED?: string } | undefined): boolean {
  return env?.OTEL_ENABLED === 'true';
}

/**
 * withSpan —— 包装 callback 进入 Cloudflare runtime span
 *
 * @param c        带 env / executionCtx 的 context（Hono Context 即可）
 * @param name     span 名（用 SpanName.* 常量，禁止字面量）
 * @param fn       span 内的业务逻辑（接收 active span 作参数）
 * @param attrs    可选初始属性（白名单字段，禁止 PII）
 *
 * 用法：
 * ```ts
 * import { withSpan, SpanName } from '@hailuo/otel';
 *
 * app.get('/health', (c) => withSpan(c, SpanName.HealthCheck, async (span) => {
 *   span.setAttribute('http.method', c.req.method);
 *   return c.json({ ok: true });
 * }));
 * ```
 */
export async function withSpan<T>(
  c: OtelContext,
  name: SpanNameValue,
  fn: (span: SpanLike) => Promise<T>,
  attrs?: Record<string, SpanAttributeValue>,
): Promise<T> {
  // env 开关关闭时直接旁路 —— 0 性能开销、0 quota 风险
  if (!isOtelEnabled(c.env)) {
    return await fn(noopSpan);
  }

  // 拿 Cloudflare 底层 executionCtx
  const ctx = c.executionCtx as CloudflareExecutionCtx | undefined;
  if (!ctx?.tracing?.enterSpan) {
    // 旧 runtime 或非 Workers 平台（本地 wrangler dev / 单测）—— 安全降级
    return await fn(noopSpan);
  }

  return await ctx.tracing.enterSpan(name, async (span: SpanLike) => {
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v !== undefined) span.setAttribute(k, v);
      }
    }
    try {
      const result = await fn(span);
      span.setAttribute('trace.status', TraceStatus.OK);
      return result;
    } catch (err) {
      span.setAttribute('trace.status', TraceStatus.ERROR);
      span.recordException(err);
      throw err;
    }
  });
}

/**
 * SpanLike —— 兼容 runtime Span 接口 + 我们的 noop
 */
export interface SpanLike {
  setAttribute(key: string, value: SpanAttributeValue): this;
  setAttributes(attributes: Record<string, SpanAttributeValue | undefined>): this;
  recordException(exception: unknown): void;
}

/** env 关闭时用的伪 span —— 业务代码一致调用，0 副作用 */
const noopSpan: SpanLike = {
  setAttribute: () => noopSpan,
  setAttributes: () => noopSpan,
  recordException: () => {},
};

/** 仅暴露 enterSpan 的最小类型 */
interface CloudflareExecutionCtx {
  tracing?: {
    enterSpan<T>(name: string, callback: (span: SpanLike) => Promise<T>): Promise<T>;
  };
}
