/**
 * M7-8：For-You 推荐雏型 — 基于本地 IndexedDB `interest_weights` store 的纯前端重排。
 *
 * 设计要点：
 * - 三信号源（仅 PostCard 已落地的真实交互，不破坏 M7-5b-2 既定 disabled 行操作四壳）：
 *     1. impression（曝光阅读）+0.2 / 帖 / session（IntersectionObserver ratio>0.5 持续 1500ms）
 *     2. bookmark add（加入书签）+5（复用 M7-7b 既有 addBookmark 成功路径）
 *     3. author click（点击作者节点链接 target=_blank）+1
 * - 权重落 IndexedDB `interest_weights` store（M7-7 已建），key 形如 `author:@handle`
 * - 用户 opt-in：localStorage `hailuo:for-you-ranking` ∈ {'on','off'}，默认 'off'
 * - 重排是稳定 partition：weight>0 浮到顶按 weight DESC，weight<=0 保持服务器原相对时序
 *
 * M7-8a 增强：
 * - 半衰期衰减（HALF_LIFE_DAYS=7）：纯展示层计算，不写回 IDB，防止老信号永久占顶
 * - 单作者权重上限（MAX_AUTHOR_WEIGHT=20）：截断防垄断
 *
 * M7-8c 增强（For-You v3）：
 * - 负反馈（NEGATIVE_FEEDBACK_DELTA=-20）：用户点「不感兴趣」强负信号压制该作者
 * - 隐藏阈值（HIDE_HANDLE_THRESHOLD=-5）：重排时权重 ≤ 此值的作者被过滤掉
 * - tag 维度信号（TAG_KEY_PREFIX='tag:#'）：从 content 抽取 hashtag，随印象/书签同步累加
 * - 曝光位置加权（IMPRESSION_DELTA_FIRST_SCREEN=0.3 vs 默认 0.2）：首屏带有权重加成
 * - §F-02：本文件零 import lib/api / lib/workerA / 零 import.meta.env / 零 fetch / 零 worker-a 字面量
 */

import {
  bumpInterest,
  deleteInterestSignal,
  getInterestWeights,
  setInterestSignal,
  type InterestSignal,
} from './localDb';
import {
  clearNegativeFeedbackSession,
  hydrateNegativeFeedbackHandles,
  persistNegativeFeedbackHandle,
} from './negFeedbackSession';

// ---- 持久化偏好（用户 opt-in） -----------------------------------------------

export type RankingPref = 'on' | 'off';

/** localStorage 持偏好 key（与既有 hailuo:theme / hailuo:endpoint 同命名空间） */
export const RANKING_STORAGE_KEY = 'hailuo:for-you-ranking';

/** 默认偏好：保守起步，未开启时与原 Timeline 行为完全一致 */
export const DEFAULT_RANKING_PREF: RankingPref = 'off';

/** 读取偏好；SSR / localStorage 不可用 / 未设置 → 走默认 */
export function readRankingPref(): RankingPref {
  if (typeof window === 'undefined' || typeof window.localStorage === 'undefined') {
    return DEFAULT_RANKING_PREF;
  }
  try {
    const raw = window.localStorage.getItem(RANKING_STORAGE_KEY);
    if (raw === 'on' || raw === 'off') return raw;
    return DEFAULT_RANKING_PREF;
  } catch {
    return DEFAULT_RANKING_PREF;
  }
}

/** 写入偏好；SSR / 隐身模式静默吞错 */
export function writeRankingPref(pref: RankingPref): void {
  if (typeof window === 'undefined' || typeof window.localStorage === 'undefined') return;
  try {
    window.localStorage.setItem(RANKING_STORAGE_KEY, pref);
  } catch {
    // 隐身模式 setItem 抛 QuotaExceededError；静默
  }
}

// ---- M7-8a 衰减 / 截断常量 --------------------------------------------------

/** 每天的毫秒数（计算半衰期用） */
export const MS_PER_DAY = 86_400_000;

/**
 * 半衰期（天）：权重每过这么多天衰减为原来的一半。
 * 7 天：书签 +5 → 一周后 +2.5 → 两周 +1.25 → 四周 +0.3125。
 */
export const HALF_LIFE_DAYS = 7;

/**
 * 单作者权重上限：截断后不在此值以上累积，防止一个作者长期霸榜。
 * 20 ≈ 4 次书签（无衰减情况下）或 20 次链接点击。
 */
export const MAX_AUTHOR_WEIGHT = 20;

// ---- 信号采集（三 delta 常量 + 三 recordX 函数） -----------------------------

/** 印象（曝光阅读）权重增量 */
export const IMPRESSION_DELTA = 0.2;
/** 加入书签权重增量 */
export const BOOKMARK_ADD_DELTA = 5;
/** 点击作者节点链接权重增量 */
export const AUTHOR_CLICK_DELTA = 1;

/** 信号 key 前缀：与 `InterestSignal.signal_key` 约定，业务侧统一以 `author:@<handle>` 串生成 */
export const AUTHOR_KEY_PREFIX = 'author:@';

/** 由 handle 构造信号 key */
export function authorKey(handle: string): string {
  return `${AUTHOR_KEY_PREFIX}${handle}`;
}

