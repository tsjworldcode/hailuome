/**
 * M9-3-R1：已登记注册中心权威表（system_config.registered_registries）。
 *
 * 硬约束：数组长度始终 ≤1；换家时整条替换，不追加第二家。
 * 含 URL / trust_pubkey / node_api_token — health / daily-sync 只读本表，不经 registry_endpoints 拼凭证。
 * registry_endpoints 继续作地址簿（pending 备用、failover 候选）。
 */

import {
  isPlainNodeApiToken,
  isWrappedNodeApiToken,
  unwrapNodeApiToken,
} from '@hailuo/shared-crypto';
import type { RegistryEndpoint, RegistryIdentityPayload } from './registryEndpoints';

export const REGISTERED_REGISTRIES_CONFIG_KEY = 'registered_registries';

/** 连通状态：仅针对这一家已登记中心。 */
export type RegisteredRegistryStatus = 'active' | 'unreachable';

export interface RegisteredRegistry {
  registry_id: string;
  registry_url: string;
  trust_pubkey: string;
  node_api_token: string;
  owner_user_id: string;
  status: RegisteredRegistryStatus;
  registered_at: string;
  last_ok_at?: string;
  last_fail_at?: string;
  fail_streak: number;
}

function stripTrailingSlash(url: string): string {
  return url.trim().replace(/\/$/, '');
}

/** 将已登记记录转成 router 可用的 endpoint 形状（不读地址簿）。 */
export function registeredRegistryToEndpoint(reg: RegisteredRegistry): RegistryEndpoint {
  return {
    registry_id: reg.registry_id,
    registry_url: stripTrailingSlash(reg.registry_url),
    trust_pubkey: reg.trust_pubkey,
    node_api_token: reg.node_api_token,
    owner_user_id: reg.owner_user_id,
    status: reg.status,
    added_at: reg.registered_at,
    last_ok_at: reg.last_ok_at,
    last_fail_at: reg.last_fail_at,
    fail_streak: reg.fail_streak,
  };
}

export function buildRegisteredRegistry(
  identity: Pick<RegistryIdentityPayload, 'registry_id' | 'registry_url' | 'pubkey'>,
  ownerUserId: string,
  nodeApiToken: string,
  registeredAt: string = new Date().toISOString(),
): RegisteredRegistry {
  return {
    registry_id: identity.registry_id.trim(),
    registry_url: stripTrailingSlash(identity.registry_url),
    trust_pubkey: identity.pubkey.trim(),
    node_api_token: nodeApiToken.trim(),
    owner_user_id: ownerUserId.trim(),
    status: 'active',
    registered_at: registeredAt,
    fail_streak: 0,
  };
}

/** 从地址簿 active+token 条目回填已登记表（升级迁移）。 */
export function registeredRegistryFromEndpoint(endpoint: RegistryEndpoint): RegisteredRegistry | null {
  const token = endpoint.node_api_token?.trim();
  const userId = endpoint.owner_user_id?.trim();
  if (!token || !userId) return null;
  if (endpoint.status === 'pending') return null;
  return {
    registry_id: endpoint.registry_id,
    registry_url: stripTrailingSlash(endpoint.registry_url),
    trust_pubkey: endpoint.trust_pubkey,
    node_api_token: token,
    owner_user_id: userId,
    status: endpoint.status === 'unreachable' ? 'unreachable' : 'active',
    registered_at: endpoint.added_at,
    last_ok_at: endpoint.last_ok_at,
    last_fail_at: endpoint.last_fail_at,
    fail_streak: endpoint.fail_streak,
  };
}

export async function readRegisteredRegistries(db: D1Database): Promise<RegisteredRegistry[]> {
  const row = await db
    .prepare(`SELECT value FROM system_config WHERE key = ? LIMIT 1`)
    .bind(REGISTERED_REGISTRIES_CONFIG_KEY)
    .first<{ value: string }>();
  if (!row?.value?.trim()) return [];
  try {
    const parsed: unknown = JSON.parse(row.value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isRegisteredRegistryShape).slice(0, 1);
  } catch {
    return [];
  }
}

function isRegisteredRegistryShape(item: unknown): item is RegisteredRegistry {
  if (!item || typeof item !== 'object') return false;
  const row = item as Record<string, unknown>;
  return typeof row.registry_id === 'string'
    && typeof row.registry_url === 'string'
    && typeof row.trust_pubkey === 'string'
    && typeof row.node_api_token === 'string'
    && typeof row.owner_user_id === 'string'
    && (row.status === 'active' || row.status === 'unreachable')
    && typeof row.registered_at === 'string'
    && typeof row.fail_streak === 'number'
    && looksLikeStoredNodeApiToken(row.node_api_token)
    && Boolean(row.owner_user_id.trim());
}

/** 明文 nat_ 或 R-MSG-1d wrap 密文均可。 */
function looksLikeStoredNodeApiToken(token: string): boolean {
  const t = token.trim();
  return (t.startsWith('nat_') && t.length >= 12) || t.startsWith('natw1:');
}

/** 读取当前唯一已登记中心；无则 null。 */
export async function readRegisteredRegistry(db: D1Database): Promise<RegisteredRegistry | null> {
  const list = await readRegisteredRegistries(db);
  return list[0] ?? null;
}

