/**
 * 公钥指纹计算（对齐注册中心 hailuo-registry/lib/ids.ts computePubkeyFingerprint）。
 *
 * 算法：SHA-256(pubkey_hex 字符串的 UTF-8 字节) → 前 16 hex → 加 `key_` 前缀
 * 输入：Ed25519 公钥 hex 字符串（64 字符，32 字节 raw）
 * 输出：`key_<16 hex chars>`，如 `key_3a7f12bc9d084e1f`
 *
 * ⚠️ 不得修改此算法：注册中心以相同实现生成 pubkey_fingerprint，
 *    节点端必须与之完全一致，否则 /.well-known/hailuo-proof 校验失败。
 */

/**
 * 计算 Ed25519 公钥的短指纹。
 *
 * 使用 Web Crypto API（Workers + Node.js 18+ 均可用）。
 */
export async function computePubkeyFingerprint(pubkeyHex: string): Promise<string> {
  const data = new TextEncoder().encode(pubkeyHex);
  const hash = await crypto.subtle.digest('SHA-256', data);
  const bytes = new Uint8Array(hash);
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return `key_${hex.slice(0, 16)}`;
}
