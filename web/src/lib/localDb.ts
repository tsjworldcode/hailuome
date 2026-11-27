// M7-7：浏览器端 IndexedDB 本地数据层
//
// 用途：书签 / 草稿 / 兴趣权重 / 离线读过帖缓存。
//
// 与 M7-6 Service Worker 的边界划分：
//   - SW（hailuo-pwa-v1-static）仅缓存静态壳（HTML / JS / CSS / SVG / 字体 / manifest / offline.html）
//   - 业务数据（帖子 JSON、兴趣权重、本地草稿、书签）全走 IndexedDB
//   - Worker B 鉴权响应 `Cache-Control: private, no-store` + `Vary: Authorization` 自身
//     就拒绝共享缓存，本模块作为应用层主动缓存的载体
//
// 安全约定（§F-02 红线，见 web/AGENTS.md）：
//   - 本文件零网络 fetch（写层/读层调用由 api.ts / workerA.ts 负责）
//   - 零构建期 env 读取（数据层不依赖任何注入参数）
//   - 零 Web Storage 调用（与 auth.ts 解耦，纯 IDB；浏览器同源策略独立隔离）
//   - 升级协作：open 成功后绑定 db.onversionchange，其它 Tab 升版本时本 Tab 主动 close + 清 dbPromise（M7-15 / 审计 §2.1）
//   - 零写层地址 / 私密 URL 字面量泄漏；零 hailuo:endpoint 以外的 storage 命名空间引用
//   - DB 名 `hailuo`、store 名通用化（书签 / 草稿 / 兴趣 / 读缓存），不暴露后端实现细节

import { showToast } from './toast';
import { clearDmVolatileStorage } from './dmSession';

// =====================================================================
// 数据库常量
// =====================================================================

const DB_NAME = 'hailuo';
const DB_VERSION = 2;

const STORE = {
  BOOKMARKS: 'bookmarks',
  DRAFTS: 'drafts',
  INTEREST: 'interest_weights',
  READ_CACHE: 'read_cache',
  /** M10-4：X25519 私信身份私钥（仅本机） */
  DM_IDENTITY: 'dm_identity',
  /** M10-4：会话 message_key 明文缓存 */
  DM_SESSION_KEYS: 'dm_session_keys',
  /** M10-4：已解密消息本地缓存 */
  DM_PLAINTEXT: 'dm_plaintext',
} as const;

/** 离线读缓存 TTL：7 天 */
const READ_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// =====================================================================
// 类型
// =====================================================================

export interface Bookmark {
  /** Worker A `posts.id`（uuid）*/
  readonly post_id: string;
  /** 本地添加时间 unix ms */
  readonly added_at: number;
  /** 可选快照：列表渲染用，不依赖网络 */
  readonly snapshot?: {
    readonly content?: string;
    readonly image_keys?: readonly string[];
    readonly author_handle?: string;
  };
}

export interface Draft {
  /** autoIncrement 主键（saveDraft 不传则新增） */
  draft_id?: number;
  /** 正文 */
  readonly content: string;
  /** 已上传图片 key 列表（M6 R2 命名空间下） */
  readonly image_keys: readonly string[];
  /** 最近编辑时间 unix ms */
  readonly updated_at: number;
}

export interface InterestSignal {
  /**
   * 信号 key：形如 `author:@handle` / `domain:example.com` / `tag:foo`。
   * 由调用方按业务约定生成；本模块不对 key 形态做约束。
   */
  readonly signal_key: string;
  /** 累计权重（建议范围 0~100，由调用方控制衰减） */
  readonly weight: number;
  /** 上次更新时间 unix ms */
  readonly last_updated: number;
}

export interface CachedPost {
  /** Worker A `posts.id`（uuid）*/
  readonly post_id: string;
  /** 完整帖子 JSON 序列化（含 author / image_urls 等渲染必需字段） */
  readonly post_json: string;
  /** 缓存写入时间 unix ms，用于 TTL gc */
  readonly cached_at: number;
}

// =====================================================================
// 连接管理
// =====================================================================

let dbPromise: Promise<IDBDatabase> | null = null;

/**
 * 多 Tab schema 升级协作：其它标签页触发 `versionchange` 时，本连接已过期，必须关闭以免阻塞新连接。
 */
