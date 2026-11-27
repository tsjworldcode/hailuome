/**
 * M9-PH-BI-2：入口当前接待窗（B · active_intake）与 manifest 缓存 — IDENTITY_DB system_config。
 *
 * - **不是** home（C）：日常 sync/health 仍只认已登记中心表
 * - 写频次 ≈ 冷启动 / 未登记打开登记页 → D1，禁止热路径 KV 写
 * - 生产日志勿 dump `bootstrap_manifest_json` 全文（反追查 / 体积）
 *
 * 契约文档：docs/worker-a-api.md §海螺入口消费层（active_intake）
 * 跨仓对齐：intake 字段名与 bootstrap 计划 m-bootstrap-ops-plan.md §四/§八/§十二一致
 */

import { BOOTSTRAP_TRUST_PUBKEY_VERSION } from './bootstrapIntakeTrustAnchor';

export const ACTIVE_INTAKE_CONFIG_KEY = 'active_intake' as const;
/** 同一次登记里，因连不上已领到的接待中心而再拉入口，最多记一次。 */
export const BOOTSTRAP_INTAKE_REPULL_USED_KEY = 'bootstrap_intake_repull_used' as const;
export const BOOTSTRAP_MANIFEST_VERSION_KEY = 'bootstrap_manifest_version' as const;
export const BOOTSTRAP_MANIFEST_CACHED_AT_KEY = 'bootstrap_manifest_cached_at' as const;
export const BOOTSTRAP_MANIFEST_JSON_KEY = 'bootstrap_manifest_json' as const;

/** 接待窗来源：入口验签成功 / 入口失败回落主中心。 */
export type ActiveIntakeSource = 'bootstrap' | 'primary_fallback';

/** manifest 本地缓存摘要（版本单调，防回滚）。 */
export interface BootstrapManifestCache {
  readonly version: number;
  readonly cached_at: string;
  /** 可选全文；排障用，可读为空。 */
  readonly json: string | null;
}

/**
 * 当前接待（B）：仅未登记 / 重新登记流程使用。
 *
 * EV-2-2 扩 `pubkey_version` 字段：
 * - V1 manifest 写入时 = 1（隐式）
 * - V2 manifest 写入时 = manifest `pubkey_version` 字段值
 * - 主中心回落 = 1
 * 缓存命中后下次 refresh 仍需比对该字段（防 manifest 内部 vs 本地钉死版本号漂移）。
 *
 * EV-3-6 扩 `rotation_window_end_at` 字段（V3 协议过渡期）：
 * - V3 manifest 写入时 = manifest `rotation_window_end_at` 字段值（ISO 8601 UTC）
 * - V1/V2 旧 manifest 写入时 = null（旧缓存迁移路径，**不**破 V1 缓存）
 * - 节点端 refresh 时主动校验：`isRotationWindowExpired` → 过期则拒绝落库
 *   并返 `BOOTSTRAP_MANIFEST_LEGACY_AFTER_WINDOW` 错误码（已存在，**复用** EV-3-2）
 */
export interface ActiveIntake {
  readonly registry_id: string;
  readonly registry_url: string;
  readonly trust_pubkey: string;
  readonly pubkey_version: number;
  readonly source: ActiveIntakeSource;
  readonly updated_at: string;
  /**
   * EV-3-6：V3 协议过渡期旧钥过期时间（ISO 8601 UTC）。
   * - V1/V2 manifest 写时 = null（不破 V1 旧缓存）
   * - V3 manifest 写时 = manifest.rotation_window_end_at
   * - 节点端 refresh 时立即校验过期；过期 manifest 应被拒绝落库
   */
  readonly rotation_window_end_at: string | null;
}

function stripTrailingSlash(url: string): string {
  return url.trim().replace(/\/$/, '');
}

function isActiveIntakeSource(v: unknown): v is ActiveIntakeSource {
  return v === 'bootstrap' || v === 'primary_fallback';
}

