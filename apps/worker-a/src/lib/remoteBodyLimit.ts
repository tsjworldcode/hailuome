/**
 * R-AUDIT-2：远端 HTTP 响应读取硬上限（防恶意 Content-Length 缺失 / 过大 body）。
 */

export type ReadBodyWithLimitResult =
  | { ok: true; bytes: ArrayBuffer }
  | { ok: false; reason: 'too_large' | 'read_failed' | 'empty' };

/** 将 hex 小写 SHA-256 与字节比对。 */
export async function sha256HexOfBytes(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * 先看 Content-Length（若声明且超限则拒绝），再用 reader 累计字节，超过 maxBytes 中止。
 */
export async function readResponseBodyWithLimit(
  res: Response,
  maxBytes: number,
): Promise<ReadBodyWithLimitResult> {
  if (!Number.isFinite(maxBytes) || maxBytes < 1) {
    return { ok: false, reason: 'too_large' };
  }

  const clRaw = res.headers.get('content-length');
  if (clRaw != null && clRaw.trim() !== '') {
    const declared = Number.parseInt(clRaw.trim(), 10);
    if (Number.isFinite(declared) && declared > maxBytes) {
      return { ok: false, reason: 'too_large' };
    }
  }

  const reader = res.body?.getReader();
  if (!reader) {
    // 无 body stream 时回退一次性读，仍做长度检查
    try {
      const buf = await res.arrayBuffer();
      if (buf.byteLength === 0) return { ok: false, reason: 'empty' };
      if (buf.byteLength > maxBytes) return { ok: false, reason: 'too_large' };
      return { ok: true, bytes: buf };
    } catch {
      return { ok: false, reason: 'read_failed' };
    }
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          /* ignore */
        }
        return { ok: false, reason: 'too_large' };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, reason: 'read_failed' };
  }

  if (total === 0) return { ok: false, reason: 'empty' };

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes: out.buffer };
}

/** 校验宣称 size / sha256（二者均可选；给出则必须匹配）。 */
export async function assertMediaIntegrity(
  bytes: ArrayBuffer,
  opts: { expectedSizeBytes?: number; expectedSha256Hex?: string },
): Promise<boolean> {
  if (
    typeof opts.expectedSizeBytes === 'number' &&
    Number.isFinite(opts.expectedSizeBytes) &&
    opts.expectedSizeBytes >= 0 &&
    bytes.byteLength !== opts.expectedSizeBytes
  ) {
    return false;
  }
  if (opts.expectedSha256Hex) {
    const want = opts.expectedSha256Hex.trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(want)) return false;
    const got = await sha256HexOfBytes(bytes);
    if (got !== want) return false;
  }
  return true;
}
