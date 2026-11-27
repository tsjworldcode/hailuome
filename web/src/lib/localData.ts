/**
 * M7-9：本地数据快照 v2（导出 / 导入 / 跨设备迁移）
 *
 * 本模块是 lib/localDb 的高阶业务层，封装"读四 store + 拼装 JSON 快照"与"解析
 * JSON + 写四 store"两条管道。schema_version 升 v2，向后兼容读 v1（M7-7c 既有
 * 导出 JSON 仍可被新版 import）。
 *
 * 与 lib/localDb 分层：
 *   - lib/localDb 是 IDB 原生操作（store.put/get/delete/clear、四 keyPath 守卫）
 *   - lib/localData 是 snapshot 业务（多 store 聚合 + JSON 序列化/解析 + 校验）
 *
 * §F-02 严守：
 *   - 零 import lib/api 与 lib/workerA 业务 client
 *   - 零 import.meta.env
 *   - 零 fetch
 *   - 零 storage 直调（forYou pref 经 lib/forYou.readRankingPref/writeRankingPref 中转）
 *   - 零 worker-a / WORKER_A_URL / localhost:8787 / hailuo:worker-a-* 字面量
 */

import {
  listBookmarks,
  listDrafts,
  getInterestWeights,
  listCachedPosts,
  bulkPutBookmarks,
  bulkPutDrafts,
  bulkPutInterestSignals,
  bulkPutCachedPosts,
  clearAll,
  type Bookmark,
  type Draft,
  type InterestSignal,
  type CachedPost,
} from './localDb';
import { listDmPlaintexts, bulkPutDmPlaintexts, type DmPlaintextRecord } from './dmLocalDb';
import {
  readRankingPref,
  writeRankingPref,
  type RankingPref,
} from './forYou';

// =====================================================================
// 常量
// =====================================================================

/** 当前导出快照 schema 版本（v3 = M10-5a 含 dm_chats 已解密私信） */
export const LOCAL_DATA_SCHEMA_VERSION = 3 as const;

/** 标识本节点版本，便于排障时识别快照来源；非业务字段 */
export const LOCAL_DATA_APP_VERSION = 'M10-5a' as const;

// =====================================================================
// 类型
// =====================================================================

/** snapshot 四 store 计数摘要（meta 内嵌；解析 v1 时由 payload 数组长度回填） */
export interface SnapshotCounts {
  readonly bookmarks: number;
  readonly drafts: number;
  readonly interest_weights: number;
  readonly read_cache: number;
  readonly dm_chats: number;
}

/** snapshot 元信息（v2 新增；v1 解析时按字段缺省值回填） */
export interface SnapshotMeta {
  readonly schema_version: 1 | 2 | 3;
  /** ISO 8601 导出时间 */
  readonly exported_at: string;
  /** 节点版本字串（仅排障用，不参与导入逻辑） */
  readonly app_version: string;
  /** 导出源 origin（如 https://hailuo.example.com），SSR / file:// 时为 '' */
  readonly export_origin: string;
  /** 四 store 计数摘要 */
  readonly counts: SnapshotCounts;
}

/** snapshot 偏好设置（v2 新增；可选） */
export interface SnapshotPrefs {
  /** For-You 重排开关；v1 缺省 */
  readonly for_you_ranking?: RankingPref;
}

/** snapshot 业务数据载荷（v1 + v2 共有结构） */
export interface SnapshotPayload {
  readonly bookmarks: readonly Bookmark[];
  readonly drafts: readonly Draft[];
  readonly interest_weights: readonly InterestSignal[];
  readonly read_cache: readonly CachedPost[];
  /** M10-5a：本机已解密私信（不含会话私钥 / X25519 身份私钥） */
  readonly dm_chats: readonly DmPlaintextRecord[];
}

/** snapshot 完整结构（v2 形态；v1 解析后会被补齐 meta + prefs） */
export interface LocalDataSnapshot {
  readonly meta: SnapshotMeta;
  readonly payload: SnapshotPayload;
  readonly prefs: SnapshotPrefs;
}

/** parseSnapshot 结果：成功返回 snapshot，失败返回错误码 + 中文消息 */
export type ParseResult =
  | { readonly ok: true; readonly snapshot: LocalDataSnapshot }
  | { readonly ok: false; readonly error: string };

/** applySnapshot 写入选项 */
export interface ApplyOptions {
  /** 写入策略；默认 'replace' = 先 clearAll 再批量 put */
  readonly mode?: 'replace';
}

/** applySnapshot 写入结果 */
export interface ApplyResult {
  readonly counts: SnapshotCounts;
}

// =====================================================================
// 工具函数
// =====================================================================

