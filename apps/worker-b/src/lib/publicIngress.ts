/**
 * SDH-5：Worker B 公开 ingress 公共 helper（body 上限 + HMAC 转发 Worker A）。
 */
import { signRequest } from '@hailuo/shared-crypto';
import type { Env } from '../env.d';
import { passthroughResponse } from './passthroughResponse';

/** R-AUDIT-1：含 403（ticket / 鉴权类公开 ingress 错误） */
export type IngressErrorStatus = 400 | 403 | 413 | 503;

export function ingressErrorJson(
  status: IngressErrorStatus,
  error_code: string,
  message: string,
): Response {
  return Response.json({ ok: false, error_code, message }, { status });
}

/** 读取请求体并校验 UTF-8 字节上限 */
export async function readRawBodyWithLimit(
  req: Request,
  maxBytes: number,
): Promise<{ ok: true; rawBody: string } | { ok: false; status: 413 }> {
  let rawBody: string;
  try {
    rawBody = await req.text();
  } catch {
    return { ok: false, status: 413 };
  }
  if (new TextEncoder().encode(rawBody).byteLength > maxBytes) {
    return { ok: false, status: 413 };
  }
  return { ok: true, rawBody };
}

export function assertWorkerABinding(env: Env): Response | null {
  if (!env.WORKER_A) {
    return ingressErrorJson(503, 'WORKER_A_BINDING_MISSING', '上游服务暂不可用，请稍后再试');
  }
  if (!env.INTERNAL_FORWARD_SECRET) {
    return ingressErrorJson(503, 'INTERNAL_FORWARD_SECRET_MISSING', '上游服务暂不可用，请稍后再试');
  }
  return null;
}

/** Service Binding + HMAC v2 转发到 Worker A 内部路径 */
export async function forwardRawBodyToWorkerA(
  env: Env,
  options: { upstreamPath: string; method: 'POST' | 'DELETE'; rawBody: string },
): Promise<Response> {
  const upstreamUrl = `https://worker-a.internal${options.upstreamPath}`;
  const signedHeaders = await signRequest(
    { method: options.method, path: options.upstreamPath },
    options.rawBody,
    env.INTERNAL_FORWARD_SECRET!,
  );
  const upstream = await env.WORKER_A!.fetch(
    new Request(upstreamUrl, {
      method: options.method,
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Forward': 'hmac-v2',
        ...signedHeaders,
      },
      body: options.rawBody,
    }),
  );
  return passthroughResponse(upstream);
}

/** JSON body 读取并校验大小 */
export async function readJsonBodyWithLimit(
  req: Request,
  maxBytes: number,
): Promise<
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; status: 400 | 413 }
> {
  const raw = await readRawBodyWithLimit(req, maxBytes);
  if (!raw.ok) {
    return { ok: false, status: 413 };
  }
  try {
    const body = JSON.parse(raw.rawBody) as Record<string, unknown>;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return { ok: false, status: 400 };
    }
    return { ok: true, body };
  } catch {
    return { ok: false, status: 400 };
  }
}

/** JSON body 转发（interactions 等） */
export async function forwardJsonToWorkerA(
  env: Env,
  options: { upstreamPath: string; method: 'POST' | 'DELETE'; body: Record<string, unknown> },
): Promise<Response> {
  const rawBody = JSON.stringify(options.body);
  return forwardRawBodyToWorkerA(env, {
    upstreamPath: options.upstreamPath,
    method: options.method,
    rawBody,
  });
}
