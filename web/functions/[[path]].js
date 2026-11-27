import deployConfig from './_worker-b-config.js';
import { isAllowedOwnerPath, isPublicWorkerBPath } from './_owner-allowlist.js';

/** 与 @hailuo/shared-types PUBLIC_WORKER_B_URL_KV_KEY 保持同值（Pages Functions 不引 workspace 包）。 */
const PUBLIC_WORKER_B_URL_KV_KEY = 'public:canonical_worker_b_url';
const PUBLIC_BASE_URL_CACHE_TTL_MS = 60_000;

/** M7-30g-2：isolate 内缓存 KV/回落解析结果，换域后最多约 60s 旧代理。 */
let cachedPublicBase = { url: '', expiresAt: 0 };

function trimUrl(value) {
  return typeof value === 'string' ? value.trim().replace(/\/+$/, '') : '';
}

/**
 * 公开读代理目标：STATE_KV 镜像 → 构建期 deployConfig → 平台 env。
 * 首次绑定 STATE_KV 前仍可靠构建期 URL；换域后以 KV 为准，免 redeploy Web。
 * M9-AUDIT-3：三者皆空 → 调用方返回 PAGES_PROXY_NOT_CONFIGURED（旧部署未绑 KV 且空配置会直接失败）。
 */
async function resolvePublicWorkerBTargetBase(env) {
  const now = Date.now();
  if (cachedPublicBase.url && now < cachedPublicBase.expiresAt) {
    return cachedPublicBase.url;
  }

  let fromKv = '';
  try {
    if (env?.STATE_KV?.get) {
      const raw = await env.STATE_KV.get(PUBLIC_WORKER_B_URL_KV_KEY);
      fromKv = trimUrl(raw);
    }
  } catch (err) {
    console.error('[pages/public-proxy] STATE_KV 读取 canonical worker_b_url 失败', err);
  }

  const url =
    fromKv ||
    trimUrl(deployConfig?.worker_b_url) ||
    trimUrl(env?.PUBLIC_WORKER_B_URL) ||
    '';

  cachedPublicBase = { url, expiresAt: now + PUBLIC_BASE_URL_CACHE_TTL_MS };
  return url;
}

function errorJson(status, code, message) {
  return Response.json({ ok: false, error_code: code, message }, { status });
}

function bytesToHex(bytes) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function randomNonce() {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

/** M13-6：isolate 内复用 HMAC CryptoKey（对齐 shared-crypto keyCache 语义） */
const hmacKeyCache = new Map();

async function getHmacSigningKey(secret) {
  const cacheKey = `hmac-sha256:${secret}`;
  let promise = hmacKeyCache.get(cacheKey);
  if (promise) return promise;
  const encoder = new TextEncoder();
  promise = crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  hmacKeyCache.set(cacheKey, promise);
  promise.catch(() => {
    if (hmacKeyCache.get(cacheKey) === promise) {
      hmacKeyCache.delete(cacheKey);
    }
  });
  return promise;
}

async function signOwnerRequest({ method, pathWithQuery, bodyText, secret, clientIp = '' }) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = randomNonce();
  const encoder = new TextEncoder();
  const key = await getHmacSigningKey(secret);
  // M7-30h-4：v3 绑 clientIp，Worker A 验签通过后才用于 login_attempts
  const input = `${method} ${pathWithQuery}\n${timestamp}:${nonce}:${bodyText}:${clientIp}`;
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(input));
  return {
    'X-Timestamp': timestamp,
    'X-Nonce': nonce,
    'X-Signature': bytesToHex(new Uint8Array(signature)),
  };
}

function copyOwnerHeaders(request) {
  const incoming = request.headers;
  const headers = new Headers();
  const contentType = incoming.get('Content-Type');
  const contentLength = incoming.get('Content-Length');
  const authorization = incoming.get('Authorization');
  const accept = incoming.get('Accept');
  // M34-4b：转发 UA，供站主会话解析系统族（否则会落成 unknown）
  const userAgent = incoming.get('User-Agent');

  if (contentType) headers.set('Content-Type', contentType);
  // Pages Owner Gateway 只保留 Worker A 需要的浏览器头，避免把公开代理内部头带入写层。
  if (contentLength) headers.set('Content-Length', contentLength);
  if (authorization) headers.set('Authorization', authorization);
  if (accept) headers.set('Accept', accept);
  if (userAgent) headers.set('User-Agent', userAgent);
  return headers;
}

function buildWorkerBRequest(request, targetBase) {
  const incoming = new URL(request.url);
  const target = new URL(`${incoming.pathname}${incoming.search}`, `${targetBase}/`);
  const headers = new Headers(request.headers);
  headers.set('X-Hailuo-Pages-Proxy', 'worker-b-public');

  return new Request(target.toString(), {
    method: request.method,
    headers,
    body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
    redirect: 'manual',
  });
}

