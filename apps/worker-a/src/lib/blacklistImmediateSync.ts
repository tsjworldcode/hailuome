/**
 * M9-13：黑名单写 D1 后立即推送 STATE_KV（Service Binding → Worker B，失败靠 Cron）。
 *
 * ALL-AUDIT-Y-16-4：出站 `WORKER_B.fetch` 在 OTEL_ENABLED 时注入 W3C `traceparent`，
 * 与 Worker B `/internal/blacklist-sync` 入站 span 对齐（HMAC 不签此头，契约不变）。
 */
import { blacklistLocalKey } from '@hailuo/shared-utils';
import { signRequest } from '@hailuo/shared-crypto';
import {
  isOtelEnabled,
  createTraceparent,
  injectTraceparent,
  writeCounter,
  writeHistogram,
} from '@hailuo/otel';
import type { Env } from '../env';
import { resolveIdentityDb } from '../db/bindings';

export type BlacklistImmediateAction = 'put' | 'delete';

export interface BlacklistImmediatePayload {
  action: BlacklistImmediateAction;
  node_url: string;
  reason?: string;
  created_at?: string;
}

/** 直接写本节点 STATE_KV（dev 无 WORKER_B binding 时的回退路径）。 */
async function applyBlacklistKvDeltaDirect(
  env: Pick<Env, 'STATE_KV'>,
  payload: BlacklistImmediatePayload,
): Promise<void> {
  if (payload.action === 'put') {
    await env.STATE_KV.put(
      blacklistLocalKey(payload.node_url),
      JSON.stringify({
        reason: payload.reason ?? '',
        created_at: payload.created_at ?? new Date().toISOString(),
      }),
    );
    return;
  }
  await env.STATE_KV.delete(blacklistLocalKey(payload.node_url));
}

/** 经 Worker B Service Binding 触发公开读层 STATE_KV 更新。 */
async function applyBlacklistKvDeltaViaWorkerB(
  env: Env,
  payload: BlacklistImmediatePayload,
): Promise<boolean> {
  if (!env.WORKER_B || !env.INTERNAL_FORWARD_SECRET) return false;
  if (env.BLACKLIST_IMMEDIATE_SYNC === 'false') return false;

  const bodyText = JSON.stringify(payload);
  const signed = await signRequest(
    { method: 'POST', path: '/internal/blacklist-sync' },
    bodyText,
    env.INTERNAL_FORWARD_SECRET,
  );
  const headers = new Headers({
    'Content-Type': 'application/json',
    'X-Internal-Forward': 'hmac-v2',
    'X-Timestamp': signed['X-Timestamp'],
    'X-Nonce': signed['X-Nonce'],
    'X-Signature': signed['X-Signature'],
  });

  // ALL-AUDIT-Y-16-4：跨域 trace —— OTEL 开时注入 traceparent（不进 HMAC 拼串）
  let traceparent: string | null = null;
  if (isOtelEnabled(env)) {
    traceparent = createTraceparent();
    injectTraceparent(headers, traceparent);
  }

  const started = Date.now();
  try {
    const res = await env.WORKER_B.fetch(
      new Request('https://worker-b.internal/internal/blacklist-sync', {
        method: 'POST',
        headers,
        body: bodyText,
      }),
    );
    const ok = res.ok;
    if (isOtelEnabled(env)) {
      writeCounter(env, 'worker_b.service_call', {
        route: 'blacklist-sync',
        ok: ok ? '1' : '0',
        status: String(res.status),
      });
      writeHistogram(env, 'worker_b.service_call.blacklist_sync', Date.now() - started, {
        ok: ok ? '1' : '0',
      });
    }
    return ok;
  } catch (err) {
    console.warn('[blacklist/immediate] Worker B Service Binding 失败', err);
    if (isOtelEnabled(env)) {
      writeCounter(env, 'worker_b.service_call', {
        route: 'blacklist-sync',
        ok: '0',
        status: 'network_error',
      });
    }
    return false;
  }
}

/**
 * 黑名单 D1 写成功后调用；优先 Worker B binding，失败则 direct STATE_KV，再失败靠 Cron 兜底。
 * NCF-AUDIT-OR-6 · 🟠 6 修后：不再清 dirty 标志（dirty 标志已删除），只更新 last_sync_at 时间戳。
 */
export async function triggerBlacklistImmediateSync(
  env: Env,
  payload: BlacklistImmediatePayload,
): Promise<void> {
  const viaB = await applyBlacklistKvDeltaViaWorkerB(env, payload);
  if (viaB) {
    // binding 成功：更新 last_sync_at 时间戳（IDENTITY_DB 单 binding，无跨 binding 风险）
    const now = new Date().toISOString();
    await resolveIdentityDb(env)
      .prepare(
        `UPDATE system_config SET value = ?, updated_at = ? WHERE key = 'blacklist_last_sync_at'`,
      )
      .bind(now, now)
      .run()
      .catch((err) => console.warn('[blacklist/immediate] 更新 last_sync_at 失败', err));
    return;
  }

  // 无 binding 或显式关闭：同账号 STATE_KV 命名空间下直接写（dev 回退）
  if (env.STATE_KV && env.BLACKLIST_IMMEDIATE_SYNC !== 'false') {
    try {
      await applyBlacklistKvDeltaDirect(env, payload);
      const now = new Date().toISOString();
      // system_config 在 IDENTITY_DB（A-2 §0090 汇总），单 binding 写。
      const identityDb = resolveIdentityDb(env);
      await identityDb
        .prepare(
          `UPDATE system_config SET value = ?, updated_at = ? WHERE key = 'blacklist_last_sync_at'`,
        )
        .bind(now, now)
        .run();
      return;
    } catch (err) {
      console.warn('[blacklist/immediate] 直接 STATE_KV 写入失败，等 cron 兜底', err);
    }
  }
  // 等 Cron syncBlacklistToKv 兜底
}
