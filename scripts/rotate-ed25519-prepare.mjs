/**
 * 一次性 Ed25519 换钥准备：生成新密钥对、patch 生产公钥、写出私钥给下一步 secret put。
 * 私钥只写 RUNNER_TEMP，不打印、不进入 artifact；stdout 只输出公钥。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const root = process.cwd();
const statePath = path.join(root, 'scripts', '.ci-deploy-state.json');
if (!fs.existsSync(statePath)) {
  console.error('缺少 scripts/.ci-deploy-state.json（先下载 ci-deploy-final artifact）');
  process.exit(1);
}
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const accountId = String(state.account_id ?? '').trim();
if (!/^[0-9a-f]{32}$/i.test(accountId)) {
  console.error('state.account_id 缺失或格式不对');
  process.exit(1);
}

const outDir = process.env.RUNNER_TEMP || path.join(root, '.tmp-rotate');
fs.mkdirSync(outDir, { recursive: true });
const privPath = path.join(outDir, 'ed25519-private.txt');
const pubPath = path.join(outDir, 'ed25519-public-hex.txt');
const pubB64Path = path.join(outDir, 'ed25519-public-b64.txt');

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const privDer = privateKey.export({ format: 'der', type: 'pkcs8' });
const pubJwk = publicKey.export({ format: 'jwk' });
const pubRaw = Buffer.from(pubJwk.x, 'base64url');
const privHex = privDer.toString('hex');
const pubHex = pubRaw.toString('hex');
const pubB64 = pubRaw.toString('base64');
if (!/^[0-9a-f]{64}$/i.test(pubHex)) {
  console.error('新公钥 hex 长度异常');
  process.exit(1);
}
fs.writeFileSync(privPath, privHex, { encoding: 'utf8', mode: 0o600 });
fs.writeFileSync(pubPath, pubHex, 'utf8');
fs.writeFileSync(pubB64Path, pubB64, 'utf8');

function patchProductionPublic(tomlRel) {
  const abs = path.join(root, tomlRel);
  const text = fs.readFileSync(abs, 'utf8');
  const idx = text.indexOf('[env.production.vars]');
  if (idx < 0) throw new Error(`${tomlRel} 找不到 [env.production.vars]`);
  const before = text.slice(0, idx);
  const after = text.slice(idx);
  if (!/ED25519_PUBLIC_KEY\s*=\s*"[^"]*"/.test(after)) {
    throw new Error(`${tomlRel} production 缺少 ED25519_PUBLIC_KEY`);
  }
  const nextAfter = after.replace(/ED25519_PUBLIC_KEY\s*=\s*"[^"]*"/, `ED25519_PUBLIC_KEY = "${pubHex}"`);
  fs.writeFileSync(abs, before + nextAfter, 'utf8');
}

patchProductionPublic('apps/worker-a/wrangler.toml');
patchProductionPublic('apps/worker-b/wrangler.toml');

if (process.env.GITHUB_ENV) {
  fs.appendFileSync(process.env.GITHUB_ENV, `CLOUDFLARE_ACCOUNT_ID=${accountId}\n`, 'utf8');
}
if (process.env.GITHUB_OUTPUT) {
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `public_hex=${pubHex}\npublic_b64=${pubB64}\n`, 'utf8');
}
console.log('new_ed25519_public_hex=' + pubHex);
console.log('new_ed25519_public_b64=' + pubB64);
console.log('private_file=' + privPath);
