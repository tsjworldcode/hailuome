/** @jsxImportSource preact */
import type { VNode } from 'preact';
import { signal, computed } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import { clearOwnerSessionForLogin } from '../lib/ownerSession';
import { createWorkerAClient, type LocalPost, type OwnerProfile } from '../lib/workerA';
import { ApiError, getErrorMessage } from '../lib/errors';
import type { FollowerTokenMode } from '@hailuo/shared-types';
import { isProtectedFollowerTokenMode } from '@hailuo/shared-utils';
import { formatOwnerHandleDisplay } from '../lib/handleDisplay';
import { buildWorkerBImageUrl, buildOwnerImageUrl, mapImageKeysToOwnerUrls, mapImageKeysToUrls, readPublicWorkerBBaseUrl, resolveOwnerImageApiBaseUrl } from '../lib/mediaUrls';
import {
  ownerBaseUrl,
  ownerCredentialsReady,
  ownerJwt,
  useOwnerCredentials,
} from '../lib/useOwnerCredentials';
import { PostCard } from './PostCard';
import { countVisibleRepostsForItem } from '../lib/repostCount';
import { ConfirmDialog } from './ConfirmDialog';
import { MediaImage } from './MediaImage';
import { QRCodeBadge } from './QRCodeBadge';
import type { FeedItem } from '../lib/api';
import { t } from '../lib/i18n';
import { buildAddFriendUri } from '../lib/hailuoUri';
import { Trash2 } from 'lucide-preact';
// M7-19：共享 mediaUrls 拼接 + computed 视图缓存 + 分页/加载更多分轨错误 + 重试
//
// 设计要点：
// - 双 gate：未配 Worker A 地址 → 引导卡跳设置 / 未登录 → 引导卡跳设置
// - 拉取顺序：getMe() → getMyPosts() → 渲染。getMe 取 handle / display_name / worker_b_url，
//   worker_b_url 用于 PostCard 的 node_url 展示（与 Timeline 视觉一致）。
// - 帖子翻页：cursor=before（最后一条 id），IntersectionObserver 触底加载（与 Timeline 同模式）。
// - image_keys → URL：走 lib/mediaUrls（与 Worker B `GET /posts` / api.imageUrl 同形）。
// - 删帖：点击「删除」→ ConfirmDialog 二次确认 → workerA.deletePost(id) → 列表移除。
//   失败时把按钮态恢复 + 顶部错误卡显示中文消息。
// - §F-02：本组件用 auth.ts.getWorkerAUrl 运行时读取 Worker A 地址，绝不读 import.meta.env.WORKER_A_URL。

const PAGE_LIMIT = 20;

const PUBLIC_WORKER_B_URL = readPublicWorkerBBaseUrl();

const me = signal<OwnerProfile | null>(null);
const posts = signal<readonly LocalPost[]>([]);
const loading = signal<boolean>(false);
const loadingMore = signal<boolean>(false);
const hasMore = signal<boolean>(true);
const cursor = signal<string | null>(null);
const errorMsg = signal<string | null>(null);
/** M7-19：加载更多失败与首屏错误分轨，避免 append 失败顶掉整页态 */
const loadMoreError = signal<string | null>(null);
/** 正在删除中的帖子 id（同一时间只允许一个删除请求） */
const deletingId = signal<string | null>(null);
/** UX-CONFIRM：删帖确认目标 */
const deleteConfirmPostId = signal<string | null>(null);

const qrVisible = signal<boolean>(false);
/** 注册中心用户 ID / 公钥指纹默认折叠，点击后再展开 */
const identityDetailsVisible = signal<boolean>(false);
/** M7-36-h0.5：注册中心海螺币余额（仅已登记用户拉取） */
const hailuoCoinsBalance = signal<number | null>(null);

const readProtectionMode = signal<FollowerTokenMode>('public-read');

const ownerNodeUrl = computed(() => {
  return me.value?.worker_b_url ?? PUBLIC_WORKER_B_URL ?? '';
});

const feedItemViews = computed((): readonly FeedItem[] => {
  const nodeUrl = ownerNodeUrl.value;
  return posts.value.map((post) => toFeedItem(post, nodeUrl));
});

const showImageConfigWarning = computed(() => {
  if (PUBLIC_WORKER_B_URL) return false;
  return posts.value.some((p) => p.image_keys.length > 0);
});

