/** @jsxImportSource preact */
import type { VNode } from 'preact';
import { signal, computed, type Signal } from '@preact/signals';
import { useEffect, useRef } from 'preact/hooks';
import {
  createWorkerBClient,
  type FeedItem,
  type PostItem,
} from '../lib/api';
import { ApiError, FALLBACK_ERROR_MESSAGE, getErrorMessage } from '../lib/errors';
import { isQuotaExceeded } from '../lib/idbErrors';
import { getInterestWeights } from '../lib/localDb';
import { showToast } from '../lib/toast';
import {
  buildHandleWeightMap,
  buildTagWeightMap,
  buildWeightMemoForItems,
  clampHandleWeights,
  decayInterestWeights,
  dwellSignificantHandles,
  explainRanking,
  type Explanation,
  mergeRerankAppend,
  topPickHandlesOf,
  HIDE_HANDLE_THRESHOLD,
  maybeCompactInterestWeights,
  RANKING_STORAGE_KEY,
  hydrateNegativeFeedbackFromSession,
  readRankingPref,
  rerankFeedItems,
  type RankingPref,
} from '../lib/forYou';
import { PostCard } from './PostCard';
import { countVisibleRepostsForItem } from '../lib/repostCount';
import { InlineComposer } from './InlineComposer';
import { RegistryRegisterBanner } from './RegistryRegisterBanner';
import { CompactLanguageToggle } from './LanguageToggle';
import { FriendsRelationSignals } from './FriendsRelationSignals';
import {
  buildFriendsRelationSignals,
  countFriendsRelationAttention,
  type FriendsRelationSignal,
} from '../lib/friendsRelationSignals';
import { initBookmarksStore } from '../lib/bookmarksStore';
import { getOwnerJwt, getWorkerAUrl } from '../lib/auth';
import { loadOwnerProfile, ownerProfile } from '../lib/ownerProfile';
import { createWorkerAClient, type LocalPost } from '../lib/workerA';
import type { FollowerTokenMode } from '@hailuo/shared-types';
import { readCachedOwnerHandle, readCachedOwnerIdentity, type CachedOwnerIdentity } from '../lib/ownerSession';
import {
  resolvePublicWorkerBBaseUrlSync,
  resolveWorkerBBaseUrl,
  resolveWorkerBBaseUrlSync,
} from '../lib/deployEnv';
import {
  buildWorkerBImageUrl,
  mapImageKeysToUrls,
  mapImageKeysToOwnerUrls,
  remapFeedItemsLocalImgToOwnerApi,
  resolveOwnerImageApiBaseUrl,
} from '../lib/mediaUrls';
import { isProtectedFollowerTokenMode } from '@hailuo/shared-utils';
import {
  accumulateFriendsFromFollowingPages,
  buildMutualNodeUrlSet,
  filterFeedItemsByMutual,
  FRIENDS_FEED_MAX_PAGES,
} from '../lib/friendsFeed';
import { t } from '../lib/i18n';

/** 站主读帖保护档位（M14-4）；null 表示尚未从 Worker A 拉取。 */
const readProtectionMode = signal<FollowerTokenMode | null>(null);

/** UX-FEED-FAST-1：session 内缓存读帖档位，刷新时首屏可立刻用对路径拉最新帖 */
const READ_PROTECTION_MODE_CACHE_KEY = 'hailuo:read-protection-mode';

function isFollowerTokenMode(v: string): v is FollowerTokenMode {
  return (
    v === 'public-read' ||
    v === 'token-required' ||
    v === 'following-only' ||
    v === 'mutual-only' ||
    v === 'owner-only'
  );
}

function readCachedReadProtectionMode(): FollowerTokenMode | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(READ_PROTECTION_MODE_CACHE_KEY);
    if (raw && isFollowerTokenMode(raw)) return raw;
  } catch {
    /* sessionStorage 不可用则忽略 */
  }
  return null;
}

function writeCachedReadProtectionMode(mode: FollowerTokenMode): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(READ_PROTECTION_MODE_CACHE_KEY, mode);
  } catch {
    /* ignore */
  }
}

//
// 设计要点：
// - 三 tab 数据源：
//     For you   → Worker B GET /posts（本节点帖子 + 官方公告；官方公告自带 node_url/post_id）
//     Following → Worker B GET /feed  （fan-out 聚合 follows，FeedItem 自带 node_url/post_id）
//     Friends   → 与 Following 同源，前端按互粉 node_url 过滤（M17-4-3；不与右栏 FoF 混用）
// - 默认 For you（与 X 一致）；URL hash 持久化（#for-you / #following / #friends），刷新/分享保留
// - 三桶 signals：每个 tab 独立 posts/cursor/hasMore/loading/loadingMore/errorMsg/initialized；
//   切 tab 时各自保留滚动数据，已拉过则不重拉
// - UX-FEED-FAST-1：首屏立刻拉最新 Feed（不串行等站主资料/读帖档位）；资料与档位后台补齐，
//   档位若与首屏假设不同则 soft 静默重拉（不闪骨架屏）；本人展示名用 cachedOwnerIdentity 兜底
// - PostItem → FeedItem 适配：本节点帖子补 PUBLIC_WORKER_B_URL；官方公告保留后端 node_url/post_id
// - InlineComposer.onPosted 触发后只重拉 For you（自己发的帖落在本节点 /posts）
// - sentinel + IntersectionObserver 监听当前 tab 的 hasMore / cursor
// - §F-02：本组件只读 PUBLIC_WORKER_B_URL + window.location.origin，不读 Worker A 地址

const FEED_LIMIT = 20;

type TabKey = 'for-you' | 'following' | 'friends';

interface TabBucket {
  /** 展示用 posts：for-you tab 在 ranking on 时是 rerank 后的结果，off 时与 rawPosts 一致 */
  readonly posts: Signal<readonly FeedItem[]>;
  /** M7-8：服务器原序的 posts（仅 for-you bucket 使用）；pref 切换时重算 posts 不重拉网络 */
  readonly rawPosts: Signal<readonly FeedItem[]>;
  readonly cursor: Signal<string | null>;
  readonly hasMore: Signal<boolean>;
  readonly loading: Signal<boolean>;
  readonly loadingMore: Signal<boolean>;
  /** M7-32d：append 失败时分轨，不覆盖首屏 errorMsg */
  readonly loadMoreError: Signal<string | null>;
  readonly errorMsg: Signal<string | null>;
  readonly initialized: Signal<boolean>;
  /**
   * M7-9b：For-You 推荐理由（Map<post_id, Explanation>）。
   * 仅 for-you bucket + pref='on' 时由 applyForYouRanking 末尾填充；
   * 渲染时 PostCard 透传 explanation={explanations.value.get(item.post_id)}。
   */
  readonly explanations: Signal<ReadonlyMap<string, Explanation>>;
  /** M7-17：for-you 增量重排 / explain memo（仅 pref=on 时使用） */
  readonly forYouRankingCache: Signal<ForYouRankingCache | null>;
}

/** append 翻页时复用：已重排列表 + 权重 memo，避免全量 O(N) regex */
interface ForYouRankingCache {
  readonly rawLength: number;
  readonly rawPrefixIds: readonly string[];
  readonly rerankedSnapshot: readonly FeedItem[];
  readonly weightByPostId: Map<string, number>;
}

