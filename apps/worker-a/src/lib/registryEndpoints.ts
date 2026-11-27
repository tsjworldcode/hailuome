/**
 * 多注册中心有序列表（M9-3-1）：登记时验签 registry_identity 并写 registry_endpoints[0]。
 *
 * 验签口径与注册中心 REGISTRY_IDENTITY_V1 对齐（registry-api.md §M23）。
 * M9-PH-TA-2：官方主链禁止 HTTPS TOFU；[0] 须过钉死公钥锚点。
 */

import {
  bindWriteRegisteredRegistries,
  buildRegisteredRegistry,
  migrateRegisteredRegistryIfNeeded,
  readRegisteredRegistry,
} from './registeredRegistries';
import { resolveIdentityDb } from '../db/bindings';
import type { Env } from '../env';
import { matchesBootstrapIntakeIdentity, readActiveIntake } from './activeIntake';
import { prepareNodeApiTokenForDb } from './nodeApiTokenAtRest';
import {
  checkPrimaryTrustAnchorHardFields,
  isAllowedPrimaryRegistryUrl,
  isPrimaryRegistryId,
  matchesPrimaryTrustPubkey,
  requireHttpsRegistryUrl,
  type PrimaryTrustAnchorRejectReason,
} from './primaryRegistryTrustAnchor';

export type RegistryEndpointStatus = 'active' | 'pending' | 'unreachable';

/** Phase 1：主 registry 换域后备用 registry 的 node_url 未自动同步标记。 */
export type UrlSyncState = 'synced' | 'stale';

export interface RegistryIdentityPayload {
  registry_id: string;
  pubkey: string;
  registry_url: string;
  issued_at: string;
  nonce: string;
}

export interface RegistryEndpoint {
  registry_id: string;
  registry_url: string;
  trust_pubkey: string;
  node_api_token?: string;
  owner_user_id?: string;
  /** M9-3-I3：home=权威登记；access=备用中心凭证。缺省按 [0]/home 语义。 */
  registration_mode?: 'home' | 'access';
  /** access 时指向 home 中心 registry_id。 */
  home_registry_id?: string;
  /** home=user_id；access=credential_id。 */
  principal_id?: string;
  /** DID v2。 */
  principal_did?: string;
  status: RegistryEndpointStatus;
  added_at: string;
  last_ok_at?: string;
  last_fail_at?: string;
  fail_streak: number;
  /** M7-30a：备用 registry 在节点换域后未同步 URL 时为 stale。 */
  url_sync_state?: UrlSyncState;
}

const NONCE_HEX_RE = /^[0-9a-fA-F]{16,64}$/;
const SIG_HEX_RE = /^[0-9a-fA-F]{128}$/;
const WORKERS_DEV_HOST_RE = /\.workers\.dev$/i;

function stripTrailingSlash(url: string): string {
  return url.trim().replace(/\/$/, '');
}

function isWorkersDevUrl(url: string): boolean {
  try {
    return WORKERS_DEV_HOST_RE.test(new URL(stripTrailingSlash(url)).hostname);
  } catch {
    return false;
  }
}

/**
 * 落库用 registry_url：验签仍用 identity 原文；写入时若 identity 是官方 workers.dev
 * 而节点实际联系的 REGISTRY_URL 是 allowlist 内正式域，优先持久化正式域。
 * M9-AUDIT-1：contact 必须过主中心 allowlist，禁止任意自定义域落库。
 */
export function preferPersistedRegistryUrl(
  contactUrl: string | undefined,
  identityUrl: string,
): string {
  const identity = stripTrailingSlash(identityUrl);
  const contact = contactUrl ? stripTrailingSlash(contactUrl) : '';
  if (
    contact
    && isAllowedPrimaryRegistryUrl(contact)
    && isWorkersDevUrl(identity)
    && !isWorkersDevUrl(contact)
  ) {
    return contact;
  }
  return identity;
}

/** 五字段 canonical JSON（键字母序）。 */
export function canonicalRegistryIdentityJson(identity: RegistryIdentityPayload): string {
  return JSON.stringify({
    issued_at: identity.issued_at,
    nonce: identity.nonce,
    pubkey: identity.pubkey,
    registry_id: identity.registry_id,
    registry_url: identity.registry_url,
  });
}

