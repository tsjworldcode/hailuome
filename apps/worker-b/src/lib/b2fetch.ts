/**
 * M5-B2：Worker B 从 B2 私有桶签名 GET 并流式返回（不 302、不暴露 B2 URL）。
 */
import { AwsClient } from 'aws4fetch';

/** 与 Worker A mediaStorage.ts 同键；含读凭证，仅服务端使用 */
export const MEDIA_B2_CONFIG_KV_KEY = 'node:media_b2_config';

const B2_IMAGE_KEY_RE = /^b2:img_[a-f0-9]+$/;

export interface B2ReadConfig {
  key_id: string;
  app_key: string;
  bucket_name: string;
  endpoint: string;
  region?: string;
}

export function parseB2ImageObjectKey(key: string): string | null {
  if (!B2_IMAGE_KEY_RE.test(key)) return null;
  return key.slice('b2:'.length);
}

export function parseB2ReadConfig(raw: string | null): B2ReadConfig | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as Partial<B2ReadConfig>;
    if (
      typeof o.key_id !== 'string' ||
      typeof o.app_key !== 'string' ||
      typeof o.bucket_name !== 'string' ||
      typeof o.endpoint !== 'string' ||
      !o.key_id.trim() ||
      !o.app_key.trim() ||
      !o.bucket_name.trim() ||
      !o.endpoint.trim()
    ) {
      return null;
    }
    const cfg: B2ReadConfig = {
      key_id: o.key_id.trim(),
      app_key: o.app_key.trim(),
      bucket_name: o.bucket_name.trim(),
      endpoint: o.endpoint.trim(),
    };
    if (typeof o.region === 'string' && o.region.trim()) cfg.region = o.region.trim();
    return cfg;
  } catch {
    return null;
  }
}

function resolveRegion(config: B2ReadConfig): string {
  if (config.region) return config.region;
  const m = config.endpoint.match(/s3\.([^.]+)\.backblazeb2\.com/);
  return m?.[1] ?? 'us-east-1';
}

/** 向 B2 S3 兼容层发起签名 GET；调用方负责 status 映射与 header 过滤 */
export async function fetchB2Object(
  config: B2ReadConfig,
  objectKey: string,
): Promise<Response> {
  const aws = new AwsClient({
    accessKeyId: config.key_id,
    secretAccessKey: config.app_key,
    service: 's3',
    region: resolveRegion(config),
  });
  const url = `${config.endpoint}/${config.bucket_name}/${objectKey}`;
  return aws.fetch(url, { method: 'GET' });
}

/** 仅允许透传的安全响应头，避免泄漏 B2 域名或签名信息 */
export function pickSafeUpstreamHeaders(upstream: Headers): Headers {
  const out = new Headers();
  const contentType = upstream.get('Content-Type');
  if (contentType) out.set('Content-Type', contentType);
  const contentLength = upstream.get('Content-Length');
  if (contentLength) out.set('Content-Length', contentLength);
  const etag = upstream.get('ETag');
  if (etag) out.set('ETag', etag);
  return out;
}
