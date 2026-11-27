// M-REFACTOR-1b：HTTP 传输层 — baseUrl 注入、JWT、JSON envelope、blob
import { ApiError } from '../errors';
import { stripTrailingSlash } from '../auth';
import type { WorkerAClientOptions } from './types';

export interface WorkerATransport {
  readonly callPublic: <T>(path: string, init?: RequestInit) => Promise<T>;
  readonly callWithJwt: <T>(path: string, init?: RequestInit) => Promise<T>;
  readonly callWithJwtBlob: (path: string, init?: RequestInit) => Promise<ArrayBuffer>;
  readonly buildQuery: (params: Record<string, string | number | undefined>) => string;
}

/**
 * M-F1 · 单次写请求超时上限（毫秒）。
 *
 * 背景：此前 fetch 无超时，Worker A 网络黑洞（跨域被拦 / 节点掉线 / Pages 代理挂起）
 * 时 Promise 永不 settle，调用方的 `busy` 状态永不复位 → 弹窗按钮永久禁用（弹窗卡死）。
 * 加 AbortController 超时后，超时按 ApiError 抛出，调用方 finally 能正常收尾。
 */
export const WORKER_A_REQUEST_TIMEOUT_MS = 20_000;

/** 超时错误码（前端 i18n catalog 需有对应文案，否则回落服务端 message / 兜底文案）。 */
export const WORKER_A_TIMEOUT_ERROR_CODE = 'REQUEST_TIMEOUT';

async function requestJson<T>(
  fetchFn: typeof fetch,
  url: string,
  init?: RequestInit,
  timeoutMs: number = WORKER_A_REQUEST_TIMEOUT_MS,
): Promise<T> {
  // 已有外部 signal 时不覆盖（尊重调用方取消）；否则自建超时 signal
  const controller = new AbortController();
  const externalSignal = init?.signal ?? null;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    else externalSignal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  let resp: Response;
  try {
    resp = await fetchFn(url, { ...init, signal: controller.signal });
  } catch (err) {
    // 超时 abort 与网络失败区分：给调用方可区分的错误码，便于提示文案
    if (controller.signal.aborted) {
      throw new ApiError(0, { error_code: WORKER_A_TIMEOUT_ERROR_CODE }, '请求超时，请检查节点是否在线后重试');
    }
    throw new ApiError(0, { error_code: 'INTERNAL_ERROR' }, '无法连接节点 API 入口，请检查 Worker B 地址是否可用');
  } finally {
    clearTimeout(timer);
  }

  const text = await resp.text();
  let parsed: unknown = null;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }

  if (!resp.ok) {
    const body = (parsed ?? null) as { error_code?: string; message?: string } | null;
    throw new ApiError(resp.status, body);
  }
  return parsed as T;
}

export function buildQuery(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  const qs = search.toString();
  return qs.length > 0 ? `?${qs}` : '';
}

/** 由 createWorkerAClient 调用；域模块只接收 transport，不互引。 */
export function createWorkerATransport(opts: WorkerAClientOptions): WorkerATransport {
  const baseUrl = stripTrailingSlash(opts.baseUrl);
  const getJwt = opts.getJwt;
  const fetchFn: typeof fetch = opts.fetchFn ?? globalThis.fetch.bind(globalThis);

  async function callPublic<T>(path: string, init?: RequestInit): Promise<T> {
    return requestJson<T>(fetchFn, `${baseUrl}${path}`, init);
  }

  async function callWithJwt<T>(path: string, init?: RequestInit): Promise<T> {
    const jwt = getJwt();
    if (!jwt) {
      throw new ApiError(401, { error_code: 'UNAUTHORIZED' });
    }
    const headers = new Headers(init?.headers);
    headers.set('Authorization', `Bearer ${jwt}`);
    return requestJson<T>(fetchFn, `${baseUrl}${path}`, { ...init, headers });
  }

  async function callWithJwtBlob(path: string, init?: RequestInit): Promise<ArrayBuffer> {
    const jwt = getJwt();
    if (!jwt) {
      throw new ApiError(401, { error_code: 'UNAUTHORIZED' });
    }
    const headers = new Headers(init?.headers);
    headers.set('Authorization', `Bearer ${jwt}`);
    // M-F1：blob 路径同样加超时（此前同样可能永久挂起）
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), WORKER_A_REQUEST_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetchFn(`${baseUrl}${path}`, { ...init, headers, signal: controller.signal });
    } catch {
      if (controller.signal.aborted) {
        throw new ApiError(0, { error_code: WORKER_A_TIMEOUT_ERROR_CODE }, '请求超时，请检查节点是否在线后重试');
      }
      throw new ApiError(0, { error_code: 'INTERNAL_ERROR' }, '无法连接节点 API 入口，请检查 Worker B 地址是否可用');
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      let payload: { error_code?: string; message?: string } = { error_code: 'HTTP_ERROR' };
      try {
        payload = (await res.json()) as typeof payload;
      } catch {
        // 非 JSON 错误体
      }
      throw new ApiError(res.status, payload);
    }
    return res.arrayBuffer();
  }

  return { callPublic, callWithJwt, callWithJwtBlob, buildQuery };
}