export const REGISTRY_IDENTITY_VERIFY_HTTP_LINE = 'POST /api/register/challenge/verify';
export const REGISTRY_IDENTITY_WELL_KNOWN_HTTP_LINE = 'GET /.well-known/hailuo-registry-identity';

export function buildRegistryIdentityV1Message(
  httpLine: string,
  issued_at: string,
  nonce: string,
  canonicalJson: string,
): string {
  return `REGISTRY_IDENTITY_V1\n${httpLine}\n${issued_at}:${nonce}:${canonicalJson}`;
}

/** challenge/verify 登记路径签名 message（兼容旧调用）。 */
export function buildRegistryIdentityV1MessageForVerify(
  issued_at: string,
  nonce: string,
  canonicalJson: string,
): string {
  return buildRegistryIdentityV1Message(
    REGISTRY_IDENTITY_VERIFY_HTTP_LINE,
    issued_at,
    nonce,
    canonicalJson,
  );
}

/** well-known 身份文档签名 message（M9-3-B8）。 */
export function buildRegistryWellKnownIdentityV1Message(
  issued_at: string,
  nonce: string,
  canonicalJson: string,
): string {
  return buildRegistryIdentityV1Message(
    REGISTRY_IDENTITY_WELL_KNOWN_HTTP_LINE,
    issued_at,
    nonce,
    canonicalJson,
  );
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

async function importRegistryTrustPubkey(pubkeyB64: string): Promise<CryptoKey> {
  const bytes = decodeBase64Any(pubkeyB64.trim());
  if (bytes.length !== 32) {
    throw new Error('REGISTRY_IDENTITY_INVALID: pubkey must decode to 32 bytes');
  }
  return crypto.subtle.importKey('raw', bytes, { name: 'Ed25519' }, false, ['verify']);
}

/** 校验 challenge/verify 返回的 registry_identity + registry_signature。 */
export async function verifyRegistryIdentitySignature(
  identity: RegistryIdentityPayload,
  registrySignatureHex: string,
): Promise<boolean> {
  return verifyRegistryIdentitySignatureWithHttpLine(
    identity,
    registrySignatureHex,
    REGISTRY_IDENTITY_VERIFY_HTTP_LINE,
  );
}

/** 校验 well-known 身份文档签名（M9-3-B8）。 */
export async function verifyRegistryWellKnownIdentitySignature(
  identity: RegistryIdentityPayload,
  registrySignatureHex: string,
): Promise<boolean> {
  return verifyRegistryIdentitySignatureWithHttpLine(
    identity,
    registrySignatureHex,
    REGISTRY_IDENTITY_WELL_KNOWN_HTTP_LINE,
  );
}

async function verifyRegistryIdentitySignatureWithHttpLine(
  identity: RegistryIdentityPayload,
  registrySignatureHex: string,
  httpLine: string,
): Promise<boolean> {
  if (!identity.registry_id?.trim() || !identity.registry_url?.trim() || !identity.pubkey?.trim()) {
    return false;
  }
  if (!identity.issued_at?.trim() || !NONCE_HEX_RE.test(identity.nonce)) {
    return false;
  }
  if (!SIG_HEX_RE.test(registrySignatureHex.trim())) {
    return false;
  }

  const canonical = canonicalRegistryIdentityJson(identity);
  const message = buildRegistryIdentityV1Message(httpLine, identity.issued_at, identity.nonce, canonical);
  try {
    const key = await importRegistryTrustPubkey(identity.pubkey);
    const sig = hexToBytes(registrySignatureHex.trim());
    if (sig.length !== 64) return false;
    return crypto.subtle.verify('Ed25519', key, sig, new TextEncoder().encode(message));
  } catch {
    return false;
  }
}

/** 登记成功后将主注册中心写入 registry_endpoints[0]。 */
export function buildRegistryEndpoint0(
  identity: RegistryIdentityPayload,
  ownerUserId: string,
  nodeApiToken: string,
  addedAt: string,
): RegistryEndpoint {
  return {
    registry_id: identity.registry_id,
    registry_url: identity.registry_url.replace(/\/$/, ''),
    trust_pubkey: identity.pubkey,
    node_api_token: nodeApiToken,
    owner_user_id: ownerUserId,
    status: 'active',
    added_at: addedAt,
    fail_streak: 0,
  };
}

export async function persistRegistryEndpoints0(
  env: Env,
  db: D1Database,
  identity: RegistryIdentityPayload,
  registrySignatureHex: string,
  ownerUserId: string,
  nodeApiToken: string,
  addedAt: string = new Date().toISOString(),
  /** 节点实际联系的注册中心根 URL（接待 B 或主中心；勿再默认套 env 主域抢在入口前面） */
  preferredRegistryUrl?: string,
): Promise<void> {
  const valid = await verifyRegistryIdentitySignature(identity, registrySignatureHex);
  if (!valid) {
    throw new Error('REGISTRY_IDENTITY_INVALID');
  }
  const contact = preferredRegistryUrl?.trim() || identity.registry_url;
  // 入口验签过的接待可出主中心 allowlist；回落主中心 / 其它路径仍走 TA
  const httpsFail = requireHttpsRegistryUrl(contact);
  if (httpsFail) {
    throw new Error('REGISTRY_TRUST_ANCHOR_MISMATCH');
  }
  const intake = await readActiveIntake(db);
  const bootstrapOk = Boolean(
    intake && matchesBootstrapIntakeIdentity(intake, contact, identity),
  );
  if (!bootstrapOk) {
    const anchorFail = checkPrimaryTrustAnchorHardFields(contact, identity);
    if (anchorFail) {
      throw new Error('REGISTRY_TRUST_ANCHOR_MISMATCH');
    }
  }
  // 验签用 identity 原文；落库 URL 可优先自定义域，避免写入已关闭的 workers.dev
  const identityForStore: RegistryIdentityPayload = {
    ...identity,
    registry_url: preferPersistedRegistryUrl(preferredRegistryUrl, identity.registry_url),
  };
  const endpoint = buildRegistryEndpoint0(identityForStore, ownerUserId, nodeApiToken, addedAt);
  // M9-AUDIT-2：地址簿 [0] 与 registered_registries 同批原子写
  const home = buildRegisteredRegistry(identityForStore, ownerUserId, nodeApiToken, addedAt);
  await writeRegistryEndpoints(env, db, [endpoint], addedAt, { registeredHome: home });
}

/** 读取 D1 中的 registry_endpoints 数组；缺失或非法 JSON 视为空。 */
export async function readRegistryEndpoints(db: D1Database): Promise<RegistryEndpoint[]> {
  const row = await db
    .prepare(`SELECT value FROM system_config WHERE key = 'registry_endpoints' LIMIT 1`)
    .first<{ value: string }>();
  if (!row?.value?.trim()) return [];
  try {
    const parsed: unknown = JSON.parse(row.value);
    return Array.isArray(parsed) ? (parsed as RegistryEndpoint[]) : [];
  } catch {
    return [];
  }
}

async function writeRegistryEndpoints(
  env: Env,
  db: D1Database,
  endpoints: RegistryEndpoint[],
  updatedAt: string,
  options?: { registeredHome?: ReturnType<typeof buildRegisteredRegistry> },
): Promise<void> {
  // R-MSG-1d：落盘前 seal；同明文只 seal 一次，避免 IV 漂移导致投影字面量不一致
  const sealCache = new Map<string, string>();
  const sealToken = async (raw: string): Promise<string> => {
    const key = raw.trim();
    const hit = sealCache.get(key);
    if (hit) return hit;
    const sealed = await prepareNodeApiTokenForDb(env, key);
    sealCache.set(key, sealed);
    return sealed;
  };
  const sealedEndpoints: RegistryEndpoint[] = [];
  for (const ep of endpoints) {
    if (!ep.node_api_token?.trim()) {
      sealedEndpoints.push(ep);
      continue;
    }
    sealedEndpoints.push({
      ...ep,
      node_api_token: await sealToken(ep.node_api_token),
    });
  }
  let home = options?.registeredHome;
  if (home?.node_api_token?.trim()) {
    home = {
      ...home,
      node_api_token: await sealToken(home.node_api_token),
    };
  }
  const stmts = [
    db.prepare(
      `INSERT OR REPLACE INTO system_config (key, value, updated_at) VALUES ('registry_endpoints', ?, ?)`,
    ).bind(JSON.stringify(sealedEndpoints), updatedAt),
    db.prepare(
      `INSERT OR IGNORE INTO system_config (key, value, updated_at) VALUES ('registry_directive_nonces', '[]', ?)`,
    ).bind(updatedAt),
  ];
  // M9-AUDIT-2：可选把 registered_registries 并进同一 batch，避免双写半成功
  if (home) {
    stmts.push(bindWriteRegisteredRegistries(db, home, updatedAt));
  }
  await db.batch(stmts);
}

/**
 * M9-AUDIT-2：按地址簿 [0] 修复 registered_registries（缺失或不一致）。
 * migrate / sync 在 skip 路径上必须调用，防止永久投影漂移。
 */
export async function repairRegisteredRegistryProjection(
  env: Env,
  db: D1Database,
): Promise<{ status: 'skipped' | 'repaired'; reason: string; registry_id?: string }> {
  const endpoints = await readRegistryEndpoints(db);
  const result = await migrateRegisteredRegistryIfNeeded(env, db, endpoints);
  if (result.status === 'migrated') {
    return {
      status: 'repaired',
      reason: result.reason ?? 'projection_repaired',
      registry_id: result.registry_id,
    };
  }
  return { status: 'skipped', reason: result.reason ?? 'noop' };
}

/** M9-3-6：写入 registry_endpoints（供 directives append 复用）。 */
export async function saveRegistryEndpoints(
  env: Env,
  db: D1Database,
  endpoints: RegistryEndpoint[],
  updatedAt: string = new Date().toISOString(),
): Promise<void> {
  await writeRegistryEndpoints(env, db, endpoints, updatedAt);
}

/**
 * M9-3-7：站主在备用注册中心完成登记后，激活 pending 条目并写入该中心凭证。
 */
export async function activatePendingRegistryEndpoint(
  env: Env,
  db: D1Database,
  registryId: string,
  identity: RegistryIdentityPayload,
  registrySignatureHex: string,
  ownerUserId: string,
  nodeApiToken: string,
  updatedAt: string = new Date().toISOString(),
  accessMeta?: {
    registration_mode: 'home' | 'access';
    home_registry_id?: string;
    principal_id?: string;
    principal_did?: string;
  },
): Promise<void> {
  const valid = await verifyRegistryIdentitySignature(identity, registrySignatureHex);
  if (!valid) {
    throw new Error('REGISTRY_IDENTITY_INVALID');
  }

  const endpoints = await readRegistryEndpoints(db);
  const idx = endpoints.findIndex((e) => e.registry_id === registryId);
  if (idx < 0) {
    throw new Error('REGISTRY_ENDPOINT_NOT_FOUND');
  }
  const pending = endpoints[idx];
  if (pending.status !== 'pending') {
    throw new Error('REGISTRY_ENDPOINT_NOT_PENDING');
  }

  const identityUrl = preferPersistedRegistryUrl(pending.registry_url, identity.registry_url);
  const pendingUrl = stripTrailingSlash(pending.registry_url);
  const signedUrl = stripTrailingSlash(identity.registry_url);
  const urlMatches =
    pendingUrl === signedUrl
    || (isWorkersDevUrl(pendingUrl) && !isWorkersDevUrl(signedUrl))
    || (isWorkersDevUrl(signedUrl) && !isWorkersDevUrl(pendingUrl) && pendingUrl === identityUrl);
  if (
    pending.registry_id !== identity.registry_id
    || !urlMatches
    || pending.trust_pubkey.trim() !== identity.pubkey.trim()
  ) {
    throw new Error('REGISTRY_IDENTITY_MISMATCH');
  }

  endpoints[idx] = {
    ...pending,
    registry_url: identityUrl,
    node_api_token: nodeApiToken,
    owner_user_id: ownerUserId,
    registration_mode: accessMeta?.registration_mode ?? 'access',
    home_registry_id: accessMeta?.home_registry_id,
    principal_id: accessMeta?.principal_id ?? ownerUserId,
    principal_did: accessMeta?.principal_did,
    status: 'active',
    fail_streak: 0,
    last_ok_at: updatedAt,
  };
  await writeRegistryEndpoints(env, db, endpoints, updatedAt);
}

export interface WellKnownRegistryIdentity {
  registry_id: string;
  pubkey: string;
  registry_url: string;
  issued_at: string;
  /** M9-PH-TA-2：官方主链强制要求；缺失即拒绝（不再 HTTPS TOFU）。 */
  nonce?: string;
  registry_signature?: string;
}

/** 从注册中心拉取 well-known 身份（M9-PH-TA-2：调用方须再过锚点验签）。 */
export async function fetchWellKnownRegistryIdentity(
  registryUrl: string,
): Promise<WellKnownRegistryIdentity> {
  const base = registryUrl.replace(/\/$/, '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(`${base}/.well-known/hailuo-registry-identity`, {
      method: 'GET',
      signal: controller.signal,
      redirect: 'manual',
    });
    if (!res.ok) {
      throw new Error(`well-known HTTP ${res.status}`);
    }
    const body = (await res.json()) as Partial<WellKnownRegistryIdentity>;
    if (!body.registry_id?.trim() || !body.pubkey?.trim() || !body.registry_url?.trim()) {
      throw new Error('well-known response missing required fields');
    }
    const nonce = body.nonce?.trim();
    const registry_signature = body.registry_signature?.trim();
    return {
      registry_id: body.registry_id.trim(),
      pubkey: body.pubkey.trim(),
      registry_url: body.registry_url.trim().replace(/\/$/, ''),
      issued_at: body.issued_at?.trim() ?? new Date().toISOString(),
      ...(nonce ? { nonce } : {}),
      ...(registry_signature ? { registry_signature } : {}),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * M9-PH-TA-2：对候选主中心 URL 的 well-known 身份做锚点硬条件 + REGISTRY_IDENTITY_V1 验签。
 * 无签名 / 验签失败 / 错 id / 错钥 / 非 https → 拒绝（废 TOFU）。
 */
export async function evaluatePrimaryWellKnownIdentity(
  contactUrl: string,
  identity: WellKnownRegistryIdentity,
): Promise<{ ok: true } | { ok: false; reason: PrimaryTrustAnchorRejectReason | 'well-known signature invalid' }> {
  const hard = checkPrimaryTrustAnchorHardFields(contactUrl, identity);
  if (hard) return { ok: false, reason: hard };

  if (!identity.registry_signature && !identity.nonce) {
    return { ok: false, reason: 'signature_missing' };
  }
  if (!identity.registry_signature || !identity.nonce) {
    return { ok: false, reason: 'signature_incomplete' };
  }

  const valid = await verifyRegistryWellKnownIdentitySignature(
    {
      registry_id: identity.registry_id,
      pubkey: identity.pubkey,
      registry_url: identity.registry_url,
      issued_at: identity.issued_at,
      nonce: identity.nonce,
    },
    identity.registry_signature,
  );
  if (!valid) {
    return { ok: false, reason: 'well-known signature invalid' };
  }
  return { ok: true };
}

export type MigrateRegistryEndpointsResult =
  | { status: 'skipped'; reason: string }
  | { status: 'migrated'; registry_id: string }
  | { status: 'repaired'; registry_id: string; reason: string }
  | { status: 'failed'; reason: string };

/**
 * 已部署节点升级：无 registry_endpoints 时从 env.REGISTRY_URL + 既有凭证合成 [0]。
 * Cron 幂等调用；登记新节点走 M9-3-1 验签路径，不经过本函数。
 * M9-PH-TA-2：必须 well-known 锚点验签通过；禁止无签名 HTTPS TOFU。
 * M9-AUDIT-2：已有 endpoints 时仍校验并修复 registered_registries 投影。
 *
 * M-OPT-SPLIT-5c-5 / M-OPT-SPLIT-7：函数签名从窄 `(env: { DB; REGISTRY_URL })` 扩为完整
 * `(env: Env)`；内部 `resolveIdentityDb(env)` 替代 `env.DB` 散点直读，让
 * 系统层看到「registry_endpoints + system_config + registered_registries
 * 都在 IDENTITY_DB」这一物理事实。BINDING_TABLE 行 `lib/registryEndpoints.ts`
 * 已纠正为 IDENTITY_DB（原误标 GOVERNANCE）。
 */
export async function migrateRegistryEndpointsIfNeeded(env: Env): Promise<MigrateRegistryEndpointsResult> {
  const db = resolveIdentityDb(env);
  const existing = await readRegistryEndpoints(db);
  if (existing.length > 0) {
    // 中文注释：不能因已有 endpoints 就永久跳过；投影半写失败须 repair
    const repaired = await repairRegisteredRegistryProjection(env, db);
    if (repaired.status === 'repaired' && repaired.registry_id) {
      return {
        status: 'repaired',
        registry_id: repaired.registry_id,
        reason: repaired.reason,
      };
    }
    return { status: 'skipped', reason: 'already_has_endpoints' };
  }

  const creds = await db.prepare(
    `SELECT key, value FROM system_config WHERE key IN ('node_api_token', 'owner_user_id')`,
  ).all<{ key: string; value: string }>();
  const map = new Map((creds.results ?? []).map((r) => [r.key, r.value]));
  const nodeApiToken = map.get('node_api_token')?.trim();
  const ownerUserId = map.get('owner_user_id')?.trim();
  if (!nodeApiToken || !ownerUserId) {
    return { status: 'skipped', reason: 'missing_legacy_creds' };
  }

  const registryUrl = env.REGISTRY_URL?.trim().replace(/\/$/, '');
  if (!registryUrl) {
    return { status: 'skipped', reason: 'missing_registry_url' };
  }

  const httpsFail = requireHttpsRegistryUrl(registryUrl);
  if (httpsFail) {
    return { status: 'failed', reason: httpsFail };
  }

  let identity: WellKnownRegistryIdentity;
  try {
    identity = await fetchWellKnownRegistryIdentity(registryUrl);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { status: 'failed', reason };
  }

  if (identity.registry_url !== registryUrl) {
    console.warn('[registry-endpoints/migrate] well-known registry_url 与 env.REGISTRY_URL 不一致', {
      env: registryUrl,
      wellKnown: identity.registry_url,
    });
  }

  const evaluated = await evaluatePrimaryWellKnownIdentity(registryUrl, identity);
  if (!evaluated.ok) {
    // 兼容 B8 断言文案：signature invalid；其余用锚点 reason
    return { status: 'failed', reason: evaluated.reason };
  }

  // 落库优先 env.REGISTRY_URL：避免 well-known 仍带 workers.dev 时写入死链
  const persistedUrl = preferPersistedRegistryUrl(registryUrl, identity.registry_url);

  const addedAt = new Date().toISOString();
  const endpoint: RegistryEndpoint = {
    registry_id: identity.registry_id,
    registry_url: persistedUrl,
    trust_pubkey: identity.pubkey,
    node_api_token: nodeApiToken,
    owner_user_id: ownerUserId,
    status: 'active',
    added_at: addedAt,
    fail_streak: 0,
  };

  const home = buildRegisteredRegistry(
    {
      registry_id: identity.registry_id,
      registry_url: persistedUrl,
      pubkey: identity.pubkey,
    },
    ownerUserId,
    nodeApiToken,
    addedAt,
  );
  // M9-AUDIT-2：endpoints + registered_registries 同批
  await writeRegistryEndpoints(env, db, [endpoint], addedAt, { registeredHome: home });
  return { status: 'migrated', registry_id: identity.registry_id };
}

export type SyncPrimaryRegistryUrlResult =
  | { status: 'skipped'; reason: string }
  | { status: 'synced'; from: string; to: string; registry_id: string }
  | { status: 'repaired'; registry_id: string; reason: string }
  | { status: 'failed'; reason: string };

/**
 * M9-PH-TA-2：env.REGISTRY_URL 变更或 [0] 锚点漂移时，强制 well-known 验签后再改写主中心条目。
 * 覆盖原「仅改 workers.dev URL、不验签」的风险路径。
 * M9-AUDIT-2：already_aligned 须同时检查 registered_registries；双写走同一 batch。
 */
export async function syncPrimaryRegistryUrlFromEnvIfNeeded(env: Env): Promise<SyncPrimaryRegistryUrlResult> {
  // M-OPT-SPLIT-7：registry_endpoints / system_config / registered_registries → IDENTITY
  const identityDb = resolveIdentityDb(env);
  const preferred = stripTrailingSlash(env.REGISTRY_URL ?? '');
  if (!preferred) {
    return { status: 'skipped', reason: 'missing_registry_url' };
  }
  const httpsFail = requireHttpsRegistryUrl(preferred);
  if (httpsFail) {
    return { status: 'failed', reason: httpsFail };
  }

  const endpoints = await readRegistryEndpoints(identityDb);
  if (endpoints.length === 0) {
    return { status: 'skipped', reason: 'no_endpoints_yet' };
  }

  const primary = endpoints[0];
  const current = stripTrailingSlash(primary.registry_url);
  const endpointAligned =
    current === preferred
    && isPrimaryRegistryId(primary.registry_id)
    && matchesPrimaryTrustPubkey(primary.trust_pubkey);

  if (endpointAligned) {
    // 中文注释：endpoint 已对齐仍可能投影缺失/漂移，必须 repair 而非直接 skip
    const repaired = await repairRegisteredRegistryProjection(env, identityDb);
    if (repaired.status === 'repaired' && repaired.registry_id) {
      return {
        status: 'repaired',
        registry_id: repaired.registry_id,
        reason: repaired.reason,
      };
    }
    return { status: 'skipped', reason: 'already_aligned' };
  }

  let identity: WellKnownRegistryIdentity;
  try {
    identity = await fetchWellKnownRegistryIdentity(preferred);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { status: 'failed', reason };
  }

  const evaluated = await evaluatePrimaryWellKnownIdentity(preferred, identity);
  if (!evaluated.ok) {
    return { status: 'failed', reason: evaluated.reason };
  }

  const persistedUrl = preferPersistedRegistryUrl(preferred, identity.registry_url);
  const updatedAt = new Date().toISOString();
  const nextEndpoints = [...endpoints];
  nextEndpoints[0] = {
    ...primary,
    registry_id: identity.registry_id,
    registry_url: persistedUrl,
    trust_pubkey: identity.pubkey,
  };

  const token = nextEndpoints[0].node_api_token?.trim();
  const ownerId = nextEndpoints[0].owner_user_id?.trim();
  const prev = await readRegisteredRegistry(identityDb);

  if (token && ownerId) {
    const baseHome = buildRegisteredRegistry(
      {
        registry_id: identity.registry_id,
        registry_url: persistedUrl,
        pubkey: identity.pubkey,
      },
      ownerId,
      token,
      updatedAt,
    );
    const home = prev && prev.registry_id === baseHome.registry_id
      ? {
        ...baseHome,
        registered_at: prev.registered_at,
        last_ok_at: prev.last_ok_at,
        last_fail_at: prev.last_fail_at,
        fail_streak: prev.fail_streak,
        status: prev.status,
      }
      : baseHome;
    await writeRegistryEndpoints(env, identityDb, nextEndpoints, updatedAt, { registeredHome: home });
  } else {
    await writeRegistryEndpoints(env, identityDb, nextEndpoints, updatedAt);
    if (prev) {
      try {
        await bindWriteRegisteredRegistries(identityDb, {
          ...prev,
          registry_id: identity.registry_id,
          registry_url: persistedUrl,
          trust_pubkey: identity.pubkey,
        }, updatedAt).run();
      } catch {
        return { status: 'failed', reason: 'registered_registries_update_failed' };
      }
    }
  }

  return {
    status: 'synced',
    from: current,
    to: persistedUrl,
    registry_id: identity.registry_id,
  };
}

export type RepairWorkersDevRegistryUrlResult =
  | { status: 'skipped'; reason: string }
  | { status: 'repaired'; from: string; to: string }
  | { status: 'failed'; reason: string };

/**
 * @deprecated M9-PH-TA-2：请用 syncPrimaryRegistryUrlFromEnvIfNeeded（强制锚点验签）。
 * 保留薄封装，避免旧 Cron/文档引用断裂；内部委托 sync。
 */
export async function repairWorkersDevRegistryUrlsIfNeeded(env: Env): Promise<RepairWorkersDevRegistryUrlResult> {
  const result = await syncPrimaryRegistryUrlFromEnvIfNeeded(env);
  if (result.status === 'synced') {
    return { status: 'repaired', from: result.from, to: result.to };
  }
  if (result.status === 'failed') {
    return { status: 'failed', reason: result.reason };
  }
  // synced 以外的 repaired（投影修复）对旧 API 记为 skipped（URL 未改）
  if (result.status === 'repaired') {
    return { status: 'skipped', reason: result.reason };
  }
  return { status: 'skipped', reason: result.reason };
}
