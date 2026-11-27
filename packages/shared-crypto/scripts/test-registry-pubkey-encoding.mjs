/**
 * 注册 pubkey 编码契约：节点 hex → 注册中心 base64（32B raw）
 * 运行：node packages/shared-crypto/scripts/test-registry-pubkey-encoding.mjs
 */
import { webcrypto } from 'node:crypto';

const { subtle } = webcrypto;

function bytesToHex(bytes) {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function hexToStandardBase64(hex, expectedBytes) {
  const bytes = hexToBytes(hex);
  if (bytes.length !== expectedBytes) throw new Error(`expected ${expectedBytes} bytes`);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function decodeBase64Any(s) {
  const normalized = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
  const bin = atob(normalized + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

let failed = 0;
function check(label, fn) {
  try {
    if (!fn()) {
      console.log('❌', label);
      failed++;
    } else {
      console.log('✅', label);
    }
  } catch (e) {
    console.log('❌', label, e.message);
    failed++;
  }
}

const keyPair = await subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
const publicRaw = new Uint8Array(await subtle.exportKey('raw', keyPair.publicKey));
const publicKeyHex = bytesToHex(publicRaw);
const pubkeyB64 = hexToStandardBase64(publicKeyHex, 32);

check('公钥 hex 64 字符', () => publicKeyHex.length === 64);
check('公钥 base64 解码为 32 字节', () => decodeBase64Any(pubkeyB64).length === 32);
check('误把 hex 当 base64 会得到 48 字节（回归根因）', () => decodeBase64Any(publicKeyHex).length === 48);

if (failed > 0) {
  console.log(`\n${failed} 项失败`);
  process.exit(1);
}
console.log('\n全部通过');
