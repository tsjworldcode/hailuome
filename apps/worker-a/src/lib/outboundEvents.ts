/**
 * outbound_events 写入 helpers（M9-3-8）。
 *
 * 记录 registry_id / router_attempts / router_detail，供 Cron 重试与排障。
 */

export interface OutboundEventInsert {
  readonly kind: string;
  readonly targetUrl: string;
  readonly status: 'ok' | 'failed';
  readonly httpCode: number | null;
  readonly errCode: string | null;
  readonly errMessage: string | null;
  readonly registryId?: string | null;
  readonly routerAttempts?: number;
  readonly routerDetail?: string | null;
}

export function newOutboundEventId(): string {
  return `evt_${crypto.randomUUID().replace(/-/g, '')}`;
}

export function truncateOutboundText(value: string | null | undefined, max = 500): string | null {
  if (!value?.trim()) return null;
  const trimmed = value.trim();
  return trimmed.length <= max ? trimmed : trimmed.slice(0, max);
}

/** 由 registryFetch path 推导 outbound kind。 */
export function outboundKindFromRegistryPath(path: string): string {
  if (path.startsWith('/api/node/health')) return 'registry/health';
  if (path.startsWith('/api/node/daily-sync')) return 'registry/daily-sync';
  if (path.startsWith('/lookup/')) return 'registry/lookup';
  if (path.includes('/api/posts/feed')) return 'registry/official-feed';
  if (path.includes('/api/recommendations')) return 'registry/recommendations';
  return 'registry/fetch';
}

/** lookup 高频：仅 failover / 多次尝试 / 失败时落库，避免 D1 写膨胀。 */
export function shouldLogRegistryFetchSuccess(path: string, routerDetail: string, attempts: number): boolean {
  if (path.startsWith('/lookup/')) {
    return attempts > 1 || routerDetail.includes('failover');
  }
  return attempts > 1 || routerDetail.includes('failover');
}

/**
 * 插入一条 outbound_event；D1 失败 fail-soft。
 */
export async function insertOutboundEvent(db: D1Database, input: OutboundEventInsert): Promise<void> {
  const now = new Date().toISOString();
  const registryId = input.registryId?.trim() || null;
  const routerAttempts = input.routerAttempts ?? 0;
  const routerDetail = truncateOutboundText(input.routerDetail);
  const errMessage = truncateOutboundText(input.errMessage);

  await db
    .prepare(
      `INSERT INTO outbound_events
         (id, kind, target_url, status, http_code, err_code, err_message,
          payload_hash, retries, registry_id, router_attempts, router_detail,
          created_at, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, '', 0, ?, ?, ?, ?, ?)`,
    )
    .bind(
      newOutboundEventId(),
      input.kind,
      input.targetUrl,
      input.status,
      input.httpCode,
      input.errCode,
      errMessage,
      registryId,
      routerAttempts,
      routerDetail,
      now,
      now,
    )
    .run()
    .catch((err) => console.error('[outboundEvents] 写入失败', err));
}
