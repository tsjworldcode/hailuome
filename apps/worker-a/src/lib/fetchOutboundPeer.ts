/**
 * SEC-AUDIT-2026-10-1：统一出站到对端 Worker B。
 * - 先 `assertSafePeerWorkerBUrl`（非法 URL **0 连接**）
 * - `redirect: 'manual'`（防 302 跳私网）
 * - AbortController 超时 + 中性 UA `hailuo-node/1.0`
 * 失败语义：返回结果对象，由调用方 fail-soft / fail-closed；日志只打脱敏 host。
 */
import {
  assertSafePeerWorkerBUrl,
  isPrivateProofTargetAllowed,
  redactOutboundUrlHost,
} from '@hailuo/shared-utils';
import type { Env } from '../env';

/** 中性 UA：不带版本/站标识（计划 UA-HYGIENE；本入口一次收齐）。 */
export const OUTBOUND_PEER_UA = 'hailuo-node/1.0';

/** 默认单跳超时（与 groupRelay 2.5s 同档）。 */
export const OUTBOUND_PEER_DEFAULT_TIMEOUT_MS = 2_500;

/**
 * 只校验、不连接。Cron / 转发要保留自己的失败分类时用这个，
 * 不要整段换成 fetchOutboundPeer。
 */
export function resolveSafeOutboundPeerUrl(env: Env, rawUrl: string): string | null {
  const allowPrivate = isPrivateProofTargetAllowed(env);
  const check = assertSafePeerWorkerBUrl(rawUrl, { allowPrivate });
  return check.ok ? check.url.toString() : null;
}

/** redirect:manual 时 3xx 必须停，不能再跟一跳。 */
export function isManualRedirectStatus(status: number): boolean {
  return status >= 300 && status < 400;
}

export type FetchOutboundPeerOk = {
  ok: true;
  response: Response;
  /** 已通过 SSRF 门禁的绝对 URL 字符串 */
  url: string;
  /** 脱敏 host（与 Err 侧同名，调用方无需收窄即可打点） */
  host: string;
};

export type FetchOutboundPeerErr = {
  ok: false;
  reason: 'unsafe_url' | 'network' | 'aborted';
  /** 脱敏 host，禁止打完整 URL */
  host?: string;
  detail?: string;
};

export type FetchOutboundPeerResult = FetchOutboundPeerOk | FetchOutboundPeerErr;

export type FetchOutboundPeerInit = Omit<RequestInit, 'redirect'> & {
  timeoutMs?: number;
  /** 覆盖 env 推导；测试可显式 true */
  allowPrivate?: boolean;
};

/**
 * 对端出站 fetch。非法 URL 不发起连接；302 不跟随。
 */
export async function fetchOutboundPeer(
  env: Env,
  rawUrl: string,
  init: FetchOutboundPeerInit = {},
): Promise<FetchOutboundPeerResult> {
  const allowPrivate = init.allowPrivate ?? isPrivateProofTargetAllowed(env);
  const check = assertSafePeerWorkerBUrl(rawUrl, { allowPrivate });
  if (!check.ok) {
    const host = redactOutboundUrlHost(rawUrl);
    console.warn('[outbound] unsafe peer url skipped', { host, reason: check.reason });
    return { ok: false, reason: 'unsafe_url', host, detail: check.reason };
  }

  const timeoutMs = init.timeoutMs ?? OUTBOUND_PEER_DEFAULT_TIMEOUT_MS;
  const { timeoutMs: _timeoutMs, allowPrivate: _allowPrivate, headers: initHeaders, signal: _signal, ...rest } =
    init;

  const headers = new Headers(initHeaders);
  if (!headers.has('User-Agent')) {
    headers.set('User-Agent', OUTBOUND_PEER_UA);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(check.url.toString(), {
      ...rest,
      headers,
      signal: controller.signal,
      redirect: 'manual',
    });
    return { ok: true, response, url: check.url.toString(), host: check.url.host };
  } catch (err) {
    const aborted = controller.signal.aborted;
    const host = check.url.host;
    console.warn('[outbound] peer fetch failed', {
      host,
      aborted,
      err: err instanceof Error ? err.message : String(err),
    });
    return {
      ok: false,
      reason: aborted ? 'aborted' : 'network',
      host,
      detail: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}
