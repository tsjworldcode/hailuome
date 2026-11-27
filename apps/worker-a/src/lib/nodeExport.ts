/**
 * M9-7 / R-AUDIT-V3 2.9：节点搬家 — 导出（D1 dump + 图片 manifest + Ed25519 JWK）。
 *
 * 格式 hailuo-node-export-v1（JSON）。MESSAGING_DB 私信/群聊不在本 bundle。
 *
 * M-OPT-SPLIT-A6-5：按表选库 dump（观察期 resolve*Db 仍可 fallback env.DB）。
 * import 仍单库（env.DB / DB_IMPORT），真分库后再开多库 import。
 */
import { ed25519PrivateKeyPkcs8HexToJwk } from '@hailuo/shared-crypto';
import { HAILUO_PROTO_VERSION, nowISO } from '@hailuo/shared-utils';
import {
  resolveContentDb,
  resolveGovernanceDb,
  resolveIdentityDb,
} from '../db/bindings';
import type { Env } from '../env';
import { isNoSuchTableError } from './nodeImportGuards';

/** 导出 bundle schema 版本（与 progress M9-7 对齐） */
export const NODE_EXPORT_SCHEMA_VERSION = 'hailuo-node-export-v1' as const;

/** 单表最大行数（Free Tier 响应体保护） */
export const NODE_EXPORT_MAX_ROWS_PER_TABLE = 5_000;

/** 响应 JSON 软上限（约 8 MB，留 Workers 余量） */
export const NODE_EXPORT_MAX_JSON_BYTES = 8 * 1024 * 1024;

/** 可搬家 D1 表白名单（不含 ephemeral / MESSAGING_DB / 运维日志） */
export const NODE_EXPORT_TABLES = [
  'users',
  'posts',
  'follows',
  'blacklist',
  'revoked_tokens',
  'feed_cache',
  'system_config',
  'owner_credentials',
  'owner_totp_settings',
  'owner_totp_recovery_codes',
  'cache_entries',
  'post_likes',
  'post_replies',
  'private_notes',
  'private_note_attachments',
  'private_notes_wrapped_key',
  'media_storage_config',
  'media_storage_usage',
  'media_object_registry',
  'registry_recommended_users',
  'fof_recommended_users',
  'registry_quota_buckets',
  'lookup_resolve_day_stats',
  'node_url_moved_entries',
  'local_notifications',
] as const;

export type NodeExportTableName = (typeof NODE_EXPORT_TABLES)[number];

/**
 * 表 → binding。以写路径运行时为准（观察期 fallback 同物理库）：
 * - owner_totp_* → IDENTITY（A-4 adapter）
 * - registry_quota_buckets / lookup_resolve_day_stats → IDENTITY（MIGRATION-COVERAGE：两表实际只建在
 *   migrations-identity/0012、0045；旧注释写 GOVERNANCE 是拆库勘误，运行时会 no such table）
 */
export const NODE_EXPORT_TABLE_BINDING: Record<
  NodeExportTableName,
  'IDENTITY' | 'GOVERNANCE' | 'CONTENT'
> = {
  users: 'IDENTITY',
  follows: 'IDENTITY',
  system_config: 'IDENTITY',
  owner_credentials: 'IDENTITY',
  owner_totp_settings: 'IDENTITY',
  owner_totp_recovery_codes: 'IDENTITY',
  cache_entries: 'IDENTITY',
  private_notes_wrapped_key: 'IDENTITY',
  media_storage_usage: 'IDENTITY',
  media_object_registry: 'IDENTITY',
  node_url_moved_entries: 'IDENTITY',
  blacklist: 'GOVERNANCE',
  revoked_tokens: 'GOVERNANCE',
  feed_cache: 'GOVERNANCE',
  post_likes: 'GOVERNANCE',
  post_replies: 'GOVERNANCE',
  registry_recommended_users: 'GOVERNANCE',
  fof_recommended_users: 'GOVERNANCE',
  media_storage_config: 'GOVERNANCE',
  local_notifications: 'GOVERNANCE',
  registry_quota_buckets: 'IDENTITY',
  lookup_resolve_day_stats: 'IDENTITY',
  posts: 'CONTENT',
  private_notes: 'CONTENT',
  private_note_attachments: 'CONTENT',
};

