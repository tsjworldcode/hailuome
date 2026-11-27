/** @jsxImportSource preact */
import type { VNode } from 'preact';
import { useEffect } from 'preact/hooks';
import { signal } from '@preact/signals';
import { Bookmark as BookmarkIcon, BookmarkX, ImageIcon } from 'lucide-preact';
import {
  listBookmarks,
  removeBookmark,
  type Bookmark,
} from '../lib/localDb';
import { initBookmarksStore, markUnbookmarked } from '../lib/bookmarksStore';
import { isQuotaExceeded } from '../lib/idbErrors';
import { showToast } from '../lib/toast';
import { formatRelativeTime } from '../lib/timeFormat';
import { t, initLanguage } from '../lib/i18n';

// M7-7d / M7-7e 本地书签页（脱网渲染 + 在线渲染原帖图片）
//
// 设计要点：
// - 数据源 100% 本地：lib/localDb.listBookmarks() 走 IDB `bookmarks` store 全量读取，
//   按 added_at DESC 已在 lib 层排序；本组件不做二次排序
// - 列表项主体（content / author_handle / 时间 / 计数）100% 用 M7-7b 写入的 `snapshot`
//   字段渲染，断网仍可阅读
// - 图片渲染走 navigator.onLine 状态机二分（M7-7e）：
//   · 在线（navigator.onLine===true）+ snapshot.image_keys 非空 → 渲染 <img src={url}> 缩略图
//     grid，每张 <a target="_blank" rel="noopener noreferrer"> 包裹「点入查看」原图
//     （snapshot.image_keys 存的是 M7-7b PostCard 从 Worker B FeedItem.image_urls 写入的
//      完整 Worker B URL 字符串，可直接放 <img src>；与 lib/api 的 `imageUrl()`
//      返回路径同源，公开读期 Worker B FOLLOWER_TOKEN_MODE='public-read' 时浏览器
//      <img> 标签可直接拉）
//   · 离线（navigator.onLine===false）或 image_keys 空 → 保留 M7-7d「N 张图片（脱网模式不显示）」
//     灰提示，与 M7-6 SW 跨源 GET network-only 策略协同（断网时 SW 不假装命中跨源资源）
//   · 在线状态切换无需重拉数据：监听 window 'online'/'offline' 事件实时切换 isOnline signal
// - snapshot 缺失（早期收藏或异常数据）：显示 italic 提示「该书签未保存快照」，
//   提示用户重新收藏获取离线渲染数据
// - 三态：null=加载中 spinner / loadError 非空=错误条 / 空数组=空态 lucide Bookmark 大图标
// - 删除：「移除书签」按钮走 removeBookmark + 本地 items 数组过滤；
//   removingIds Set 防双击；失败静默吞错（与 PostCard 书签按钮一致）
//
// §F-02：本文件零 import lib/api 与 lib/workerA / 零 import.meta.env / 零 fetch( / 零
// localStorage + sessionStorage 直调（一切持久化经 lib/localDb 中转）/ 零 worker-a +
// WORKER_A_URL + hailuo:worker-a-* + localhost:8787 字面量。图片走浏览器 <img> 标签
// 由浏览器自身发请求，**非本模块走 fetch API**，URL 来自 IDB 中已写入的 Worker B
// 公开域名串。

const items = signal<Bookmark[] | null>(null);
const removingIds = signal<ReadonlySet<string>>(new Set());
const loadError = signal<string | null>(null);
// M7-7e：在线状态 signal，决定缩略图是否渲染。
// SSR / 隐身模式 navigator 不存在时默认 true（保守不诱导用户认为断网）。
const isOnline = signal<boolean>(
  typeof navigator !== 'undefined' && typeof navigator.onLine === 'boolean'
    ? navigator.onLine
    : true,
);

async function refreshItems(): Promise<void> {
  try {
    const list = await listBookmarks();
    items.value = list;
    loadError.value = null;
  } catch {
    // SSR / 隐身模式 / IDB 被禁用：写错误态文案，不抛出阻塞渲染
    items.value = [];
    loadError.value = t('bookmarksLoadFailed');
  }
}