const ISO_RE_ACTIVE_INTAKE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

/** 严格解析 active_intake JSON；非法 / 空 → null。
 *
 * EV-2-2 兼容旧缓存：缺 `pubkey_version` 字段时缺省 1（V1 旧缓存迁移路径）。
 * 但缺该字段会被审计为「旧数据」——若想严格校验，可改为 `!== 1` 报错。
 *
 * EV-3-6 兼容旧缓存：缺 `rotation_window_end_at` 字段时缺省 null（V1/V2 旧缓存迁移路径）。
 * 显式非 ISO 字符串 → 拒（与 manifest V3 字段语义一致）。
 */
export function parseActiveIntake(raw: string | null | undefined): ActiveIntake | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const row = parsed as Record<string, unknown>;
    if (typeof row.registry_id !== 'string' || !row.registry_id.trim()) return null;
    if (typeof row.registry_url !== 'string' || !row.registry_url.trim()) return null;
    if (typeof row.trust_pubkey !== 'string' || !row.trust_pubkey.trim()) return null;
    if (!isActiveIntakeSource(row.source)) return null;
    if (typeof row.updated_at !== 'string' || !row.updated_at.trim()) return null;
    // EV-2-2-3：pubkey_version 缺省 = 钉死（V1 旧缓存迁移）；显式非正整数 → 拒
    let pubkeyVersion = BOOTSTRAP_TRUST_PUBKEY_VERSION;
    if (row.pubkey_version !== undefined) {
      if (typeof row.pubkey_version !== 'number' || !Number.isInteger(row.pubkey_version) || row.pubkey_version <= 0) {
        return null;
      }
      pubkeyVersion = row.pubkey_version;
    }
    // EV-3-6：rotation_window_end_at 缺省 = null（V1/V2 旧缓存迁移）；显式非 ISO 字符串 → 拒
    let rotationWindowEndAt: string | null = null;
    if (row.rotation_window_end_at !== undefined && row.rotation_window_end_at !== null) {
      if (typeof row.rotation_window_end_at !== 'string' || !ISO_RE_ACTIVE_INTAKE.test(row.rotation_window_end_at)) {
        return null;
      }
      rotationWindowEndAt = row.rotation_window_end_at;
    }
    return {
      registry_id: row.registry_id.trim(),
      registry_url: stripTrailingSlash(row.registry_url),
      trust_pubkey: row.trust_pubkey.trim(),
      pubkey_version: pubkeyVersion,
      source: row.source,
      updated_at: row.updated_at.trim(),
      rotation_window_end_at: rotationWindowEndAt,
    };
  } catch {
    return null;
  }
}

function normalizePubkeyB64(raw: string): string {
  return raw.trim().replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
}

/**
 * M9-PH-BI-5：入口验签写入的 B 与即将落库的 identity/contact 是否同一接待。
 * 命中则可跳过主中心域名 allowlist；primary_fallback 不得走本闸。
 */
export function matchesBootstrapIntakeIdentity(
  intake: ActiveIntake,
  contactUrl: string,
  identity: { registry_id: string; pubkey: string; registry_url: string },
): boolean {
  if (intake.source !== 'bootstrap') return false;
  const contact = stripTrailingSlash(contactUrl);
  const idUrl = stripTrailingSlash(identity.registry_url);
  if (!contact || contact !== intake.registry_url || idUrl !== intake.registry_url) return false;
  if (intake.registry_id !== identity.registry_id.trim()) return false;
  const a = normalizePubkeyB64(intake.trust_pubkey);
  const b = normalizePubkeyB64(identity.pubkey);
  return a.length > 0 && a === b;
}

