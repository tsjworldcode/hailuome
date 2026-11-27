/**
 * health 下行 directives 验签与落库（M9-3-6）。
 *
 * 与注册中心 REGISTRY_DIRECTIVE_V1 对齐（registry-api.md §M23）。
 * M9-PH-TA-3：[0].trust_pubkey 须对齐钉死锚点；已登记节点的联邦备用仅认主中心签的 add_registry（拒 env 裸写）。
 * M9-PH-BI-6：add_registry **不是**冷启动/容量开窗；未登记节点不 append pending，接待走入口 active_intake。
 */

import {
  readRegistryEndpoints,
  saveRegistryEndpoints,
  type RegistryEndpoint,
} from './registryEndpoints';
import {
  PRIMARY_TRUST_PUBKEY_B64,
  isPrimaryRegistryId,
  primaryEndpointReadyForDirectives,
} from './primaryRegistryTrustAnchor';
import { assertSafeOutboundHttpsUrl, serializeProtoEnvelope } from '@hailuo/shared-utils';
import { readRegisteredRegistry } from './registeredRegistries';

const NONCE_HEX_RE = /^[0-9a-fA-F]{16,64}$/;
const SIG_HEX_RE = /^[0-9a-fA-F]{128}$/;
const ISSUED_AT_WINDOW_MS = 300_000;
const MAX_DIRECTIVE_NONCES = 500;

/** @deprecated M-OPT-12：新指令验签用 DAILY_SYNC_PATH；保留仅用于兼容期旧 health 信封。 */
export const REGISTRY_DIRECTIVE_HEALTH_PATH = 'POST /api/node/health';

/** M-DS-1：daily-sync 下行 directives 验签 path。 */
export const REGISTRY_DIRECTIVE_DAILY_SYNC_PATH = 'POST /api/node/daily-sync';

/** registry_endpoints 有序列表最大长度（M9-3-B1；对齐计划与子请求预算）。 */
export const MAX_REGISTRY_ENDPOINTS = 5;

export interface RegistryAddDirective {
  action: 'add_registry';
  registry_id: string;
  registry_url: string;
  trust_pubkey: string;
  issued_at: string;
  nonce: string;
}

export interface RegistryNoopDirective {
  action: 'noop';
  issued_at: string;
  nonce: string;
}

export type RegistryDirective = RegistryAddDirective | RegistryNoopDirective;

export type ApplyRegistryDirectivesResult =
  | { status: 'skipped'; reason: string }
  | { status: 'applied'; added_registry_ids: string[]; noop_count: number };

/** 对象键字母序递归排序后 JSON.stringify。 */
export function canonicalDirectivesJson(directives: RegistryDirective[]): string {
  return JSON.stringify(sortKeysDeep(directives));
}

export function buildRegistryDirectiveV1Message(
  issued_at: string,
  nonce: string,
  registry_id: string,
  directives: RegistryDirective[],
  httpPath: string = REGISTRY_DIRECTIVE_HEALTH_PATH,
): string {
  return `REGISTRY_DIRECTIVE_V1\n${httpPath}\n${issued_at}:${nonce}:${registry_id}:${canonicalDirectivesJson(directives)}`;
}

export async function readRegistryDirectiveNonces(db: D1Database): Promise<string[]> {
  const row = await db
    .prepare(`SELECT value FROM system_config WHERE key = 'registry_directive_nonces' LIMIT 1`)
    .first<{ value: string }>();
  if (!row?.value?.trim()) return [];
  try {
    const parsed: unknown = JSON.parse(row.value);
    return Array.isArray(parsed)
      ? parsed.filter((n): n is string => typeof n === 'string' && NONCE_HEX_RE.test(n))
      : [];
  } catch {
    return [];
  }
}

async function appendRegistryDirectiveNonces(
  db: D1Database,
  newNonces: string[],
  updatedAt: string,
): Promise<void> {
  const existing = await readRegistryDirectiveNonces(db);
  const merged = [...existing, ...newNonces];
  const trimmed = merged.length > MAX_DIRECTIVE_NONCES
    ? merged.slice(merged.length - MAX_DIRECTIVE_NONCES)
    : merged;
  await db
    .prepare(
      `INSERT OR REPLACE INTO system_config (key, value, updated_at) VALUES ('registry_directive_nonces', ?, ?)`,
    )
    .bind(JSON.stringify(trimmed), updatedAt)
    .run();
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => sortKeysDeep(item));
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) out[key] = sortKeysDeep(obj[key]);
    return out;
  }
  return value;
}