async function handleRemove(postId: string): Promise<void> {
  if (removingIds.value.has(postId)) return;
  const next = new Set(removingIds.value);
  next.add(postId);
  removingIds.value = next;
  try {
    await removeBookmark(postId);
    const current = items.value ?? [];
    items.value = current.filter((b) => b.post_id !== postId);
    // M7-12：同步顶层 bookmarkIds Set，跨页跳回 Timeline 时 PostCard 书签态同步移除
    markUnbookmarked(postId);
  } catch (err) {
    // M7-13 F-13：QuotaExceeded 给 toast，其它错误静默吞（下次点击/重渲染可重试）
    if (isQuotaExceeded(err)) showToast(t('localStorageQuotaExceeded'), 'error');
  } finally {
    const after = new Set(removingIds.value);
    after.delete(postId);
    removingIds.value = after;
  }
}

/** 从 author_handle 派生 @handle 显示串（缺失时回落 @unknown） */
function deriveHandle(authorHandle: string | undefined): string {
  if (!authorHandle || authorHandle.trim() === '') return 'unknown';
  return authorHandle.replace(/^@/, '').slice(0, 16);
}

/** post_id 短截展示（uuid 前 8 字符 + 省略号） */
function shortPostId(postId: string): string {
  return postId.length > 8 ? `${postId.slice(0, 8)}…` : postId;
}

