/**
 * Backblaze B2 图片上传工具（M5-B2）。
 *
 * 使用 aws4fetch 对 B2 S3 兼容 API 进行 AWS Signature V4 签名，
 * 无需额外 Cloudflare binding，仅占用 1 个 fetch 子请求。
 *
 * 设计原则：
 *   - 调用方检查 env 字段是否齐全后再调用本函数（非空断言由调用方保证）
 *   - 本函数只负责签名 + 上传，失败时抛出异常由调用方捕获并降级 KV（F-13）
 */

import { AwsClient } from 'aws4fetch';

export interface B2Config {
  keyId: string;
  appKey: string;
  bucketName: string;
  /** B2 S3 兼容端点，格式：https://s3.<region>.backblazeb2.com（或自定义域名） */
  endpoint: string;
  /** 可选 region 覆盖（默认从 endpoint 推断；自定义域名场景必须显式传入 M5-C6） */
  region?: string;
}

/**
 * 推断 B2 S3 region：
 *   1. 优先使用 config.region 覆盖（支持自定义域名 / CDN 前置场景）
 *   2. 其次从标准 endpoint URL 提取（https://s3.us-west-004.backblazeb2.com → us-west-004）
 *   3. 都不可得 → 回退 us-east-1（B2 S3 兼容层接受此值）
 */
function resolveRegion(config: B2Config): string {
  if (config.region) return config.region;
  const m = config.endpoint.match(/s3\.([^.]+)\.backblazeb2\.com/);
  return m?.[1] ?? 'us-east-1';
}

/**
 * 流式上传到 B2 S3 兼容存储（M5-C4b：大文件根本解法）。
 *
 * 请求 body 作为 ReadableStream 直接管道到 B2，完全不缓冲进 Worker 内存。
 * 解决问题：
 *   - 内存：不再将整个文件装入 ArrayBuffer（128MB Workers 内存上限）
 *   - CPU：UNSIGNED-PAYLOAD 跳过 Body 哈希 + 流式传输无 JS 计算
 *
 * @param config        B2 配置
 * @param objectKey     B2 内部对象 key（不含 b2: 前缀）
 * @param stream        请求体 ReadableStream（来自 c.req.raw.body）
 * @param contentType   MIME 类型
 * @param contentLength 文件字节数字符串（必填，B2 S3 PUT 不支持 chunked encoding）
 * @throws 上传失败时抛出 Error
 */
export async function uploadToB2Stream(
  config: B2Config,
  objectKey: string,
  stream: ReadableStream,
  contentType: string,
  contentLength: string,
): Promise<void> {
  // M5-C7：Content-Length 是必填参数（B2 S3 PUT 不支持 chunked encoding）。
  // 调用方（routes/images.ts）需负责在 路由进入本函数前检查请求头。
  const aws = new AwsClient({
    accessKeyId: config.keyId,
    secretAccessKey: config.appKey,
    service: 's3',
    region: resolveRegion(config),
  });

  const url = `${config.endpoint}/${config.bucketName}/${objectKey}`;
  const response = await aws.fetch(url, {
    method: 'PUT',
    headers: {
      'Content-Type': contentType,
      // 流式传输必须跳过 Body 哈希，否则 aws4fetch 会尝试读取 stream 计算 SHA256
      'x-amz-content-sha256': 'UNSIGNED-PAYLOAD',
      'Content-Length': contentLength,
    },
    body: stream,
    // duplex: 'half' 是 fetch streaming request body 的必要标志
    // @ts-ignore - TypeScript 类型定义尚未覆盖此标准字段
    duplex: 'half',
  });

  if (!response.ok) {
    const errBody = await response.text().catch(() => '');
    throw new Error(`B2 流式 PUT 失败 HTTP ${response.status}: ${errBody.slice(0, 200)}`);
  }
}

/** 删除 B2 S3 兼容对象；用于私有附件删除的尽力清理。 */
export async function deleteB2Object(
  config: B2Config,
  objectKey: string,
): Promise<void> {
  const aws = new AwsClient({
    accessKeyId: config.keyId,
    secretAccessKey: config.appKey,
    service: 's3',
    region: resolveRegion(config),
  });

  const url = `${config.endpoint}/${config.bucketName}/${objectKey}`;
  const response = await aws.fetch(url, { method: 'DELETE' });
  if (!response.ok && response.status !== 404) {
    const errBody = await response.text().catch(() => '');
    throw new Error(`B2 DELETE 失败 HTTP ${response.status}: ${errBody.slice(0, 200)}`);
  }
}