// ---- M7-8c：tag 维度 + 负反馈 + 位置加权 常量 ---------------------------

/**
 * 负反馈（「不感兴趣」）信号增量：一次 -20。
 * 半衰期 7 天下一周后衰减为 -10，两周 -5，足以压制该作者几个周不被推出。
 */
export const NEGATIVE_FEEDBACK_DELTA = -20;

/**
 * 重排时隐藏阈值：衰减后作者权重 ≤ 此值的帖子被从 feed 过滤掉。
 * -5：一次负反馈（-20）衰减两个半衰期（-5）内都会隐藏该作者。
 */
export const HIDE_HANDLE_THRESHOLD = -5;

/** tag 信号 key 前缀：hashtag 本体不含 `#`，但 key 前缀保留 `#` 以便读。 */
export const TAG_KEY_PREFIX = 'tag:#';

/** 由 hashtag 构造信号 key（调用侧传不含 `#` 的纯 tag 名） */
export function tagKey(tag: string): string {
  return `${TAG_KEY_PREFIX}${tag}`;
}

/** 印象同步累加的 tag 增量（远小于作者 +0.2，防多 tag 帖污染） */
export const TAG_DELTA_FROM_IMPRESSION = 0.05;

/** 书签同步累加的 tag 增量（远小于作者 +5，书签是强信号但 tag 不是主轴） */
export const TAG_DELTA_FROM_BOOKMARK = 1;

/** 单帖最多提取几个 tag 参与计算（防 spam 帖堆 50 个 hashtag 污染权重） */
export const MAX_TAGS_PER_POST = 4;

/** 单个 tag 最大长度（超过截断，与服务器端未来约定保一致） */
export const MAX_TAG_LENGTH = 32;

/**
 * 首屏曝光增量：页面 mount 时 PostCard 已在视口内（未经滚动），
 * 视为「完整看见了」加成 1.5×；滚入视口走默认 IMPRESSION_DELTA。
 */
export const IMPRESSION_DELTA_FIRST_SCREEN = 0.3;

/**
 * 模块级 session 去重 Set：同一 handle 同一会话只触发一次 impression bump，
 * 避免列表内重复出现同作者帖子时被刷高（M7-2 Timeline 默认就会出现同站多帖）。
 * 页面刷新 / 关闭后自然清空，下次访问可再次累加（与 weight 衰减语义独立）。
 */
const impressionSeenHandles = new Set<string>();

/**
 * 仅供测试 / 调试：清空 session 去重 Set。
 * 非生产路径，不暴露在常规 UI 入口。
 */
export function resetImpressionDedup(): void {
  impressionSeenHandles.clear();
}

/**
 * M7-8c：recordImpression 扩展 options：options.tags 可选（同步 +TAG_DELTA_FROM_IMPRESSION、
 * 受 MAX_TAGS_PER_POST 上限）；options.firstScreen 可选（true 走 IMPRESSION_DELTA_FIRST_SCREEN 加权、
 * 否则走默认 IMPRESSION_DELTA）。options 参数本身可选，M7-8 / M7-8b 调用侧 0 参数变更。
 *
 * 同 session 仅一次 +author bump（去重）；tag 信号同 session 也有独立去重 Set。
 */
export async function recordImpression(
  handle: string,
  options?: { readonly tags?: readonly string[]; readonly firstScreen?: boolean },
): Promise<void> {
  if (!handle) return;
  if (impressionSeenHandles.has(handle)) {
    // 作者已去重，但 tag 信号仍需处理（同 session 另一帖带相同 tag）——交给下面的 tag 去重逻辑
  } else {
    impressionSeenHandles.add(handle);
    const delta = options?.firstScreen === true ? IMPRESSION_DELTA_FIRST_SCREEN : IMPRESSION_DELTA;
    try {
      await bumpInterest(authorKey(handle), delta);
      // M7-8b：真正落地的 impression 抵消该 handle 之前累计的 skim（用户开始认真读了）
      clearSkimCountFor(handle);
    } catch {
      // SSR / IDB 不可用 / 隐身模式：静默
    }
  }
  // M7-8c：tag 同步累加（受 MAX_TAGS_PER_POST 上限 + 同 session 去重）
  if (options?.tags && options.tags.length > 0) {
    await bumpTagsFromImpression(options.tags);
  }
}

/**
 * M7-8c：recordBookmarkAdd 扩展 options：options.tags 可选（同步 +TAG_DELTA_FROM_BOOKMARK）。
 * options 参数本身可选，M7-8 调用侧 0 参数变更。
 */
export async function recordBookmarkAdd(
  handle: string,
  options?: { readonly tags?: readonly string[] },
): Promise<void> {
  if (!handle) return;
  try {
    await bumpInterest(authorKey(handle), BOOKMARK_ADD_DELTA);
  } catch {
    // 静默
  }
  // M7-8c：tag 同步累加（书签是强信号，不去重，每次都打）
  if (options?.tags && options.tags.length > 0) {
    await bumpTagsFromBookmark(options.tags);
  }
}

/** 点击作者节点链接信号：bumpInterest +1；失败静默 */
export async function recordAuthorClick(handle: string): Promise<void> {
  if (!handle) return;
  try {
    await bumpInterest(authorKey(handle), AUTHOR_CLICK_DELTA);
  } catch {
    // 静默
  }
}