function decodeBase64Any(s: string): Uint8Array {
  const normalized = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
  const bin = atob(normalized + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

async function importTrustPubkey(pubkeyB64: string): Promise<CryptoKey> {
  const bytes = decodeBase64Any(pubkeyB64.trim());
  if (bytes.length !== 32) throw new Error('invalid trust_pubkey length');
  return crypto.subtle.importKey('raw', bytes, { name: 'Ed25519' }, false, ['verify']);
}

/** M9-3-B3：add_registry 落库前字段校验（https URL + Ed25519 32B 公钥）。 */
export function validateAddRegistryFields(
  directive: Pick<RegistryAddDirective, 'registry_url' | 'trust_pubkey'>,
): { ok: true } | { ok: false; reason: 'registry_url_not_https' | 'registry_url_unsafe' | 'trust_pubkey_invalid' } {
  const url = directive.registry_url.trim().replace(/\/$/, '');
  if (!url.startsWith('https://')) {
    return { ok: false, reason: 'registry_url_not_https' };
  }
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') {
      return { ok: false, reason: 'registry_url_not_https' };
    }
  } catch {
    return { ok: false, reason: 'registry_url_not_https' };
  }
  // 主中心已签名，这里只挡住内网字面地址和非法端口，避免写进地址簿后再被定时同步请求。
  const safe = assertSafeOutboundHttpsUrl(url);
  if (!safe.ok) {
    return { ok: false, reason: 'registry_url_unsafe' };
  }

  try {
    const bytes = decodeBase64Any(directive.trust_pubkey.trim());
    if (bytes.length !== 32) {
      return { ok: false, reason: 'trust_pubkey_invalid' };
    }
    // 与 importTrustPubkey 同 decode 路径，确保可导入 Ed25519 raw
    void bytes;
  } catch {
    return { ok: false, reason: 'trust_pubkey_invalid' };
  }

  return { ok: true };
}

export function parseRegistryDirective(raw: unknown): RegistryDirective | null {
  if (!raw || typeof raw !== 'object') return null;
  const d = raw as Record<string, unknown>;
  const action = d.action;
  if (action !== 'add_registry' && action !== 'noop') return null;

  const issued_at = typeof d.issued_at === 'string' ? d.issued_at.trim() : '';
  const nonce = typeof d.nonce === 'string' ? d.nonce.trim() : '';
  if (!issued_at || !NONCE_HEX_RE.test(nonce)) return null;

  if (action === 'noop') return { action: 'noop', issued_at, nonce };

  const registry_id = typeof d.registry_id === 'string' ? d.registry_id.trim() : '';
  const registry_url = typeof d.registry_url === 'string'
    ? d.registry_url.trim().replace(/\/$/, '')
    : '';
  const trust_pubkey = typeof d.trust_pubkey === 'string' ? d.trust_pubkey.trim() : '';
  if (!registry_id || !registry_url || !trust_pubkey) return null;

  return { action: 'add_registry', registry_id, registry_url, trust_pubkey, issued_at, nonce };
}

function isIssuedAtFresh(issued_at: string, nowMs: number): boolean {
  const ts = Date.parse(issued_at);
  if (!Number.isFinite(ts)) return false;
  return Math.abs(nowMs - ts) <= ISSUED_AT_WINDOW_MS;
}

