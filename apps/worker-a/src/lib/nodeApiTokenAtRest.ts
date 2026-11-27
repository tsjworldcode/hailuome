/**
 * R-MSG-1d：节点 D1 中 `nat_` 的 seal/open 唯一出口。
 * - 落盘：明文 → `natw1:…` AES-GCM（需 NODE_API_TOKEN_WRAP_SECRET）
 * - 读出：密文 unwrap；legacy 明文双读并懒迁移 rewrite
 * - 日志禁止输出完整明文
 */
import {
  isPlainNodeApiToken,
  isWrappedNodeApiToken,
  unwrapNodeApiToken,
  wrapNodeApiToken,
} from '@hailuo/shared-crypto';
import { resolveIdentityDb } from '../db/bindings';
import type { Env } from '../env';
import {
  REGISTERED_REGISTRIES_CONFIG_KEY,
  bindWriteRegisteredRegistries,
  type RegisteredRegistry,
} from './registeredRegistries';

export class NodeApiTokenWrapError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'NODE_API_TOKEN_WRAP_SECRET_MISSING'
      | 'NODE_API_TOKEN_MALFORMED'
      | 'NODE_API_TOKEN_UNWRAP_FAILED',
  ) {
    super(message);
    this.name = 'NodeApiTokenWrapError';
  }
}

/** 解析 wrap secret：独立 NODE_API_TOKEN_WRAP_SECRET（≥16）。 */
export function resolveNodeApiTokenWrapSecret(env: Env): string | null {
  const s = env.NODE_API_TOKEN_WRAP_SECRET?.trim() ?? '';
  return s.length >= 16 ? s : null;
}

export function requireNodeApiTokenWrapSecret(env: Env): string {
  const s = resolveNodeApiTokenWrapSecret(env);
  if (!s) {
    throw new NodeApiTokenWrapError(
      '节点未配置 NODE_API_TOKEN_WRAP_SECRET（≥16 字节），无法落盘注册中心凭证',
      'NODE_API_TOKEN_WRAP_SECRET_MISSING',
    );
  }
  return s;
}

/** 写入 D1 前：已 wrap 则原样；明文则 seal。 */
export async function prepareNodeApiTokenForDb(env: Env, token: string): Promise<string> {
  const t = token.trim();
  if (isWrappedNodeApiToken(t)) return t;
  if (!isPlainNodeApiToken(t)) {
    throw new NodeApiTokenWrapError('node_api_token 形态无效', 'NODE_API_TOKEN_MALFORMED');
  }
  return wrapNodeApiToken(t, requireNodeApiTokenWrapSecret(env));
}

export type OpenNodeApiTokenResult = {
  plain: string;
  /** 读出时仍是明文 legacy，调用方可触发懒迁移 */
  wasLegacyPlain: boolean;
};

/**
 * 读出供 Bearer 使用的明文。
 * - wrap → unwrap
 * - legacy `nat_` → 原样返回（wasLegacyPlain=true）；有 secret 时调用方应 rewrite
 */
export async function openNodeApiToken(env: Env, stored: string): Promise<OpenNodeApiTokenResult> {
  const t = stored.trim();
  if (isWrappedNodeApiToken(t)) {
    const secret = resolveNodeApiTokenWrapSecret(env);
    if (!secret) {
      throw new NodeApiTokenWrapError(
        '节点未配置 NODE_API_TOKEN_WRAP_SECRET，无法解密已包裹的注册中心凭证',
        'NODE_API_TOKEN_WRAP_SECRET_MISSING',
      );
    }
    try {
      const plain = await unwrapNodeApiToken(t, secret);
      return { plain, wasLegacyPlain: false };
    } catch {
      throw new NodeApiTokenWrapError('注册中心凭证密文无法解密', 'NODE_API_TOKEN_UNWRAP_FAILED');
    }
  }
  if (isPlainNodeApiToken(t)) {
    return { plain: t, wasLegacyPlain: true };
  }
  throw new NodeApiTokenWrapError('node_api_token 形态无效', 'NODE_API_TOKEN_MALFORMED');
}