// ---- M7-8c：负反馈信号 + session 隐藏 -----------------------------------

/**
 * 同 session 被点过「不感兴趣」的 handle 集：PostCard 查询后立即渲染 null，不等重排传播。
 * M7-16：刷新后由 sessionStorage `hailuo:neg-hide` 恢复（见 hydrateNegativeFeedbackFromSession）。
 * pref=on 时 IDB -20 仍参与 rerank 过滤；pref=off 时主要靠本 Set + session 备份。
 */
const negativeFeedbackHandles = new Set<string>();

/** Timeline mount 调用：合并 sessionStorage 中已点「不感兴趣」的 handle */
export function hydrateNegativeFeedbackFromSession(): void {
  hydrateNegativeFeedbackHandles(negativeFeedbackHandles);
}

/** 查询某 handle 是否本 session 被点过负反馈（PostCard 用于渲染隐藏判定） */
export function isNegativelyFedBack(handle: string): boolean {
  return negativeFeedbackHandles.has(handle);
}

/** 仅供测试 / 调试：清空内存 Set 与 sessionStorage 备份。 */
export function resetNegativeFeedbackDedup(): void {
  negativeFeedbackHandles.clear();
  clearNegativeFeedbackSession();
}

/**
 * 负反馈信号：bumpInterest(-20) + 加入 session 隐藏表。
 * session 隐藏立即生效；IDB 失败向上抛出让 UI toast（M7-32c）。
 */
export async function recordNegativeFeedback(handle: string): Promise<void> {
  if (!handle) return;
  negativeFeedbackHandles.add(handle);
  persistNegativeFeedbackHandle(handle);
  await bumpInterest(authorKey(handle), NEGATIVE_FEEDBACK_DELTA);
}

// ---- M7-8c：tag 抽取 + tag 累加辅助 ----------------------------------------

/**
 * 从 content 抽取 hashtag：
 * - 正则 `/#([^\s#]+)/g` 抓不含空白不含 `#` 的主体段
 * - 多 tag 去重（同帖重复 hashtag 不加倍）
 * - 按出现顺序保留前 MAX_TAGS_PER_POST 个
 * - 单 tag 超过 MAX_TAG_LENGTH 截断后仍计一个
 * - 纯函数，无副作用；content 为空 / null / undefined 返回空数组
 */
export function extractTagsFromContent(content: string | null | undefined): string[] {
  if (!content) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  const re = /#([^\s#]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    let tag = m[1];
    if (!tag) continue;
    if (tag.length > MAX_TAG_LENGTH) tag = tag.slice(0, MAX_TAG_LENGTH);
    if (seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
    if (out.length >= MAX_TAGS_PER_POST) break;
  }
  return out;
}

/**
 * tag 同 session 去重表：同一 tag 同 session 仅累一次 impression 增量，与 author 去重独立。
 * 页面刷新后自然清空。
 */
const tagImpressionSeen = new Set<string>();

/** 仅供测试 / 调试：清空 tag impression 去重表。 */
export function resetTagImpressionDedup(): void {
  tagImpressionSeen.clear();
}

/** 内部辅助：impression 路径上 tag 同步累加（失败静默、仅首次 +0.05）。 */
async function bumpTagsFromImpression(tags: readonly string[]): Promise<void> {
  const limited = tags.slice(0, MAX_TAGS_PER_POST);
  for (const t of limited) {
    if (!t) continue;
    if (tagImpressionSeen.has(t)) continue;
    tagImpressionSeen.add(t);
    try {
      await bumpInterest(tagKey(t), TAG_DELTA_FROM_IMPRESSION);
    } catch {
      // 静默；IDB 不可用不影响 UI
    }
  }
}

/** 内部辅助：bookmark 路径上 tag 同步累加（失败静默、不去重、每次 +1）。 */
async function bumpTagsFromBookmark(tags: readonly string[]): Promise<void> {
  const limited = tags.slice(0, MAX_TAGS_PER_POST);
  for (const t of limited) {
    if (!t) continue;
    try {
      await bumpInterest(tagKey(t), TAG_DELTA_FROM_BOOKMARK);
    } catch {
      // 静默
    }
  }
}

// ---- M7-8b 信号源拓展：dwell（停留时长）+ skim（连续滑过） ------------------

/**
 * 停留时长每 tick 的毫秒数：用户在 impression（1500ms）触发后，每继续在视口内
 * 停留这么多毫秒，给该 handle 加一次 dwell 增量。
 */
export const DWELL_TICK_MS = 5_000;

/** 每个 dwell tick 加的权重增量（小幅追加，不抢主信号风头） */
export const DWELL_DELTA = 0.1;

/**
 * 单 session 单 handle dwell 增量上限（5 ticks × 0.1 = +0.5），与 impression 同
 * session 去重相互独立。防止用户挂在某帖上无限刷高。
 */
export const MAX_DWELL_TICKS_PER_HANDLE = 5;

/**
 * 连续 skim 阈值：同 handle 累计这么多次「未到 impression 阈值就离开视口」后，
 * 触发一次 skim 负向信号；超过后计数归零，下一轮重新累计。
 */