function resolveDbForExportTable(env: Env, table: NodeExportTableName): D1Database {
  const binding = NODE_EXPORT_TABLE_BINDING[table];
  if (binding === 'CONTENT') return resolveContentDb(env);
  if (binding === 'GOVERNANCE') return resolveGovernanceDb(env);
  return resolveIdentityDb(env);
}

export interface NodeExportMeta {
  schema_version: typeof NODE_EXPORT_SCHEMA_VERSION;
  proto_version: typeof HAILUO_PROTO_VERSION;
  exported_at: string;
  export_origin: string;
  table_counts: Record<string, number>;
  image_manifest_count: number;
  notes: readonly string[];
}

export interface NodeExportCrypto {
  ed25519_public_key_hex: string;
  ed25519_private_key_jwk: JsonWebKey;
  /** import 后须手动 wrangler secret put ED25519_PRIVATE_KEY（PKCS8 hex） */
  ed25519_private_key_pkcs8_hex_hint: string;
}

export interface NodeExportImageManifestItem {
  storage_key: string;
  sources: string[];
}

export interface NodeExportBundle {
  meta: NodeExportMeta;
  d1: Record<string, Record<string, unknown>[]>;
  crypto: NodeExportCrypto;
  image_manifest: NodeExportImageManifestItem[];
}

export class NodeExportTooLargeError extends Error {
  constructor(
    readonly table: string,
    readonly limit: number,
  ) {
    super(`表 ${table} 行数超过导出上限 ${limit}`);
    this.name = 'NodeExportTooLargeError';
  }
}

async function dumpTable(
  db: D1Database,
  table: NodeExportTableName,
): Promise<Record<string, unknown>[]> {
  try {
    const res = await db
      .prepare(`SELECT * FROM ${table} LIMIT ?`)
      .bind(NODE_EXPORT_MAX_ROWS_PER_TABLE + 1)
      .all<Record<string, unknown>>();
    const rows = res.results ?? [];
    if (rows.length > NODE_EXPORT_MAX_ROWS_PER_TABLE) {
      throw new NodeExportTooLargeError(table, NODE_EXPORT_MAX_ROWS_PER_TABLE);
    }
    return rows;
  } catch (err) {
    if (err instanceof NodeExportTooLargeError) throw err;
    if (isNoSuchTableError(err)) return [];
    throw err;
  }
}

function parseImageKeys(raw: unknown): string[] {
  if (typeof raw !== 'string' || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((k): k is string => typeof k === 'string' && k.length > 0);
  } catch {
    return [];
  }
}

function addManifestKey(
  map: Map<string, Set<string>>,
  key: string,
  source: string,
): void {
  const trimmed = key.trim();
  if (!trimmed) return;
  const set = map.get(trimmed) ?? new Set<string>();
  set.add(source);
  map.set(trimmed, set);
}

