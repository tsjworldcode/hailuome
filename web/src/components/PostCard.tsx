/** @jsxImportSource preact */
/**
 * NCF-WEB-2：PostCard 以展示为主；交互状态机在 hooks/postCard。
 * PostCardProps 保持稳定（Timeline / Profile 调用方零改）。
 */
import type { VNode } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { MessageCircle, Repeat2, Heart, Bookmark, Share, EyeOff, Sparkles } from 'lucide-preact';
import { ConfirmDialog } from './ConfirmDialog';
import { ImageLightbox } from './ImageLightbox';
import type { FeedItem } from '../lib/api';
import { rewriteImageUrlsForBrowser } from '../lib/mediaUrls';
import { MediaImage } from './MediaImage';
import { VerifiedBadge } from './VerifiedBadge';
import { formatRelativeTime } from '../lib/timeFormat';
import { initLanguage, language, t } from '../lib/i18n';
import { type Explanation, feedItemInterestHandle } from '../lib/forYou';
import { formatPublicHandleDisplay } from '../lib/handleDisplay';
import {
  REPLY_MAX_LENGTH,
  usePostBookmark,
  usePostEngagementSignals,
  usePostInteractions,
  usePostNegativeFeedback,
  usePostRepost,
} from '../hooks/postCard';

// M7-5b-2 + UX-FEED-FLUSH-1：X 风格列表行（border-b 贴齐）；互动逻辑见 NCF-WEB-2 hooks。
// UX-FEED-FLUSH-1：时间线帖与帖贴齐（border-b 列表行，无圆角卡片间距）。
// 向后兼容：extractDomain / formatRelativeTime / onDelete / 行操作壳等既有契约保留。

export interface PostCardProps {
  readonly item: FeedItem;
  /** 注入"现在"以便测试稳定输出；默认运行时 Date.now() */
  readonly now?: number;
  /**
   * 可选删除回调；传入则渲染「删除」按钮（M7-4 Profile 用）。
   * Timeline（M7-2）不传，按钮不渲染，外观零变化。
   */
  readonly onDelete?: () => void | Promise<void>;
  /** 删除中态（disable 按钮 + 文字"删除中…"），由调用方控制 */
  readonly isDeleting?: boolean;
  /** M7-9b：For-You 推荐理由（解释卡片）。 */
  readonly explanation?: Explanation;
  /** M7-22：覆盖作者 handle（本节点帖子用站主真实 handle） */
  readonly authorHandle?: string;
  /** M7-22：覆盖作者显示名 */
  readonly authorDisplayName?: string;
  /** 站主已设置头像时，帖子卡片优先展示真实头像。 */
  readonly authorAvatarUrl?: string;
  /** M7-31c：作者邮箱已验证蓝标 */
  readonly authorEmailVerified?: boolean;
  /** M9-1-5：转发成功后回调（Timeline 重拉 For you） */
  readonly onReposted?: () => void;
  /** UX-FEED-REPOST-COUNT-1：当前列表可见的本源转发条数（非全网） */
  readonly repostCount?: number;
}

/**
 * 从节点 URL 派生 `@handle` 文本（X 视觉占位，与登录用户名无关）。
 */
function deriveHandle(url: string): string {
  try {
    const host = new URL(url).host.replace(/^www\./, '');
    const seg = host.split('.')[0] ?? host;
    return seg.slice(0, 16);
  } catch {
    return url.slice(0, 16);
  }
}

/** FNV-1a 32-bit 字符串哈希，仅做视觉散列。 */
function fnv1a32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

function avatarHue(url: string): number {
  return fnv1a32(url) % 360;
}

function avatarLetter(domain: string): string {
  const c = domain.trim().charAt(0);
  return c ? c.toUpperCase() : '?';
}

