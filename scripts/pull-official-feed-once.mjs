/**
 * 部署完成后尽力拉取一次注册中心官方公告。
 *
 * 通过 Worker B 站主代理登录并调用 Worker A 的本地拉取接口；失败只告警不让部署失败。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { webcrypto } from 'node:crypto';
import {
  applyDeployUrlsToConfig,
  hasDeployUrl,
  resolveDeployUrlsFromConfig,
} from './resolve-deploy-urls.mjs';

if (!globalThis.crypto) globalThis.crypto = webcrypto;

const WEB_CRYPTO_PBKDF2_MAX = 100_000;
const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));

function encodeText(value) {
  return new TextEncoder().encode(value);
}

function bytesToHex(bytes) {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex) {
  const arr = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    arr[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return arr;
}

async function derivePasswordHash(password, saltHex, iterations) {
  const salt = hexToBytes(saltHex);
  const passwordBytes = encodeText(password);
  let hashBytes;
  if (iterations <= WEB_CRYPTO_PBKDF2_MAX) {
    const keyMaterial = await crypto.subtle.importKey(
      'raw',
      passwordBytes,
      { name: 'PBKDF2' },
      false,
      ['deriveBits'],
    );
    const hashBuf = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
      keyMaterial,
      256,
    );
    hashBytes = new Uint8Array(hashBuf);
  } else {
    const { pbkdf2 } = await import('@noble/hashes/pbkdf2');
    const { sha256 } = await import('@noble/hashes/sha2');
    hashBytes = pbkdf2(sha256, passwordBytes, salt, { c: iterations, dkLen: 32 });
  }
  return `v1:PBKDF2:${iterations}:SHA256:${saltHex}:${bytesToHex(hashBytes)}`;
}

function parseArgs(argv) {
  const opts = { tokenFile: path.join(SCRIPTS_DIR, 'cloudflare-api-token.json') };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--token-file' && argv[i + 1]) opts.tokenFile = path.resolve(argv[++i]);
    else if (arg.startsWith('--token-file=')) opts.tokenFile = path.resolve(arg.slice('--token-file='.length));
  }
  return opts;
}

function pick(config, keys) {
  for (const key of keys) {
    const value = config[key];
    if (value != null && String(value).trim()) return String(value).trim().replace(/\/+$/, '');
  }
  return '';
}

async function readJsonResponse(res) {
  const text = await res.text();
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return { ok: false, error_code: `HTTP_${res.status}`, message: text.slice(0, 200) };
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const config = JSON.parse(fs.readFileSync(opts.tokenFile, 'utf8'));

  if (!hasDeployUrl(config)) {
    const urls = await resolveDeployUrlsFromConfig(config);
    applyDeployUrlsToConfig(config, urls);
    fs.writeFileSync(opts.tokenFile, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  }

  const baseUrl = pick(config, ['WORKER_B_URL', 'WORKER_B_HOST']);
  const username = pick(config, ['OWNER_LOGIN_USERNAME']);
  const password = config.OWNER_LOGIN_PASSWORD != null ? String(config.OWNER_LOGIN_PASSWORD) : '';
  if (!baseUrl || !username || !password) {
    console.log('[pull-official-feed-once] SKIP 缺少 WORKER_B_URL / OWNER_LOGIN_USERNAME / OWNER_LOGIN_PASSWORD');
    return;
  }

  const paramsRes = await fetch(
    `${baseUrl}/auth/login-params?${new URLSearchParams({ username })}`,
    { headers: { Accept: 'application/json' } },
  );
  const paramsBody = await readJsonResponse(paramsRes);
  if (!paramsRes.ok || !paramsBody?.ok || !paramsBody?.data) {
    console.log(`[pull-official-feed-once] SKIP login-params ${paramsBody?.error_code ?? paramsRes.status}`);
    return;
  }

  const passwordHash = await derivePasswordHash(
    password,
    paramsBody.data.salt_hex,
    paramsBody.data.iterations,
  );
  const loginRes = await fetch(`${baseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password_hash: passwordHash }),
  });
  const loginBody = await readJsonResponse(loginRes);
  const token = loginBody?.data?.token;
  if (!loginRes.ok || !loginBody?.ok || !token) {
    console.log(`[pull-official-feed-once] SKIP login ${loginBody?.error_code ?? loginRes.status}`);
    return;
  }

  const pullRes = await fetch(`${baseUrl}/api/local/registry-official-feed/pull`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  const pullBody = await readJsonResponse(pullRes);
  if (pullRes.ok && pullBody?.ok) {
    const data = pullBody.data ?? {};
    console.log(
      `[pull-official-feed-once] OK fetched=${data.fetched_count ?? 0} inserted=${data.inserted_count ?? 0} remaining_today=${data.remaining_today ?? '?'}`,
    );
    return;
  }

  // 部署脚本会反复执行，429/未登记/网络暂不可用都不应让部署失败。
  console.log(`[pull-official-feed-once] SKIP pull ${pullBody?.error_code ?? pullRes.status}: ${pullBody?.message ?? ''}`);
}

main().catch((err) => {
  console.log(`[pull-official-feed-once] SKIP ${err?.message ?? err}`);
});
