#!/usr/bin/env node
/**
 * 本地部署密钥门禁：token 内 ED25519 私钥必须与公钥成对，且与 D1 users.pubkey 一致。
 * 用法：node scripts/check-local-ed25519-pair.mjs [--token-file scripts/cloudflare-api-token.json]
 */
import fs from 'node:fs';
import path from 'node:path';
import { assertEd25519KeyPairConsistent, normalizeEd25519PublicKey } from './lib/ed25519-key-consistency.mjs';

function argValue(name, fallback) {
  const idx = process.argv.indexOf(name);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return fallback;
}

const tokenFile = path.resolve(argValue('--token-file', 'scripts/cloudflare-api-token.json'));
if (!fs.existsSync(tokenFile)) {
  console.error(`[ed25519-gate] 找不到 token 文件：${tokenFile}`);
  process.exit(1);
}
let cfg;
try {
  cfg = JSON.parse(fs.readFileSync(tokenFile, 'utf8').replace(/^\uFEFF/, ''));
} catch (err) {
  console.error(`[ed25519-gate] token 文件 JSON 解析失败：${err.message}`);
  process.exit(1);
}

const priv = String(cfg.ED25519_PRIVATE_KEY ?? '').trim();
const pub = String(cfg.ED25519_PUBLIC_KEY ?? '').trim();
if (!priv || !pub) {
  console.error('[ed25519-gate] token 缺少 ED25519_PRIVATE_KEY 或 ED25519_PUBLIC_KEY');
  process.exit(1);
}

let publicHex;
try {
  publicHex = assertEd25519KeyPairConsistent({
    privateKeyHex: priv,
    publicKey: pub,
    label: 'token ED25519',
  }).publicHex;
  console.log(`[ed25519-gate] ✓ token 私钥/公钥成对（${publicHex.slice(0, 12)}…）`);
} catch (err) {
  console.error(`[ed25519-gate] ✗ ${err.message}`);
  process.exit(1);
}

const accountId = String(cfg.CLOUDFLARE_ACCOUNT_ID ?? '').trim();
const apiToken = String(cfg.CLOUDFLARE_API_TOKEN ?? '').trim();
const d1Id = String(cfg.IDENTITY_DATABASE_ID ?? '').trim();
if (!/^[0-9a-f]{32}$/i.test(accountId) || !apiToken || !d1Id) {
  console.error('[ed25519-gate] token 缺少 Account ID / API Token / IDENTITY_DATABASE_ID');
  process.exit(1);
}

let rows;
try {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${d1Id}/query`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sql: 'SELECT pubkey FROM users LIMIT 1' }),
    },
  );
  const json = await res.json().catch(() => null);
  if (!json?.success) {
    const msg = json?.errors?.map((e) => e.message).join('; ') || `HTTP ${res.status}`;
    if (/no such table:\s*users/i.test(msg)) {
      console.log('[ed25519-gate] ⚠ D1 尚无 users 表（未登记），跳过 D1 公钥比对');
      process.exit(0);
    }
    throw new Error(msg);
  }
  rows = json.result?.[0]?.results ?? [];
} catch (err) {
  console.error(`[ed25519-gate] ✗ 查询 D1 users.pubkey 失败：${err.message}`);
  process.exit(1);
}

const d1Pub = normalizeEd25519PublicKey(rows?.[0]?.pubkey);
if (!d1Pub) {
  console.log('[ed25519-gate] ⚠ D1 users.pubkey 为空（未完成登记），跳过 D1 公钥比对');
  process.exit(0);
}
if (d1Pub !== publicHex) {
  console.error(
    `[ed25519-gate] ✗ token 公钥 ${publicHex.slice(0, 12)}… 与 D1 users.pubkey ${d1Pub.slice(0, 12)}… 不一致`,
  );
  process.exit(1);
}
console.log('[ed25519-gate] ✓ token 公钥与 D1 users.pubkey 一致');
