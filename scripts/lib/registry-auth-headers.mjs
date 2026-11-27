/**
 * NCF-HS-3：脚本侧注册中心鉴权头（与 Worker A registryAuthHandle / registryRouter 对齐）。
 *
 * - normalize：trim + lower + 去前导 @ / 截断 @regN；**保留 `_`**
 * - Header 值：`encodeURIComponent(normalize(...))`（中文 ByteString 安全）
 * ❌ 禁止对鉴权 handle 做 `_→-`（那是加好友本地段规则，会错片）
 */

/** @param {string} raw */
export function normalizeAuthHandleLocal(raw) {
  let s = String(raw ?? '')
    .trim()
    .toLowerCase();
  if (!s) return null;
  while (s.startsWith('@')) {
    s = s.slice(1).trim();
  }
  const at = s.indexOf('@');
  if (at >= 0) {
    s = s.slice(0, at).trim();
  }
  return s || null;
}

/**
 * 写入 `X-Hailuo-Node-Handle` 的值；非法/空 → null（调用方可省略头，对齐中心软窗口「缺头」）。
 * @param {string} raw
 * @returns {string | null}
 */
export function encodeRegistryHandleHeader(raw) {
  const local = normalizeAuthHandleLocal(raw);
  if (!local) return null;
  return encodeURIComponent(local);
}

/**
 * 在已有 headers 上补 Handle（有合法 handle 才写入）。
 * @param {Record<string, string>} headers
 * @param {string} [handleRaw]
 * @returns {Record<string, string>}
 */
export function withRegistryHandleHeader(headers, handleRaw) {
  const encoded = encodeRegistryHandleHeader(handleRaw ?? '');
  if (encoded) {
    headers['X-Hailuo-Node-Handle'] = encoded;
  }
  return headers;
}

/**
 * 从常见 env / 参数解析脚本用 handle（优先 NODE_HANDLE，再 BOOTSTRAP_HANDLE）。
 * @param {NodeJS.ProcessEnv} [env]
 */
export function resolveScriptAuthHandle(env = process.env) {
  return (
    (env.NODE_HANDLE ?? '').trim() ||
    (env.BOOTSTRAP_HANDLE ?? '').trim() ||
    (env.R_MSG_1C_HANDLE ?? '').trim() ||
    ''
  );
}