export const SKIM_THRESHOLD = 3;

/** 单次 skim 负向信号权重增量（负数：从权重里减一点） */
export const SKIM_DELTA = -0.3;

/**
 * 模块级 dwell tick 计数表：handle → 已累计的 tick 数。
 * 与 impressionSeenHandles 同生命周期（session 级，关页清空）。
 */
const dwellTickCount = new Map<string, number>();

/**
 * 模块级 skim 计数表：handle → 当前连续 skim 次数。
 * 达 SKIM_THRESHOLD 时归零，重新累计。
 * 当某 handle 的 impression 真正触发时，也归零（用户开始认真读，前面的 skim 抵消）。
 */
const skimCount = new Map<string, number>();

/**
 * 仅供测试 / 调试：清空 dwell + skim 计数。
 */
export function resetDwellSkimDedup(): void {
  dwellTickCount.clear();
  skimCount.clear();
}

/**
 * 停留时长 tick 信号：每次调用尝试给该 handle +DWELL_DELTA，受 MAX 限制。
 *
 * - 超过上限后静默 no-op（不调 IDB）
 * - 失败（SSR / IDB 不可用）静默
 */
export async function recordDwell(handle: string): Promise<void> {
  if (!handle) return;
  const used = dwellTickCount.get(handle) ?? 0;
  if (used >= MAX_DWELL_TICKS_PER_HANDLE) return;
  dwellTickCount.set(handle, used + 1);
  try {
    await bumpInterest(authorKey(handle), DWELL_DELTA);
  } catch {
    // 静默
  }
}

/**
 * 连续 skim 信号：累计到 SKIM_THRESHOLD 时落地一次 SKIM_DELTA。
 *
 * - 未达阈值时仅累计内存计数，不写 IDB（避免高频 -0.x 信号污染）
 * - 达阈值 → bumpInterest 一次 + 计数清零
 * - 失败静默
 */
export async function recordSkim(handle: string): Promise<void> {
  if (!handle) return;
  const next = (skimCount.get(handle) ?? 0) + 1;
  if (next < SKIM_THRESHOLD) {
    skimCount.set(handle, next);
    return;
  }
  // 触发负向信号 + 计数归零
  skimCount.set(handle, 0);
  try {
    await bumpInterest(authorKey(handle), SKIM_DELTA);
  } catch {
    // 静默
  }
}

/**
 * 给 recordImpression 用的 hook：当某 handle 的 impression 真正落地时，
 * 应当抵消该 handle 此前累计的 skim 计数（用户开始认真读了，之前的滑过不算账）。
 *
 * 由 recordImpression 内部在 bumpInterest 成功后调用，业务侧不需要直接调。
 */
function clearSkimCountFor(handle: string): void {
  skimCount.delete(handle);
}

// ---- M7-8a 衰减 / 截断纯函数 ------------------------------------------------

/**
 * 半衰期衰减：返回新数组，每条 signal 的 weight 走 `raw * 2^(-elapsed_days / halfLife)`。
 *
 * - 纯展示层计算，不写回 IDB（保留原始 signal 精度，避免漂移）
 * - elapsed < 0（系统时钟漂移）按 0 处理（不放大）
 * - halfLife 参数支持未来动态调整，默认走 HALF_LIFE_DAYS
 */
export function decayInterestWeights(
  signals: readonly InterestSignal[],
  now: number,
  halfLife: number = HALF_LIFE_DAYS,
): InterestSignal[] {
  if (signals.length === 0) return [];
  return signals.map((s) => {
    const elapsedMs = now - s.last_updated;
    // 负 elapsed 或零距离：不衰减
    if (elapsedMs <= 0) return { ...s };
    const elapsedDays = elapsedMs / MS_PER_DAY;
    const factor = Math.pow(2, -elapsedDays / halfLife);
    return {
      signal_key: s.signal_key,
      weight: s.weight * factor,
      last_updated: s.last_updated,
    };
  });
}

/**
 * 单作者权重截断：返回新 Map，每个 entry 的 weight 不超过 max。
 *
 * - 零值与负值不动（仅截断正值顶部）
 * - 返回新 Map，不 mutate 输入
 */
export function clampHandleWeights(
  map: ReadonlyMap<string, number>,
  max: number = MAX_AUTHOR_WEIGHT,
): Map<string, number> {
  const result = new Map<string, number>();
  for (const [k, v] of map) {
    result.set(k, v > max ? max : v);
  }
  return result;
}

// ---- 重排算法 ---------------------------------------------------------------

/**
 * 从 `getInterestWeights()` 返回的全量 InterestSignal 列表中，只取 `author:@*` 前缀
 * 的条目，剥前缀得到 handle，建 Map<handle, weight>。
 *
 * 非 author 前缀（未来如 tag:* / domain:*）的信号本步不参与 For-You 重排。
 */
export function buildHandleWeightMap(
  signals: readonly InterestSignal[],
): Map<string, number> {
  const map = new Map<string, number>();
  for (const s of signals) {
    if (!s.signal_key.startsWith(AUTHOR_KEY_PREFIX)) continue;
    const handle = s.signal_key.slice(AUTHOR_KEY_PREFIX.length);
    if (!handle) continue;
    map.set(handle, s.weight);
  }
  return map;
}