const avatarUrl = computed(() => {
  const profile = me.value;
  if (!profile?.avatar_key) return '';
  const ownerImageBase = resolveOwnerImageApiBaseUrl();
  // SEC-AUDIT-2026-10-12：保护档下站主头像也走 JWT 通道（无法给自己申领粉丝 Token）
  if (isProtectedFollowerTokenMode(readProtectionMode.value) && ownerImageBase) {
    return buildOwnerImageUrl(ownerImageBase, profile.avatar_key);
  }
  const base = PUBLIC_WORKER_B_URL || profile.worker_b_url;
  return base ? buildWorkerBImageUrl(base, profile.avatar_key) : '';
});

function formatProfileDate(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' });
}

/** 海螺币展示：整数不带小数，否则保留最多 2 位 */
function formatHailuoCoins(balance: number): string {
  if (Number.isInteger(balance)) return String(balance);
  return String(Math.round(balance * 100) / 100);
}

function toFeedItem(post: LocalPost, nodeUrl: string): FeedItem {
  const ownerImageBase = resolveOwnerImageApiBaseUrl();
  // SEC-AUDIT-2026-10-12：保护档本站帖图走 /api/images/，避免票据/粉丝 Token 自申领死路
  const useOwnerImages =
    isProtectedFollowerTokenMode(readProtectionMode.value) && Boolean(ownerImageBase);
  const imageBase = useOwnerImages
    ? ownerImageBase
    : PUBLIC_WORKER_B_URL || nodeUrl;
  return {
    id: post.id,
    node_url: nodeUrl,
    post_id: post.id,
    content: post.content,
    sig: post.sig,
    image_urls: useOwnerImages
      ? mapImageKeysToOwnerUrls(imageBase, post.image_keys)
      : mapImageKeysToUrls(imageBase, post.image_keys),
    created_at: post.created_at,
    post_kind: post.post_kind,
    repost_of: post.repost_of,
  };
}

async function loadInitial(): Promise<void> {
  const currentBaseUrl = ownerBaseUrl.value;
  const currentJwt = ownerJwt.value;
  if (!currentBaseUrl || !currentJwt) return;

  loading.value = true;
  errorMsg.value = null;
  hailuoCoinsBalance.value = null;

  const client = createWorkerAClient({
    baseUrl: currentBaseUrl,
    getJwt: () => currentJwt,
  });

  try {
    // 顺序：先 getMe 取身份，再首屏帖子；任一失败都在 catch 中统一显示
    const profile = await client.getMe();
    me.value = profile;
    // M7-41：老节点本地 registration_email 可能为空——拉一次登记档案触发回填并补显只读邮箱
    if (!profile.registration_email?.trim() && profile.registered === true) {
      try {
        const reg = await client.getRegistrationProfile();
        const email = reg.email?.trim();
        if (email) {
          me.value = { ...profile, registration_email: email };
        }
      } catch {
        // 中文注释：补读失败不影响主页其余内容
      }
    }
    if (profile.registry_user_id) {
      try {
        const certCtx = await client.getCertificationContext();
        hailuoCoinsBalance.value = certCtx.hailuo_coins;
      } catch {
        hailuoCoinsBalance.value = null;
      }
    }
    try {
      const modeSetting = await client.getFollowerTokenMode();
      readProtectionMode.value = modeSetting.mode;
    } catch {
      readProtectionMode.value = 'public-read';
    }

    const list = await client.getMyPosts({});
    posts.value = list.items;
    cursor.value = list.next_cursor;
    hasMore.value = list.next_cursor !== null && list.items.length === PAGE_LIMIT;
  } catch (err) {
    if (err instanceof ApiError) {
      errorMsg.value = err.displayMessage;
    } else {
      errorMsg.value = getErrorMessage({}, t('profileLoadFailed'));
    }
  } finally {
    loading.value = false;
  }
}

