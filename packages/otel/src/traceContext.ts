/**
 * @hailuo/otel · W3C Trace Context（traceparent）轻量工具
 *
 * 格式：`00-<trace-id 32 hex>-<parent-id 16 hex>-<flags 2 hex>`
 * 用途：Worker A → Worker B Service Binding 显式传链路 ID，
 * 便于在 Cloudflare Observability 里对齐「写层 → 读层」跨域调用。
 *
 * 注意：
 * - HMAC 签名（X-Timestamp / X-Nonce / X-Signature）**不**覆盖 traceparent，
 *   加头不破坏现有 `signRequest` / `verifyRequest` 契约。
 * - 禁止把 trace-id 当用户标识；不含 IP / URL / handle。
 * - OTEL_ENABLED=false 时调用方应跳过注入（本模块不读 env，由调用方门控）。
 */

const TRACEPARENT_RE =
  /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i;

export interface ParsedTraceparent {
  version: string;
  traceId: string;
  parentId: string;
  flags: string;
}

/** 生成 16 字节 / 8 字节随机 hex（Workers crypto.getRandomValues） */
function randomHex(byteLen: number): string {
  const buf = new Uint8Array(byteLen);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * 新建一条 W3C traceparent（新 root：新 trace-id + 新 span-id，flags=01 sampled）
 */
export function createTraceparent(): string {
  return `00-${randomHex(16)}-${randomHex(8)}-01`;
}

/**
 * 解析 traceparent；非法则 null（调用方降级为新建或不注入）
 */
export function parseTraceparent(header: string | null | undefined): ParsedTraceparent | null {
  if (!header || typeof header !== 'string') return null;
  const m = TRACEPARENT_RE.exec(header.trim());
  if (!m) return null;
  const [, version, traceId, parentId, flags] = m;
  // 全 0 trace-id 非法（W3C）
  if (/^0+$/.test(traceId)) return null;
  return { version, traceId, parentId, flags };
}

/**
 * 在已有 trace 下开子 span：保留 trace-id，换新 parent-id（本 span id）
 */
export function childTraceparent(parent: string): string | null {
  const parsed = parseTraceparent(parent);
  if (!parsed) return null;
  return `00-${parsed.traceId}-${randomHex(8)}-${parsed.flags || '01'}`;
}

/**
 * 把 traceparent 写入 Headers（覆盖已有同名头）
 */
export function injectTraceparent(headers: Headers, traceparent: string): void {
  headers.set('traceparent', traceparent);
}

/**
 * 从 Headers / 字符串取 traceparent
 */
export function readTraceparent(
  headers: Headers | { get(name: string): string | null },
): string | null {
  const v = headers.get('traceparent') ?? headers.get('Traceparent');
  return v && parseTraceparent(v) ? v.trim() : null;
}