/** 公开读优先 Service Binding（避免 workers.dev 公网不可达）；回落公网 URL。 */
async function forwardToWorkerB(context, request, targetBase) {
  const incoming = new URL(request.url);
  const pathWithQuery = `${incoming.pathname}${incoming.search}`;
  const method = request.method.toUpperCase();
  const body =
    method === 'GET' || method === 'HEAD' ? undefined : request.body;

  if (context.env?.WORKER_B?.fetch) {
    const headers = new Headers(request.headers);
    headers.set('X-Hailuo-Pages-Proxy', 'worker-b-binding');
    try {
      return await context.env.WORKER_B.fetch(
        new Request(`https://worker-b.internal${pathWithQuery}`, {
          method,
          headers,
          body,
          redirect: 'manual',
        }),
      );
    } catch (err) {
      console.error('[pages/public-proxy] WORKER_B Service Binding 失败，回落公网 fetch', err);
    }
  }

  if (!targetBase) {
    return errorJson(
      503,
      'PAGES_PROXY_NOT_CONFIGURED',
      'Pages 公开读代理未配置 Worker B 地址，请绑定 STATE_KV / WORKER_B 或重新部署 Web',
    );
  }
  return fetch(buildWorkerBRequest(request, targetBase));
}

/**
 * M7-36-h6a：Owner Gateway POST/PUT/PATCH 须预读 body 为 ArrayBuffer。
 * HMAC v3 签名材料与 WORKER_A.fetch 转发必须共用同一份字节，禁止直接透传 ReadableStream。
 */
async function readOwnerRequestBody(request, method) {
  if (method === 'GET' || method === 'HEAD') {
    return { bodyBytes: undefined, bodyText: '' };
  }
  try {
    const bodyBytes = await request.arrayBuffer();
    const bodyText = bodyBytes.byteLength > 0 ? new TextDecoder().decode(bodyBytes) : '';
    return { bodyBytes, bodyText };
  } catch (err) {
    console.error('[pages/owner-gateway] failed to read request body', err);
    return { error: errorJson(400, 'INVALID_BODY', '请求体读取失败') };
  }
}

async function forwardToWorkerA(context, url, method) {
  if (!context.env?.WORKER_A) {
    return errorJson(503, 'OWNER_GATEWAY_BINDING_MISSING', '站主通道未绑定 Worker A，请检查 Pages Functions Service Binding');
  }
  if (!context.env?.INTERNAL_FORWARD_SECRET) {
    return errorJson(503, 'INTERNAL_FORWARD_SECRET_MISSING', '站主通道缺少内部签名密钥，请检查 Pages 环境变量');
  }

  const bodyRead = await readOwnerRequestBody(context.request, method);
  if (bodyRead.error) {
    return bodyRead.error;
  }
  const { bodyBytes, bodyText } = bodyRead;

  const pathWithQuery = `${url.pathname}${url.search}`;
  const clientIp = (context.request.headers.get('CF-Connecting-IP') ?? '').trim();
  const signedHeaders = await signOwnerRequest({
    method,
    pathWithQuery,
    bodyText,
    secret: context.env.INTERNAL_FORWARD_SECRET,
    clientIp,
  });
  const headers = copyOwnerHeaders(context.request);
  // M9-23/M9-24：Web 站主写层经 Pages Service Binding 直达 Worker A，白名单来自 SSOT。
  headers.set('X-Hailuo-Pages-Proxy', 'owner-gateway');
  if (clientIp) headers.set('X-Hailuo-Client-Ip', clientIp);
  // M7-30k-3：v3 签名材料对应 hmac-v3 marker（Service Binding 内部转发仍用 hmac-v2）
  headers.set('X-Internal-Forward', 'hmac-v3');
  headers.set('X-Timestamp', signedHeaders['X-Timestamp']);
  headers.set('X-Nonce', signedHeaders['X-Nonce']);
  headers.set('X-Signature', signedHeaders['X-Signature']);

  try {
    return await context.env.WORKER_A.fetch(
      new Request(`https://worker-a.internal${pathWithQuery}`, {
        method,
        headers,
        body: bodyBytes,
        redirect: 'manual',
      }),
    );
  } catch (err) {
    console.error('[pages/owner-gateway] Service Binding call failed', err);
    return errorJson(502, 'OWNER_GATEWAY_UPSTREAM_ERROR', '站主写层服务暂时不可达，请稍后再试');
  }
}

/** Pages 同源网关：站主写层走 Worker A Service Binding，公开读/外部协议仍走 Worker B。 */
export async function onRequest(context) {
  const url = new URL(context.request.url);
  const method = context.request.method.toUpperCase();

  if (isAllowedOwnerPath(method, url.pathname)) {
    return forwardToWorkerA(context, url, method);
  }

  if (isPublicWorkerBPath(url.pathname)) {
    const targetBase = await resolvePublicWorkerBTargetBase(context.env);
    return forwardToWorkerB(context, context.request, targetBase);
  }

  // 中文注释：/api|/auth 形态但未进白名单时不要 next() 出 HTML，否则前端把失败当成「点了没反应」
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/')) {
    return errorJson(
      403,
      'OWNER_GATEWAY_PATH_DENIED',
      `站主网关未放行 ${method} ${url.pathname}，请检查 Owner Gateway allowlist`,
    );
  }

  return context.next();
}
