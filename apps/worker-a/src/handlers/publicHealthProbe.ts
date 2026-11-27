import type { Env } from '../env';
import { resolveLocalPublicBaseUrl } from '../lib/localPublicBaseUrl';

const PROBE_TIMEOUT_MS = 5000;

export interface PublicHealthProbeResult {
  worker_b_url: string;
  ok: boolean;
  http_status: number | null;
  latency_ms: number;
  error: string | null;
  checked_at: string;
}

/** M-DS-2a/3：站主自测 Worker B 公开 /health（与注册中心回访同路径）。 */
export async function probeWorkerBPublicHealth(env: Env): Promise<PublicHealthProbeResult> {
  const base = await resolveLocalPublicBaseUrl(env);
  const checkedAt = new Date().toISOString();
  if (!base) {
    return {
      worker_b_url: '',
      ok: false,
      http_status: null,
      latency_ms: 0,
      error: 'Worker B 地址未配置',
      checked_at: checkedAt,
    };
  }

  const url = `${base}/health`;
  const started = Date.now();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      signal: controller.signal,
    });
    return {
      worker_b_url: base,
      ok: res.ok,
      http_status: res.status,
      latency_ms: Date.now() - started,
      error: res.ok ? null : `HTTP ${res.status}`,
      checked_at: checkedAt,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      worker_b_url: base,
      ok: false,
      http_status: null,
      latency_ms: Date.now() - started,
      error: message.slice(0, 200),
      checked_at: checkedAt,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}