function safeOrigin(): string {
  if (typeof window === 'undefined') return '';
  try {
    return window.location.origin;
  } catch {
    return '';
  }
}

function countsOf(payload: SnapshotPayload): SnapshotCounts {
  return {
    bookmarks: payload.bookmarks.length,
    drafts: payload.drafts.length,
    interest_weights: payload.interest_weights.length,
    read_cache: payload.read_cache.length,
    dm_chats: payload.dm_chats.length,
  };
}

// =====================================================================
// buildSnapshot：读四 store + 读 prefs 拼装 v2 快照
// =====================================================================

export async function buildSnapshot(): Promise<LocalDataSnapshot> {
  const [bookmarks, drafts, interest, cache, dmChats] = await Promise.all([
    listBookmarks(),
    listDrafts(),
    getInterestWeights(),
    listCachedPosts(),
    listDmPlaintexts(),
  ]);
  const payload: SnapshotPayload = {
    bookmarks,
    drafts,
    interest_weights: interest,
    read_cache: cache,
    dm_chats: dmChats,
  };
  // 读 forYou pref 走 lib/forYou 中转（SSR / 隐身模式静默回 'off'）
  const forYouPref: RankingPref = readRankingPref();
  return {
    meta: {
      schema_version: LOCAL_DATA_SCHEMA_VERSION,
      exported_at: new Date().toISOString(),
      app_version: LOCAL_DATA_APP_VERSION,
      export_origin: safeOrigin(),
      counts: countsOf(payload),
    },
    payload,
    prefs: {
      for_you_ranking: forYouPref,
    },
  };
}

// =====================================================================
// serializeSnapshot：JSON.stringify pretty
// =====================================================================

export function serializeSnapshot(snapshot: LocalDataSnapshot): string {
  return JSON.stringify(snapshot, null, 2);
}

// =====================================================================
// parseSnapshot：解析 + 校验，向后兼容 v1（M7-7c 原导出格式）
//
// v1 形态（来自 M7-7c LocalDataPanel.handleExport）：
//   { schema_version: 1, exported_at: ISO, hailuo: { bookmarks, drafts,
//     interest_weights, read_cache } }
//
// v2 形态（本步）：
//   { meta: {...}, payload: {...}, prefs: {...} }
//
// 解析策略：先看顶层有无 meta 字段；有则按 v2 解；否则按 v1 解并升级填充 meta。
// =====================================================================

function isArrayOf<T>(v: unknown, validate: (x: unknown) => x is T): v is readonly T[] {
  return Array.isArray(v) && v.every(validate);
}

function isBookmark(x: unknown): x is Bookmark {
  return (
    typeof x === 'object' &&
    x !== null &&
    typeof (x as { post_id?: unknown }).post_id === 'string' &&
    typeof (x as { added_at?: unknown }).added_at === 'number'
  );
}

function isDraft(x: unknown): x is Draft {
  return (
    typeof x === 'object' &&
    x !== null &&
    typeof (x as { content?: unknown }).content === 'string' &&
    Array.isArray((x as { image_keys?: unknown }).image_keys) &&
    typeof (x as { updated_at?: unknown }).updated_at === 'number'
  );
}

function isInterestSignal(x: unknown): x is InterestSignal {
  return (
    typeof x === 'object' &&
    x !== null &&
    typeof (x as { signal_key?: unknown }).signal_key === 'string' &&
    typeof (x as { weight?: unknown }).weight === 'number' &&
    typeof (x as { last_updated?: unknown }).last_updated === 'number'
  );
}

function isCachedPost(x: unknown): x is CachedPost {
  return (
    typeof x === 'object' &&
    x !== null &&
    typeof (x as { post_id?: unknown }).post_id === 'string' &&
    typeof (x as { post_json?: unknown }).post_json === 'string' &&
    typeof (x as { cached_at?: unknown }).cached_at === 'number'
  );
}

function isDmPlaintextRecord(x: unknown): x is DmPlaintextRecord {
  return (
    typeof x === 'object' &&
    x !== null &&
    typeof (x as { message_id?: unknown }).message_id === 'string' &&
    typeof (x as { conversation_id?: unknown }).conversation_id === 'string' &&
    typeof (x as { peer_handle?: unknown }).peer_handle === 'string' &&
    ((x as { direction?: unknown }).direction === 'inbox' ||
      (x as { direction?: unknown }).direction === 'outbox') &&
    typeof (x as { plaintext?: unknown }).plaintext === 'string' &&
    typeof (x as { created_at?: unknown }).created_at === 'string'
  );
}

