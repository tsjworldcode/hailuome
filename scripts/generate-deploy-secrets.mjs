/**
 * 部署用 Secret / Ed25519 密钥一次性生成（供 deploy-all.ps1 / bootstrap 调用）
 * 输出 JSON 到 stdout，勿重定向到日志（含私钥）。
 *
 * 运行：node scripts/generate-deploy-secrets.mjs
 */
function bytesToHex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function randomHex(byteLen = 32) {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(byteLen)));
}

async function generateEd25519() {
  const keyPair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const publicRaw = await crypto.subtle.exportKey('raw', keyPair.publicKey);
  const privatePkcs8 = await crypto.subtle.exportKey('pkcs8', keyPair.privateKey);
  return {
    ED25519_PUBLIC_KEY: bytesToHex(new Uint8Array(publicRaw)),
    ED25519_PRIVATE_KEY: bytesToHex(new Uint8Array(privatePkcs8)),
  };
}

const ed = await generateEd25519();
const payload = {
  JWT_SECRET: randomHex(32),
  INTERNAL_FORWARD_SECRET: randomHex(32),
  TOTP_WRAP_SECRET: randomHex(32),
  NODE_API_TOKEN_WRAP_SECRET: randomHex(32),
  // OWNER-KEY-1：包裹群主持钥表 key_material；仅 Worker A；勿与其它 wrap secret 复用
  GROUP_OWNER_KEY_WRAP_SECRET: randomHex(32),
  // SEC-6-SECRET：仅 Worker B 媒体票据 HMAC；与其它密钥职责分离；部署侧幂等 put（已有则跳过）
  MEDIA_TICKET_SECRET: randomHex(32),
  ...ed,
};

process.stdout.write(JSON.stringify(payload));