/**
 * 从节点 URL 派生 handle（与 PostCard.deriveHandle 同算法，避免循环依赖在此重写一份）。
 *
 * 取 host 主干段（去掉 www. 与 TLD），不可解析时回落原串前 16 字符。
 * 必须与 PostCard.tsx 中的实现保持完全一致，否则权重 key 对不上。
 */
export function deriveHandleFromNodeUrl(url: string): string {
  try {
    const host = new URL(url).host.replace(/^www\./, '');
    const seg = host.split('.')[0] ?? host;
    return seg.slice(0, 16);
  } catch {
    return url.slice(0, 16);
  }
}

/** M9-1-5：负反馈 / 重排权重优先原帖作者 handle（转发帖用 repost_of.author_handle） */
export function feedItemInterestHandle(item: {
  readonly node_url: string;
  readonly post_kind?: 'original' | 'repost';
  readonly repost_of?: { readonly author_handle?: string } | null;
}): string {
  if (item.post_kind === 'repost' && item.repost_of?.author_handle) {
    return item.repost_of.author_handle;
  }
  return deriveHandleFromNodeUrl(item.node_url);
}

/**
 * M7-8c：从 InterestSignal 全量取 `tag:#*` 前缀的条目，剩 prefix 后得 Map<tag, weight>。
 * 与 buildHandleWeightMap 对称；未来可拓展 buildDomainWeightMap 等。
 */
export function buildTagWeightMap(
  signals: readonly InterestSignal[],
): Map<string, number> {
  const map = new Map<string, number>();
  for (const s of signals) {
    if (!s.signal_key.startsWith(TAG_KEY_PREFIX)) continue;
    const tag = s.signal_key.slice(TAG_KEY_PREFIX.length);
    if (!tag) continue;
    map.set(tag, s.weight);
  }
  return map;
}

/**
 * M7-8c：从 content 抽取 hashtag，对每个 tag 查 tagWeights 并求和，作为重排加成。
 * 受 MAX_TAGS_PER_POST 上限；tagWeights 不含的 tag 贡献 0。纯函数。
 */
export function tagBonusForContent(
  content: string | null | undefined,
  tagWeights: ReadonlyMap<string, number>,
): number {
  if (!content || tagWeights.size === 0) return 0;
  const tags = extractTagsFromContent(content);
  let sum = 0;
  for (const t of tags) {
    sum += tagWeights.get(t) ?? 0;
  }
  return sum;
}

/** M7-17：单帖有效权重（author + tagBonus），供增量重排与 memo 复用 */
export function effectiveWeightForItem<
  T extends {
    readonly node_url: string;
    readonly content?: string;
    readonly post_kind?: 'original' | 'repost';
    readonly repost_of?: { readonly author_handle?: string } | null;
  },
>(
  item: T,
  weights: ReadonlyMap<string, number>,
  tagWeights?: ReadonlyMap<string, number>,
): number {
  const handle = feedItemInterestHandle(item);
  const authorW = weights.get(handle) ?? 0;
  const tagBonus = tagWeights ? tagBonusForContent(item.content, tagWeights) : 0;
  return authorW + tagBonus;
}

export type RerankFeedOptions = {
  readonly tagWeights?: ReadonlyMap<string, number>;
  readonly hideThreshold?: number;
};

function splitRerankedByWeight<T extends { readonly post_id: string }>(
  reranked: readonly T[],
  weightByPostId: ReadonlyMap<string, number>,
): { positives: T[]; nonPositive: T[] } {
  const positives: T[] = [];
  const nonPositive: T[] = [];
  for (const item of reranked) {
    const w = weightByPostId.get(item.post_id) ?? 0;
    if (w > 0) positives.push(item);
    else nonPositive.push(item);
  }
  return { positives, nonPositive };
}

function insertPositiveByWeight<T extends { readonly post_id: string }>(
  positives: T[],
  item: T,
  weight: number,
  weightByPostId: Map<string, number>,
): void {
  let insertAt = positives.length;
  for (let i = 0; i < positives.length; i++) {
    const w = weightByPostId.get(positives[i].post_id) ?? 0;
    if (weight > w) {
      insertAt = i;
      break;
    }
  }
  positives.splice(insertAt, 0, item);
}

/**
 * M7-17：append 场景增量重排——仅处理 newItems，与 previousReranked 合并，避免对全量 raw 重算 hashtag。
 */
export function mergeRerankAppend<
  T extends { readonly post_id: string; readonly node_url: string; readonly content?: string },
>(
  previousReranked: readonly T[],
  weightByPostId: Map<string, number>,
  newItems: readonly T[],
  weights: ReadonlyMap<string, number>,
  options?: RerankFeedOptions,
): T[] {
  if (newItems.length === 0) return [...previousReranked];
  const tagWeights = options?.tagWeights;
  const hideThreshold = options?.hideThreshold;
  const { positives, nonPositive } = splitRerankedByWeight(previousReranked, weightByPostId);

  for (const item of newItems) {
    const w = effectiveWeightForItem(item, weights, tagWeights);
    weightByPostId.set(item.post_id, w);
    if (typeof hideThreshold === 'number' && w <= hideThreshold) continue;
    if (w > 0) insertPositiveByWeight(positives, item, w, weightByPostId);
    else nonPositive.push(item);
  }
  return [...positives, ...nonPositive];
}