function bindDbVersionChangeHandler(db: IDBDatabase): void {
  db.onversionchange = () => {
    db.close();
    dbPromise = null;
    showToast('本地数据库已升级，请刷新页面以同步', 'info');
  };
}

/**
 * 打开（或复用）`hailuo` IDB 连接。首次调用触发 v1 schema 迁移。
 *
 * SSR / 测试环境（无 `indexedDB`）抛错；调用方应在浏览器 island 内使用。
 */
export function openDb(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(new Error('IndexedDB 不可用：当前环境不在浏览器'));
  }
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE.BOOKMARKS)) {
        db.createObjectStore(STORE.BOOKMARKS, { keyPath: 'post_id' });
      }
      if (!db.objectStoreNames.contains(STORE.DRAFTS)) {
        db.createObjectStore(STORE.DRAFTS, { keyPath: 'draft_id', autoIncrement: true });
      }
      if (!db.objectStoreNames.contains(STORE.INTEREST)) {
        db.createObjectStore(STORE.INTEREST, { keyPath: 'signal_key' });
      }
      if (!db.objectStoreNames.contains(STORE.READ_CACHE)) {
        db.createObjectStore(STORE.READ_CACHE, { keyPath: 'post_id' });
      }
      if (!db.objectStoreNames.contains(STORE.DM_IDENTITY)) {
        db.createObjectStore(STORE.DM_IDENTITY, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE.DM_SESSION_KEYS)) {
        db.createObjectStore(STORE.DM_SESSION_KEYS, { keyPath: 'key_id' });
      }
      if (!db.objectStoreNames.contains(STORE.DM_PLAINTEXT)) {
        db.createObjectStore(STORE.DM_PLAINTEXT, { keyPath: 'message_id' });
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      bindDbVersionChangeHandler(db);
      resolve(db);
    };
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open 失败'));
    req.onblocked = () => reject(new Error('IndexedDB open 被其它标签阻塞'));
  });
  return dbPromise;
}

/** 关闭并清理连接缓存（测试 / 退出登录用） */
export function closeDb(): void {
  if (!dbPromise) return;
  const p = dbPromise;
  dbPromise = null;
  void p.then((db) => db.close()).catch(() => {});
}

/**
 * 单请求事务：run 必须同步返回 IDBRequest，禁止在事务内 await（M7-17 P2）。
 */
function txRequest<T>(
  storeName: string,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(storeName, mode);
        const store = t.objectStore(storeName);
        const req = run(store);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error('IndexedDB 请求失败'));
        t.onerror = () => reject(t.error ?? new Error('IndexedDB 事务被中止'));
      }),
  );
}

/** 同事务内同步排队多个 put/delete，全部 onsuccess 后再 resolve */
function txManyRequests(
  storeName: string,
  count: number,
  schedule: (store: IDBObjectStore, onDone: () => void, onFail: (err: Error) => void) => void,
): Promise<void> {
  if (count === 0) return Promise.resolve();
  return openDb().then(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const t = db.transaction(storeName, 'readwrite');
        const store = t.objectStore(storeName);
        let left = count;
        const onDone = () => {
          left -= 1;
          if (left === 0) resolve();
        };
        const onFail = (err: Error) => reject(err);
        schedule(store, onDone, onFail);
        t.onerror = () => reject(t.error ?? new Error('IndexedDB 事务被中止'));
      }),
  );
}

// =====================================================================
// 书签
// =====================================================================

export function addBookmark(b: Bookmark): Promise<void> {
  return txRequest(STORE.BOOKMARKS, 'readwrite', (store) => store.put(b)).then(() => undefined);
}

export function removeBookmark(postId: string): Promise<void> {
  return txRequest(STORE.BOOKMARKS, 'readwrite', (store) => store.delete(postId)).then(
    () => undefined,
  );
}

export function isBookmarked(postId: string): Promise<boolean> {
  return txRequest(STORE.BOOKMARKS, 'readonly', (store) => store.getKey(postId)).then(
    (key) => key !== undefined,
  );
}

