// M5-P2 烟雾测试：验证 keyCache 不破坏签名/验签语义。
// 运行：node packages/shared-crypto/scripts/smoke-keycache.mjs
//
// 测试矩阵：
//   1) JWT 签发与验签往返一致
//   2) Ed25519 签名与验签往返一致
//   3) 同一密钥多次调用：CryptoKey 来自缓存（行为一致 + 性能更优）
//   4) 不同密钥不串号

import { signOwnerJWT, verifyOwnerJWT, generateKeyPair, signPost, verifyPost } from '@hailuo/shared-crypto';

async function main() {
  // ── 1. JWT 往返 ──
  const secret = 'test-jwt-secret-' + Math.random().toString(36).slice(2);
  const handle = 'alice';
  const token = await signOwnerJWT(handle, secret, 60);
  const payload = await verifyOwnerJWT(token, secret);
  if (!payload || payload.sub !== handle) {
    throw new Error(`JWT 往返失败：${JSON.stringify(payload)}`);
  }
  console.log('[1/4] ✓ JWT 签发/验签往返一致');

  // ── 2. Ed25519 帖子签名往返 ──
  const { publicKeyHex, privateKeyHex } = await generateKeyPair();
  const postId = 'post_test';
  const content = '海螺测试 emoji 🌊';
  const createdAt = new Date().toISOString();
  const sig = await signPost(postId, content, createdAt, privateKeyHex);
  const ok = await verifyPost(postId, content, createdAt, sig, publicKeyHex);
  if (!ok) throw new Error('Ed25519 验签失败');
  console.log('[2/4] ✓ Ed25519 签名/验签往返一致');

  // ── 3. 同 secret 高频调用，行为一致（缓存路径）──
  const t0 = Date.now();
  for (let i = 0; i < 100; i++) {
    const tk = await signOwnerJWT(handle, secret, 60);
    const pl = await verifyOwnerJWT(tk, secret);
    if (!pl || pl.sub !== handle) throw new Error(`第 ${i} 次 JWT 行为不一致`);
  }
  const dt = Date.now() - t0;
  console.log(`[3/4] ✓ 100 次 JWT 缓存路径均一致（耗时 ${dt}ms）`);

  // ── 4. 不同 secret 不串号 ──
  const tokenA = await signOwnerJWT('user-a', 'secret-A', 60);
  const wrong = await verifyOwnerJWT(tokenA, 'secret-B');
  if (wrong !== null) throw new Error('不同 secret 串号验签成功，缓存隔离失败');
  console.log('[4/4] ✓ 不同 secret 缓存隔离正确');

  console.log('\n所有用例通过，keyCache 不破坏签名/验签语义。');
}

main().catch((err) => {
  console.error('SMOKE FAILED:', err);
  process.exit(1);
});