/** 全量重排后为每条可见帖写入 effectiveWeight memo */
export function buildWeightMemoForItems<
  T extends { readonly post_id: string; readonly node_url: string; readonly content?: string },
>(
  items: readonly T[],
  weights: ReadonlyMap<string, number>,
  tagWeights?: ReadonlyMap<string, number>,
): Map<string, number> {
  const map = new Map<string, number>();
  for (const item of items) {
    map.set(item.post_id, effectiveWeightForItem(item, weights, tagWeights));
  }
  return map;
}

/**
 * 稳定 partition 重排：
 * - weight > 0 的项浮到顶，组内按 weight DESC 排（同权重保持服务器相对时序）
 * - weight <= 0（包括无权重）的项原序保留在下方
 *
 * M7-8c 扩展 options（可选，默认与 M7-8 原行为一致）：
 * - options.tagWeights：Map<tag, weight>，提供后 effectiveWeight = authorWeight + tagBonus
 * - options.hideThreshold：effectiveWeight ≤ 此阈值的项被过滤掉（不仅不浮顶，是从 feed 移除）
 *
 * 输入 items 视为只读；返回新数组。前端展示层重排，不影响服务器分页 cursor。
 */
export function rerankFeedItems<
  T extends {
    readonly node_url: string;
    readonly content?: string;
    readonly source_type?: string;
    readonly post_kind?: 'original' | 'repost';
    readonly repost_of?: { readonly author_handle?: string } | null;
  },
>(
  items: readonly T[],
  weights: Map<string, number>,
  options?: RerankFeedOptions,
): T[] {
  if (items.length === 0) return [];
  const tagWeights = options?.tagWeights;
  const hideThreshold = options?.hideThreshold;
  // 标注原序 + 有效权重（author + tagBonus）
  const annotated = items.map((item, idx) => {
    const handle = feedItemInterestHandle(item);
    const authorW = weights.get(handle) ?? 0;
    const tagBonus = tagWeights ? tagBonusForContent(item.content, tagWeights) : 0;
    return { item, idx, weight: authorW + tagBonus };
  });
  // M7-8c：hideThreshold 存在时过滤 effectiveWeight ≤ 阈值的项
  const visible =
    typeof hideThreshold === 'number'
      // 官方公告是全节点必达信息，不参与“不感兴趣”隐藏过滤。
      ? annotated.filter((a) => a.item.source_type === 'official' || a.weight > hideThreshold)
      : annotated;
  const positive = visible.filter((a) => a.weight > 0);
  const nonPositive = visible.filter((a) => a.weight <= 0);
  // positive 按 weight DESC 排；同权重按原 idx ASC（即服务器相对时序）
  positive.sort((a, b) => {
    if (b.weight !== a.weight) return b.weight - a.weight;
    return a.idx - b.idx;
  });
  // nonPositive 已按原 idx 排（filter 保序），无需再排
  return [...positive.map((a) => a.item), ...nonPositive.map((a) => a.item)];
}

// ---- M7-9b：For-You explainable why（解释卡片） ----------------------------
// ---- M7-9c：解释卡片加位置/排序维度的 reason（M7-11 起 kind='top-pick' 文案「优先展示」，原 M7-9c 命名 first-screen / 文案「首屏推荐」于 M7-11 修正避免与 M7-8c IMPRESSION_DELTA_FIRST_SCREEN 视口前 800px 真首屏曝光信号语义混淆）
// ---- M7-9d：解释卡片加「你常停留」dwell 维度（读 M7-8b session 级 dwellTickCount Map，不读 IDB）

/**
 * 单条推荐理由：discriminated union。
 * - kind='author'：因关注/曝光/点击作者累积出的 author 信号（weight=该 handle author 权重）
 * - kind='tag'：因订阅 hashtag 累积出的 tag 信号（weight=该 tag 权重）
 * - kind='top-pick'（M7-11，原 M7-9c first-screen）：算法位置/排序维度原因 = 重排权重 top-N 的位置；与 M7-8c IMPRESSION_DELTA_FIRST_SCREEN（视口前 800px 真首屏曝光）**完全独立、不互通**；不参与 weight 排序、weight=0 仅作类型占位；文案「优先展示」
 * - kind='dwell'（M7-9d）：停留久信号，M7-8b session 级 dwellTickCount Map 累计达阈话后触发，weight=0 仅作类型占位
 */
export type RankingReason =
  | { readonly kind: 'author'; readonly handle: string; readonly weight: number }
  | { readonly kind: 'tag'; readonly tag: string; readonly weight: number }
  | { readonly kind: 'top-pick'; readonly weight: 0 }
  | { readonly kind: 'dwell'; readonly handle: string; readonly weight: 0 };

/** 一条 item 的推荐理由列表，按贡献权重 DESC 排，截到 MAX_REASONS_PER_POST；top-pick reason 始终 prepend 到首位，dwell reason 次之，后跟 author/tag */
export type Explanation = readonly RankingReason[];

