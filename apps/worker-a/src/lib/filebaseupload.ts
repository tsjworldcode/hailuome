/**
 * Filebase S3 兼容上传（M5-FB）。
 * endpoint 默认 https://s3.filebase.io；region 默认 auto（非 B2 的 us-east-1）。
 */
import { AwsClient } from 'aws4fetch';

export interface FilebaseConfig {
  keyId: string;
  appKey: string;
  bucketName: string;
  endpoint: string;
  region?: string;
}

/** Filebase S3 兼容层 region；未显式传入时固定 auto */
export function resolveFilebaseRegion(config: FilebaseConfig): string {
  if (config.region?.trim()) return config.region.trim();
  return 'auto';
}

export async function uploadToFilebaseStream(
  config: FilebaseConfig,
  objectKey: string,
  stream: ReadableStream,
  contentType: string,
  contentLength: string,
): Promise<void> {
  const aws = new AwsClient({
    accessKeyId: config.keyId,
    secretAccessKey: config.appKey,
    service: 's3',
    region: resolveFilebaseRegion(config),
  });

  const url = `${config.endpoint}/${config.bucketName}/${objectKey}`;
  const response = await aws.fetch(url, {
    method: 'PUT',
    headers: {
      'Content-Type': contentType,
      'x-amz-content-sha256': 'UNSIGNED-PAYLOAD',
      'Content-Length': contentLength,
    },
    body: stream,
    // @ts-ignore duplex 为流式 PUT 所需
    duplex: 'half',
  });

  if (!response.ok) {
    const errBody = await response.text().catch(() => '');
    throw new Error(`Filebase 流式 PUT 失败 HTTP ${response.status}: ${errBody.slice(0, 200)}`);
  }
}

export async function deleteFilebaseObject(
  config: FilebaseConfig,
  objectKey: string,
): Promise<void> {
  const aws = new AwsClient({
    accessKeyId: config.keyId,
    secretAccessKey: config.appKey,
    service: 's3',
    region: resolveFilebaseRegion(config),
  });

  const url = `${config.endpoint}/${config.bucketName}/${objectKey}`;
  const response = await aws.fetch(url, { method: 'DELETE' });
  if (!response.ok && response.status !== 404) {
    const errBody = await response.text().catch(() => '');
    throw new Error(`Filebase DELETE 失败 HTTP ${response.status}: ${errBody.slice(0, 200)}`);
  }
}
