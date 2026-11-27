/**
 * B2 S3 兼容 ListObjectsV2：枚举 bucket 对象总字节数（M5-SR-P2b 低频校准）。
 * 单次 Worker 调用有子请求上限，默认最多 40 页（每页 1000 对象）。
 */
import { AwsClient } from 'aws4fetch';
import type { B2Config } from './b2upload';

export interface B2BucketUsageResult {
  readonly bytes: number;
  readonly objectCount: number;
  readonly pages: number;
  /** 因 maxPages 未扫完 bucket 时为 true */
  readonly truncated: boolean;
}

function resolveRegion(config: B2Config): string {
  if (config.region) return config.region;
  const m = config.endpoint.match(/s3\.([^.]+)\.backblazeb2\.com/);
  return m?.[1] ?? 'us-east-1';
}

/** 解析 S3 ListObjectsV2 XML 单页（Workers 无 DOM，用正则） */
export function parseListObjectsV2Page(xml: string): {
  bytes: number;
  count: number;
  truncated: boolean;
  nextToken: string | null;
} {
  let bytes = 0;
  let count = 0;
  const sizeRe = /<Size>(\d+)<\/Size>/g;
  let m: RegExpExecArray | null;
  while ((m = sizeRe.exec(xml)) !== null) {
    bytes += Number.parseInt(m[1], 10);
    count += 1;
  }
  const truncated = /<IsTruncated>\s*true\s*<\/IsTruncated>/i.test(xml);
  const tokenMatch = xml.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/);
  return { bytes, count, truncated, nextToken: tokenMatch?.[1] ?? null };
}

/** 分页列举 B2 bucket 用量；失败抛错由调用方 fail-soft */
export async function listB2BucketUsage(
  config: B2Config,
  opts?: { maxPages?: number },
): Promise<B2BucketUsageResult> {
  const maxPages = opts?.maxPages ?? 40;
  const aws = new AwsClient({
    accessKeyId: config.keyId,
    secretAccessKey: config.appKey,
    service: 's3',
    region: resolveRegion(config),
  });

  let totalBytes = 0;
  let totalCount = 0;
  let continuationToken: string | undefined;
  let pages = 0;
  let truncated = false;

  for (let page = 0; page < maxPages; page++) {
    const url = new URL(`${config.endpoint}/${config.bucketName}`);
    url.searchParams.set('list-type', '2');
    url.searchParams.set('max-keys', '1000');
    if (continuationToken) {
      url.searchParams.set('continuation-token', continuationToken);
    }

    const response = await aws.fetch(url.toString(), { method: 'GET' });
    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      throw new Error(`B2 ListObjectsV2 失败 HTTP ${response.status}: ${errBody.slice(0, 200)}`);
    }

    const xml = await response.text();
    const parsed = parseListObjectsV2Page(xml);
    totalBytes += parsed.bytes;
    totalCount += parsed.count;
    pages += 1;

    if (!parsed.truncated || !parsed.nextToken) {
      truncated = false;
      break;
    }
    continuationToken = parsed.nextToken;
    if (page === maxPages - 1) {
      truncated = true;
    }
  }

  return { bytes: totalBytes, objectCount: totalCount, pages, truncated };
}