async function loadMore(): Promise<void> {
  if (loadingMore.value || !hasMore.value) return;
  const currentBaseUrl = ownerBaseUrl.value;
  const currentJwt = ownerJwt.value;
  const currentCursor = cursor.value;
  if (!currentBaseUrl || !currentJwt || !currentCursor) return;

  loadingMore.value = true;
  loadMoreError.value = null;
  const client = createWorkerAClient({
    baseUrl: currentBaseUrl,
    getJwt: () => currentJwt,
  });

  try {
    const list = await client.getMyPosts({ before: currentCursor });
    posts.value = [...posts.value, ...list.items];
    cursor.value = list.next_cursor;
    hasMore.value = list.next_cursor !== null && list.items.length === PAGE_LIMIT;
  } catch (err) {
    if (err instanceof ApiError) {
      loadMoreError.value = err.displayMessage;
    } else {
      loadMoreError.value = getErrorMessage({}, t('profileLoadMoreFailed'));
    }
  } finally {
    loadingMore.value = false;
  }
}

function requestDelete(postId: string): void {
  deleteConfirmPostId.value = postId;
}

async function confirmDelete(): Promise<void> {
  const postId = deleteConfirmPostId.value;
  if (!postId) return;

  const currentBaseUrl = ownerBaseUrl.value;
  const currentJwt = ownerJwt.value;
  if (!currentBaseUrl || !currentJwt) return;

  deletingId.value = postId;
  errorMsg.value = null;
  const client = createWorkerAClient({
    baseUrl: currentBaseUrl,
    getJwt: () => currentJwt,
  });

  try {
    await client.deletePost(postId);
    posts.value = posts.value.filter((p) => p.id !== postId);
    deleteConfirmPostId.value = null;
  } catch (err) {
    if (err instanceof ApiError) {
      errorMsg.value = err.displayMessage;
    } else {
      errorMsg.value = getErrorMessage({}, t('profileDeleteFailed'));
    }
  } finally {
    deletingId.value = null;
  }
}

/** 触底加载：IntersectionObserver 监听底部 sentinel 元素 */
function attachInfiniteScroll(): (() => void) | undefined {
  if (typeof window === 'undefined') return;
  const sentinel = document.getElementById('profile-bottom-sentinel');
  if (!sentinel) return;
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting && hasMore.value && !loadingMore.value) {
          void loadMore();
        }
      }
    },
    { rootMargin: '200px' },
  );
  observer.observe(sentinel);
  return () => observer.disconnect();
}