export function serializeActiveIntake(intake: ActiveIntake): string {
  const normalized: ActiveIntake = {
    registry_id: intake.registry_id.trim(),
    registry_url: stripTrailingSlash(intake.registry_url),
    trust_pubkey: intake.trust_pubkey.trim(),
    // EV-2-2-3：写入时确保 pubkey_version 是正整数；异常输入落钉死（与入口版本号同步）
    pubkey_version:
      Number.isInteger(intake.pubkey_version) && intake.pubkey_version > 0
        ? intake.pubkey_version
        : BOOTSTRAP_TRUST_PUBKEY_VERSION,
    source: intake.source,
    updated_at: intake.updated_at.trim(),
    // EV-3-6：rotation_window_end_at null 时**不**写字段（保持 V1 旧缓存字节级兼容）
    // 显式 ISO 字符串保留（V3 manifest 写入）；非 ISO → 落 null（与 parse 对称）
    rotation_window_end_at:
      typeof intake.rotation_window_end_at === 'string' && ISO_RE_ACTIVE_INTAKE.test(intake.rotation_window_end_at)
        ? intake.rotation_window_end_at
        : null,
  };
  // EV-3-6：null 时**不**序列化字段（V1 旧缓存迁移路径，**不**破字节级兼容）
  if (normalized.rotation_window_end_at === null) {
    const { rotation_window_end_at: _omit, ...rest } = normalized;
    return JSON.stringify(rest);
  }
  return JSON.stringify(normalized);
}

/**
 * 新版本是否可接受（防 rollback）。
 * `prev` 缺失或 0 时，任意正整数 version 可接受；否则须严格大于 prev。
 */
export function isManifestVersionNewer(
  nextVersion: number,
  prevVersion: number | null | undefined,
): boolean {
  if (!Number.isFinite(nextVersion) || nextVersion <= 0 || !Number.isInteger(nextVersion)) {
    return false;
  }
  const prev = prevVersion == null || !Number.isFinite(prevVersion) ? 0 : prevVersion;
  return nextVersion > prev;
}

/**
 * EV-3-6：V3 协议过渡期旧钥过期时间检查。
 * - `rotationWindowEndAt` 为 null / undefined / 空 → 不过期（V1/V2 manifest 无此字段）
 * - `nowMs` 为 null / undefined → 用 Date.now()（生产默认）
 * - nowMs > parse(rotationWindowEndAt) → 过期
 * - 非法 ISO 字符串 → 当作"已过期"（fail-closed；与 parseActiveIntake 拒收非 ISO 对称）
 */
export function isRotationWindowExpired(
  rotationWindowEndAt: string | null | undefined,
  nowMs?: number | null,
): boolean {
  if (typeof rotationWindowEndAt !== 'string' || !rotationWindowEndAt.trim()) {
    return false; // V1/V2 旧 manifest 无 rotation_window_end_at → 永不过期
  }
  if (!ISO_RE_ACTIVE_INTAKE.test(rotationWindowEndAt)) {
    return true; // 非法 ISO → fail-closed：当作已过期
  }
  const endMs = Date.parse(rotationWindowEndAt);
  if (!Number.isFinite(endMs)) {
    return true; // 解析失败 → fail-closed
  }
  const now = nowMs ?? Date.now();
  return now > endMs;
}

export async function readBootstrapIntakeRepullUsed(db: D1Database): Promise<boolean> {
  const row = await db
    .prepare(`SELECT value FROM system_config WHERE key = ? LIMIT 1`)
    .bind(BOOTSTRAP_INTAKE_REPULL_USED_KEY)
    .first<{ value: string }>();
  return row?.value === '1';
}

/** 再拉这一回已经用过。写在拉取之前，避免失败后又拉第三次。 */
export async function markBootstrapIntakeRepullUsed(db: D1Database): Promise<void> {
  const now = new Date().toISOString();
  await db
    .prepare(`INSERT OR REPLACE INTO system_config(key, value, updated_at) VALUES(?, ?, ?)`)
    .bind(BOOTSTRAP_INTAKE_REPULL_USED_KEY, '1', now)
    .run();
}