/** 从 posts / registry / 头像等汇总 IMAGE_KV 键清单（不含二进制） */
export async function buildImageManifest(env: Env): Promise<NodeExportImageManifestItem[]> {
  const map = new Map<string, Set<string>>();
  const contentDb = resolveContentDb(env);
  const identityDb = resolveIdentityDb(env);

  const posts = await contentDb
    .prepare(`SELECT image_keys FROM posts WHERE deleted_at IS NULL LIMIT ?`)
    .bind(NODE_EXPORT_MAX_ROWS_PER_TABLE)
    .all<{ image_keys: string }>();
  for (const row of posts.results ?? []) {
    for (const key of parseImageKeys(row.image_keys)) {
      addManifestKey(map, key, 'posts');
    }
  }

  const users = await identityDb
    .prepare(`SELECT avatar_key FROM users WHERE avatar_key IS NOT NULL AND avatar_key != '' LIMIT 100`)
    .all<{ avatar_key: string }>();
  for (const row of users.results ?? []) {
    addManifestKey(map, row.avatar_key, 'users.avatar_key');
  }

  try {
    const registry = await identityDb
      .prepare(
        // 公开帖媒体登记行的 scope 实际是 'public_post'（0037+0043 默认值），
        // 私信/群图是 'messaging'；旧写法只查 ('public','messaging') 会漏掉所有公开帖图片。
        `SELECT object_key AS storage_key, scope FROM media_object_registry
          WHERE scope IN ('public_post', 'messaging')
          LIMIT ?`,
      )
      .bind(NODE_EXPORT_MAX_ROWS_PER_TABLE)
      .all<{ storage_key: string; scope: string }>();
    for (const row of registry.results ?? []) {
      addManifestKey(map, row.storage_key, `media_object_registry:${row.scope}`);
    }
  } catch {
    // 表不存在时忽略
  }

  return [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([storage_key, sources]) => ({
      storage_key,
      sources: [...sources].sort(),
    }));
}

export type NodeExportCryptoEnv = {
  ED25519_PRIVATE_KEY: string;
  ED25519_PUBLIC_KEY?: string;
  WORKER_B_URL?: string;
};

export async function buildNodeExportBundle(
  env: Env,
  cryptoEnv: NodeExportCryptoEnv,
  exportOrigin: string,
): Promise<NodeExportBundle> {
  const d1: Record<string, Record<string, unknown>[]> = {};
  const table_counts: Record<string, number> = {};

  for (const table of NODE_EXPORT_TABLES) {
    const db = resolveDbForExportTable(env, table);
    const rows = await dumpTable(db, table);
    d1[table] = rows;
    table_counts[table] = rows.length;
  }

  const image_manifest = await buildImageManifest(env);
  const privateJwk = await ed25519PrivateKeyPkcs8HexToJwk(cryptoEnv.ED25519_PRIVATE_KEY);

  let publicHex = cryptoEnv.ED25519_PUBLIC_KEY?.trim() ?? '';
  if (!publicHex) {
    const identityDb = resolveIdentityDb(env);
    const userRow = await identityDb
      .prepare(`SELECT pubkey FROM users LIMIT 1`)
      .first<{ pubkey: string }>();
    publicHex = userRow?.pubkey?.trim() ?? '';
  }

  return {
    meta: {
      schema_version: NODE_EXPORT_SCHEMA_VERSION,
      proto_version: HAILUO_PROTO_VERSION,
      exported_at: nowISO(),
      export_origin: exportOrigin,
      table_counts,
      image_manifest_count: image_manifest.length,
      notes: [
        '⚠️ 本 bundle 为明文 JSON，含站主凭证哈希、Ed25519 私钥、私密笔记等；请离线加密保管，勿上传公开网盘。',
        '本 bundle 不含 IMAGE_KV / POSTS_CACHE_KV 二进制；请按 image_manifest 另行复制对象存储或重新上传图片。',
        'MESSAGING_DB（私信/群聊）不在本 bundle；请使用 M10-5b 加密备份单独迁移。',
        '导入时 owner_totp_* 不会迁入（TOTP_WRAP_SECRET 不随包迁移）；请在新节点重新启用二次验证。',
        '导入后须在新节点设置 wrangler secret：ED25519_PRIVATE_KEY（见 crypto.ed25519_private_key_pkcs8_hex_hint）。',
      ],
    },
    d1,
    crypto: {
      ed25519_public_key_hex: publicHex,
      ed25519_private_key_jwk: privateJwk,
      ed25519_private_key_pkcs8_hex_hint: cryptoEnv.ED25519_PRIVATE_KEY,
    },
    image_manifest,
  };
}

export function estimateBundleJsonBytes(bundle: NodeExportBundle): number {
  return new TextEncoder().encode(JSON.stringify(bundle)).length;
}