export function listBookmarks(): Promise<Bookmark[]> {
  return txRequest<Bookmark[]>(STORE.BOOKMARKS, 'readonly', (store) =>
    store.getAll() as IDBRequest<Bookmark[]>,
  ).then((items) => [...(items ?? [])].sort((a, b) => b.added_at - a.added_at));
}

// =====================================================================
// 草稿
// =====================================================================

/**
 * 保存草稿：未传 `draft_id` 则新增；传了则覆盖。
 *
 * 返回 store 写入后的主键（新草稿自动分配的 autoIncrement 整数）。
 */
export function saveDraft(draft: Draft): Promise<number> {
  return txRequest<IDBValidKey>(STORE.DRAFTS, 'readwrite', (store) => store.put(draft)).then(
    (id) => id as number,
  );
}

export function getDraft(draftId: number): Promise<Draft | null> {
  return txRequest<Draft | undefined>(STORE.DRAFTS, 'readonly', (store) => store.get(draftId)).then(
    (d) => d ?? null,
  );
}

export function deleteDraft(draftId: number): Promise<void> {
  return txRequest(STORE.DRAFTS, 'readwrite', (store) => store.delete(draftId)).then(() => undefined);
}

export function listDrafts(): Promise<Draft[]> {
  return txRequest<Draft[]>(STORE.DRAFTS, 'readonly', (store) =>
    store.getAll() as IDBRequest<Draft[]>,
  ).then((items) => [...(items ?? [])].sort((a, b) => b.updated_at - a.updated_at));
}

// =====================================================================
// 兴趣权重（M9+ For-you 排序用，本步只落数据层）
// =====================================================================

/**
 * 累加权重信号：已存则在原权重上加 `delta`，否则新增。
 *
 * 调用方按业务规则约束 `delta`（建议 1~10）并自行实现衰减（如按 last_updated
 * 做线性衰减）；本模块只保证「累加 + 时间戳更新」语义。
 */
export function bumpInterest(signalKey: string, delta: number): Promise<InterestSignal> {
  return openDb().then(
    (db) =>
      new Promise<InterestSignal>((resolve, reject) => {
        const t = db.transaction(STORE.INTEREST, 'readwrite');
        const store = t.objectStore(STORE.INTEREST);
        const getReq = store.get(signalKey) as IDBRequest<InterestSignal | undefined>;
        getReq.onsuccess = () => {
          const existing = getReq.result;
          const next: InterestSignal = {
            signal_key: signalKey,
            weight: (existing?.weight ?? 0) + delta,
            last_updated: Date.now(),
          };
          const putReq = store.put(next);
          putReq.onsuccess = () => resolve(next);
          putReq.onerror = () => reject(putReq.error ?? new Error('bumpInterest put 失败'));
        };
        getReq.onerror = () => reject(getReq.error ?? new Error('bumpInterest get 失败'));
        t.onerror = () => reject(t.error ?? new Error('bumpInterest 事务被中止'));
      }),
  );
}

export function getInterestWeights(): Promise<InterestSignal[]> {
  return txRequest<InterestSignal[]>(STORE.INTEREST, 'readonly', (store) =>
    store.getAll() as IDBRequest<InterestSignal[]>,
  ).then((items) => [...(items ?? [])].sort((a, b) => b.weight - a.weight));
}

/**
 * M7-8b：直接写入一条 InterestSignal（覆盖式 put，不累加，不重写 last_updated）。
 *
 * 与 bumpInterest 互补：
 * - bumpInterest 用于「真实交互」+delta 累加 + 把 last_updated 重置为 Date.now()
 * - setInterestSignal 用于「数据维护」直接落整条（典型场景：compact 把衰减后的
 *   weight 与同一时间锚点 last_updated 一起写回，下次 bumpInterest 自然在衰减
 *   后的值上 +delta）
 */
export function setInterestSignal(signal: InterestSignal): Promise<void> {
  return txRequest(STORE.INTEREST, 'readwrite', (store) => store.put(signal)).then(() => undefined);
}

/**
 * M7-8b：按 signal_key 删除一条 InterestSignal。
 *
 * 用于 compact 阶段衰减到极小（< 阈值）时主动清理，防止 store 无限增长。
 */
export function deleteInterestSignal(signalKey: string): Promise<void> {
  return txRequest(STORE.INTEREST, 'readwrite', (store) => store.delete(signalKey)).then(
    () => undefined,
  );
}

