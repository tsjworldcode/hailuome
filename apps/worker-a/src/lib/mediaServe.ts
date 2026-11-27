/**
 * M14-11：站主 JWT 读媒体对象（owner-only 时 Web 不走 Worker B /img/）。
 * 支持 kv / r2 / b2 / filebase 前缀，与 Worker B GET /img/:key 分支对齐。
 */
import type { Env } from '../env';
import {
  MEDIA_B2_CONFIG_KV_KEY,
  fetchB2Object,
  parseB2MediaObjectKey,
  parseB2ReadConfig,
  pickSafeUpstreamHeaders,
} from './b2fetch';
import {
  MEDIA_FILEBASE_CONFIG_KV_KEY,
  fetchFilebaseObject,
  parseFilebaseMediaObjectKey,
  parseFilebaseReadConfig,
  pickSafeUpstreamHeaders as pickFilebaseHeaders,
} from './filebasefetch';

const OWNER_IMAGE_CACHE = 'private, no-store';

function imageNotFound(): Response {
  return Response.json(
    { ok: false, error_code: 'IMAGE_NOT_FOUND', message: '图片不存在' },
    { status: 404, headers: { 'Cache-Control': OWNER_IMAGE_CACHE } },
  );
}

/** 按 internal key 读取二进制；仅站主 JWT 路由调用 */
export async function serveMediaObject(env: Env, key: string): Promise<Response> {
  if (key.startsWith('kv:')) {
    const result = await env.IMAGE_KV.getWithMetadata<{ contentType: string }>(
      key,
      'arrayBuffer',
    );
    if (!result.value) return imageNotFound();
    const headers = new Headers({
      'Content-Type': result.metadata?.contentType ?? 'application/octet-stream',
      'Cache-Control': OWNER_IMAGE_CACHE,
    });
    return new Response(result.value as ArrayBuffer, { headers });
  }

  if (key.startsWith('r2:')) {
    if (!env.HAILUO_IMAGE_R2) return imageNotFound();
    const obj = await env.HAILUO_IMAGE_R2.get(key).catch(() => null);
    if (!obj) return imageNotFound();
    const headers = new Headers({
      'Content-Type': obj.httpMetadata?.contentType ?? 'application/octet-stream',
      'Cache-Control': OWNER_IMAGE_CACHE,
    });
    return new Response(obj.body, { headers });
  }

  if (key.startsWith('filebase:')) {
    const objectKey = parseFilebaseMediaObjectKey(key);
    if (!objectKey) return imageNotFound();
    const rawConfig = await env.STATE_KV.get(MEDIA_FILEBASE_CONFIG_KV_KEY);
    const filebaseConfig = parseFilebaseReadConfig(rawConfig);
    if (!filebaseConfig) return imageNotFound();

    let upstream: Response;
    try {
      upstream = await fetchFilebaseObject(filebaseConfig, objectKey);
    } catch (err) {
      console.error('[worker-a/images] Filebase 上游请求失败', err);
      return imageNotFound();
    }
    if (upstream.status === 404 || upstream.status === 403 || !upstream.ok || !upstream.body) {
      return imageNotFound();
    }
    return new Response(upstream.body, {
      status: 200,
      headers: pickFilebaseHeaders(upstream.headers),
    });
  }

  if (key.startsWith('b2:')) {
    const objectKey = parseB2MediaObjectKey(key);
    if (!objectKey) return imageNotFound();
    const rawConfig = await env.STATE_KV.get(MEDIA_B2_CONFIG_KV_KEY);
    const b2Config = parseB2ReadConfig(rawConfig);
    if (!b2Config) return imageNotFound();

    let upstream: Response;
    try {
      upstream = await fetchB2Object(b2Config, objectKey);
    } catch (err) {
      console.error('[worker-a/images] B2 上游请求失败', err);
      return imageNotFound();
    }
    if (upstream.status === 404 || upstream.status === 403 || !upstream.ok || !upstream.body) {
      return imageNotFound();
    }
    return new Response(upstream.body, {
      status: 200,
      headers: pickSafeUpstreamHeaders(upstream.headers),
    });
  }

  return imageNotFound();
}