/** 单帖最多展示几条推荐理由（避免解释卡片过长喧宾夺主） */
export const MAX_REASONS_PER_POST = 3;

/**
 * M7-11（原 M7-9c FIRST_SCREEN_POST_COUNT）：默认「重排权重 top-N」帖数（Timeline reranked.slice(0, N) 内的 unique handle 集入 topPickHandles）。
 * 5 是启发式估算：与 Timeline 首屏可见 4~6 条帖相近，但**语义是算法排序位置而非视口可见性**——与 M7-8c IMPRESSION_DELTA_FIRST_SCREEN（视口前 800px 真首屏曝光信号采集）**完全独立**。
 * 调用方可显式传任意 Set 覆盖。
 */
export const TOP_PICK_POST_COUNT = 5;

/**
 * M7-11（原 M7-9c firstScreenHandlesOf）：从重排后的 items 列表的前 N 条中抽出 unique handle Set。
 * Timeline applyForYouRanking 调用后透传给 explainRanking options.topPickHandles。
 * 纯函数、不读 IDB / 不读 storage / 不调 fetch。
 * 语义澄清：返回的是「按 ranking 权重排序后位居前列」的 handle，**不是**「用户视野中实际可见」的 handle。
 */
export function topPickHandlesOf<T extends { readonly node_url: string }>(
  items: readonly T[],
  count: number = TOP_PICK_POST_COUNT,
): Set<string> {
  const handles = new Set<string>();
  const n = Math.max(0, Math.min(count, items.length));
  for (let i = 0; i < n; i++) {
    const it = items[i];
    if (!it) continue;
    const h = deriveHandleFromNodeUrl(it.node_url);
    if (h) handles.add(h);
  }
  return handles;
}

/**
 * M7-9d：「你常停留」触发阈值——session 累计 dwell tick 数 ≥ 该值 → 解释为 dwell reason。
 * 默认 3：3 个 tick × DWELL_TICK_MS(5s/tick) ≈ 连续停留 15s，不太低避免噪声也不太高避免不触发。
 * MAX_DWELL_TICKS_PER_HANDLE=5 是 M7-8b 上限不变；DWELL_REASON_THRESHOLD 仅是展示层门槛。
 */
export const DWELL_REASON_THRESHOLD = 3;

/**
 * M7-9d：读 M7-8b 模块内部 dwellTickCount Map，取 count ≥ threshold 的 handle 集。
 * Timeline applyForYouRanking 调用后透传给 explainRanking options.dwellHandles。
 * 纯函数读模块 state；不读 IDB / 不读 storage / 不调 fetch / 不修改 dwellTickCount。
 * session 级（关页清），与 M7-11 topPickHandlesOf 同语义在 reranking 时点快照。
 */
export function dwellSignificantHandles(
  threshold: number = DWELL_REASON_THRESHOLD,
): Set<string> {
  const handles = new Set<string>();
  for (const [handle, count] of dwellTickCount.entries()) {
    if (count >= threshold) handles.add(handle);
  }
  return handles;
}

/**
 * 给单条 item 算「为什么浮顶」的纯函数推导：
 * - 派生 handle → 取 authorWeights.get(handle)，> 0 加入 reasons（kind='author'）
 * - 从 content 抽取 hashtag → 每个 tag 查 tagWeights，> 0 加入 reasons（kind='tag'）
 * - 按 weight DESC 排，截到 MAX_REASONS_PER_POST
 * - M7-11（原 M7-9c）：若 options.topPickHandles 命中该 handle → prepend kind='top-pick' 到首位
 * - M7-9d：若 options.dwellHandles 命中该 handle → 插入 kind='dwell' 到 top-pick 之后、author/tag 之前
 * - 总长仍 slice 到 MAX_REASONS_PER_POST（保证 top-pick + dwell 位置/状态 reason 优先展示，超出数量时挤掉权重最低的 author/tag）
 *
 * 纯函数，不读 IDB / 不读 storage / 不调 fetch；与 rerankFeedItems 完全独立的解释 pass。
 * weight ≤ 0 不返回（不解释负反馈/隐藏作者），与 rerankFeedItems 浮顶逻辑（weight>0）对齐。
 * options 参数本身可选，M7-9b 三参调用 + M7-11 仅传 topPickHandles 四参调用 0 变更。
 */
export function explainRanking<
  T extends { readonly node_url: string; readonly content?: string },
>(
  item: T,
  authorWeights: ReadonlyMap<string, number>,
  tagWeights: ReadonlyMap<string, number>,
  options?: {
    readonly topPickHandles?: ReadonlySet<string>;
    readonly dwellHandles?: ReadonlySet<string>;
  },
): Explanation {
  const reasons: RankingReason[] = [];
  const handle = deriveHandleFromNodeUrl(item.node_url);
  const authorW = authorWeights.get(handle) ?? 0;
  if (authorW > 0) {
    reasons.push({ kind: 'author', handle, weight: authorW });
  }
  if (item.content && tagWeights.size > 0) {
    const tags = extractTagsFromContent(item.content);
    for (const t of tags) {
      const w = tagWeights.get(t) ?? 0;
      if (w > 0) {
        reasons.push({ kind: 'tag', tag: t, weight: w });
      }
    }
  }
  reasons.sort((a, b) => b.weight - a.weight);
  // M7-11/9d：位置/状态 reason 不参与权重排序，prepend 到前，总长仍 ≤ MAX_REASONS_PER_POST
  // 顺序：top-pick → dwell → author/tag（按 weight DESC）
  const prepends: RankingReason[] = [];
  if (handle && options?.topPickHandles?.has(handle)) {
    prepends.push({ kind: 'top-pick', weight: 0 });
  }
  if (handle && options?.dwellHandles?.has(handle)) {
    prepends.push({ kind: 'dwell', handle, weight: 0 });
  }
  if (prepends.length > 0) {
    return [...prepends, ...reasons].slice(0, MAX_REASONS_PER_POST);
  }
  return reasons.slice(0, MAX_REASONS_PER_POST);
}