/** 清除指定前缀的兴趣权重；用于设置页恢复被“不感兴趣”隐藏的作者。 */
export function deleteInterestSignalsByPrefix(prefix: string): Promise<number> {
  return openDb().then(
    (db) =>
      new Promise<number>((resolve, reject) => {
        const t = db.transaction(STORE.INTEREST, 'readwrite');
        const store = t.objectStore(STORE.INTEREST);
        const getAllReq = store.getAll() as IDBRequest<InterestSignal[]>;
        getAllReq.onsuccess = () => {
          const matched = (getAllReq.result ?? []).filter((s) => s.signal_key.startsWith(prefix));
          if (matched.length === 0) {
            resolve(0);
            return;
          }
          let left = matched.length;
          for (const signal of matched) {
            const delReq = store.delete(signal.signal_key);
            delReq.onsuccess = () => {
              left -= 1;
              if (left === 0) resolve(matched.length);
            };
            delReq.onerror = () =>
              reject(delReq.error ?? new Error('deleteInterestSignalsByPrefix delete 失败'));
          }
        };
        getAllReq.onerror = () =>
          reject(getAllReq.error ?? new Error('deleteInterestSignalsByPrefix getAll 失败'));
        t.onerror = () => reject(t.error ?? new Error('deleteInterestSignalsByPrefix 事务中止'));
      }),
  );
}

// =====================================================================
// 离线读缓存（与 M7-6 SW 联动；SW 不缓存帖子响应）
// =====================================================================

export function cachePost(postId: string, postJson: string): Promise<void> {
  const entry: CachedPost = { post_id: postId, post_json: postJson, cached_at: Date.now() };
  return txRequest(STORE.READ_CACHE, 'readwrite', (store) => store.put(entry)).then(() => undefined);
}

/** 取缓存帖子；过期（>7 天）视为不存在并返回 null（不主动删除，留给 gc） */
export function getCachedPost(postId: string): Promise<CachedPost | null> {
  return txRequest<CachedPost | undefined>(STORE.READ_CACHE, 'readonly', (store) =>
    store.get(postId),
  ).then((entry) => {
    if (!entry) return null;
    if (Date.now() - entry.cached_at > READ_CACHE_TTL_MS) return null;
    return entry;
  });
}

/**
 * M7-7c：列出所有读缓存条目，按 cached_at DESC 排序（最近缓存靠前）。
 *
 * 不校验 TTL，调用方按需筛选；用于 Settings 本地数据导出 / 计数展示。
 * 与 `getCachedPost` 的语义差异：getCachedPost 单条且 TTL 过期返 null；
 * 本函数返回原始全量，导出场景下应把过期条目一并落到 JSON（提供完整快照）。
 */
export function listCachedPosts(): Promise<CachedPost[]> {
  return txRequest<CachedPost[]>(STORE.READ_CACHE, 'readonly', (store) =>
    store.getAll() as IDBRequest<CachedPost[]>,
  ).then((items) => [...(items ?? [])].sort((a, b) => b.cached_at - a.cached_at));
}

/** 垃圾回收：删除 7 天以上的读缓存条目；返回删除数量 */
export function gcReadCache(): Promise<number> {
  return openDb().then(
    (db) =>
      new Promise<number>((resolve, reject) => {
        const t = db.transaction(STORE.READ_CACHE, 'readwrite');
        const store = t.objectStore(STORE.READ_CACHE);
        const getAllReq = store.getAll() as IDBRequest<CachedPost[]>;
        getAllReq.onsuccess = () => {
          const items = getAllReq.result ?? [];
          const cutoff = Date.now() - READ_CACHE_TTL_MS;
          const expired = items.filter((c) => c.cached_at <= cutoff);
          if (expired.length === 0) {
            resolve(0);
            return;
          }
          let left = expired.length;
          for (const c of expired) {
            const delReq = store.delete(c.post_id);
            delReq.onsuccess = () => {
              left -= 1;
              if (left === 0) resolve(expired.length);
            };
            delReq.onerror = () =>
              reject(delReq.error ?? new Error('gcReadCache delete 失败'));
          }
        };
        getAllReq.onerror = () => reject(getAllReq.error ?? new Error('gcReadCache getAll 失败'));
        t.onerror = () => reject(t.error ?? new Error('gcReadCache 事务被中止'));
      }),
  );
}

