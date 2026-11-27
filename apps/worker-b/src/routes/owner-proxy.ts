/**
 * @deprecated since M9-23; migrate to web/functions/[[path]].js + Owner Gateway
 *
 * M8-11：Worker B 站主写层代理（M9-23 后仅 compat 降级路径）。
 *
 * 浏览器只访问公开 Worker B。Worker B 仅把 SSOT 白名单内的站主接口
 * 通过 Service Binding 转发到 Worker A，让 Worker A 可以在生产关闭公网 workers.dev。
 *
 * 新部署默认 `OWNER_PROXY_MODE=disabled`（410）；仅旧站显式 `compat` 时保留本路径。
 */
import type { Context } from 'hono';
import { signOwnerGatewayRequest, signRequest } from '@hailuo/shared-crypto';
import { INTERNAL_FORWARD_MARKER_V2, INTERNAL_FORWARD_MARKER_V3 } from '@hailuo/shared-types';
import { isAllowedOwnerPath } from '@hailuo/shared-utils';
import type { Env } from '../env.d';
import { passthroughResponse } from './follower-tokens';

type OwnerProxyContext = Context<{ Bindings: Env }>;

/** isolate 内只 warn 一次，避免 compat 热路径刷屏 */
let ownerProxyDeprecationWarned = false;

/** 契约/单测：重置 deprecation warn 门闩 */
export function resetOwnerProxyDeprecationWarnForTests(): void {
  ownerProxyDeprecationWarned = false;
}

function copyForwardHeaders(c: OwnerProxyContext): Headers {
  const headers = new Headers();
  const contentType = c.req.header('Content-Type');
  const contentLength = c.req.header('Content-Length');
  const authorization = c.req.header('Authorization');
  const accept = c.req.header('Accept');
  // M34-4b：转发 UA，供站主会话解析系统族（否则会落成 unknown）
  const userAgent = c.req.header('User-Agent');

  if (contentType) headers.set('Content-Type', contentType);
  // 浏览器端不能手动设置 Content-Length；代理层保留平台实际收到的长度，供 B2 上传链路使用。
  if (contentLength) headers.set('Content-Length', contentLength);
  if (authorization) headers.set('Authorization', authorization);
  if (accept) headers.set('Accept', accept);
  if (userAgent) headers.set('User-Agent', userAgent);
  return headers;
}

function errorJson(c: OwnerProxyContext, status: 400 | 410 | 502 | 503, code: string, message: string): Response {
  return c.json({ ok: false, error_code: code, message }, status);
}

function isOwnerProxyCompatEnabled(env: Env): boolean {
  return env.OWNER_PROXY_MODE === 'compat';
}

function warnOwnerProxyDeprecatedOnce(): void {
  if (ownerProxyDeprecationWarned) return;
  ownerProxyDeprecationWarned = true;
  console.warn('[hailuo] worker-b owner-proxy 已废弃，请迁到 Owner Gateway');
}

async function writeWorkerBProxyLog(
  c: OwnerProxyContext,
  input: {
    level: 'info' | 'warn' | 'error';
    event: string;
    message: string;
    details?: Record<string, unknown>;
  },
): Promise<void> {
  if (!c.env.WORKER_A || !c.env.INTERNAL_FORWARD_SECRET) return;

  const body = JSON.stringify({
    source: 'worker-b-proxy',
    level: input.level,
    event: input.event,
    message: input.message,
    details: input.details ?? {},
  });
  const signedHeaders = await signRequest(
    { method: 'POST', path: '/api/internal/operation-logs' },
    body,
    c.env.INTERNAL_FORWARD_SECRET,
  );

  try {
    await c.env.WORKER_A.fetch(
      new Request('https://worker-a.internal/api/internal/operation-logs', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Forward': INTERNAL_FORWARD_MARKER_V2,
          ...signedHeaders,
        },
        body,
      }),
    );
  } catch (err) {
    console.error('[worker-b/owner-proxy] failed to write operation log', err);
  }
}