export function PostCard({
  item,
  now,
  onDelete,
  isDeleting,
  explanation,
  authorHandle,
  authorDisplayName,
  authorAvatarUrl,
  authorEmailVerified,
  onReposted,
  repostCount = 0,
}: PostCardProps): VNode {
  useEffect(() => {
    initLanguage();
  }, []);

  const images = rewriteImageUrlsForBrowser(item.image_urls);
  const extraCount = images.length > 4 ? images.length - 4 : 0;
  const visibleImages = images.slice(0, 4);
  const gridCols = visibleImages.length <= 1 ? 'grid-cols-1' : 'grid-cols-2';
  const handle = authorHandle ?? deriveHandle(item.node_url);
  const handleLabel = formatPublicHandleDisplay(handle);
  const displayName =
    (authorDisplayName && authorDisplayName.trim()) || handleLabel || handle;
  const hue = avatarHue(item.node_url);
  const letter = avatarLetter(displayName);
  const avatarStyle = `background-color: hsl(${hue}, 60%, 55%)`;
  const isOfficialPost = item.source_type === 'official';
  const isRepostCard = item.post_kind === 'repost' && Boolean(item.repost_of);
  const interactionNodeUrl =
    isRepostCard && item.repost_of ? item.repost_of.node_url : item.node_url;
  const interactionPostId =
    isRepostCard && item.repost_of ? item.repost_of.post_id : item.post_id;
  const negativeFeedbackHandle = feedItemInterestHandle(item);

  const { articleRef, tagsRef } = usePostEngagementSignals({
    handle,
    content: item.content,
  });

  const { bookmarked, bookmarkBusy, toggleBookmark } = usePostBookmark({
    postId: item.post_id,
    content: item.content,
    visibleImages,
    authorHandle: handle,
    tagsRef,
  });

  const {
    likeCount,
    replyCount,
    likedByMe,
    interactionBusy,
    replyOpen,
    replyText,
    setReplyText,
    replies,
    replyBusy,
    toggleLike,
    openReplies,
    submitReply,
  } = usePostInteractions({
    isOfficialPost,
    interactionNodeUrl,
    interactionPostId,
  });

  const {
    repostBusy,
    repostConfirmOpen,
    setRepostConfirmOpen,
    originPost,
    originLoading,
    originUnavailable,
    confirmRepost,
  } = usePostRepost({
    item,
    handle,
    isOfficialPost,
    isRepostCard,
    onReposted,
  });

  const { hidden, negativeBusy, handleNegativeFeedback } = usePostNegativeFeedback({
    isOfficialPost,
    negativeFeedbackHandle,
  });

  if (!isOfficialPost && hidden) return null as unknown as VNode;

  // UX-APPLE-9：图片灯箱状态（点击缩略图 → 全屏查看）
  // - 默认展示当前帖图；repost 内原帖图点击时把 images 替换为原帖图集。
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState(0);
  const [lightboxImages, setLightboxImages] = useState<readonly string[]>(images);
  const openLightbox = (i: number) => {
    setLightboxIndex(i);
    setLightboxOpen(true);
  };
  const closeLightbox = () => setLightboxOpen(false);
  const handleLightboxIndexChange = (next: number) => setLightboxIndex(next);

  return (
    <article
      ref={articleRef}
      class="group relative border-b border-[#eff3f4] bg-transparent px-4 py-3 transition-colors hover:bg-zinc-50 sm:px-6 dark:border-[#2f3336] dark:hover:bg-white/[0.03]"
    >
      <div class="flex gap-3">
        {authorAvatarUrl ? (
          <MediaImage
            src={authorAvatarUrl}
            alt=""
            loading="lazy"
            class="h-10 w-10 shrink-0 rounded-full object-cover"
            ariaHidden
          />
        ) : (
          <div
            class="flex h-10 w-10 shrink-0 select-none items-center justify-center rounded-full text-base font-bold text-white"
            style={avatarStyle}
            aria-hidden="true"
          >
            {letter}
          </div>
        )}

        <div class="flex min-w-0 flex-1 flex-col">
          <header class="flex items-baseline gap-1.5 text-sm">
            {isOfficialPost && (
              <span class="shrink-0 rounded-full border border-sky-200 bg-sky-50 px-2 py-0.5 text-[11px] font-semibold text-sky-700 dark:border-sky-500/30 dark:bg-sky-500/10 dark:text-sky-200">
                {t('postOfficialBadge')}
              </span>
            )}
            <span
              class="truncate text-[15px] font-bold text-zinc-950 dark:text-zinc-50"
              title={displayName}
            >
              {displayName}
            </span>
            {authorEmailVerified && <VerifiedBadge />}
            <span class="truncate text-zinc-500 dark:text-zinc-400">{handleLabel}</span>
            <span class="text-zinc-500 dark:text-zinc-400" aria-hidden="true">·</span>
            <time
              class="shrink-0 text-zinc-500 tabular-nums hover:underline dark:text-zinc-400"
              dateTime={item.created_at}
              title={item.created_at}
            >
              {formatRelativeTime(item.created_at, now, language.value)}
            </time>
            {onDelete && (
              <button
                type="button"
                class="ml-auto shrink-0 rounded-full border border-rose-200 px-2 py-0.5 text-xs font-medium text-rose-700 hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-rose-500/40 dark:text-rose-300 dark:hover:bg-rose-500/10"
                onClick={() => void onDelete()}
                disabled={isDeleting}
                aria-label={t('postDeleteAria')}
              >
                {isDeleting ? t('postDeleting') : t('postDelete')}
              </button>
            )}
          </header>

          {explanation && explanation.length > 0 && (
            <p
              class="mt-1 flex flex-wrap items-center gap-x-1 text-xs text-sky-700 dark:text-sky-300"
              role="note"
              aria-label={t('postReason')}
            >
              <Sparkles size={12} aria-hidden={true} />
              {explanation.map((r, i) => (
                <span
                  key={
                    r.kind === 'author'
                      ? `author:${r.handle}`
                      : r.kind === 'tag'
                        ? `tag:${r.tag}`
                        : r.kind === 'dwell'
                          ? `dwell:${r.handle}`
                          : 'top-pick'
                  }
                >
                  {i > 0 && <span class="mx-1 text-fg3" aria-hidden={true}>·</span>}
                  {r.kind === 'author'
                    ? t('postReasonAuthor', undefined, { handle: formatPublicHandleDisplay(r.handle) || r.handle })
                    : r.kind === 'tag'
                      ? t('postReasonTag', undefined, { tag: r.tag })
                      : r.kind === 'dwell'
                        ? t('postReasonDwell', undefined, { handle: formatPublicHandleDisplay(r.handle) || r.handle })
                        : t('postReasonTopPick')}
                </span>
              ))}
            </p>
          )}

          {isRepostCard && (
            <p class="mt-1 text-sm text-fg2">
              {t('postRepostedBy', undefined, { handle: displayName })}
            </p>
          )}

          {!isRepostCard && (
            <p class="mt-1 whitespace-pre-wrap break-words text-[15px] leading-6 text-zinc-900 dark:text-zinc-50">
              {item.content}
            </p>
          )}

          {!isRepostCard && visibleImages.length > 0 && (
            <div
              class={`mt-3 grid gap-0.5 overflow-hidden rounded-2xl ring-1 ring-[#eff3f4] dark:ring-[#2f3336] ${gridCols} ${
                visibleImages.length === 1
                  ? 'max-h-[510px]'
                  : 'h-[min(510px,70vw)] max-h-[510px]'
              }`}
            >
              {visibleImages.map((src, i) => (
                <button
                  key={src}
                  type="button"
                  onClick={() => {
                    setLightboxImages(images);
                    openLightbox(i);
                  }}
                  aria-label={t('lightboxOpenAria')}
                  class="group/lightbox relative block h-full w-full cursor-zoom-in focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/80"
                >
                  <MediaImage
                    src={src}
                    alt=""
                    loading="lazy"
                    decoding="async"
                    sizes="(max-width: 760px) 100vw, 760px"
                    class={
                      visibleImages.length === 1
                        ? 'max-h-[510px] w-full object-cover transition group-hover/lightbox:opacity-95'
                        : 'h-full min-h-0 w-full object-cover transition group-hover/lightbox:opacity-95'
                    }
                  />
                </button>
              ))}
              {extraCount > 0 && (
                <p class="col-span-full px-2 pb-2 text-xs text-zinc-500 dark:text-zinc-400">
                  {t('postMoreImages', undefined, { count: extraCount })}
                </p>
              )}
            </div>
          )}

          {isRepostCard && item.repost_of && (
            <div class="mt-3 rounded-xl border border-zinc-300 bg-zinc-50/80 p-3 dark:border-zinc-700 dark:bg-zinc-900/40">
              <p class="text-xs text-zinc-500 dark:text-zinc-400">
                {formatPublicHandleDisplay(item.repost_of.author_handle)}
              </p>
              {originLoading && (
                <p class="mt-2 text-sm text-zinc-500 dark:text-zinc-400">{t('feedLoadingMore')}</p>
              )}
              {originUnavailable && !originLoading && (
                <p class="mt-2 text-sm text-fg2">
                  {t('postRepostOriginUnavailable')}
                </p>
              )}
              {originPost && !originLoading && (
                <>
                  <p class="mt-2 whitespace-pre-wrap break-words text-[15px] leading-6 text-zinc-900 dark:text-zinc-50">
                    {originPost.content}
                  </p>
                  {originPost.image_urls.length > 0 && (
                    <div
                      class={`mt-2 grid gap-0.5 overflow-hidden rounded-2xl ring-1 ring-[#eff3f4] dark:ring-[#2f3336] ${
                        originPost.image_urls.length === 1 ? 'grid-cols-1 max-h-[510px]' : 'grid-cols-2 h-[min(510px,70vw)] max-h-[510px]'
                      }`}
                    >
                      {rewriteImageUrlsForBrowser(originPost.image_urls).slice(0, 4).map((src) => (
                        <button
                          key={src}
                          type="button"
                          onClick={() => {
                            const urls = rewriteImageUrlsForBrowser(originPost.image_urls);
                            const i = Math.max(0, urls.indexOf(src));
                            openLightbox(i);
                            // 复用同一灯箱：把可见图集替换成原帖图
                            setLightboxImages(urls);
                          }}
                          aria-label={t('lightboxOpenAria')}
                          class="group/lightbox relative block h-full w-full cursor-zoom-in focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/80"
                        >
                          <MediaImage
                            src={src}
                            alt=""
                            loading="lazy"
                            decoding="async"
                            sizes="(max-width: 760px) 50vw, 380px"
                            class={
                              originPost.image_urls.length === 1
                                ? 'max-h-[510px] w-full object-cover transition group-hover/lightbox:opacity-95'
                                : 'h-full min-h-0 w-full object-cover transition group-hover/lightbox:opacity-95'
                            }
                          />
                        </button>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {/* UX-POST-ACTIONS-ALIGN-1：操作行已在头像旁的正文列内，勿再 pl-[52px]（会二次缩进、整排看起来靠右）。
              与正文左缘对齐 + justify-between 均分（推特式），比「全部挤左」更稳。 */}
          <div
            class="mt-3 flex w-full max-w-md items-center justify-between text-[13px] font-medium text-zinc-500 dark:text-zinc-400"
            role="group"
            aria-label={t('postActions')}
          >
            <button
              type="button"
              class={'group inline-flex min-h-[44px] min-w-[44px] items-center justify-center gap-1.5 rounded-full px-2.5 transition-colors hover:text-[rgb(var(--fg-2))] disabled:cursor-not-allowed disabled:opacity-50 ' + (replyOpen ? 'text-sky-500 dark:text-sky-400' : '')}
              aria-label={`${t('postReply')}，${replyCount}`}
              aria-pressed={replyOpen}
              title={t('postReply')}
              onClick={() => void openReplies()}
              disabled={isOfficialPost}
            >
              <MessageCircle size={18} strokeWidth={2} aria-hidden="true" />
              <span class="text-xs tabular-nums">{replyCount}</span>
            </button>
            <button
              type="button"
              class="group inline-flex min-h-[44px] min-w-[44px] items-center justify-center gap-1.5 rounded-full px-2.5 transition-colors hover:text-[rgb(var(--fg-2))] disabled:cursor-not-allowed disabled:opacity-50"
              aria-label={`${t('postRepost')}，${repostBusy ? '…' : repostCount}`}
              title={isRepostCard || isOfficialPost ? t('postComingSoon', undefined, { action: t('postRepost') }) : t('postRepost')}
              onClick={() => setRepostConfirmOpen(true)}
              disabled={isOfficialPost || isRepostCard || repostBusy}
            >
              <Repeat2 size={18} strokeWidth={2} aria-hidden="true" />
              <span class="text-xs tabular-nums">{repostBusy ? '…' : repostCount}</span>
            </button>
            <button
              type="button"
              class={'group inline-flex min-h-[44px] min-w-[44px] items-center justify-center gap-1.5 rounded-full px-2.5 transition-colors hover:text-[rgb(var(--fg-2))] disabled:cursor-not-allowed disabled:opacity-50 ' + (likedByMe ? 'text-rose-500 dark:text-rose-400' : '')}
              aria-label={`${t('postLike')}，${likeCount}`}
              aria-pressed={likedByMe}
              title={t('postLike')}
              onClick={() => void toggleLike()}
              disabled={isOfficialPost || interactionBusy}
            >
              <Heart size={18} strokeWidth={2} fill={likedByMe ? 'currentColor' : 'none'} aria-hidden="true" />
              <span class="text-xs tabular-nums">{likeCount}</span>
            </button>
            <button
              type="button"
              class={
                'group inline-flex min-h-[44px] min-w-[44px] items-center justify-center gap-1.5 rounded-full px-2.5 transition-colors hover:text-[rgb(var(--fg-2))] disabled:cursor-not-allowed disabled:opacity-50 ' +
                (bookmarked ? 'text-amber-500 dark:text-amber-400' : '')
              }
              aria-label={`${bookmarked ? t('postBookmarkRemove') : t('postBookmarkAdd')}，${bookmarked ? 1 : 0}`}
              aria-pressed={bookmarked}
              title={bookmarked ? t('postBookmarkAddedTitle') : t('postBookmarkAdd')}
              onClick={() => void toggleBookmark()}
              disabled={bookmarkBusy}
            >
              <Bookmark
                size={18}
                strokeWidth={2}
                fill={bookmarked ? 'currentColor' : 'none'}
                aria-hidden="true"
              />
              <span class="text-xs tabular-nums">{bookmarked ? 1 : 0}</span>
            </button>
            {!isOfficialPost && (
              <button
                type="button"
                class="group inline-flex min-h-[44px] min-w-[44px] items-center justify-center gap-1.5 rounded-full px-2.5 transition-colors hover:text-[rgb(var(--fg-2))] disabled:cursor-not-allowed disabled:opacity-50"
                aria-label={t('postNotInterested')}
                title={t('postNotInterestedTitle')}
                onClick={() => void handleNegativeFeedback()}
                disabled={negativeBusy}
              >
                <EyeOff size={18} strokeWidth={2} aria-hidden="true" />
              </button>
            )}
            <button
              type="button"
              class="group inline-flex min-h-[44px] min-w-[44px] items-center justify-center gap-1.5 rounded-full px-2.5 transition-colors hover:text-[rgb(var(--fg-2))] disabled:cursor-default disabled:opacity-50"
              aria-label={`${t('postShare')}，0`}
              title={t('postComingSoon', undefined, { action: t('postShare') })}
              disabled
            >
              <Share size={18} strokeWidth={2} aria-hidden="true" />
              <span class="text-xs tabular-nums">0</span>
            </button>
          </div>

          {/* UX-APPLE-8：回复区与 PostCard 卡片同底色、无独立边框；顶部一根淡线分段；评论列表项用左侧对话线 + 平齐文字，不再渲染小框卡片。
              - 容器 `bg-transparent` + `border-t border-zinc-200/70 dark:border-zinc-800/80` 与 PostCard 卡片同色调融合
              - 输入 textarea 无边框、靠同页底色，仅 focus 时 sky 描边
              - 单条评论 `li` 去掉 `rounded-md border bg-white`，改为透明 + 左侧 2px 浅灰线 + pl-3 缩进；元信息 + 内容平齐排
              - 提交按钮保持 rounded-full sky，与 InlineComposer 同源 */}
          {replyOpen && (
            <div class="mt-3 border-t border-zinc-200/70 pt-3 dark:border-zinc-800/80">
              <div class="flex gap-2">
                <textarea
                  value={replyText}
                  onInput={(e) => setReplyText((e.currentTarget as HTMLTextAreaElement).value)}
                  maxLength={REPLY_MAX_LENGTH}
                  rows={2}
                  placeholder={t('postReplyPlaceholder')}
                  class="hailuo-focus min-h-16 flex-1 resize-y rounded-full border border-transparent bg-transparent px-3 py-2 text-[15px] text-zinc-900 outline-none transition focus:border-sky-500 dark:text-zinc-50 dark:placeholder:text-zinc-500"
                />
                <button
                  type="button"
                  onClick={() => void submitReply()}
                  disabled={replyBusy || replyText.trim().length === 0}
                  class="h-9 shrink-0 self-end rounded-full bg-sky-600 px-4 text-sm font-semibold text-white transition hover:bg-sky-700 disabled:cursor-not-allowed disabled:bg-sky-400"
                >
                  {replyBusy ? t('postReplySubmitting') : t('postReply')}
                </button>
              </div>
              {replies.length > 0 && (
                <ul class="mt-3 space-y-2">
                  {replies.map((reply) => (
                    <li key={reply.id} class="border-l-2 border-zinc-200/70 pl-3 dark:border-zinc-700/70">
                      <div class="flex items-center gap-1 text-xs text-zinc-500 dark:text-zinc-400">
                        <span class="font-medium text-zinc-700 dark:text-zinc-200">
                          {formatPublicHandleDisplay(reply.actor_handle)}
                        </span>
                        <span aria-hidden="true">·</span>
                        <time dateTime={reply.created_at}>{formatRelativeTime(reply.created_at, now, language.value)}</time>
                      </div>
                      <p class="mt-0.5 whitespace-pre-wrap break-words text-[15px] leading-6 text-zinc-900 dark:text-zinc-50">{reply.content}</p>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={repostConfirmOpen}
        pending={repostBusy}
        title={t('postRepostDialogTitle')}
        body={<p>{t('postRepostConfirm')}</p>}
        cancelLabel={t('postRepostDialogCancel')}
        confirmLabel={t('postRepostDialogConfirm')}
        confirmPendingLabel={t('postRepostBusy')}
        icon={<Repeat2 size={20} strokeWidth={2} aria-hidden="true" />}
        onCancel={() => {
          if (!repostBusy) setRepostConfirmOpen(false);
        }}
        onConfirm={() => void confirmRepost()}
      />

      {/* UX-APPLE-9：图片灯箱全屏浮层（fixed + z-50） */}
      {lightboxOpen && (
        <ImageLightbox
          images={lightboxImages}
          index={lightboxIndex}
          alt={displayName}
          onClose={closeLightbox}
          onIndexChange={handleLightboxIndexChange}
        />
      )}
    </article>
  );
}