export function Profile(): VNode {
  useOwnerCredentials(() => {
    if (ownerBaseUrl.value && ownerJwt.value) {
      void loadInitial();
    }
  });

  useEffect(() => {
    // 仅在首屏数据就位后挂监听，否则 sentinel 不存在
    if (!loading.value && posts.value.length > 0 && hasMore.value) {
      return attachInfiniteScroll();
    }
    return undefined;
  }, [loading.value, posts.value.length, hasMore.value]);

  if (!ownerCredentialsReady.value) {
    // 整站登录态由 SiteAuthGate 统一展示；避免 SSR/水合后底部残留「正在校验登录状态…」
    return <div aria-busy="true" />;
  }

  // gate 1：部署入口缺失。生产应由 PUBLIC_WORKER_B_URL / deploy-env.json 自动注入。
  if (ownerBaseUrl.value === null) {
    return (
      <section class="rounded-lg border border-amber-300 bg-amber-50 p-5 text-sm leading-6 text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-100">
        <h2 class="text-base font-semibold">{t('profileGateEndpointTitle')}</h2>
        <p class="mt-2">{t('profileGateEndpointBody')}</p>
        <a
          href="/settings"
          class="mt-3 inline-block rounded-md bg-amber-600 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-amber-700"
        >
          {t('profileGoSettings')}
        </a>
      </section>
    );
  }

  // gate 2：会话失效
  if (ownerJwt.value === null) {
    return (
      <section class="rounded-lg border border-amber-300 bg-amber-50 p-5 text-sm leading-6 text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-100">
        <h2 class="text-base font-semibold">{t('profileGateSessionTitle')}</h2>
        <p class="mt-2">{t('profileGateSessionBody')}</p>
        <button
          type="button"
          class="mt-3 inline-block rounded-md bg-amber-600 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-amber-700"
          onClick={clearOwnerSessionForLogin}
        >
          {t('profileBackLogin')}
        </button>
      </section>
    );
  }

  const views = feedItemViews.value;

  return (
    <div class="space-y-5">
      {me.value && (
        <header class="rounded-lg border border-slate-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
          <div class="flex flex-col gap-4">
            <div class="flex items-start gap-4">
              {avatarUrl.value ? (
                <MediaImage
                  src={avatarUrl.value}
                  alt={t('profileAvatarAlt')}
                  class="h-20 w-20 shrink-0 rounded-full border border-slate-200 object-cover dark:border-zinc-700"
                />
              ) : (
                <div class="flex h-20 w-20 shrink-0 items-center justify-center rounded-full bg-sky-600 text-2xl font-bold text-white">
                  {me.value.handle.slice(0, 1).toUpperCase()}
                </div>
              )}
              <div class="min-w-0 flex-1">
                <h1 class="break-words text-xl font-bold tracking-tight text-slate-900 dark:text-zinc-50">
                  {me.value.display_name || me.value.handle}
                </h1>
                <p class="text-sm text-slate-500 dark:text-zinc-400">
                  {formatOwnerHandleDisplay(me.value)}
                </p>
                {/* UX-AUTH-2：待认证从侧栏挪到个人主页；点击去邮箱认证页 */}
                {me.value.registered === true && me.value.email_verified !== true && (
                  <a
                    href="/certify"
                    class="mt-2 inline-flex rounded-full border border-sky-300 bg-sky-50 px-2.5 py-0.5 text-xs font-semibold text-sky-800 transition hover:bg-sky-100 dark:border-sky-400 dark:bg-sky-500/15 dark:text-sky-200 dark:hover:bg-sky-500/25"
                    data-i18n="navProfilePendingCertify"
                  >
                    {t('navProfilePendingCertify')}
                  </a>
                )}
                <div class="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-sm">
                  <a
                    href="/follows"
                    class="group inline-flex items-baseline gap-1 text-slate-700 transition hover:text-sky-700 dark:text-zinc-200 dark:hover:text-sky-300"
                  >
                    <span class="text-base font-bold text-slate-900 dark:text-zinc-50">
                      {me.value.following_count ?? 0}
                    </span>
                    <span class="text-slate-500 group-hover:text-sky-600 dark:text-zinc-400">
                      {t('profileFollowingCount')}
                    </span>
                  </a>
                  <span
                    class="inline-flex items-baseline gap-1 text-slate-500 dark:text-zinc-400"
                    title={t('profileFollowersHint')}
                  >
                    <span class="text-base font-bold">{t('profileFollowersUnavailable')}</span>
                    <span>{t('profileFollowersCount')}</span>
                  </span>
                </div>
                {me.value.bio && (
                  <p class="mt-3 whitespace-pre-wrap text-sm leading-6 text-slate-700 dark:text-zinc-200">{me.value.bio}</p>
                )}
              </div>
            </div>

            <div class="grid gap-2 text-sm text-slate-600 dark:text-zinc-300">
              <div class="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500 dark:text-zinc-400">
                {formatProfileDate(me.value.created_at) && (
                  <span>{t('profileCreatedAtPrefix')}{formatProfileDate(me.value.created_at)}</span>
                )}
              </div>
              {me.value.contact_email && (
                <p class="text-sm text-slate-600 dark:text-zinc-300">
                  <span class="text-slate-500 dark:text-zinc-400">{t('profileEmailPrefix')}</span>
                  <a
                    class="break-all text-sky-700 hover:underline dark:text-sky-300"
                    href={`mailto:${me.value.contact_email}`}
                  >
                    {me.value.contact_email}
                  </a>
                </p>
              )}
              {/* M7-41b：登记邮箱仅站主 JWT 本页可见，不进 Worker B / 公开资料 */}
              {me.value.registration_email && (
                <p class="text-sm text-slate-600 dark:text-zinc-300">
                  <span class="text-slate-500 dark:text-zinc-400">{t('profileRegistrationEmailPrefix')}</span>
                  <span class="break-all">{me.value.registration_email}</span>
                  <span class="ml-2 text-xs text-slate-400 dark:text-zinc-500">
                    {t('profileRegistrationEmailPrivateHint')}
                  </span>
                </p>
              )}
              <a
                href={me.value.worker_b_url}
                target="_blank"
                rel="noopener noreferrer"
                class="break-all text-xs text-sky-700 hover:underline dark:text-sky-300"
                title={t('profileWorkerBTitle')}
              >
                {extractHostSafe(me.value.worker_b_url)}
              </a>
              {(me.value.registry_user_id || me.value.did_v2 || me.value.pubkey_fingerprint) && (
                <div class="space-y-2">
                  <button
                    type="button"
                    class="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 transition hover:bg-slate-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
                    aria-expanded={identityDetailsVisible.value}
                    onClick={() => {
                      identityDetailsVisible.value = !identityDetailsVisible.value;
                    }}
                  >
                    {identityDetailsVisible.value
                      ? t('profileIdentityHide')
                      : t('profileIdentityShow')}
                  </button>
                  {identityDetailsVisible.value && (
                    <dl class="grid gap-1 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600 dark:border-zinc-800 dark:bg-zinc-950/60 dark:text-zinc-300 sm:grid-cols-[auto,1fr]">
                      {me.value.registry_user_id && (
                        <>
                          <dt class="text-slate-500 dark:text-zinc-500">{t('profileRegistryUserId')}</dt>
                          <dd class="break-all font-mono">{me.value.registry_user_id}</dd>
                        </>
                      )}
                      {me.value.did_v2 && (
                        <>
                          <dt class="text-slate-500 dark:text-zinc-500">{t('profileDid')}</dt>
                          <dd class="break-all font-mono">{me.value.did_v2}</dd>
                        </>
                      )}
                      {me.value.pubkey_fingerprint && (
                        <>
                          <dt class="text-slate-500 dark:text-zinc-500">{t('profilePubkeyFingerprint')}</dt>
                          <dd class="break-all font-mono">{me.value.pubkey_fingerprint}</dd>
                        </>
                      )}
                      {hailuoCoinsBalance.value !== null && (
                        <>
                          <dt class="text-slate-500 dark:text-zinc-500">{t('profileHailuoCoins')}</dt>
                          <dd class="font-mono tabular-nums">
                            {formatHailuoCoins(hailuoCoinsBalance.value)}
                          </dd>
                        </>
                      )}
                    </dl>
                  )}
                </div>
              )}
              <a href="/settings" class="w-fit text-xs text-slate-500 hover:text-sky-600 dark:text-zinc-400 dark:hover:text-sky-300">
                {t('profileEditLink')}
              </a>
            </div>
          </div>
          {/* 二维码区：控件与二维码靠左，说明文案在右 */}
          <div class="mt-4 flex flex-col gap-3 border-t border-slate-200 pt-4 dark:border-zinc-800 sm:flex-row sm:items-start sm:gap-5">
            <div class="flex shrink-0 flex-col items-start gap-3">
              <button
                type="button"
                class="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 transition hover:bg-slate-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
                onClick={() => {
                  // 二维码可能包含公开节点链接，默认折叠，用户明确点击后再渲染。
                  qrVisible.value = !qrVisible.value;
                }}
              >
                {qrVisible.value ? t('profileQrHide') : t('profileQrShow')}
              </button>
              {qrVisible.value && (
                <QRCodeBadge
                  value={
                    me.value.handle && me.value.worker_b_url
                      ? buildAddFriendUri({
                          handle: me.value.handle,
                          node: me.value.worker_b_url,
                        })
                      : me.value.worker_b_url
                  }
                  label={
                    me.value.handle && me.value.worker_b_url
                      ? t('friendQrShare')
                      : t('profileQrAlt')
                  }
                  class="shrink-0"
                />
              )}
            </div>
            <div class="min-w-0 flex-1">
              <p class="text-sm font-semibold text-slate-900 dark:text-zinc-50">
                {me.value.handle && me.value.worker_b_url
                  ? t('friendQrShare')
                  : t('profileQrTitle')}
              </p>
              {qrVisible.value && (
                <p class="mt-1 break-all text-xs text-slate-500 dark:text-zinc-400">
                  {me.value.handle && me.value.worker_b_url
                    ? buildAddFriendUri({
                        handle: me.value.handle,
                        node: me.value.worker_b_url,
                      })
                    : me.value.worker_b_url}
                </p>
              )}
            </div>
          </div>
        </header>
      )}

      {showImageConfigWarning.value && (
        <section
          class="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-100"
          role="status"
        >
          <p class="font-semibold">{t('profileImageWarningTitle')}</p>
          <p class="mt-1 text-xs leading-5">
            {t('profileImageWarningBodyPrefix')}{' '}
            <code class="rounded bg-amber-100 px-1 dark:bg-amber-900/50">PUBLIC_WORKER_B_URL</code>
            {t('profileImageWarningBodySuffix')}
          </p>
        </section>
      )}

      {errorMsg.value && (
        <section
          class="rounded-lg border border-rose-300 bg-rose-50 p-4 text-sm leading-6 text-rose-900 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-100"
          role="alert"
          aria-live="polite"
        >
          <p class="font-semibold">{t('profileErrorTitle')}</p>
          <p class="mt-1">{errorMsg.value}</p>
          <button
            type="button"
            class="mt-3 rounded-md border border-rose-300 bg-white px-3 py-1.5 text-xs font-medium text-rose-800 hover:bg-rose-100 dark:border-rose-700 dark:bg-zinc-900 dark:text-rose-200 dark:hover:bg-zinc-800"
            onClick={() => void loadInitial()}
          >
            {t('profileRetry')}
          </button>
        </section>
      )}

      {loading.value && posts.value.length === 0 && (
        <section
          class="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-slate-200 bg-slate-50/80 px-4 py-10 text-sm text-slate-500 dark:border-zinc-800 dark:bg-zinc-900/40 dark:text-zinc-400"
          aria-busy="true"
          aria-label={t('profileLoading')}
        >
          <span
            class="h-5 w-5 animate-spin rounded-full border-2 border-slate-300 border-t-sky-600 dark:border-zinc-600 dark:border-t-sky-400"
            aria-hidden="true"
          />
          <p>{t('profileLoading')}</p>
        </section>
      )}

      {!loading.value && posts.value.length === 0 && !errorMsg.value && (
        <section class="rounded-lg border border-slate-200 bg-white p-6 text-center text-sm text-slate-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300">
          <p>{t('profileEmptyTitle')}</p>
          <a
            href="/composer"
            class="mt-3 inline-block rounded-md bg-sky-600 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-sky-700"
          >
            {t('profileFirstPost')}
          </a>
        </section>
      )}

      {posts.value.length > 0 && (
        <section aria-label={t('profilePostList')}>
          {views.map((view) => (
            <PostCard
              key={view.post_id}
              item={view}
              authorHandle={me.value?.handle}
              authorDisplayName={me.value?.display_name}
              authorAvatarUrl={avatarUrl.value || undefined}
              onDelete={() => requestDelete(view.post_id)}
              isDeleting={deletingId.value === view.post_id}
              repostCount={countVisibleRepostsForItem(views, view)}
            />
          ))}
        </section>
      )}

      {loadMoreError.value && (
        <section
          class="rounded-lg border border-rose-200 bg-rose-50 p-3 text-center text-sm text-rose-800 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-100"
          role="alert"
        >
          <p>{loadMoreError.value}</p>
          <button
            type="button"
            class="mt-2 rounded-md bg-rose-600 px-3 py-1 text-xs font-medium text-white hover:bg-rose-700"
            onClick={() => void loadMore()}
          >
            {t('profileRetryMore')}
          </button>
        </section>
      )}

      {posts.value.length > 0 && (
        <div id="profile-bottom-sentinel" class="h-4" aria-hidden="true" />
      )}

      {loadingMore.value && (
        <p class="text-center text-xs text-slate-500" aria-live="polite">
          {t('profileLoadingMore')}
        </p>
      )}

      {!hasMore.value && posts.value.length > 0 && (
        <p class="text-center text-xs text-slate-400">{t('profileEnd')}</p>
      )}

      <ConfirmDialog
        open={deleteConfirmPostId.value !== null}
        pending={deletingId.value !== null}
        title={t('profileDeleteDialogTitle')}
        body={
          deleteConfirmPostId.value ? (
            <p>{t('profileDeleteConfirm', undefined, { id: deleteConfirmPostId.value })}</p>
          ) : null
        }
        cancelLabel={t('profileDeleteDialogCancel')}
        confirmLabel={t('profileDeleteDialogConfirm')}
        confirmPendingLabel={t('profileDeleteDialogPending')}
        icon={<Trash2 size={20} strokeWidth={2} aria-hidden="true" />}
        confirmClassName="rounded-full bg-rose-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-rose-700 disabled:cursor-wait disabled:opacity-70 dark:bg-rose-500 dark:hover:bg-rose-400"
        onCancel={() => {
          if (deletingId.value === null) deleteConfirmPostId.value = null;
        }}
        onConfirm={() => void confirmDelete()}
      />
    </div>
  );
}

function extractHostSafe(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
