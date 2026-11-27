#!/usr/bin/env node
/**
 * 把 Worker A 当前 ED25519_PUBLIC_KEY 同步到 STATE_KV 的 public:profile。
 *
 * 背景：Worker B 的 /users/:handle 优先返回 STATE_KV 公开资料快照；换钥只改
 * Worker A / D1 / 注册中心时，快照里仍是旧 pubkey，外部节点会拿旧公钥验签失败。
 *
 * 用法：
 *   CLOUDFLARE_API_TOKEN=... node scripts/sync-public-profile-pubkey.mjs \
 *     [--state scripts/.ci-deploy-state.json] [--public-hex <64hex>]
 * 不传 --public-hex 时从 Worker A 线上 bindings 读取。
 */
import fs from 'node:fs';
import path from 'node:path';

function argValue(name, fallback) {
  const idx = process.argv.indexOf(name);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return fallback;
}

const statePath = path.resolve(argValue('--state', 'scripts/.ci-deploy-state.json'));
if (!fs.existsSync(statePath)) {
  console.error(`[sync-profile] 找不到部署状态：${statePath}`);
  process.exit(1);
}
const state = JSON.parse(fs.readFileSync(statePath, 'utf8').replace(/^\uFEFF/, ''));

const accountId = String(state.account_id ?? '').trim();
const workerAName = String(state.WORKER_A_NAME ?? '').trim();
const kvNamespaceId = String(state.kv?.STATE_KV ?? '').trim();
const token = String(process.env.CLOUDFLARE_API_TOKEN ?? '').trim();
if (!/^[0-9a-f]{32}$/i.test(accountId)) {
  console.error('[sync-profile] state.account_id 缺失或格式不对');
  process.exit(1);
}
if (!workerAName || !kvNamespaceId || !token) {
  console.error('[sync-profile] 缺少 WORKER_A_NAME / STATE_KV / CLOUDFLARE_API_TOKEN');
  process.exit(1);
}

const headers = { Authorization: `Bearer ${token}` };

let publicHex = String(argValue('--public-hex', '')).trim().toLowerCase();
if (!publicHex) {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${workerAName}/settings`,
    { headers },
  );
  const json = await res.json().catch(() => null);
  if (!json?.success) {
    console.error('[sync-profile] 读取 Worker A settings 失败：', JSON.stringify(json?.errors ?? res.status));
    process.exit(1);
  }
  const binding = (json.result?.bindings ?? []).find(
    (b) => b.type === 'plain_text' && b.name === 'ED25519_PUBLIC_KEY',
  );
  publicHex = String(binding?.text ?? '').trim().toLowerCase();
}
if (!/^[0-9a-f]{64}$/.test(publicHex)) {
  console.error('[sync-profile] 公钥不是 64 位 hex，拒绝写入');
  process.exit(1);
}

const kvBase = `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${kvNamespaceId}/values`;
const profileKey = 'public:profile';
const profileUrl = `${kvBase}/${encodeURIComponent(profileKey)}`;

const getRes = await fetch(profileUrl, { headers });
if (!getRes.ok) {
  console.error(`[sync-profile] 读取 ${profileKey} 失败：HTTP ${getRes.status}`);
  process.exit(1);
}
const raw = await getRes.text();
let profile;
try {
  profile = JSON.parse(raw);
} catch (err) {
  console.error(`[sync-profile] ${profileKey} 不是合法 JSON：${err.message}`);
  process.exit(1);
}

const oldPubkey = String(profile.pubkey ?? '');
profile.pubkey = publicHex;
profile.updated_at = new Date().toISOString();

const putRes = await fetch(profileUrl, {
  method: 'PUT',
  headers: { ...headers, 'Content-Type': 'text/plain; charset=utf-8' },
  body: JSON.stringify(profile),
});
const putJson = await putRes.json().catch(() => null);
if (!putJson?.success) {
  console.error('[sync-profile] 写入 KV 失败：', JSON.stringify(putJson?.errors ?? putRes.status));
  process.exit(1);
}

console.log(`[sync-profile] handle=${profile.handle ?? '(missing)'}`);
console.log(`[sync-profile] pubkey ${oldPubkey.slice(0, 12)}… -> ${publicHex.slice(0, 12)}…`);
console.log('[sync-profile] ✓ STATE_KV public:profile 已同步');