/** 用钉死的主中心公钥验签 REGISTRY_DIRECTIVE_V1（M9-PH-TA-3；不信任漂移的 [0].trust_pubkey 字面量）。 */
export async function verifyRegistryDirectiveSignature(
  primary: RegistryEndpoint,
  directives: RegistryDirective[],
  registrySignatureHex: string,
  httpPath: string = REGISTRY_DIRECTIVE_HEALTH_PATH,
): Promise<boolean> {
  if (directives.length === 0) return false;
  if (!SIG_HEX_RE.test(registrySignatureHex.trim())) return false;
  // 调用方应先 primaryEndpointReadyForDirectives；此处再拒一次防漏网
  if (!primaryEndpointReadyForDirectives(primary).ok) return false;

  const head = directives[0];
  // M9-3-B7 / M23-7d：message 第三段始终为签发方（primary）registry_id。
  const registryIdForMessage = primary.registry_id;

  const message = buildRegistryDirectiveV1Message(
    head.issued_at,
    head.nonce,
    registryIdForMessage,
    directives,
    httpPath,
  );

  try {
    // 始终用仓库钉死公钥验签，不读可能被 TOFU 污染的 endpoint 字段
    const key = await importTrustPubkey(PRIMARY_TRUST_PUBKEY_B64);
    const sig = hexToBytes(registrySignatureHex.trim());
    if (sig.length !== 64) return false;
    return crypto.subtle.verify('Ed25519', key, sig, new TextEncoder().encode(message));
  } catch {
    return false;
  }
}

/**
 * 验签通过后执行 directives：add_registry 尾部 append pending（**仅已登记有 home**）；记录 nonce 防重放。
 * M9-PH-TA-3：仅当 trustEndpoint 对齐钉死锚点时才验签/落库；备用不可经 env 手填写入。
 * M9-PH-BI-6：无 home 时跳过 add_registry（不把 directive 当开窗）。
 */
export async function applyRegistryDirectives(
  env: import('../env').Env,
  db: D1Database,
  trustEndpoint: RegistryEndpoint,
  rawDirectives: unknown[],
  registrySignatureHex: string,
  now: Date = new Date(),
  httpPath: string = REGISTRY_DIRECTIVE_HEALTH_PATH,
): Promise<ApplyRegistryDirectivesResult> {
  if (rawDirectives.length === 0) {
    return { status: 'skipped', reason: 'empty_directives' };
  }
  if (!registrySignatureHex?.trim()) {
    return { status: 'skipped', reason: 'missing_signature' };
  }

  const anchorReady = primaryEndpointReadyForDirectives(trustEndpoint);
  if (!anchorReady.ok) {
    return { status: 'skipped', reason: anchorReady.reason };
  }

  const directives = rawDirectives
    .map(parseRegistryDirective)
    .filter((d): d is RegistryDirective => d !== null);
  if (directives.length === 0) {
    return { status: 'skipped', reason: 'invalid_directives' };
  }

  const nowMs = now.getTime();
  for (const d of directives) {
    if (!isIssuedAtFresh(d.issued_at, nowMs)) {
      return { status: 'skipped', reason: 'issued_at_out_of_window' };
    }
  }

  const seenNonces = new Set(await readRegistryDirectiveNonces(db));
  for (const d of directives) {
    if (seenNonces.has(d.nonce)) {
      return { status: 'skipped', reason: 'nonce_replay' };
    }
  }

  const valid = await verifyRegistryDirectiveSignature(
    trustEndpoint,
    directives,
    registrySignatureHex,
    httpPath,
  );
  if (!valid) {
    return { status: 'skipped', reason: 'signature_invalid' };
  }

  let endpoints = await readRegistryEndpoints(db);
  if (endpoints.length === 0) {
    endpoints = [trustEndpoint];
  }
  // 地址簿 [0] 也必须对齐锚点，防止 DB 与 trustEndpoint 参数不一致时仍 append
  const storedPrimary = endpoints[0];
  if (storedPrimary && !primaryEndpointReadyForDirectives(storedPrimary).ok) {
    return { status: 'skipped', reason: 'trust_anchor_mismatch' };
  }

  const knownIds = new Set(endpoints.map((e) => e.registry_id));
  // 未登记：add_registry 不充当开窗；只读一次 home
  const home = await readRegisteredRegistry(db);

  const added: string[] = [];
  let noopCount = 0;
  const consumedNonces: string[] = [];

  for (const d of directives) {
    consumedNonces.push(d.nonce);
    if (d.action === 'noop') {
      noopCount += 1;
      continue;
    }
    // add_registry 仅主注册中心 [0] 可签发
    const primaryId = endpoints[0]?.registry_id;
    if (d.action === 'add_registry' && primaryId && trustEndpoint.registry_id !== primaryId) {
      continue;
    }
    // 禁止把主中心 ID 再 append 成「备用」
    if (d.action === 'add_registry' && isPrimaryRegistryId(d.registry_id)) {
      continue;
    }
    // 无家不 append：冷启动走入口 B，不靠主中心开窗
    if (d.action === 'add_registry' && !home) {
      continue;
    }
    if (knownIds.has(d.registry_id)) continue;

    const fieldCheck = validateAddRegistryFields(d);
    if (!fieldCheck.ok) {
      // 验签通过但字段非法：跳过该条 add_registry，不写入 D1
      continue;
    }

    if (endpoints.length >= MAX_REGISTRY_ENDPOINTS) {
      return { status: 'skipped', reason: 'max_endpoints' };
    }

    endpoints.push({
      registry_id: d.registry_id,
      registry_url: d.registry_url,
      trust_pubkey: d.trust_pubkey,
      status: 'pending',
      added_at: now.toISOString(),
      fail_streak: 0,
    });
    knownIds.add(d.registry_id);
    added.push(d.registry_id);
  }

  const updatedAt = now.toISOString();
  await saveRegistryEndpoints(env, db, endpoints, updatedAt);
  await appendRegistryDirectiveNonces(db, consumedNonces, updatedAt);

  return { status: 'applied', added_registry_ids: added, noop_count: noopCount };
}