// =====================================================================
// M7-9：批量写入 helper（数据导入 v2 用，schema 零变更）
//
// 与既有单条 API 的差异：
//   - addBookmark / saveDraft / setInterestSignal / cachePost 单事务单条
//   - cachePost 会强制重写 cached_at = Date.now()
//   - 本组 helper 在单事务内批量 put，**原样保留所有时间戳字段**（added_at /
//     updated_at / cached_at / last_updated 不重写），保证跨设备迁移后顺序与
//     过期判定语义不变。
//   - Promise.all + Promise<void>(req.onsuccess→resolve) 模式，store.put 顺序
//     入队，事务在 oncomplete 时 resolve（IDB 一个事务可执行多个 put）。
//   - 空数组直接 resolve 不开事务，避免无意义连接。
// =====================================================================

export function bulkPutBookmarks(items: readonly Bookmark[]): Promise<void> {
  return txManyRequests(STORE.BOOKMARKS, items.length, (store, onDone, onFail) => {
    for (const b of items) {
      const req = store.put(b);
      req.onsuccess = onDone;
      req.onerror = () => onFail(req.error ?? new Error('bulkPutBookmarks 失败'));
    }
  });
}

export function bulkPutDrafts(items: readonly Draft[]): Promise<void> {
  return txManyRequests(STORE.DRAFTS, items.length, (store, onDone, onFail) => {
    for (const d of items) {
      const req = store.put(d);
      req.onsuccess = onDone;
      req.onerror = () => onFail(req.error ?? new Error('bulkPutDrafts 失败'));
    }
  });
}

export function bulkPutInterestSignals(items: readonly InterestSignal[]): Promise<void> {
  return txManyRequests(STORE.INTEREST, items.length, (store, onDone, onFail) => {
    for (const s of items) {
      const req = store.put(s);
      req.onsuccess = onDone;
      req.onerror = () => onFail(req.error ?? new Error('bulkPutInterestSignals 失败'));
    }
  });
}

export function bulkPutCachedPosts(items: readonly CachedPost[]): Promise<void> {
  return txManyRequests(STORE.READ_CACHE, items.length, (store, onDone, onFail) => {
    for (const c of items) {
      const req = store.put(c);
      req.onsuccess = onDone;
      req.onerror = () => onFail(req.error ?? new Error('bulkPutCachedPosts 失败'));
    }
  });
}

// =====================================================================
// 全量清空（登出 / 切换节点用）
// =====================================================================

export async function clearAll(): Promise<void> {
  const db = await openDb();
  return new Promise<void>((resolve, reject) => {
    const t = db.transaction(
      [
        STORE.BOOKMARKS,
        STORE.DRAFTS,
        STORE.INTEREST,
        STORE.READ_CACHE,
        STORE.DM_IDENTITY,
        STORE.DM_SESSION_KEYS,
        STORE.DM_PLAINTEXT,
      ],
      'readwrite',
    );
    t.objectStore(STORE.BOOKMARKS).clear();
    t.objectStore(STORE.DRAFTS).clear();
    t.objectStore(STORE.INTEREST).clear();
    t.objectStore(STORE.READ_CACHE).clear();
    t.objectStore(STORE.DM_IDENTITY).clear();
    t.objectStore(STORE.DM_SESSION_KEYS).clear();
    t.objectStore(STORE.DM_PLAINTEXT).clear();
    t.oncomplete = () => {
      clearDmVolatileStorage();
      resolve();
    };
    t.onerror = () => reject(t.error ?? new Error('clearAll 失败'));
    t.onabort = () => reject(t.error ?? new Error('clearAll 被中止'));
  });
}

// =====================================================================
// 仅供契约测试 / 调试用的常量导出（生产代码不应依赖）
// =====================================================================

export const __DB_NAME__ = DB_NAME;
export const __DB_VERSION__ = DB_VERSION;
export const __STORE__ = STORE;
export const __READ_CACHE_TTL_MS__ = READ_CACHE_TTL_MS;
