/**
 * Web Crypto 密钥导入缓存（M5-P2 性能优化）。
 *
 * 背景：
 *   - JWT 验签 / Ed25519 发帖签名 / 粉丝 token 验签都是高频热路径。
 *   - 每次调用都 `crypto.subtle.importKey` 会重做 PKCS8/raw 解析与密钥派生，
 *     单次开销约 0.5–2ms CPU，按 Workers 10ms CPU 限额是显著占比。
 *   - 同一个 isolate 在 Cloudflare Workers 中可被多请求复用，module-level
 *     变量在 isolate 生命周期内保持——是缓存 CryptoKey 的天然容器。
 *
 * 设计：
 *   - 缓存 `Promise<CryptoKey>` 而非 CryptoKey 本身，避免并发首次调用时
 *     发起多次 importKey（共享同一个进行中的 Promise 即可）。
 *   - key 用 `<algo>:<material>` 作为索引，碰撞概率为零（不同算法/不同密钥）。
 *   - 不做主动失效：CryptoKey 不可变，密钥材料变更时整个 Worker 会重新部署
 *     从而新建 isolate 与缓存。
 *   - 不限容量：每个节点的密钥材料是常量级（自身私钥 + JWT secret + 偶尔
 *     来自其它节点的公钥用于验签），不会无限增长。
 *
 * ⚠️ 安全注意：
 *   - 缓存只在内存中，进程重启即丢失，不增加密钥泄露面。
 *   - 不缓存 CryptoKey 的 `extractable=true` 版本——本仓库所有 importKey
 *     都传 `extractable=false`，缓存 CryptoKey 也无法导出原始材料。
 */

const cache = new Map<string, Promise<CryptoKey>>();

/**
 * 统一的密钥导入入口：相同 cacheKey 的请求共享同一个 Promise<CryptoKey>。
 *
 * @param cacheKey 缓存索引（必须包含算法与密钥材料，不同密钥不能共用 cacheKey）
 * @param importer 实际执行 crypto.subtle.importKey 的函数（仅在 cache miss 时调用）
 */
export function getCachedKey(
  cacheKey: string,
  importer: () => Promise<CryptoKey>,
): Promise<CryptoKey> {
  let promise = cache.get(cacheKey);
  if (promise) return promise;
  promise = importer();
  cache.set(cacheKey, promise);
  // 若 importer 异常（如密钥格式错误），从缓存中清除，避免后续请求一直拿到失败的 Promise
  promise.catch(() => {
    if (cache.get(cacheKey) === promise) {
      cache.delete(cacheKey);
    }
  });
  return promise;
}

/**
 * 仅供测试使用：清空所有缓存。
 * 生产代码不应调用此函数。
 */
export function __clearKeyCacheForTests(): void {
  cache.clear();
}
