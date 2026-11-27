/**
 * 生成节点 Ed25519 密钥对（与 @hailuo/shared-crypto 存储格式一致）
 * 运行：npm run keys:generate
 */
function bytesToHex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function generateKeyPair() {
  const keyPair = await crypto.subtle.generateKey(
    { name: 'Ed25519' },
    true,
    ['sign', 'verify'],
  );
  const publicRaw = await crypto.subtle.exportKey('raw', keyPair.publicKey);
  const privatePkcs8 = await crypto.subtle.exportKey('pkcs8', keyPair.privateKey);
  return {
    publicKeyHex: bytesToHex(new Uint8Array(publicRaw)),
    privateKeyHex: bytesToHex(new Uint8Array(privatePkcs8)),
  };
}

const { publicKeyHex, privateKeyHex } = await generateKeyPair();

console.log('\n=== 海螺节点 Ed25519 密钥对 ===\n');
console.log('ED25519_PUBLIC_KEY（写入 worker-a/b wrangler.toml [env.production.vars]）：');
console.log(publicKeyHex);
console.log('\nED25519_PRIVATE_KEY（仅 wrangler secret put，禁止提交 git）：');
console.log(privateKeyHex);
console.log('\n下一步（production 环境示例）：');
console.log('  cd apps/worker-a');
console.log(`  echo "${privateKeyHex}" | npx wrangler secret put ED25519_PRIVATE_KEY --env production`);
console.log('  # 将公钥填入 worker-a 与 worker-b 的 ED25519_PUBLIC_KEY 后 deploy\n');