export function BookmarksList(): VNode {
  useEffect(() => {
    initLanguage();
    let mounted = true;
    refreshItems().catch(() => {
      // refreshItems 内部已兜底，这里仅卸载守卫；保留 then-style 防止未处理 rejection 警告
    });
    // M7-12：mount 时也调一次；跨页面跳转上 Timeline 未 mount 过的新 session
    // 下顶层 bookmarkIds Set 依然能被填充（幂等，不重拉）。
    void initBookmarksStore();
    return () => {
      mounted = false;
      void mounted;
    };
  }, []);

  // M7-7e：监听 window 'online'/'offline' 事件，实时同步 isOnline signal。
  // 与 mount effect 分离便于单独测试 & 卸载时干净 removeEventListener。
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const handleOnline = (): void => {
      isOnline.value = true;
    };
    const handleOffline = (): void => {
      isOnline.value = false;
    };
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  const list = items.value;
  const err = loadError.value;
  const total = list?.length ?? 0;

  return (
    <section
      aria-labelledby="bookmarks-heading"
      class="space-y-4"
    >
      <header class="space-y-1">
        <h1
          id="bookmarks-heading"
          class="flex items-center gap-2 text-2xl font-bold text-zinc-900 dark:text-zinc-50"
        >
          <BookmarkIcon size={24} aria-hidden="true" />
          {t('bookmarksTitle')}
        </h1>
        <p class="text-sm text-zinc-600 dark:text-zinc-400">
          {t('bookmarksSubtitlePrefix')}
          {isOnline.value ? (
            <span class="font-medium text-sky-700 dark:text-sky-400">{t('bookmarksSubtitleOnline')}</span>
          ) : (
            <span class="font-medium text-fg2">{t('bookmarksSubtitleOffline')}</span>
          )}
        </p>
      </header>

      {err !== null && (
        <div
          role="status"
          aria-live="polite"
          class="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200"
        >
          {err}
        </div>
      )}

      {list === null && err === null && (
        <div
          role="status"
          aria-live="polite"
          class="rounded-lg border border-zinc-200 bg-white px-4 py-6 text-center text-sm text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400"
        >
          {t('bookmarksLoading')}
        </div>
      )}

      {list !== null && err === null && list.length === 0 && (
        // 中文注释：UX-AUDIT-7 — 空态虚框/图标提对比；离线图数提示已是 text-xs（计划里的 10px 字号目标已过时）
        <div class="flex flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed border-zinc-400/80 bg-white px-6 py-12 text-center dark:border-zinc-500/80 dark:bg-zinc-900">
          <BookmarkIcon
            size={48}
            aria-hidden="true"
            class="text-zinc-400 dark:text-zinc-500"
          />
          <h2 class="text-base font-semibold text-zinc-700 dark:text-zinc-200">
            {t('bookmarksEmptyTitle')}
          </h2>
          <p class="max-w-xs text-sm text-zinc-500 dark:text-zinc-400">
            {t('bookmarksEmptyBody')}
          </p>
          <a
            href="/"
            class="mt-2 inline-flex items-center rounded-full bg-sky-500 px-4 py-2 text-sm font-semibold text-white hover:bg-sky-600 dark:bg-sky-600 dark:hover:bg-sky-500"
          >
            {t('bookmarksGoTimeline')}
          </a>
        </div>
      )}

      {list !== null && list.length > 0 && (
        <>
          <div class="text-xs text-zinc-500 dark:text-zinc-400">
            {t('bookmarksCountLine', undefined, { count: String(total) })}
          </div>
          <ul role="list" class="overflow-hidden rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
            {list.map((b) => {
              const removing = removingIds.value.has(b.post_id);
              const handle = deriveHandle(b.snapshot?.author_handle);
              const content = b.snapshot?.content ?? '';
              const imgCount = b.snapshot?.image_keys?.length ?? 0;
              const addedIso = new Date(b.added_at).toISOString();
              const initial = handle.charAt(0).toUpperCase() || '?';
              return (
                <li
                  key={b.post_id}
                  class="border-b border-zinc-200 px-4 py-3 last:border-b-0 dark:border-zinc-800"
                >
                  <article class="flex gap-3">
                    <div class="flex h-10 w-10 shrink-0 select-none items-center justify-center rounded-full bg-zinc-300 text-base font-bold text-white dark:bg-zinc-700">
                      {initial}
                    </div>
                    <div class="min-w-0 flex-1">
                      <div class="flex items-center gap-1.5 text-sm">
                        <span class="font-semibold text-zinc-900 dark:text-zinc-50">
                          @{handle}
                        </span>
                        <span class="text-fg3">·</span>
                        <time
                          dateTime={addedIso}
                          class="text-zinc-500 dark:text-zinc-400"
                          title={addedIso}
                        >
                          {formatRelativeTime(addedIso)}
                        </time>
                      </div>

                      {content !== '' ? (
                        <p class="mt-1 whitespace-pre-wrap break-words text-sm text-zinc-800 [display:-webkit-box] [-webkit-line-clamp:6] [-webkit-box-orient:vertical] overflow-hidden dark:text-zinc-200">
                          {content}
                        </p>
                      ) : (
                        <p class="mt-1 text-sm italic text-zinc-500 dark:text-zinc-400">
                          {t('bookmarksMissingSnapshot')}
                        </p>
                      )}

                      {imgCount > 0 && isOnline.value && b.snapshot?.image_keys !== undefined && b.snapshot.image_keys.length > 0 ? (
                        <div
                          class={`mt-2 grid gap-0.5 overflow-hidden rounded-2xl ring-1 ring-zinc-200 dark:ring-zinc-800 ${
                            b.snapshot.image_keys.length <= 1
                              ? 'grid-cols-1 max-h-[510px]'
                              : 'grid-cols-2 h-[min(510px,70vw)] max-h-[510px]'
                          }`}
                        >
                          {b.snapshot.image_keys.slice(0, 4).map((url) => (
                            <a
                              key={url}
                              href={url}
                              target="_blank"
                              rel="noopener noreferrer"
                              aria-label={t('bookmarksViewOriginalAria')}
                              class="block min-h-0 focus:outline-none focus:ring-2 focus:ring-sky-500"
                            >
                              <img
                                src={url}
                                alt=""
                                loading="lazy"
                                decoding="async"
                                class={
                                  b.snapshot!.image_keys!.length <= 1
                                    ? 'max-h-[510px] w-full object-cover'
                                    : 'h-full min-h-0 w-full object-cover'
                                }
                              />
                            </a>
                          ))}
                        </div>
                      ) : (
                        imgCount > 0 && (
                          <div class="mt-2 inline-flex items-center gap-1 text-xs text-zinc-500 dark:text-zinc-400">
                            <ImageIcon size={14} aria-hidden="true" />
                            {t('bookmarksImagesOffline', undefined, { count: String(imgCount) })}
                          </div>
                        )
                      )}

                      <div class="mt-2 flex items-center justify-between gap-2">
                        <span class="font-mono text-xs text-fg3" title={b.post_id}>
                          post_id: {shortPostId(b.post_id)}
                        </span>
                        <button
                          type="button"
                          onClick={() => void handleRemove(b.post_id)}
                          disabled={removing}
                          aria-label={t('bookmarksRemoveAria')}
                          class="inline-flex items-center gap-1 rounded-full border border-rose-200 px-3 py-1 text-xs font-medium text-rose-700 transition-colors hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-rose-900 dark:text-rose-300 dark:hover:bg-rose-950"
                        >
                          <BookmarkX size={14} aria-hidden="true" />
                          {removing ? t('bookmarksRemoving') : t('bookmarksRemove')}
                        </button>
                      </div>
                    </div>
                  </article>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}