export async function readActiveIntake(db: D1Database): Promise<ActiveIntake | null> {
  const row = await db
    .prepare(`SELECT value FROM system_config WHERE key = ? LIMIT 1`)
    .bind(ACTIVE_INTAKE_CONFIG_KEY)
    .first<{ value: string }>();
  return parseActiveIntake(row?.value);
}

/**
 * 没有避开参数：本地还没有接待记录才写入，后到的普通领取丢掉。
 * 再问成功：覆盖本地。此后才到的上一次领取看到已有记录，写不进去。
 * 返回 wrote 表示这次写入生效；kept 表示留下本地已有的那一份。
 */
export async function commitBootstrapIntakeSnapshot(
  db: D1Database,
  input: {
    readonly isRepull: boolean;
    readonly intake: ActiveIntake;
    readonly manifest?: {
      readonly version: number;
      readonly cachedAt: string;
      readonly json: string;
    } | null;
  },
): Promise<'wrote' | 'kept'> {
  const now = input.intake.updated_at;
  const json = serializeActiveIntake(input.intake);
  if (input.isRepull) {
    const statements: D1PreparedStatement[] = [
      db.prepare(
        `INSERT OR REPLACE INTO system_config(key, value, updated_at) VALUES(?, ?, ?)`,
      ).bind(ACTIVE_INTAKE_CONFIG_KEY, json, now),
    ];
    if (input.manifest) statements.push(...manifestCacheStatements(db, input.manifest, now));
    await db.batch(statements);
    return 'wrote';
  }

  // 不用 INSERT OR REPLACE 字面，避免旧测试桩忽略 WHERE 后把后到的一份写进去。
  const claim = db.prepare(
    `/* intake-claim-first */
     INSERT INTO system_config(key, value, updated_at) VALUES(?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       value = excluded.value,
       updated_at = excluded.updated_at
     WHERE length(trim(system_config.value)) = 0`,
  ).bind(ACTIVE_INTAKE_CONFIG_KEY, json, now);
  const statements: D1PreparedStatement[] = [claim];
  if (input.manifest) {
    const follow = `
      /* intake-claim-follow */
      INSERT OR REPLACE INTO system_config(key, value, updated_at)
      SELECT ?, ?, ?
      WHERE (SELECT value FROM system_config WHERE key = 'active_intake') = ?`;
    statements.push(
      db.prepare(follow).bind(BOOTSTRAP_MANIFEST_VERSION_KEY, String(input.manifest.version), now, json),
      db.prepare(follow).bind(BOOTSTRAP_MANIFEST_CACHED_AT_KEY, input.manifest.cachedAt, now, json),
      db.prepare(follow).bind(BOOTSTRAP_MANIFEST_JSON_KEY, input.manifest.json, now, json),
    );
  }
  const results = await db.batch(statements);
  const changes = Array.isArray(results) ? results[0]?.meta?.changes : undefined;
  if (changes === 0) return 'kept';
  if (changes === 1) return 'wrote';
  const existing = await readActiveIntake(db);
  if (existing) return 'kept';
  await writeActiveIntake(db, input.intake);
  if (input.manifest) {
    await writeBootstrapManifestCache(db, {
      version: input.manifest.version,
      cached_at: input.manifest.cachedAt,
      json: input.manifest.json,
      storeJson: true,
    });
  }
  return 'wrote';
}

function manifestCacheStatements(
  db: D1Database,
  manifest: { readonly version: number; readonly cachedAt: string; readonly json: string },
  now: string,
): D1PreparedStatement[] {
  return [
    db.prepare(
      `INSERT OR REPLACE INTO system_config(key, value, updated_at) VALUES(?, ?, ?)`,
    ).bind(BOOTSTRAP_MANIFEST_VERSION_KEY, String(manifest.version), now),
    db.prepare(
      `INSERT OR REPLACE INTO system_config(key, value, updated_at) VALUES(?, ?, ?)`,
    ).bind(BOOTSTRAP_MANIFEST_CACHED_AT_KEY, manifest.cachedAt, now),
    db.prepare(
      `INSERT OR REPLACE INTO system_config(key, value, updated_at) VALUES(?, ?, ?)`,
    ).bind(BOOTSTRAP_MANIFEST_JSON_KEY, manifest.json, now),
  ];
}