// ---- M7-8b 衰减状态周期 persist ---------------------------------------------

/**
 * Compact 写回的最小保留阈值：衰减后权重的绝对值低于这个数就主动删除该条信号。
 *
 * 0.1：约等于 1 个印象（+0.2）半衰期一次（5 天）后的水平，再衰减一轮已无展示
 * 价值，从 IDB 主动剔除避免 store 无限膨胀。负权重同样按绝对值判断。
 */
export const MIN_PERSIST_WEIGHT = 0.1;

/**
 * Compact 周期：两次 persist 写回的最小间隔（24 小时）。
 *
 * Compact 是数据维护路径（不参与 M7-8a 重排计算），由 Timeline mount 顺便触发，
 * 距上次 < 24h 直接 skip，避免每次刷新都写一波 IDB。
 */
export const COMPACT_INTERVAL_MS = 86_400_000;

/** localStorage 上次 compact 时间戳 key（与 hailuo:for-you-ranking 同命名空间） */
export const COMPACT_STORAGE_KEY = 'hailuo:for-you-compact-last-ms';

/**
 * Compact 周期写回：读全量 → 用 M7-8a decayInterestWeights 算衰减 →
 * 极小权重（|w| < MIN_PERSIST_WEIGHT）调 deleteInterestSignal 清掉；
 * 其余调 setInterestSignal 写回 { signal_key, weight: 衰减后, last_updated: now }。
 *
 * 写完后 raw 即「已 compact 到 now 的衰减后值」，下次 bumpInterest 在此基础上 +delta
 * 并把 last_updated 重置为新 Date.now()，语义自洽。
 *
 * - 与 M7-8a applyForYouRanking 计算路径**完全独立**：Timeline 重排时仍按 raw 即时
 *   走 decayInterestWeights（精度损失只取自一次衰减，不会被 compact 重复折扣）。
 * - 失败（SSR / IDB 不可用）静默；返回 { updated: 0, deleted: 0 }。
 */
export async function compactInterestWeights(
  now: number,
): Promise<{ updated: number; deleted: number }> {
  let updated = 0;
  let deleted = 0;
  try {
    const signals = await getInterestWeights();
    if (signals.length === 0) return { updated: 0, deleted: 0 };
    const decayed = decayInterestWeights(signals, now);
    for (const s of decayed) {
      if (Math.abs(s.weight) < MIN_PERSIST_WEIGHT) {
        try {
          await deleteInterestSignal(s.signal_key);
          deleted += 1;
        } catch {
          // 单条删除失败：静默，下次 compact 再清
        }
        continue;
      }
      try {
        await setInterestSignal({
          signal_key: s.signal_key,
          weight: s.weight,
          last_updated: now,
        });
        updated += 1;
      } catch {
        // 单条写回失败：静默，raw 保持，下次重排仍按原始 last_updated 算
      }
    }
  } catch {
    // 读全量失败：静默
  }
  return { updated, deleted };
}

/**
 * 视情况执行 compact：距上次 < COMPACT_INTERVAL_MS 就跳过；否则跑一遍并刷新时间戳。
 *
 * 由 Timeline mount 顺便触发，无任何 UI 反馈；SSR / 隐身模式静默 no-op。
 *
 * 返回值：`{ ran: true|false, result?: {...} }`，主要供测试断言使用。
 */
export async function maybeCompactInterestWeights(
  now: number = Date.now(),
): Promise<{ ran: boolean; updated: number; deleted: number }> {
  if (typeof window === 'undefined' || typeof window.localStorage === 'undefined') {
    return { ran: false, updated: 0, deleted: 0 };
  }
  let lastMs = 0;
  try {
    const raw = window.localStorage.getItem(COMPACT_STORAGE_KEY);
    if (raw !== null) {
      const parsed = Number.parseInt(raw, 10);
      if (Number.isFinite(parsed)) lastMs = parsed;
    }
  } catch {
    // 读 localStorage 失败：当作首次跑
  }
  if (now - lastMs < COMPACT_INTERVAL_MS) {
    return { ran: false, updated: 0, deleted: 0 };
  }
  const result = await compactInterestWeights(now);
  try {
    window.localStorage.setItem(COMPACT_STORAGE_KEY, String(now));
  } catch {
    // 隐身模式 setItem 抛 QuotaExceededError；静默（下次还会重跑，幂等）
  }
  return { ran: true, updated: result.updated, deleted: result.deleted };
}
