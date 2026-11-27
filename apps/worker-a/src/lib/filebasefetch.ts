/**
 * M5-FB + M14-11：Worker A 站主 JWT 读路径从 Filebase 私有桶签名 GET。
 */
import { AwsClient } from 'aws4fetch';

export const MEDIA_FILEBASE_CONFIG_KV_KEY = 'node:media_filebase_config';

const FILEBASE_IMAGE_KEY_RE = /^filebase:img_[a-f0-9]+$/;
const FILEBASE_MSG_KEY_RE = /^filebase:msg_[a-f0-9]{16,64}$/;

export interface FilebaseReadConfig {
  key_id: string;
  app_key: string;
  bucket_name: string;
  endpoint: string;
  region?: string;
}

function resolveFilebaseRegion(config: FilebaseReadConfig): string {
  if (config.region?.trim()) return config.region.trim();
  return 'auto';
}

export function parseFilebaseImageObjectKey(key: string): string | null {
  if (!FILEBASE_IMAGE_KEY_RE.test(key)) return null;
  return key.slice('filebase:'.length);
}

/** 公开帖 img_ 与 Messaging msg_ 共用读路径。 */
export function parseFilebaseMediaObjectKey(key: string): string | null {
  if (FILEBASE_IMAGE_KEY_RE.test(key) || FILEBASE_MSG_KEY_RE.test(key)) {
    return key.slice('filebase:'.length);
  }
  return null;
}

export function parseFilebaseReadConfig(raw: string | null): FilebaseReadConfig | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as Partial<FilebaseReadConfig>;
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
    const cfg: FilebaseReadConfig = {
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

export async function fetchFilebaseObject(
  config: FilebaseReadConfig,
  objectKey: string,
): Promise<Response> {
  const aws = new AwsClient({
    accessKeyId: config.key_id,
    secretAccessKey: config.app_key,
    service: 's3',
    region: resolveFilebaseRegion(config),
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