function createBucket(): TabBucket {
  return {
    posts: signal<readonly FeedItem[]>([]),
    rawPosts: signal<readonly FeedItem[]>([]),
    cursor: signal<string | null>(null),
    hasMore: signal<boolean>(true),
    loading: signal<boolean>(true),
    loadingMore: signal<boolean>(false),
    loadMoreError: signal<string | null>(null),
    errorMsg: signal<string | null>(null),
    initialized: signal<boolean>(false),
    explanations: signal<ReadonlyMap<string, Explanation>>(new Map()),
    forYouRankingCache: signal<ForYouRankingCache | null>(null),
  };
}

function clearForYouRankingCache(bucket: TabBucket): void {
  bucket.forYouRankingCache.value = null;
}

function rawPrefixMatches(raw: readonly FeedItem[], cache: ForYouRankingCache): boolean {
  if (raw.length < cache.rawLength) return false;
  for (let i = 0; i < cache.rawLength; i++) {
    if (raw[i]?.post_id !== cache.rawPrefixIds[i]) return false;
  }
  return true;
}

/**
 * M7-8：For-You 重排偏好（默认 off，用户 opt-in）。
 * - mount 从 localStorage 读
 * - LocalDataPanel toggle 写 localStorage 后发 'storage' 事件（包含同页检测）
 * - signal 变化时 useEffect 重算 for-you bucket 的 posts = rerank(rawPosts, weights) 或 rawPosts
 */
const rankingPref = signal<RankingPref>('off');

const buckets: Record<TabKey, TabBucket> = {
  'for-you': createBucket(),
  following: createBucket(),
  friends: createBucket(),
};

/** M17-4-3：互粉 node_url 集合缓存（null=未拉） */
const mutualFriendUrls = signal<ReadonlySet<string> | null>(null);

/**
 * REL-FIX-12：好友 tab 的「关系未闭环」信号（对方知不知道）。
 *
 * 空数组 = 没有待处理的信号（**不渲染**信号条）。
 * 拉取失败时保持上一次值（fail-soft：信号条是**增强**信息，
 * 拉不到不该让整个时间线报错）。
 */
const friendsRelationSignals = signal<readonly FriendsRelationSignal[]>([]);

/** 当前激活的 tab；mount 时由 hash 同步覆盖，默认 for-you */
const activeTab = signal<TabKey>('for-you');
const cachedOwnerIdentity = signal<CachedOwnerIdentity | null>(null);

/** 派生：当前 bucket 是否处于空态（首屏拉完且无错误且 0 条） */
const currentIsEmpty = computed(() => {
  const tab = activeTab.value;
  if (!isFeedTab(tab)) return false;
  const b = buckets[tab];
  return !b.loading.value && b.posts.value.length === 0 && !b.errorMsg.value;
});

/** 客户端 mount 时的 follower node URL；约定 window.location.origin */
function getFollowerNodeUrl(): string {
  if (typeof window === 'undefined') return '';
  return window.location.origin;
}