function parsePayload(raw: unknown, dmChatsDefault: readonly DmPlaintextRecord[] = []): SnapshotPayload | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  if (!isArrayOf(obj.bookmarks, isBookmark)) return null;
  if (!isArrayOf(obj.drafts, isDraft)) return null;
  if (!isArrayOf(obj.interest_weights, isInterestSignal)) return null;
  if (!isArrayOf(obj.read_cache, isCachedPost)) return null;
  const dmChats =
    obj.dm_chats === undefined
      ? dmChatsDefault
      : isArrayOf(obj.dm_chats, isDmPlaintextRecord)
        ? obj.dm_chats
        : null;
  if (dmChats === null) return null;
  return {
    bookmarks: obj.bookmarks,
    drafts: obj.drafts,
    interest_weights: obj.interest_weights,
    read_cache: obj.read_cache,
    dm_chats: dmChats,
  };
}

export function parseSnapshot(json: string): ParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return { ok: false, error: 'JSON 解析失败：文件格式不是合法 JSON。' };
  }
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, error: '快照根对象格式异常：应为 object。' };
  }
  const root = raw as Record<string, unknown>;

  // v2/v3 路径：顶层含 meta + payload
  if (typeof root.meta === 'object' && root.meta !== null) {
    const meta = root.meta as Record<string, unknown>;
    const schemaVersion = meta.schema_version;
    if (schemaVersion !== 2 && schemaVersion !== 3) {
      return {
        ok: false,
        error: `不支持的 schema_version：${String(schemaVersion)}（仅支持 1、2 或 3）。`,
      };
    }
    const payload = parsePayload(root.payload, []);
    if (!payload) {
      return { ok: false, error: 'v2/v3 快照 payload 字段缺失或类型错误。' };
    }
    const prefs: SnapshotPrefs =
      typeof root.prefs === 'object' && root.prefs !== null
        ? {
            for_you_ranking:
              (root.prefs as Record<string, unknown>).for_you_ranking === 'on'
                ? 'on'
                : (root.prefs as Record<string, unknown>).for_you_ranking === 'off'
                ? 'off'
                : undefined,
          }
        : {};
    return {
      ok: true,
      snapshot: {
        meta: {
          schema_version: schemaVersion === 3 ? 3 : 2,
          exported_at: typeof meta.exported_at === 'string' ? meta.exported_at : '',
          app_version: typeof meta.app_version === 'string' ? meta.app_version : '',
          export_origin: typeof meta.export_origin === 'string' ? meta.export_origin : '',
          counts: countsOf(payload),
        },
        payload,
        prefs,
      },
    };
  }

  // v1 路径：顶层含 schema_version=1 + hailuo.* 四数组
  if (root.schema_version === 1 && typeof root.hailuo === 'object' && root.hailuo !== null) {
    const payload = parsePayload(root.hailuo, []);
    if (!payload) {
      return { ok: false, error: 'v1 快照 hailuo.* 四字段缺失或类型错误。' };
    }
    return {
      ok: true,
      snapshot: {
        meta: {
          schema_version: 1,
          exported_at: typeof root.exported_at === 'string' ? root.exported_at : '',
          app_version: '',
          export_origin: '',
          counts: countsOf(payload),
        },
        payload,
        prefs: {},
      },
    };
  }

  return {
    ok: false,
    error: '无法识别的快照格式：既不是 v2（顶层 meta+payload）也不是 v1（schema_version=1 + hailuo.*）。',
  };
}

// =====================================================================
// applySnapshot：默认 replace 策略，先 clearAll 再批量 put
// =====================================================================

export async function applySnapshot(
  snapshot: LocalDataSnapshot,
  options: ApplyOptions = {},
): Promise<ApplyResult> {
  // 仅支持 replace；future 可扩 'merge' 策略
  const mode = options.mode ?? 'replace';
  if (mode !== 'replace') {
    throw new Error(`不支持的导入模式：${String(mode)}（当前仅支持 replace）`);
  }

  // 1. 清空四 store（单事务 readwrite）
  await clearAll();

  // 2. 批量 put 四 store（每 store 一个事务；items 顺序入队 + 原样保留时间戳）
  await Promise.all([
    bulkPutBookmarks(snapshot.payload.bookmarks),
    bulkPutDrafts(snapshot.payload.drafts),
    bulkPutInterestSignals(snapshot.payload.interest_weights),
    bulkPutCachedPosts(snapshot.payload.read_cache),
    bulkPutDmPlaintexts(snapshot.payload.dm_chats),
  ]);

  // 3. 应用 prefs（若快照含 for_you_ranking 则覆盖当前 pref；缺省保留当前）
  if (snapshot.prefs.for_you_ranking === 'on' || snapshot.prefs.for_you_ranking === 'off') {
    writeRankingPref(snapshot.prefs.for_you_ranking);
  }

  return { counts: countsOf(snapshot.payload) };
}
