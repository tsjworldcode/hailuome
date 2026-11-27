/**
 * M5-SR-P2c：R2 用量校准 — Cloudflare REST /usage API（首选）或 HAILUO_IMAGE_R2 binding list 回落。
 */

export interface R2CfUsageResult {
  readonly payloadBytes: number;
  readonly metadataBytes: number;
  readonly objectCount: number;
}

export interface R2BindingListUsageResult {
  readonly bytes: number;
  readonly objectCount: number;
  readonly pages: number;
  readonly truncated: boolean;
}

function parseUsageNumber(raw: unknown): number {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) return raw;
  if (typeof raw === 'string' && raw.trim()) {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return 0;
}

/** 解析 CF R2 bucket /usage 响应 */
export function parseR2CfUsageJson(json: unknown): R2CfUsageResult | null {
  if (!json || typeof json !== 'object') return null;
  const root = json as { success?: boolean; result?: Record<string, unknown> };
  if (root.success === false || !root.result) return null;
  const r = root.result;
  const payloadBytes = parseUsageNumber(r.payloadSize);
  const metadataBytes = parseUsageNumber(r.metadataSize);
  const objectCount = parseUsageNumber(r.objectCount);
  return { payloadBytes, metadataBytes, objectCount };
}

/** Cloudflare REST：GET /accounts/{id}/r2/buckets/{name}/usage */
export async function fetchR2CfUsageApi(
  accountId: string,
  bucketName: string,
  apiToken: string,
): Promise<R2CfUsageResult> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/r2/buckets/${encodeURIComponent(bucketName)}/usage`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${apiToken}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`R2 CF usage API 失败 HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const parsed = parseR2CfUsageJson(await res.json());
  if (!parsed) {
    throw new Error('R2 CF usage API 响应格式无效');
  }
  return parsed;
}

/** HAILUO_IMAGE_R2 binding 分页 list（无 CF API token 时的回落路径） */
export async function listR2BindingUsage(
  bucket: R2Bucket,
  opts?: { maxPages?: number },
): Promise<R2BindingListUsageResult> {
  const maxPages = opts?.maxPages ?? 40;
  let totalBytes = 0;
  let totalCount = 0;
  let cursor: string | undefined;
  let pages = 0;
  let truncated = false;

  for (let page = 0; page < maxPages; page++) {
    const listed = await bucket.list({ limit: 1000, cursor });
    for (const obj of listed.objects) {
      totalBytes += obj.size;
      totalCount += 1;
    }
    pages += 1;
    if (!listed.truncated || !listed.cursor) {
      truncated = false;
      break;
    }
    cursor = listed.cursor;
    if (page === maxPages - 1) {
      truncated = true;
    }
  }

  return { bytes: totalBytes, objectCount: totalCount, pages, truncated };
}