/** 从已解析 JSON 信封 apply directives（避免 Response 二次消费）。 */
export async function applyRegistryDirectivesFromEnvelope(
  env: import('../env').Env,
  db: D1Database,
  body: Record<string, unknown>,
  communicatingEndpoint?: RegistryEndpoint,
  httpPath: string = REGISTRY_DIRECTIVE_HEALTH_PATH,
): Promise<ApplyRegistryDirectivesResult> {
  const directives = body.directives;
  const signature = body.registry_signature;

  if (!Array.isArray(directives) || directives.length === 0) {
    return { status: 'skipped', reason: 'no_directives' };
  }
  if (typeof signature !== 'string' || !signature.trim()) {
    return { status: 'skipped', reason: 'missing_signature' };
  }

  const endpoints = await readRegistryEndpoints(db);
  const trustEndpoint = communicatingEndpoint ?? endpoints[0];
  if (!trustEndpoint?.trust_pubkey?.trim()) {
    return { status: 'skipped', reason: 'missing_trust_pubkey' };
  }

  return applyRegistryDirectives(env, db, trustEndpoint, directives, signature, new Date(), httpPath);
}

/** 解析注册中心 200 JSON 并尝试 apply directives（fail-soft）。 */
export async function applyRegistryDirectivesFromResponse(
  env: import('../env').Env,
  db: D1Database,
  res: Response,
  communicatingEndpoint?: RegistryEndpoint,
  httpPath: string = REGISTRY_DIRECTIVE_HEALTH_PATH,
): Promise<ApplyRegistryDirectivesResult> {
  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    return { status: 'skipped', reason: 'invalid_json' };
  }

  if (!parsed || typeof parsed !== 'object') {
    return { status: 'skipped', reason: 'invalid_json' };
  }

  const body = parsed as Record<string, unknown>;
  return applyRegistryDirectivesFromEnvelope(env, db, body, communicatingEndpoint, httpPath);
}

/** 解析 health 200 JSON 并尝试 apply directives（历史 path 兼容）。 */
export async function applyHealthDirectivesFromResponse(
  env: import('../env').Env,
  db: D1Database,
  res: Response,
  communicatingEndpoint?: RegistryEndpoint,
): Promise<ApplyRegistryDirectivesResult> {
  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    return { status: 'skipped', reason: 'invalid_json' };
  }
  if (!parsed || typeof parsed !== 'object') {
    return { status: 'skipped', reason: 'invalid_json' };
  }
  return applyRegistryDirectivesFromEnvelope(
    env,
    db,
    parsed as Record<string, unknown>,
    communicatingEndpoint,
    REGISTRY_DIRECTIVE_HEALTH_PATH,
  );
}

/** health POST 可选 body：M9-6 proto_version envelope + 已知 registry_id（跳过重复 add_registry）。 */
export async function buildHealthPostBody(db: D1Database): Promise<string | undefined> {
  const endpoints = await readRegistryEndpoints(db);
  if (endpoints.length === 0) return undefined;
  return serializeProtoEnvelope({
    known_registry_ids: endpoints.map((e) => e.registry_id),
  });
}