export async function ownerProxyHandler(c: OwnerProxyContext): Promise<Response> {
  if (!isOwnerProxyCompatEnabled(c.env)) {
    // M9-23：站主写层默认迁出 Worker B；仅旧部署显式 OWNER_PROXY_MODE=compat 时保留降级路径。
    return errorJson(c, 410, 'OWNER_PROXY_DISABLED', '站主写层代理已迁移到 Pages Owner Gateway');
  }

  warnOwnerProxyDeprecatedOnce();

  if (!c.env.WORKER_A) {
    console.error('[worker-b/owner-proxy] env.WORKER_A Service Binding is missing');
    return errorJson(c, 503, 'WORKER_A_BINDING_MISSING', '写层服务暂不可用，请稍后再试');
  }
  if (!c.env.INTERNAL_FORWARD_SECRET) {
    console.error('[worker-b/owner-proxy] env.INTERNAL_FORWARD_SECRET is missing');
    return errorJson(c, 503, 'INTERNAL_FORWARD_SECRET_MISSING', '写层服务暂不可用，请稍后再试');
  }

  const url = new URL(c.req.url);
  const method = c.req.method.toUpperCase();
  const pathWithQuery = `${url.pathname}${url.search}`;

  if (!isAllowedOwnerPath(method, url.pathname)) {
    return errorJson(c, 400, 'OWNER_PROXY_PATH_NOT_ALLOWED', '该写层接口不允许公开代理');
  }

  let bodyBytes: ArrayBuffer | undefined;
  if (method !== 'GET' && method !== 'HEAD') {
    try {
      bodyBytes = await c.req.arrayBuffer();
    } catch (err) {
      console.error('[worker-b/owner-proxy] failed to read request body', err);
      await writeWorkerBProxyLog(c, {
        level: 'warn',
        event: 'owner_proxy_body_read_failed',
        message: err instanceof Error ? err.message : String(err),
        details: { method, path: url.pathname },
      });
      return errorJson(c, 400, 'INVALID_BODY', '请求体读取失败');
    }
  }

  const forwardHeaders = copyForwardHeaders(c);
  const bodyText = bodyBytes ? new TextDecoder().decode(bodyBytes) : '';
  const clientIp = (c.req.header('CF-Connecting-IP') ?? '').trim();
  const signedHeaders = await signOwnerGatewayRequest(
    { method, path: pathWithQuery },
    bodyText,
    clientIp,
    c.env.INTERNAL_FORWARD_SECRET,
  );
  // M7-30i-1：compat 路径与 Pages 同用 HMAC v3 绑 clientIp，供 Worker A login_attempts 分桶
  forwardHeaders.set('X-Hailuo-Owner-Proxy', 'compat');
  if (clientIp) forwardHeaders.set('X-Hailuo-Client-Ip', clientIp);
  forwardHeaders.set('X-Internal-Forward', INTERNAL_FORWARD_MARKER_V3);
  forwardHeaders.set('X-Timestamp', signedHeaders['X-Timestamp']);
  forwardHeaders.set('X-Nonce', signedHeaders['X-Nonce']);
  forwardHeaders.set('X-Signature', signedHeaders['X-Signature']);

  let upstream: Response;
  try {
    upstream = await c.env.WORKER_A.fetch(
      new Request(`https://worker-a.internal${pathWithQuery}`, {
        method,
        headers: forwardHeaders,
        body: bodyBytes,
      }),
    );
  } catch (err) {
    console.error('[worker-b/owner-proxy] Service Binding call failed', err);
    await writeWorkerBProxyLog(c, {
      level: 'error',
      event: 'owner_proxy_service_binding_failed',
      message: err instanceof Error ? err.message : String(err),
      details: { method, path: url.pathname },
    });
    return errorJson(c, 502, 'UPSTREAM_ERROR', '写层服务暂时不可达，请稍后再试');
  }

  if (upstream.status >= 500) {
    const upstreamText = await upstream.clone().text().catch(() => '');
    await writeWorkerBProxyLog(c, {
      level: 'error',
      event: 'owner_proxy_upstream_5xx',
      message: `Worker A 返回 ${upstream.status}`,
      details: {
        method,
        path: url.pathname,
        status: upstream.status,
        body: upstreamText.slice(0, 500),
      },
    });
  }

  return passthroughResponse(upstream);
}

export const __testOnlyIsOwnerProxyCompatEnabled = isOwnerProxyCompatEnabled;
