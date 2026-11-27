/**
 * Ed25519 密钥一致性：hex/base64 归一 + 从 PKCS#8 私钥推导公钥。
 * 部署门禁用：公钥必须同时匹配 Worker A / D1 / 注册中心；私钥必须与公钥成对。
 */
import crypto from 'node:crypto';

/** 接受 hex（64）或 base64（32 字节），统一返回小写 hex；非法返回 ''。 */
export function normalizeEd25519PublicKey(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  if (/^[0-9a-f]{64}$/i.test(raw)) return raw.toLowerCase();
  try {
    const buf = Buffer.from(raw, 'base64');
    if (buf.length === 32) return buf.toString('hex');
  } catch {
    /* ignore */
  }
  return '';
}

/** 从 PKCS#8 DER hex 私钥推导 raw 公钥 hex；非法抛错。 */
export function deriveEd25519PublicHexFromPkcs8Hex(privateKeyHex) {
  const raw = String(privateKeyHex ?? '').trim();
  if (!/^[0-9a-f]+$/i.test(raw) || raw.length % 2 !== 0) {
    throw new Error('ED25519_PRIVATE_KEY 不是合法 hex');
  }
  const key = crypto.createPrivateKey({
    key: Buffer.from(raw, 'hex'),
    format: 'der',
    type: 'pkcs8',
  });
  const jwk = crypto.createPublicKey(key).export({ format: 'jwk' });
  if (!jwk.x) throw new Error('Ed25519 私钥缺少公钥 x');
  return Buffer.from(jwk.x, 'base64url').toString('hex');
}

/**
 * 校验私钥→公钥与预期公钥（hex/base64）一致。
 * @returns {{ok: true, publicHex: string}}
 */
export function assertEd25519KeyPairConsistent({ privateKeyHex, publicKey, label = 'ed25519' }) {
  const expected = normalizeEd25519PublicKey(publicKey);
  if (!expected) {
    throw new Error(`${label} 预期公钥缺失或格式非法（需 64 hex 或 base64 32 字节）`);
  }
  const derived = deriveEd25519PublicHexFromPkcs8Hex(privateKeyHex);
  if (derived !== expected) {
    throw new Error(`${label} 私钥与公钥不匹配：私钥推导 ${derived.slice(0, 12)}… ≠ 预期 ${expected.slice(0, 12)}…`);
  }
  return { ok: true, publicHex: expected };
}
