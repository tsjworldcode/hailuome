/**
 * M5-B2 + M14-11：Worker A 站主 JWT 读路径从 B2 私有桶签名 GET（与 Worker B 读逻辑对齐）。
 */
import { AwsClient } from 'aws4fetch';

/** 与 mediaStorage.ts 同键；含读凭证，仅服务端使用 */
export const MEDIA_B2_CONFIG_KV_KEY = 'node:media_b2_config';

const B2_IMAGE_KEY_RE = /^b2:img_[a-f0-9]+$/;
const B2_MSG_KEY_RE = /^b2:msg_[a-f0-9]{16,64}$/;

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

/** 公开帖 img_ 与 Messaging msg_ 共用读路径。 */
export function parseB2MediaObjectKey(key: string): string | null {
  if (B2_IMAGE_KEY_RE.test(key) || B2_MSG_KEY_RE.test(key)) {
    return key.slice('b2:'.length);
  }
  return null;
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

export function pickSafeUpstreamHeaders(upstream: Headers): Headers {
  const out = new Headers();
  const contentType = upstream.get('Content-Type');
  if (contentType) out.set('Content-Type', contentType);
  const contentLength = upstream.get('Content-Length');
  if (contentLength) out.set('Content-Length', contentLength);
  const etag = upstream.get('ETag');
  if (etag) out.set('ETag', etag);
  out.set('Cache-Control', 'private, no-store');
  return out;
}