/** 解析 URL hash → TabKey；不识别时回 'for-you' */
function parseHashToTab(hash: string): TabKey {
  const h = hash.replace(/^#/, '').toLowerCase();
  if (h === 'following') return 'following';
  if (h === 'friends') return 'friends';
  return 'for-you';
}

/** 写回 URL hash（replaceState 不污染 history back stack） */
function writeHash(tab: TabKey): void {
  if (typeof window === 'undefined') return;
  const next = `#${tab}`;
  if (window.location.hash === next) return;
  try {
    window.history.replaceState(null, '', next);
  } catch {
    // 安全 fallback：直接赋值会留 history 项，但比报错好
    window.location.hash = next;
  }
}

/** PostItem（/posts）→ FeedItem 适配：本节点帖子补来源；官方公告保留后端来源字段。 */
function postToFeedItem(p: PostItem, nodeUrl: string): FeedItem {
  return {
    id: p.id,
    node_url: p.node_url ?? nodeUrl,
    post_id: p.post_id ?? p.id,
    source_type: p.source_type,
    author_handle: p.author_handle,
    content: p.content,
    sig: p.sig,
    image_urls: p.image_urls,
    created_at: p.created_at,
    post_kind: p.post_kind,
    repost_of: p.repost_of,
  };
}

/** M14-4：owner-only 下 Worker A 直读 D1 列表项 → FeedItem */
function localPostToFeedItem(
  post: LocalPost,
  nodeUrl: string,
  imageBaseUrl: string,
  mapImages: typeof mapImageKeysToUrls = mapImageKeysToUrls,
): FeedItem {
  return {
    id: post.id,
    node_url: nodeUrl,
    post_id: post.id,
    content: post.content,
    sig: post.sig,
    image_urls: mapImages(imageBaseUrl, post.image_keys),
    created_at: post.created_at,
    post_kind: post.post_kind,
    repost_of: post.repost_of,
  };
}

function dedupeFeedItems(items: readonly FeedItem[]): readonly FeedItem[] {
  const seen = new Set<string>();
  const out: FeedItem[] = [];
  for (const item of items) {
    const key = `${normalizeNodeUrl(item.node_url)}::${item.post_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function mergeForYouCandidates(primary: readonly FeedItem[], following: readonly FeedItem[]): readonly FeedItem[] {
  // For you 候选池 = 本节点/官方帖子 + 关注流帖子；只在前端读时合并，不增加后端写路径。
  return [...dedupeFeedItems([...primary, ...following])].sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export function Timeline(): VNode {
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const workerBUrl = signal<string | null>(resolveWorkerBBaseUrlSync() || null);
  const publicWorkerBUrl = signal<string | null>(resolvePublicWorkerBBaseUrlSync() || null);
  const workerBResolving = signal(!workerBUrl.value);

  // 异步补全：deploy-env.json → auth/me（不阻塞首屏；getMe 挂起时有超时）
  useEffect(() => {
    if (workerBUrl.value) {
      publicWorkerBUrl.value = publicWorkerBUrl.value || resolvePublicWorkerBBaseUrlSync() || workerBUrl.value;
      workerBResolving.value = false;
      return;
    }
    let cancelled = false;
    workerBResolving.value = true;
    void (async () => {
      try {
        let url = await Promise.race([
          resolveWorkerBBaseUrl(ownerProfile.value?.worker_b_url),
          new Promise<string>((resolve) => {
            setTimeout(() => resolve(''), 8000);
          }),
        ]);
        if (!url) {
          await Promise.race([
            loadOwnerProfile(),
            new Promise<void>((r) => setTimeout(r, 5000)),
          ]);
          url = resolveWorkerBBaseUrlSync(ownerProfile.value?.worker_b_url);
        }
        if (!cancelled) {
          workerBUrl.value = url || null;
          publicWorkerBUrl.value = resolvePublicWorkerBBaseUrlSync(ownerProfile.value?.worker_b_url) || url || null;
        }
      } finally {
        if (!cancelled) workerBResolving.value = false;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const workerB = workerBUrl.value;

  // mount 同步 hash → activeTab，并立刻拉当前 tab 最新 Feed（UX-FEED-FAST-1）
  useEffect(() => {
    cachedOwnerIdentity.value = readCachedOwnerIdentity();
    if (!workerB || !getOwnerJwt()) {
      // 未配 Worker B 或未登录站主：不拉 Feed（整站门禁已拦截，此处为纵深防御）
      buckets['for-you'].loading.value = false;
      buckets['following'].loading.value = false;
      buckets.friends.loading.value = false;
      return;
    }

    // 用 session 缓存档位（若有）立刻走对路径；否则默认 public-read，后台纠正
    const cachedMode = readCachedReadProtectionMode();
    if (cachedMode) {
      readProtectionMode.value = cachedMode;
    }
    const modeAtStart = readProtectionMode.value ?? 'public-read';

    if (typeof window !== 'undefined') {
      activeTab.value = parseHashToTab(window.location.hash);
    }
    if (isFeedTab(activeTab.value)) {
      ensureLoaded(activeTab.value, workerB);
    } else {
      buckets['for-you'].loading.value = false;
      buckets['following'].loading.value = false;
      buckets.friends.loading.value = false;
    }

    // 站主资料 + 读帖档位后台补齐；本人名字先靠 cachedOwnerIdentity，资料到了自然刷新
    void (async () => {
      const profileTask = (async () => {
        await loadOwnerProfile();
        publicWorkerBUrl.value =
          resolvePublicWorkerBBaseUrlSync(ownerProfile.value?.worker_b_url) ||
          publicWorkerBUrl.value ||
          workerB;
      })();

      let modeAfter: FollowerTokenMode = modeAtStart;
      const workerAUrl = getWorkerAUrl();
      if (workerAUrl) {
        try {
          const aClient = createWorkerAClient({ baseUrl: workerAUrl, getJwt: () => getOwnerJwt() });
          const modeSetting = await aClient.getFollowerTokenMode();
          modeAfter = modeSetting.mode;
          readProtectionMode.value = modeAfter;
          writeCachedReadProtectionMode(modeAfter);
        } catch {
          modeAfter = 'public-read';
          readProtectionMode.value = 'public-read';
          writeCachedReadProtectionMode('public-read');
        }
      } else {
        modeAfter = 'public-read';
        readProtectionMode.value = 'public-read';
      }

      await profileTask.catch(() => undefined);

      // 档位与首屏假设不同：静默重拉最新 Feed（不闪骨架、不展示上一屏缓存）
      if (modeAfter !== modeAtStart && isFeedTab(activeTab.value)) {
        const b = buckets[activeTab.value];
        b.initialized.value = false;
        ensureLoaded(activeTab.value, workerB, { soft: true });
      }
    })();
  }, [workerB]);

  // M7-8：mount 从 localStorage 读 For-You 重排偏好 + 跨标签同步以及 LocalDataPanel 同页同步
  useEffect(() => {
    if (typeof window === 'undefined') return;
    // M7-16：刷新后恢复「不感兴趣」隐藏表（sessionStorage 备份，尤其 pref=off）
    hydrateNegativeFeedbackFromSession();
    rankingPref.value = readRankingPref();
    function handleStorage(e: StorageEvent): void {
      if (e.key !== null && e.key !== RANKING_STORAGE_KEY) return;
      rankingPref.value = readRankingPref();
    }
    window.addEventListener('storage', handleStorage);
    // M7-8b：mount 时顺便触一次 compact（距上次 < 24h 自动 skip，IDB 异常静默）
    // 与 M7-8a 重排计算完全独立——重排仍按 raw 即时算衰减；compact 只做数据维护
    void maybeCompactInterestWeights();
    // M7-12：mount 时拉一次 listBookmarks 填顶层 bookmarkIds signal Set，
    // PostCard 同步读 signal.value.has(post_id) 不再逐帖走 IDB readonly tx。
    void initBookmarksStore();
    return () => window.removeEventListener('storage', handleStorage);
  }, []);

  // M7-8：For-You 偏好切换时重算 for-you posts（不重拉网络）
  useEffect(() => {
    const fy = buckets['for-you'];
    if (fy.rawPosts.value.length === 0) return;
    clearForYouRankingCache(fy);
    void applyForYouRanking(fy, rankingPref.value, { feedAppend: false });
  }, [rankingPref.value]);

  // 切 tab：未拉过则首屏；写 hash
  useEffect(() => {
    if (!workerB) return;
    writeHash(activeTab.value);
    if (isFeedTab(activeTab.value)) {
      ensureLoaded(activeTab.value, workerB);
      // REL-FIX-12：切到好友 tab 时**刷新**关系信号。
      // ensureLoaded 对已初始化 tab 是 noop（保留滚动数据）→ 信号会停在旧值；
      // 而信号正是「对方知不知道」这种**随时会变**的信息（回执 24h 内可能
      // 从 pending_retry 变 giveup）→ 每次进入好友 tab 都重拉一次。
      // ⚠️ 只在切 tab 时触发（不随 append 翻页重复拉）→ 请求量可控。
      if (activeTab.value === 'friends') {
        void loadFriendsRelationSignals();
      }
    }
  }, [activeTab.value, workerB]);

  // 无限滚动 sentinel —— 跟随 activeTab + 当前 bucket 的 hasMore / loading 变化
  useEffect(() => {
    if (!workerB || !isFeedTab(activeTab.value)) return;
    const b = buckets[activeTab.value];
    if (!b.hasMore.value) return;
    const el = sentinelRef.current;
    if (!el) return;
    if (typeof IntersectionObserver === 'undefined') return;

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (!entry || !entry.isIntersecting) return;
        const tabNow = activeTab.value;
        if (!isFeedTab(tabNow)) return;
        const cur = buckets[tabNow];
        if (cur.loading.value || cur.loadingMore.value || !cur.hasMore.value) return;
        void loadFeed({
          tab: tabNow,
          workerBUrl: workerB,
          cursorParam: cur.cursor.value,
          append: true,
        });
      },
      { rootMargin: '200px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [
    workerB,
    activeTab.value,
    activeTab.value === 'for-you' || activeTab.value === 'following' || activeTab.value === 'friends'
      ? buckets[activeTab.value].hasMore.value
      : false,
    activeTab.value === 'for-you' || activeTab.value === 'following' || activeTab.value === 'friends'
      ? buckets[activeTab.value].loading.value
      : false,
  ]);

  // InlineComposer 发帖成功 → 重拉 For you（自己的帖归本节点 /posts）；
  // 同时如果当前在 Following 上，也清掉它的 initialized 让用户切回去时强制重拉
  // （fan-out 聚合是 Cron 写入 KV，自己的帖不直接进 /feed，留给 Cron 自然刷新即可）
  const handlePosted = (): void => {
    if (!workerB) return;
    const fy = buckets['for-you'];
    fy.posts.value = [];
    fy.rawPosts.value = [];
    fy.cursor.value = null;
    fy.hasMore.value = true;
    fy.errorMsg.value = null;
    fy.loading.value = true;
    fy.initialized.value = false;
    activeTab.value = 'for-you';
    void loadFeed({
      tab: 'for-you',
      workerBUrl: workerB,
      cursorParam: null,
      append: false,
    });
  };

  if (workerBResolving.value) {
    return (
      <section class="m-4 rounded-3xl bg-white/80 p-8 text-center text-sm text-zinc-500 shadow-sm ring-1 ring-zinc-200/70 dark:bg-white/5 dark:text-zinc-400 dark:ring-white/10">
        {t('feedLoadingConfig')}
      </section>
    );
  }

  // 1. 未解析到 Worker B —— 引导重新部署（deploy-all 会自动注入，无需手填控制台）
  if (!workerB) {
    return (
      <section class="m-4 rounded-3xl border border-amber-200 bg-amber-50/90 p-5 text-sm leading-6 text-amber-900 shadow-sm dark:border-amber-400/30 dark:bg-amber-500/10 dark:text-amber-100">
        <h2 class="text-base font-semibold">{t('feedWorkerBMissingTitle')}</h2>
        <p class="mt-2">
          {t('feedWorkerBMissingBody', undefined, { command: '.\\scripts\\deploy-all.ps1' })}
        </p>
        <p class="mt-2 text-xs text-amber-800">
          {t('feedWorkerBMissingHint')}
        </p>
      </section>
    );
  }

  const cur = isFeedTab(activeTab.value) ? buckets[activeTab.value] : buckets['for-you'];
  const profile = ownerProfile.value;

  return (
    <div class="flex min-h-0 flex-1 flex-col">
      <RegistryRegisterBanner />
      <Tabs />
      {(isFeedTab(activeTab.value)) && (
        <>
          <InlineComposer onPosted={handlePosted} />
          <Body
            tab={activeTab.value}
            bucket={cur}
            workerBUrl={workerB}
            publicWorkerBUrl={publicWorkerBUrl.value || workerB}
            cachedOwnerIdentity={cachedOwnerIdentity.value}
            sentinelRef={sentinelRef}
            ownerProfile={profile}
            onReposted={handlePosted}
          />
        </>
      )}
    </div>
  );
}

function isFeedTab(tab: TabKey): tab is TabKey {
  return tab === 'for-you' || tab === 'following' || tab === 'friends';
}

// =====================================================================
// 子组件：Tabs 条
// =====================================================================

function Tabs(): VNode {
  return (
    <header class="sticky top-0 z-20 shrink-0 border-b border-zinc-200/70 bg-white/85 backdrop-blur-md dark:border-zinc-800/80 dark:bg-black/85">
      <div class="flex items-center justify-end gap-3 px-4 py-2.5 sm:justify-between">
        <h1 class="hidden text-xl font-bold tracking-tight text-zinc-950 dark:text-zinc-50 sm:block">{t('homeTitle')}</h1>
        <CompactLanguageToggle />
      </div>
      <nav
        class="flex"
        role="tablist"
        aria-label={t('feedTabAria')}
      >
        <TabButton tab="for-you" label={t('homeTabForYou')} />
        <TabButton tab="following" label={t('homeTabFollowing')} />
        <TabButton tab="friends" label={t('homeTabFriends')} />
      </nav>
    </header>
  );
}

interface TabButtonProps {
  readonly tab: TabKey;
  readonly label: string;
}

function TabButton({ tab, label }: TabButtonProps): VNode {
  const isActive = activeTab.value === tab;
  // UX-AUDIT-3：选中态药丸内嵌于内层 span，保留 button flex 三等宽；药丸本身是强选中信号，底部下划线删除
  const baseCls =
    'flex flex-1 items-center justify-center p-1 transition-colors';
  const innerCls = isActive
    ? 'rounded-full bg-zinc-900 px-3 py-1.5 text-[15px] font-bold text-white dark:bg-white dark:text-zinc-900'
    : 'rounded-full px-3 py-1.5 text-[15px] font-medium text-zinc-500 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-900';
  return (
    <button
      type="button"
      role="tab"
      aria-selected={isActive ? 'true' : 'false'}
      aria-current={isActive ? 'page' : undefined}
      class={`${baseCls}`}
      data-tab={tab}
      onClick={() => {
        if (activeTab.value === tab) return;
        activeTab.value = tab;
      }}
    >
      <span class={innerCls}>{label}</span>
    </button>
  );
}

// =====================================================================
// 子组件：当前 tab 的内容主体
// =====================================================================

interface BodyProps {
  readonly tab: TabKey;
  readonly bucket: TabBucket;
  readonly workerBUrl: string;
  readonly publicWorkerBUrl: string;
  readonly cachedOwnerIdentity: CachedOwnerIdentity | null;
  readonly sentinelRef: { current: HTMLDivElement | null };
  readonly ownerProfile: import('../lib/workerA').OwnerProfile | null;
  /** M9-1-5：转发成功后重拉 For you（与 InlineComposer.onPosted 同源） */
  readonly onReposted?: () => void;
}

function normalizeNodeUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

function Body({ tab, bucket, workerBUrl, publicWorkerBUrl, cachedOwnerIdentity, sentinelRef, ownerProfile, onReposted }: BodyProps): VNode {
  // REL-FIX-12：好友 tab 的「关系未闭环」信号条。
  // ⚠️ 刻意放在**空态判断之前** —— 恰恰是「投递 giveup（对方压根没收到）」
  // 的场景下，好友动态会是**空的**，而这正是站主最需要看到信号的时刻。
  // signal 在 render 期读取 → 拉回来后自动重渲染（@preact/signals 集成）。
  const relationSignals = tab === 'friends' ? friendsRelationSignals.value : [];
  const relationAttentionCount = countFriendsRelationAttention(relationSignals);

  // 首屏加载中
  if (bucket.loading.value) {
    return (
      <ul>
        {[0, 1, 2].map((i) => (
          <li
            key={i}
            class="h-24 animate-pulse border-b border-[#eff3f4] bg-zinc-50/50 dark:border-[#2f3336] dark:bg-zinc-900/40"
          />
        ))}
      </ul>
    );
  }

  // 错误态
  if (bucket.errorMsg.value) {
    return (
      <section class="m-4 rounded-3xl border border-rose-200 bg-rose-50/90 p-5 text-sm leading-6 text-rose-900 shadow-sm dark:border-rose-500/40 dark:bg-rose-500/10 dark:text-rose-200">
        <h2 class="text-base font-semibold">{t('feedLoadFailed')}</h2>
        <p class="mt-2">{bucket.errorMsg.value}</p>
        <button
          type="button"
          class="mt-3 rounded-md bg-rose-600 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-rose-700"
          onClick={() => {
            bucket.errorMsg.value = null;
            bucket.loading.value = true;
            bucket.posts.value = [];
            bucket.rawPosts.value = [];
            bucket.cursor.value = null;
            bucket.hasMore.value = true;
            void loadFeed({
              tab,
              workerBUrl,
              cursorParam: null,
              append: false,
            });
          }}
        >
          {t('feedRetry')}
        </button>
      </section>
    );
  }

  // 空态
  if (currentIsEmpty.value) {
    const emptyHint =
      tab === 'for-you'
        ? t('feedEmptyForYou')
        : tab === 'friends'
          ? t('feedEmptyFriends')
          : t('feedEmptyFollowing');
    return (
      <div>
        {/* REL-FIX-12：空态也**先**显示关系信号条 ——
            「投递 giveup（对方压根没收到）」恰恰会导致好友动态为空，
            而这正是站主最需要看到信号的时刻（否则只看到「还没有互粉好友的动态」，
            完全不知道是「好友没发内容」还是「我的请求根本没送到」）。 */}
        {relationSignals.length > 0 && (
          <FriendsRelationSignals
            signals={relationSignals}
            attentionCount={relationAttentionCount}
          />
        )}
        <section class="m-4 rounded-3xl bg-white/80 p-8 text-center text-sm text-zinc-600 shadow-sm ring-1 ring-zinc-200/70 dark:bg-white/5 dark:text-zinc-400 dark:ring-white/10">
          <p class="text-base font-semibold text-zinc-900 dark:text-zinc-100">{t('feedEmptyTitle')}</p>
          <p class="mt-2">{emptyHint}</p>
        </section>
      </div>
    );
  }

  // 帖子列表 + sentinel
  return (
    <div class="pb-8">
      {/* REL-FIX-12：好友 tab 的关系信号条（在帖子列表上方，不阻断浏览） */}
      {relationSignals.length > 0 && (
        <FriendsRelationSignals
          signals={relationSignals}
          attentionCount={relationAttentionCount}
        />
      )}
      <ul>
        {bucket.posts.value.map((item) => {
          // 中文注释：刷新首屏时 ownerProfile 可能尚未返回，先用公开 Worker B URL
          // 和本地登录 handle 识别本人帖子，避免短暂显示 worker-b 域名派生名。
          const isOwnByProfile =
            ownerProfile &&
            normalizeNodeUrl(item.node_url) === normalizeNodeUrl(ownerProfile.worker_b_url);
          const isOwnByPublicUrl = normalizeNodeUrl(item.node_url) === normalizeNodeUrl(publicWorkerBUrl);
          const isOwn = Boolean(isOwnByProfile || (cachedOwnerIdentity?.handle && isOwnByPublicUrl));
          const ownerHandle =
            ownerProfile?.handle_qualified?.trim() ||
            ownerProfile?.handle ||
            cachedOwnerIdentity?.handle ||
            undefined;
          const ownerDisplayName = ownerProfile?.display_name ?? cachedOwnerIdentity?.displayName ?? undefined;
          const authorAvatarUrl = isOwn && ownerProfile?.avatar_key
            ? buildWorkerBImageUrl(workerBUrl, ownerProfile.avatar_key)
            : undefined;
          const authorEmailVerified = isOwn ? ownerProfile?.email_verified === true : false;
          const countPool =
            bucket.rawPosts.value.length > 0 ? bucket.rawPosts.value : bucket.posts.value;
          return (
            <li key={item.id}>
              <PostCard
                item={isOwn ? { ...item, node_url: publicWorkerBUrl } : item}
                explanation={bucket.explanations.value.get(item.post_id)}
                authorHandle={isOwn ? ownerHandle : item.author_handle}
                authorDisplayName={isOwn ? ownerDisplayName : item.author_handle}
                authorAvatarUrl={authorAvatarUrl}
                authorEmailVerified={authorEmailVerified}
                onReposted={onReposted}
                repostCount={countVisibleRepostsForItem(countPool, item)}
              />
            </li>
          );
        })}
      </ul>

      {bucket.loadMoreError.value && (
        <section class="mx-6 mt-4 rounded-2xl border border-amber-200 bg-amber-50/90 p-4 text-sm text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-100">
          <p class="font-medium">{t('feedLoadMoreFailed')}</p>
          <p class="mt-1">{bucket.loadMoreError.value}</p>
          <button
            type="button"
            class="mt-3 rounded-md bg-amber-600 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-amber-700"
            disabled={bucket.loadingMore.value}
            onClick={() => {
              bucket.loadMoreError.value = null;
              void loadFeed({
                tab,
                workerBUrl,
                cursorParam: bucket.cursor.value,
                append: true,
              });
            }}
          >
            {t('feedRetry')}
          </button>
        </section>
      )}

      {bucket.loadingMore.value && (
        <p class="mx-6 mt-5 rounded-full border border-zinc-300 bg-zinc-50 px-3 py-2 text-center text-xs text-slate-500 dark:border-zinc-700 dark:bg-zinc-900/60 dark:text-zinc-400">{t('feedLoadingMore')}</p>
      )}
      {!bucket.hasMore.value && (
        <p
          class="mx-6 mb-8 mt-5 rounded-full border border-zinc-300 bg-zinc-50 px-3 py-2 text-center text-xs text-sky-600 dark:border-zinc-700 dark:bg-zinc-900/60 dark:text-sky-300"
          data-ux="feed-end"
        >
          {t('feedEnd')}
        </p>
      )}

      <div ref={sentinelRef} class="h-1 w-full" aria-hidden="true" />
    </div>
  );
}

// =====================================================================
// 内部：拉取
// =====================================================================

/**
 * M7-8：根据偏好对 for-you bucket 应用重排，写回 bucket.posts。
 * - pref === 'off'：posts 直接 = rawPosts（与服务器原序一致）
 * - pref === 'on'：拉 IDB 兴趣权重 → 稳定 partition rerank → 写 posts
 * - IDB 异常（SSR / 隐身模式 / Quota）：回落 posts = rawPosts + error toast（M7-20）
 */
async function applyForYouRanking(
  bucket: TabBucket,
  pref: RankingPref,
  opts?: { readonly feedAppend?: boolean },
): Promise<void> {
  const raw = bucket.rawPosts.value;
  if (pref === 'off') {
    bucket.posts.value = raw;
    clearForYouRankingCache(bucket);
    // M7-9b：pref off 时不展示解释卡片，清空 Map（避免上次 on 的残留）
    bucket.explanations.value = new Map();
    return;
  }
  try {
    const signals = await getInterestWeights();
    // M7-8a：半衰期衰减 → 建权重 Map → 单作者截断 → 重排
    // M7-8c：在 author 权重基础上叠加 tag 权重 + 按 HIDE_HANDLE_THRESHOLD 过滤负反馈作者
    const now = Date.now();
    const decayed = decayInterestWeights(signals, now);
    const rawMap = buildHandleWeightMap(decayed);
    const map = clampHandleWeights(rawMap);
    const tagWeights = buildTagWeightMap(decayed);
    const rerankOpts = { tagWeights, hideThreshold: HIDE_HANDLE_THRESHOLD };

    const cache = bucket.forYouRankingCache.value;
    const canIncremental =
      opts?.feedAppend === true &&
      cache !== null &&
      raw.length > cache.rawLength &&
      rawPrefixMatches(raw, cache);

    let reranked: readonly FeedItem[];
    let weightByPostId: Map<string, number>;

    if (canIncremental) {
      const newItems = raw.slice(cache.rawLength);
      weightByPostId = new Map(cache.weightByPostId);
      reranked = mergeRerankAppend(cache.rerankedSnapshot, weightByPostId, newItems, map, rerankOpts);
    } else {
      reranked = rerankFeedItems(raw, map, rerankOpts);
      weightByPostId = buildWeightMemoForItems(reranked, map, tagWeights);
    }

    bucket.forYouRankingCache.value = {
      rawLength: raw.length,
      rawPrefixIds: raw.map((i) => i.post_id),
      rerankedSnapshot: reranked,
      weightByPostId,
    };
    bucket.posts.value = reranked;

    // M7-9b + M7-17：解释 pass；append 时仅算新 post_id，复用已有 Map
    const topPickHandles = topPickHandlesOf(reranked);
    const dwellHandles = dwellSignificantHandles();
    const explanations = canIncremental
      ? new Map(bucket.explanations.value)
      : new Map<string, Explanation>();
    for (const item of reranked) {
      if (canIncremental && explanations.has(item.post_id)) continue;
      const reasons = explainRanking(item, map, tagWeights, {
        topPickHandles,
        dwellHandles,
      });
      if (reasons.length > 0) {
        explanations.set(item.post_id, reasons);
      } else {
        explanations.delete(item.post_id);
      }
    }
    bucket.explanations.value = explanations;
  } catch (err) {
    // IDB 不可用：回落原序 + toast 告知用户；Timeline 仍可读，不影响 Feed 拉取
    if (isQuotaExceeded(err)) {
      showToast(t('localStorageQuotaExceeded'), 'error');
    } else {
      showToast(t('feedRankingWeightsFailed'), 'error');
    }
    bucket.posts.value = raw;
    bucket.explanations.value = new Map();
    clearForYouRankingCache(bucket);
  }
}

/** 若 tab 未拉过则触发首屏拉；已拉过 noop（保留滚动数据）。soft：已有帖时不闪骨架，静默换成最新。 */
function ensureLoaded(
  tab: TabKey,
  workerBUrl: string,
  opts?: { readonly soft?: boolean },
): void {
  const b = buckets[tab];
  if (b.initialized.value) return;
  b.initialized.value = true;
  void loadFeed({
    tab,
    workerBUrl,
    cursorParam: null,
    append: false,
    soft: opts?.soft === true,
  });
}

interface LoadFeedArgs {
  readonly tab: TabKey;
  readonly workerBUrl: string;
  readonly cursorParam: string | null;
  readonly append: boolean;
  /** 已有列表时后台重拉：不置 loading，避免骨架屏盖住当前帖 */
  readonly soft?: boolean;
}

/** M14：站主 protected 档下本节点帖子走 Worker A JWT 直读 D1 */
async function loadOwnerLocalPostsForFeed(args: {
  cursorParam: string | null;
  publicNodeUrl: string;
  imageBaseUrl: string;
  mapImages?: typeof mapImageKeysToUrls;
}): Promise<{
  items: readonly FeedItem[];
  nextCursor: string | null;
  hasMore: boolean;
}> {
  const workerAUrl = getWorkerAUrl();
  if (!workerAUrl || !getOwnerJwt()) {
    throw new ApiError(503, { error_code: 'UNAUTHORIZED', message: t('timelineWorkerALoginRequired') });
  }
  const ownerClient = createWorkerAClient({
    baseUrl: workerAUrl,
    getJwt: () => getOwnerJwt(),
  });
  const data = await ownerClient.getMyPosts(
    args.cursorParam ? { before: args.cursorParam } : undefined,
  );
  return {
    items: data.items.map((p) =>
      localPostToFeedItem(
        p,
        args.publicNodeUrl,
        args.imageBaseUrl,
        args.mapImages ?? mapImageKeysToUrls,
      ),
    ),
    nextCursor: data.next_cursor,
    hasMore: data.next_cursor !== null,
  };
}

async function loadOwnerLocalFeed(args: {
  cursorParam: string | null;
}): Promise<{
  items: readonly FeedItem[];
  nextCursor: string | null;
  hasMore: boolean;
}> {
  const workerAUrl = getWorkerAUrl();
  if (!workerAUrl || !getOwnerJwt()) {
    throw new ApiError(503, { error_code: 'UNAUTHORIZED', message: t('timelineWorkerALoginRequired') });
  }
  const ownerClient = createWorkerAClient({
    baseUrl: workerAUrl,
    getJwt: () => getOwnerJwt(),
  });
  const data = await ownerClient.getLocalFeed(
    args.cursorParam ? { cursor: args.cursorParam, limit: FEED_LIMIT } : { limit: FEED_LIMIT },
  );
  return {
    items: data.items.map((row) => ({
      id: row.id,
      node_url: row.node_url,
      post_id: row.post_id,
      source_type: row.source_type,
      content: row.content,
      sig: row.sig,
      image_urls: row.image_urls,
      created_at: row.created_at,
      author_handle: row.author_handle,
      post_kind: row.post_kind,
      repost_of: row.repost_of,
    })),
    nextCursor: data.cursor,
    hasMore: data.has_more,
  };
}

/**
 * SEC-AUDIT-2026-10-10 / 10-12：保护档下把 feed_cache 本站 `/img/` 改成站主 `/api/images/`。
 *
 * 【为什么扩到 following-only / mutual-only / token-required】
 * 站主本人不在 follows 表，无法给本站申领粉丝 Token / 媒体票据；
 * 若仍走 Worker B `/img/`，本站图会 403 破图。站主 JWT 通道才是正路。
 * public-read 仍用公开 `/img/`（可走 CDN，不必强行走 JWT Blob）。
 */
function remapFeedItemsIfProtected(
  items: readonly FeedItem[],
  workerBUrl: string,
): readonly FeedItem[] {
  const mode = readProtectionMode.value ?? 'public-read';
  if (!isProtectedFollowerTokenMode(mode)) return items;
  if (!getWorkerAUrl() || !getOwnerJwt()) return items;
  const ownerApiBase = resolveOwnerImageApiBaseUrl();
  if (!ownerApiBase) return items;
  const publicNodeUrl =
    resolvePublicWorkerBBaseUrlSync(ownerProfile.value?.worker_b_url) || workerBUrl;
  const localOrigins = [
    publicNodeUrl,
    workerBUrl,
    ownerProfile.value?.worker_b_url ?? '',
  ].filter((u) => Boolean(u && String(u).trim()));
  return remapFeedItemsLocalImgToOwnerApi(items, {
    ownerApiBase,
    localOrigins,
  });
}

/** 关注流单页（Following / Friends 共用底层） */
async function loadFollowingSourcePage(args: {
  workerBUrl: string;
  cursorParam: string | null;
}): Promise<{
  items: readonly FeedItem[];
  nextCursor: string | null;
  hasMore: boolean;
}> {
  const mode = readProtectionMode.value ?? 'public-read';
  const ownerLoggedIn = Boolean(getWorkerAUrl() && getOwnerJwt());
  const protectedMode = isProtectedFollowerTokenMode(mode);

  if (mode === 'owner-only' && !ownerLoggedIn) {
    throw new ApiError(503, { error_code: 'UNAUTHORIZED', message: t('timelineOwnerOnlyLoginRequired') });
  }

  if (ownerLoggedIn && (mode === 'owner-only' || protectedMode)) {
    return loadOwnerLocalFeed({ cursorParam: args.cursorParam });
  }

  const client = createWorkerBClient({
    baseUrl: args.workerBUrl,
    followerNodeUrl: getFollowerNodeUrl(),
    followerHandle: readCachedOwnerHandle(),
  });
  const params = args.cursorParam
    ? { cursor: args.cursorParam, limit: FEED_LIMIT }
    : { limit: FEED_LIMIT };
  const data = await client.getFeed(params);
  return {
    items: data.items,
    nextCursor: data.cursor,
    hasMore: data.has_more,
  };
}

/** M17-4-3：拉互粉 URL 集合（会话内缓存；强制刷新可清 signal） */
async function ensureMutualFriendUrls(opts?: { readonly force?: boolean }): Promise<ReadonlySet<string>> {
  if (!opts?.force && mutualFriendUrls.value) return mutualFriendUrls.value;
  const workerAUrl = getWorkerAUrl();
  if (!workerAUrl || !getOwnerJwt()) {
    const empty = new Set<string>();
    mutualFriendUrls.value = empty;
    return empty;
  }
  const client = createWorkerAClient({
    baseUrl: workerAUrl,
    getJwt: () => getOwnerJwt(),
  });
  const data = await client.listMutualFollows();
  const set = buildMutualNodeUrlSet(data.items);
  mutualFriendUrls.value = set;
  return set;
}

/**
 * REL-FIX-12：拉好友关系「未闭环」信号（对方在等我 / 我在等对方 / 对方尚未收到回执）。
 *
 * 数据源与通讯录面板**同源**（Worker A `GET /api/friend-requests`，三份列表），
 * 但**独立拉取**：
 *   - 面板在「消息 → 通讯录」页，Timeline 不该为了显示一行信号条
 *     把面板那三份列表全拉一遍（面板还有撤回深链等额外查询）；
 *   - 时间线是**高频浏览**页面 → 信号条必须**fail-soft**：
 *     拉失败只保留上一次值，**绝不**让时间线报错或空态。
 *
 * ⚠️ 只在**好友 tab** 拉（其它 tab 不显示信号条）→ 零额外请求。
 *
 * 去重：`loadFriendsRelationSignals` 可能被「首屏 loadFeed」与「切 tab」同时触发
 * → 用 in-flight Promise 去重，避免同一时刻发两遍相同的三份列表请求。
 */
let friendsRelationSignalsInFlight: Promise<void> | null = null;

function loadFriendsRelationSignals(): Promise<void> {
  if (friendsRelationSignalsInFlight) return friendsRelationSignalsInFlight;
  const task = (async () => {
    const workerAUrl = getWorkerAUrl();
    if (!workerAUrl || !getOwnerJwt()) {
      friendsRelationSignals.value = [];
      return;
    }
    try {
      const client = createWorkerAClient({
        baseUrl: workerAUrl,
        getJwt: () => getOwnerJwt(),
      });
      const [inRes, outRes, resolvedRes] = await Promise.all([
        client.listFriendRequests({ direction: 'incoming', status: 'pending', limit: 30 }),
        client.listFriendRequests({ direction: 'outgoing', status: 'pending', limit: 30 }),
        // REL-FIX-11 的派生过滤：已处理但回执未确认送达对方（只查 incoming）。
        client.listFriendRequests({ direction: 'incoming', status: 'resolved', limit: 30 }),
      ]);
      friendsRelationSignals.value = buildFriendsRelationSignals({
        incomingPending: inRes.items,
        outgoingPending: outRes.items,
        incomingResolved: resolvedRes.items,
      });
    } catch {
      // fail-soft：信号条是增强信息，拉不到就保留上一次值（首次为空 → 不渲染）。
      // ⚠️ 刻意**不**打 console.error：生产日志默认无 PII（12-anti-deanonymization）。
    }
  })().finally(() => {
    friendsRelationSignalsInFlight = null;
  });
  friendsRelationSignalsInFlight = task;
  return task;
}

/** M7-36-h6b：首屏与 append 分轨错误，避免弱网加载更多时覆盖已展示 Feed。 */
function setFeedLoadError(bucket: TabBucket, append: boolean, message: string): void {
  if (append) {
    bucket.loadMoreError.value = message;
  } else {
    bucket.errorMsg.value = message;
  }
}

async function loadFeed(args: LoadFeedArgs): Promise<void> {
  const { tab, workerBUrl, cursorParam, append, soft } = args;
  const b = buckets[tab];
  if (append) {
    b.loadingMore.value = true;
  } else if (!(soft && b.posts.value.length > 0)) {
    b.loading.value = true;
  }

  try {
    // M17-4-3：好友 tab — 底层关注流 + 互粉 URL 过滤；可多翻几页凑满
    if (tab === 'friends') {
      // REL-FIX-12：并行拉「关系未闭环」信号（对方知不知道）。
      // 与 Feed 拉取**并行**而非串行 → 不拖慢首屏；失败 fail-soft（见函数内注释）。
      // ⚠️ 只在**首屏**拉（append 翻页不重复拉）→ 翻页不产生额外请求。
      if (!append) {
        void loadFriendsRelationSignals();
      }
      const mutual = await ensureMutualFriendUrls({ force: !append });
      if (mutual.size === 0) {
        b.posts.value = append ? b.posts.value : [];
        b.cursor.value = null;
        b.hasMore.value = false;
        b.errorMsg.value = null;
        b.loadMoreError.value = null;
        return;
      }

      const pages: {
        items: readonly FeedItem[];
        nextCursor: string | null;
        hasMore: boolean;
      }[] = [];
      let cursor = cursorParam;
      let hasMoreUnderlying = true;
      for (let i = 0; i < FRIENDS_FEED_MAX_PAGES && hasMoreUnderlying; i++) {
        const page = await loadFollowingSourcePage({ workerBUrl, cursorParam: cursor });
        pages.push(page);
        cursor = page.nextCursor;
        hasMoreUnderlying = page.hasMore;
        const soFar = filterFeedItemsByMutual(
          pages.flatMap((p) => p.items),
          mutual,
        );
        if (soFar.length >= FEED_LIMIT || !page.hasMore) break;
      }

      const accumulated = accumulateFriendsFromFollowingPages(pages, mutual, FEED_LIMIT);
      // SEC-AUDIT-2026-10-12：保护档本站图改写（Friends 底层也走 feed_cache）
      const remappedAccumulated = {
        ...accumulated,
        items: remapFeedItemsIfProtected(accumulated.items, workerBUrl),
      };
      // 去重（append 时与已展示合并）
      const merged = append
        ? dedupeFeedItems([...b.posts.value, ...remappedAccumulated.items])
        : dedupeFeedItems(remappedAccumulated.items);
      b.posts.value = merged;
      b.cursor.value = accumulated.nextCursor;
      b.hasMore.value = accumulated.hasMore;
      b.errorMsg.value = null;
      b.loadMoreError.value = null;
      return;
    }

    const mode = readProtectionMode.value ?? 'public-read';
    const ownerLoggedIn = Boolean(getWorkerAUrl() && getOwnerJwt());
    const protectedMode = isProtectedFollowerTokenMode(mode);
    const publicNodeUrl =
      resolvePublicWorkerBBaseUrlSync(ownerProfile.value?.worker_b_url) || workerBUrl;
    const publicImageBaseUrl =
      resolvePublicWorkerBBaseUrlSync(ownerProfile.value?.worker_b_url) || workerBUrl;
    const ownerImageBaseUrl = resolveOwnerImageApiBaseUrl();
    // 保护三档 + owner-only：本站帖 image_keys 直接拼站主 JWT 路径（与 remap 出口一致）
    const useOwnerImages =
      protectedMode && ownerLoggedIn && Boolean(ownerImageBaseUrl);
    const imageBaseUrl = useOwnerImages ? ownerImageBaseUrl : publicImageBaseUrl;
    const mapLocalImages = useOwnerImages ? mapImageKeysToOwnerUrls : mapImageKeysToUrls;

    let items: readonly FeedItem[];
    let nextCursor: string | null;
    let nextHasMore: boolean;

    if (mode === 'owner-only' && !ownerLoggedIn) {
      setFeedLoadError(b, append, getErrorMessage({}, t('timelineOwnerOnlyLoginRequired')));
      return;
    }

    // M14-4/9：owner-only For you 走 Worker A 本节点帖；M14-10：protected/owner-only Following 走 Worker A feed_cache
    if (mode === 'owner-only' && ownerLoggedIn && tab === 'for-you') {
      const localPage = await loadOwnerLocalPostsForFeed({
        cursorParam,
        publicNodeUrl,
        imageBaseUrl,
        mapImages: mapLocalImages,
      });
      items = localPage.items;
      nextCursor = localPage.nextCursor;
      nextHasMore = localPage.hasMore;
    } else if (
      tab === 'following' &&
      ownerLoggedIn &&
      (mode === 'owner-only' || protectedMode)
    ) {
      const localFeed = await loadFollowingSourcePage({ workerBUrl, cursorParam });
      // SEC-AUDIT-2026-10-12：保护档下 feed_cache 本站 /img/ → /api/images/
      items = remapFeedItemsIfProtected(localFeed.items, workerBUrl);
      nextCursor = localFeed.nextCursor;
      nextHasMore = localFeed.hasMore;
    } else if (tab === 'for-you' && protectedMode && ownerLoggedIn) {
      const client = createWorkerBClient({
        baseUrl: workerBUrl,
        followerNodeUrl: getFollowerNodeUrl(),
        followerHandle: readCachedOwnerHandle(),
      });
      const params = cursorParam
        ? { cursor: cursorParam, limit: FEED_LIMIT }
        : { limit: FEED_LIMIT };
      const localPage = await loadOwnerLocalPostsForFeed({
        cursorParam: null,
        publicNodeUrl,
        imageBaseUrl,
      });
      const postsData = await client.getPosts(params).catch(() => null);
      const officialItems = (postsData?.items ?? [])
        .filter((p) => p.source_type === 'official')
        .map((p) => postToFeedItem(p, publicNodeUrl));
      let followingData = await client.getFeed(params).catch(() => null);
      if (!followingData) {
        // M7-36-h6b：append 失败不回落本地 feed，避免重复帖与 cursor 错乱。
        if (append) {
          throw new ApiError(503, { error_code: 'UPSTREAM_ERROR' }, t('feedLoadMoreFailed'));
        }
        try {
          const localFeed = await loadOwnerLocalFeed({ cursorParam: params.cursor ?? null });
          followingData = {
            items: localFeed.items,
            cursor: localFeed.nextCursor,
            has_more: localFeed.hasMore,
          };
        } catch {
          followingData = null;
        }
      }
      items = remapFeedItemsIfProtected(
        mergeForYouCandidates(
          [...localPage.items, ...officialItems],
          followingData?.items ?? [],
        ),
        workerBUrl,
      );
      nextCursor = postsData?.cursor ?? followingData?.cursor ?? localPage.nextCursor;
      nextHasMore = Boolean(
        postsData?.has_more || followingData?.has_more || localPage.hasMore,
      );
    } else {
      const client = createWorkerBClient({
        baseUrl: workerBUrl,
        followerNodeUrl: getFollowerNodeUrl(),
        followerHandle: readCachedOwnerHandle(),
      });
      const params = cursorParam
        ? { cursor: cursorParam, limit: FEED_LIMIT }
        : { limit: FEED_LIMIT };

      if (tab === 'for-you') {
        let data = null;
        try {
          data = await client.getPosts(params);
        } catch {
          data = null;
        }
        if (!data && ownerLoggedIn && !append) {
          // M7-36-h6b：仅首屏允许 D1 回落；append 失败走 loadMoreError 分轨。
          const localPage = await loadOwnerLocalPostsForFeed({
            cursorParam,
            publicNodeUrl,
            imageBaseUrl,
            mapImages: mapLocalImages,
          });
          items = localPage.items;
          nextCursor = localPage.nextCursor;
          nextHasMore = localPage.hasMore;
        } else if (!data) {
          throw new ApiError(503, { error_code: 'UPSTREAM_ERROR' }, t('feedLoadFailed'));
        } else {
          const fromB = data.items.map((p) => postToFeedItem(p, publicNodeUrl));
          const officialItems = fromB.filter((p) => p.source_type === 'official');
          const kvLocalItems = fromB.filter((p) => p.source_type !== 'official');
          // UX-FEED-REPOST-HOME-1：已登录 For you 合并本机 D1 帖（含刚转发）。
          // Worker B posts:latest 走 waitUntil + 边缘缓存，会比个人页 D1 慢一拍。
          let ownerLocalItems: readonly FeedItem[] = [];
          if (ownerLoggedIn) {
            try {
              const localPage = await loadOwnerLocalPostsForFeed({
                cursorParam: null,
                publicNodeUrl,
                imageBaseUrl,
                mapImages: mapLocalImages,
              });
              ownerLocalItems = localPage.items;
            } catch {
              ownerLocalItems = [];
            }
          }
          const followingData = await client.getFeed(params).catch(() => null);
          items = mergeForYouCandidates(
            [...ownerLocalItems, ...officialItems],
            [...kvLocalItems, ...(followingData?.items ?? [])],
          );
          nextCursor = data.cursor;
          nextHasMore = data.has_more;
        }
      } else {
        const data = await client.getFeed(params);
        items = data.items;
        nextCursor = data.cursor;
        nextHasMore = data.has_more;
      }
    }

    if (tab === 'for-you') {
      // M7-8：for-you bucket 维护双道 rawPosts（服务器原序）+ posts（展示层）
      const nextRaw = append ? [...b.rawPosts.value, ...items] : [...items];
      b.rawPosts.value = nextRaw;
      await applyForYouRanking(b, rankingPref.value, { feedAppend: append });
    } else {
      b.posts.value = append ? [...b.posts.value, ...items] : [...items];
    }
    b.cursor.value = nextCursor;
    b.hasMore.value = nextHasMore;
    b.errorMsg.value = null;
    b.loadMoreError.value = null;
  } catch (err) {
    const msg =
      err instanceof ApiError
        ? err.displayMessage
        : err instanceof Error
          ? getErrorMessage({ message: err.message })
          : FALLBACK_ERROR_MESSAGE;
    if (append) {
      b.loadMoreError.value = msg;
    } else {
      b.errorMsg.value = msg;
    }
  } finally {
    b.loading.value = false;
    b.loadingMore.value = false;
  }
}