/** 比较两处存储是否同一明文（IV 不同的密文仍相等）。 */
export async function nodeApiTokensEqualAtRest(
  env: Env,
  a: string,
  b: string,
): Promise<boolean> {
  try {
    const left = await openNodeApiToken(env, a);
    const right = await openNodeApiToken(env, b);
    return left.plain === right.plain;
  } catch {
    return a.trim() === b.trim();
  }
}

/**
 * 懒迁移：若 system_config / registered_registries / registry_endpoints 仍含明文 `nat_`，
 * 有 wrap secret 时一次性改写为同一密文字符串（三处共用，避免 IV 漂移误判）。
 */
export async function lazyRewritePlainNodeApiTokens(env: Env): Promise<{
  rewritten: boolean;
  reason: string;
}> {
  const secret = resolveNodeApiTokenWrapSecret(env);
  if (!secret) return { rewritten: false, reason: 'no_wrap_secret' };

  const identityDb = resolveIdentityDb(env);
  const rows = await identityDb
    .prepare(
      `SELECT key, value FROM system_config WHERE key IN ('node_api_token', 'registry_endpoints', ?)`,
    )
    .bind(REGISTERED_REGISTRIES_CONFIG_KEY)
    .all<{ key: string; value: string }>();

  const map = new Map((rows.results ?? []).map((r) => [r.key, r.value]));
  const rawConfig = map.get('node_api_token')?.trim() ?? '';
  let home: RegisteredRegistry | null = null;
  try {
    const parsed: unknown = JSON.parse(map.get(REGISTERED_REGISTRIES_CONFIG_KEY) ?? '[]');
    if (Array.isArray(parsed) && parsed[0] && typeof parsed[0] === 'object') {
      home = parsed[0] as RegisteredRegistry;
    }
  } catch {
    home = null;
  }
  let endpoints: Array<{ node_api_token?: string } & Record<string, unknown>> = [];
  try {
    const parsed: unknown = JSON.parse(map.get('registry_endpoints') ?? '[]');
    if (Array.isArray(parsed)) endpoints = parsed as typeof endpoints;
  } catch {
    endpoints = [];
  }

  const candidates = [
    rawConfig,
    home?.node_api_token?.trim() ?? '',
    ...endpoints.map((e) => (typeof e.node_api_token === 'string' ? e.node_api_token.trim() : '')),
  ].filter(Boolean);

  const anyPlain = candidates.some((c) => isPlainNodeApiToken(c));
  if (!anyPlain) return { rewritten: false, reason: 'already_wrapped_or_empty' };

  let plain = '';
  for (const c of candidates) {
    const opened = await openNodeApiToken(env, c);
    plain = opened.plain;
    break;
  }
  if (!plain) return { rewritten: false, reason: 'no_token' };

  const sealed = await wrapNodeApiToken(plain, secret);
  const now = new Date().toISOString();
  const nextEndpoints = endpoints.map((ep) =>
    typeof ep.node_api_token === 'string' && ep.node_api_token.trim()
      ? { ...ep, node_api_token: sealed }
      : ep,
  );
  const stmts = [
    identityDb
      .prepare(
        `INSERT OR REPLACE INTO system_config (key, value, updated_at) VALUES ('node_api_token', ?, ?)`,
      )
      .bind(sealed, now),
    identityDb
      .prepare(
        `INSERT OR REPLACE INTO system_config (key, value, updated_at) VALUES ('registry_endpoints', ?, ?)`,
      )
      .bind(JSON.stringify(nextEndpoints), now),
  ];
  if (home && typeof home.node_api_token === 'string') {
    stmts.push(bindWriteRegisteredRegistries(identityDb, { ...home, node_api_token: sealed }, now));
  }
  await identityDb.batch(stmts);
  return { rewritten: true, reason: 'legacy_plain_sealed' };
}
