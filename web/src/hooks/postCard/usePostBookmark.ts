/**
 * NCF-WEB-2：书签切换（顶层 bookmarkIds signal + IDB）。
 */
import { useState } from 'preact/hooks';
import { addBookmark, removeBookmark } from '../../lib/localDb';
import { bookmarkIds, markBookmarked, markUnbookmarked } from '../../lib/bookmarksStore';
import { isQuotaExceeded } from '../../lib/idbErrors';
import { showToast } from '../../lib/toast';
import { t } from '../../lib/i18n';
import { recordBookmarkAdd } from '../../lib/forYou';

export type UsePostBookmarkArgs = {
  postId: string;
  content: string;
  visibleImages: readonly string[];
  authorHandle: string;
  tagsRef: { current: readonly string[] };
};

export function usePostBookmark({
  postId,
  content,
  visibleImages,
  authorHandle,
  tagsRef,
}: UsePostBookmarkArgs) {
  const bookmarked = bookmarkIds.value.has(postId);
  const [bookmarkBusy, setBookmarkBusy] = useState(false);

  async function toggleBookmark(): Promise<void> {
    if (bookmarkBusy) return;
    setBookmarkBusy(true);
    try {
      if (bookmarked) {
        await removeBookmark(postId);
        // M7-12：同步顶层 bookmarkIds Set（preact-signals 自动重渲染本组件及同 Timeline 中所有订阅者）
        markUnbookmarked(postId);
      } else {
        await addBookmark({
          post_id: postId,
          added_at: Date.now(),
          snapshot: {
            content: content,
            image_keys: visibleImages,
            author_handle: authorHandle,
          },
        });
        markBookmarked(postId);
        // M7-8：加入书签视为强正向信号，bumpInterest(+5)；M7-8c：tag 同步 +1
        void recordBookmarkAdd(authorHandle, { tags: tagsRef.current });
      }
    } catch (err) {
      // M7-13 F-13：QuotaExceeded 给 toast，其它错误静默吞（UI 不闪红）
      if (isQuotaExceeded(err)) showToast(t('localStorageQuotaExceeded'), 'error');
    } finally {
      setBookmarkBusy(false);
    }
  }

  return { bookmarked, bookmarkBusy, toggleBookmark };
}