export async function writeActiveIntake(db: D1Database, intake: ActiveIntake): Promise<void> {
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT OR REPLACE INTO system_config(key, value, updated_at) VALUES(?, ?, ?)`,
    )
    .bind(ACTIVE_INTAKE_CONFIG_KEY, serializeActiveIntake(intake), now)
    .run();
}

/** 清除 B（例如重新登记前）；绝不改写 home（C）。 */
export async function clearActiveIntake(db: D1Database): Promise<void> {
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT OR REPLACE INTO system_config(key, value, updated_at) VALUES(?, ?, ?)`,
    )
    .bind(ACTIVE_INTAKE_CONFIG_KEY, '', now)
    .run();
}

export async function readBootstrapManifestCache(
  db: D1Database,
): Promise<BootstrapManifestCache | null> {
  const rows = await db
    .prepare(
      `SELECT key, value FROM system_config WHERE key IN (?, ?, ?)`,
    )
    .bind(
      BOOTSTRAP_MANIFEST_VERSION_KEY,
      BOOTSTRAP_MANIFEST_CACHED_AT_KEY,
      BOOTSTRAP_MANIFEST_JSON_KEY,
    )
    .all<{ key: string; value: string }>();

  const map = new Map<string, string>();
  for (const r of rows.results ?? []) {
    map.set(r.key, r.value ?? '');
  }
  const versionRaw = map.get(BOOTSTRAP_MANIFEST_VERSION_KEY)?.trim() ?? '';
  const cachedAt = map.get(BOOTSTRAP_MANIFEST_CACHED_AT_KEY)?.trim() ?? '';
  if (!versionRaw || !cachedAt) return null;
  const version = Number(versionRaw);
  if (!Number.isFinite(version) || version < 0) return null;
  const jsonRaw = map.get(BOOTSTRAP_MANIFEST_JSON_KEY)?.trim() ?? '';
  return {
    version,
    cached_at: cachedAt,
    json: jsonRaw || null,
  };
}

/**
 * 写入 manifest 缓存。调用方应先用 `isManifestVersionNewer` 闸版本。
 * @param storeJson 是否落全文；默认 true。生产排障可关以省体积。
 */
export async function writeBootstrapManifestCache(
  db: D1Database,
  input: {
    readonly version: number;
    readonly cached_at?: string;
    readonly json?: string | null;
    readonly storeJson?: boolean;
  },
): Promise<void> {
  if (!Number.isInteger(input.version) || input.version <= 0) {
    throw new Error('bootstrap_manifest_version 必须为正整数');
  }
  const cachedAt = (input.cached_at ?? new Date().toISOString()).trim();
  const storeJson = input.storeJson !== false;
  const jsonValue = storeJson && input.json?.trim() ? input.json.trim() : '';
  const now = new Date().toISOString();

  await db.batch([
    db
      .prepare(
        `INSERT OR REPLACE INTO system_config(key, value, updated_at) VALUES(?, ?, ?)`,
      )
      .bind(BOOTSTRAP_MANIFEST_VERSION_KEY, String(input.version), now),
    db
      .prepare(
        `INSERT OR REPLACE INTO system_config(key, value, updated_at) VALUES(?, ?, ?)`,
      )
      .bind(BOOTSTRAP_MANIFEST_CACHED_AT_KEY, cachedAt, now),
    db
      .prepare(
        `INSERT OR REPLACE INTO system_config(key, value, updated_at) VALUES(?, ?, ?)`,
      )
      .bind(BOOTSTRAP_MANIFEST_JSON_KEY, jsonValue, now),
  ]);
}
