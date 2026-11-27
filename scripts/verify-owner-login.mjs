/**
 * 部署后校验：浏览器同款流程 — login-params → derive → POST password_hash。
 *
 * PBKDF2 内联实现（Node 不能直接 import packages/*.ts，与 test-password-logic.mjs 同策略）。
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

function encodeText(s) {
  return new TextEncoder().encode(s);
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

/** 与 shared-crypto derivePasswordHash 行为一致（≤100k Web Crypto；>100k @noble/hashes） */
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
    const a = argv[i];
    if (a === '--token-file' && argv[i + 1]) opts.tokenFile = path.resolve(argv[++i]);
    else if (a.startsWith('--token-file=')) opts.tokenFile = path.resolve(a.slice('--token-file='.length));
  }
  return opts;
}

function pick(config, keys) {
  for (const k of keys) {
    const v = config[k];
    if (v != null && String(v).trim()) return String(v).trim().replace(/\/+$/, '');
  }
  return '';
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const config = JSON.parse(fs.readFileSync(opts.tokenFile, 'utf8'));

  if (!hasDeployUrl(config)) {
    try {
      const urls = await resolveDeployUrlsFromConfig(config);
      applyDeployUrlsToConfig(config, urls);
      fs.writeFileSync(opts.tokenFile, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    } catch (err) {
      console.error(`[verify-owner-login] 无法解析 WORKER_A_URL: ${err?.message ?? err}`);
      process.exit(1);
    }
  }

  // M9-23 后生产登录走 Pages 同源网关（Service Binding → Worker A），不再直连 workers.dev：
  // 用户侧 workers.dev 常被封禁/关 workers_dev 后 404，直连必挂。优先 PAGES_URL / WORKER_A_ORIGIN。
  const gatewayUrl = pick(config, ['PAGES_URL', 'WORKER_A_ORIGIN']);
  const directUrl = pick(config, ['WORKER_A_URL', 'WORKER_A_HOST']);
  const baseUrl = gatewayUrl || directUrl;
  const channel = gatewayUrl ? 'pages-gateway' : 'worker-direct';
  const username = pick(config, ['OWNER_LOGIN_USERNAME']);
  const password = config.OWNER_LOGIN_PASSWORD != null ? String(config.OWNER_LOGIN_PASSWORD) : '';

  if (!baseUrl || !username || !password) {
    console.error('[verify-owner-login] token 缺少 PAGES_URL/WORKER_A_ORIGIN（或 WORKER_A_URL）/ OWNER_LOGIN_USERNAME / OWNER_LOGIN_PASSWORD');
    process.exit(1);
  }

  // Node 全局 fetch 不读系统代理；有 HTTPS_PROXY/HTTP_PROXY 时经 undici ProxyAgent 发请求。
  // deploy-network.ps1 已把 Windows 系统代理同步进进程 env，这里只管消费。
  const proxyRaw =
    process.env.HTTPS_PROXY ||
    process.env.HTTP_PROXY ||
    process.env.https_proxy ||
    process.env.http_proxy ||
    '';
  const proxyUrl = proxyRaw.trim();
  let fetchFn = (...args) => fetch(...args);
  let viaProxy = false;
  if (proxyUrl) {
    try {
      const { ProxyAgent, fetch: undiciFetch } = await import('undici');
      const dispatcher = new ProxyAgent(proxyUrl);
      fetchFn = (url, init = {}) => undiciFetch(url, { ...init, dispatcher });
      viaProxy = true;
    } catch (err) {
      console.warn(`[verify-owner-login] 代理模块不可用，回落直连（${err?.message ?? err}）`);
    }
  }
  console.log(`[verify-owner-login] via=${channel}${viaProxy ? ' +proxy' : ''} base=${baseUrl}`);

  let paramsRes;
  try {
    paramsRes = await fetchFn(
      `${baseUrl}/auth/login-params?${new URLSearchParams({ username })}`,
      { headers: { Accept: 'application/json' } },
    );
  } catch (err) {
    console.error(`[verify-owner-login] 网络失败: ${err?.message ?? err}`);
    process.exit(2);
  }
  const paramsBody = await paramsRes.json();
  if (!paramsRes.ok || !paramsBody?.ok || !paramsBody?.data) {
    console.error(`[verify-owner-login] login-params FAIL: ${paramsBody?.error_code ?? paramsRes.status}`);
    process.exit(1);
  }

  const passwordHash = await derivePasswordHash(
    password,
    paramsBody.data.salt_hex,
    paramsBody.data.iterations,
  );

  let res;
  try {
    res = await fetchFn(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password_hash: passwordHash }),
    });
  } catch (err) {
    console.error(`[verify-owner-login] 网络失败: ${err?.message ?? err}`);
    process.exit(2);
  }

  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }

  if (res.ok && body?.ok === true && body?.data?.token) {
    console.log(`[verify-owner-login] OK ${username} @ ${baseUrl} (client-side hash)`);
    process.exit(0);
  }

  const code = body?.error_code ?? `HTTP_${res.status}`;
  const msg = body?.message ?? text.slice(0, 200);
  console.error(`[verify-owner-login] FAIL ${code}: ${msg}`);
  process.exit(1);
}

main();
