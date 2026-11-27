/**
 * 生成指定字节长度的随机 hex 字符串（Web Crypto，无 Node 依赖）。
 * 例：randomNonceHex(16) → 32 字符 hex（与 M9-19 互动 envelope nonce 同模式）。
 */
export function randomNonceHex(byteLength: number): string {
  if (!Number.isInteger(byteLength) || byteLength <= 0) {
    throw new Error('randomNonceHex: byteLength must be a positive integer');
  }
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}