/**
 * 写入已登记表：始终覆盖为长度 0 或 1。
 * 传入 null / 空 → 清空；传入一条 → 替换为该条。
 */
export function bindWriteRegisteredRegistries(
  db: D1Database,
  registries: RegisteredRegistry[] | RegisteredRegistry | null,
  updatedAt: string = new Date().toISOString(),
): D1PreparedStatement {
  const list = registries == null
    ? []
    : Array.isArray(registries)
      ? registries.slice(0, 1)
      : [registries];
  return db
    .prepare(
      `INSERT OR REPLACE INTO system_config (key, value, updated_at) VALUES (?, ?, ?)`,
    )
    .bind(REGISTERED_REGISTRIES_CONFIG_KEY, JSON.stringify(list), updatedAt);
}

export async function writeRegisteredRegistries(
  db: D1Database,
  registries: RegisteredRegistry[] | RegisteredRegistry | null,
  updatedAt: string = new Date().toISOString(),
): Promise<void> {
  await bindWriteRegisteredRegistries(db, registries, updatedAt).run();
}

/** 比对已登记投影与地址簿 [0] 推导结果（身份字段；token 按明文等价，避免 import at-rest 循环依赖）。 */
async function openStoredTokenForCompare(
  env: import('../env').Env,
  stored: string,
): Promise<string> {
  const t = stored.trim();
  if (isWrappedNodeApiToken(t)) {
    const secret = env.NODE_API_TOKEN_WRAP_SECRET?.trim() ?? '';
    if (secret.length < 16) throw new Error('NODE_API_TOKEN_WRAP_SECRET_MISSING');
    return unwrapNodeApiToken(t, secret);
  }
  if (isPlainNodeApiToken(t)) return t;
  throw new Error('NODE_API_TOKEN_MALFORMED');
}

export async function registeredProjectionMatches(
  env: import('../env').Env,
  current: RegisteredRegistry,
  expected: RegisteredRegistry,
): Promise<boolean> {
  let tokenOk = current.node_api_token.trim() === expected.node_api_token.trim();
  if (!tokenOk) {
    try {
      const left = await openStoredTokenForCompare(env, current.node_api_token);
      const right = await openStoredTokenForCompare(env, expected.node_api_token);
      tokenOk = left === right;
    } catch {
      tokenOk = false;
    }
  }
  return current.registry_id === expected.registry_id
    && stripTrailingSlash(current.registry_url) === stripTrailingSlash(expected.registry_url)
    && current.trust_pubkey.trim() === expected.trust_pubkey.trim()
    && tokenOk
    && current.owner_user_id === expected.owner_user_id;
}

/** 登记成功：以本家为唯一会员（换家即整条替换）。 */
export async function persistRegisteredRegistry(
  db: D1Database,
  identity: Pick<RegistryIdentityPayload, 'registry_id' | 'registry_url' | 'pubkey'>,
  ownerUserId: string,
  nodeApiToken: string,
  registeredAt: string = new Date().toISOString(),
): Promise<RegisteredRegistry> {
  const row = buildRegisteredRegistry(identity, ownerUserId, nodeApiToken, registeredAt);
  await writeRegisteredRegistries(db, row, registeredAt);
  return row;
}

export async function patchRegisteredRegistry(
  db: D1Database,
  patch: Partial<RegisteredRegistry>,
): Promise<void> {
  const current = await readRegisteredRegistry(db);
  if (!current) return;
  if (patch.registry_id && patch.registry_id !== current.registry_id) return;
  await writeRegisteredRegistries(db, { ...current, ...patch, registry_id: current.registry_id });
}

export async function markRegisteredRegistrySuccess(db: D1Database): Promise<void> {
  const now = new Date().toISOString();
  await patchRegisteredRegistry(db, {
    last_ok_at: now,
    fail_streak: 0,
    status: 'active',
  });
}

export async function markRegisteredRegistryUnreachable(db: D1Database): Promise<void> {
  const current = await readRegisteredRegistry(db);
  if (!current) return;
  const now = new Date().toISOString();
  await writeRegisteredRegistries(db, {
    ...current,
    last_fail_at: now,
    fail_streak: current.fail_streak + 1,
    status: 'unreachable',
  });
}

/**
 * M9-AUDIT-2：若已登记表缺失，或与地址簿 [0] 身份字段不一致，则按 [0] 回填/修复。
 * 供 Cron / migrate skip 路径 / registryRouter 幂等调用。
 */
export async function migrateRegisteredRegistryIfNeeded(
  env: import('../env').Env,
  db: D1Database,
  endpoints: RegistryEndpoint[],
): Promise<{ status: 'skipped' | 'migrated'; reason?: string; registry_id?: string }> {
  const primary = endpoints[0];
  if (!primary) {
    return { status: 'skipped', reason: 'no_endpoints' };
  }
  const built = registeredRegistryFromEndpoint(primary);
  if (!built) {
    return { status: 'skipped', reason: 'primary_not_registered' };
  }

  const existing = await readRegisteredRegistry(db);
  if (existing && (await registeredProjectionMatches(env, existing, built))) {
    return { status: 'skipped', reason: 'already_registered' };
  }

  await writeRegisteredRegistries(db, built);
  return {
    status: 'migrated',
    registry_id: built.registry_id,
    reason: existing ? 'projection_mismatch' : 'projection_missing',
  };
}
