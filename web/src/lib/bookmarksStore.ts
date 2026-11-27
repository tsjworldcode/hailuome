// M7-12（响应「M7 系列审计报告」§6.2 性能 finding F-08）：
// 顶层 bookmarkIds signal Set 索引 —— 把原本每个 PostCard mount 时独立调
// `idbIsBookmarked(post_id)` 触发一条 IDB readonly tx 的做法，收敛为「顶层
// listBookmarks 一次 → 构 Set → 写 signal，PostCard 同步读 signal.value.has」。
//
// 设计要点：
// - **行为零变更**：PostCard 显示书签态在视觉上完全一致；只是数据来源从 IDB 单
//   条 getKey 改为内存 Set lookup。书签 add/remove 的 IDB 写仍走 lib/localDb，
//   只是同步更新顶层 Set 保持一致。
// - **幂等 init**：`initBookmarksStore()` 第一次调用拉 IDB；后续调用走 promise
//   cache 不重复拉。Timeline mount + BookmarksList mount 都调一次，保证不同
//   入口都能同步顶层 Set。
// - **immutable copy-on-write**：`markBookmarked` / `markUnbookmarked` 创建新
//   Set 写入 signal，触发 preact-signals 自动重渲染所有读 `bookmarkIds.value`
//   的组件。
// - **SSR / 隐身模式 / IDB 禁用兜底**：`listBookmarks` 失败时静默保持空 Set，
//   PostCard 显示「未收藏」态（与原先 `idbIsBookmarked` 失败 catch 兜底语义一致）。
// - **§F-02 红线**：本文件零 import lib/api / lib/workerA / 零 import.meta.env /
//   零 fetch / 零 storage 直调 / 零 worker-a + WORKER_A_URL + localhost:8787
//   + hailuo:worker-a-* 字面量。仅 import lib/localDb listBookmarks 一项（与
//   BookmarksList 一致）。

import { signal, type Signal } from '@preact/signals';
import { listBookmarks } from './localDb';

/**
 * 顶层书签 post_id 索引；初始空 Set。
 *
 * 读取方式（preact-signals 自动订阅）：
 * ```ts
 * const isBookmarked = bookmarkIds.value.has(post_id);
 * ```
 * 在 Preact 函数组件中访问 `.value` 会自动建立订阅，Set 替换时组件重渲染。
 */
export const bookmarkIds: Signal<ReadonlySet<string>> = signal<ReadonlySet<string>>(new Set());

/**
 * 幂等初始化：拉 IDB 全量书签 → 构 post_id Set → 写 signal。
 *
 * - 首次调用真正执行；后续调用复用 promise（即使首次失败也不重试，与 IDB
 *   不可用语义一致）。
 * - 失败静默：listBookmarks 抛错（SSR / 隐身 / IDB 禁用）时保持空 Set，
 *   PostCard 全部显示「未收藏」（与原 idbIsBookmarked.catch 兜底一致）。
 */
let initPromise: Promise<void> | null = null;
export function initBookmarksStore(): Promise<void> {
  if (initPromise !== null) return initPromise;
  initPromise = (async () => {
    try {
      const list = await listBookmarks();
      const next = new Set<string>();
      for (const b of list) next.add(b.post_id);
      bookmarkIds.value = next;
    } catch {
      // SSR / 隐身模式 / IDB 禁用：保持空 Set，PostCard 显示未收藏态；
      // 与既有 idbIsBookmarked 失败兜底语义一致。
    }
  })();
  return initPromise;
}

/**
 * 标记 post_id 为已收藏（PostCard.toggleBookmark add 成功后调用）。
 * 已在 Set 中则 no-op，避免无意义 signal 重写引起重渲染抖动。
 */
export function markBookmarked(postId: string): void {
  if (bookmarkIds.value.has(postId)) return;
  const next = new Set(bookmarkIds.value);
  next.add(postId);
  bookmarkIds.value = next;
}

/**
 * 标记 post_id 为已移除（PostCard.toggleBookmark remove 或
 * BookmarksList.handleRemove 成功后调用）。
 * 不在 Set 中则 no-op。
 */
export function markUnbookmarked(postId: string): void {
  if (!bookmarkIds.value.has(postId)) return;
  const next = new Set(bookmarkIds.value);
  next.delete(postId);
  bookmarkIds.value = next;
}
