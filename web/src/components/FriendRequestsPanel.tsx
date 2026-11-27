/** @jsxImportSource preact */
/**
 * M17-2：待处理加好友请求面板（设置折叠区复用）
 *
 * REL-FIX-11：接收侧「已投递但对方未读/未知」可感知 —— 本面板是接收侧可见性的落点：
 *   ① `status=resolved` 段：已 accept / reject 但**回执未确认送达对方**的行
 *      （对方仍在干等）—— 与发起侧 REL-FIX-4 的 `FriendDeliveryBadge` 严格对称。
 *   ② 面板标题旁的未读角标（pending 数）—— 对齐 REL-FIX-5 群主待审批角标做法。
 *   ③ 撤回通知：`friend_request_withdrawn` 让发起方自己也能看到「我撤回了」。
 */
import type { VNode } from 'preact';
import { useCallback, useEffect, useState } from 'preact/hooks';
import { getOwnerJwt, getWorkerAUrl } from '../lib/auth';
import { createWorkerAClient, type FriendRequestItem } from '../lib/workerA';
import { unreadFriendRequestCount } from '../lib/friendRequestUnreadStore';
import { ApiError } from '../lib/errors';
import { t } from '../lib/i18n';
import { formatRelativeTime } from '../lib/timeFormat';
import { showToast } from '../lib/toast';
import { FriendRequestButton } from './FriendRequestButton';
import { FriendAcceptConfirmDialog } from './FriendAcceptConfirmDialog';
import { FriendDeliveryBadge } from './FriendDeliveryBadge';
import { FriendReceiptBadge } from './FriendReceiptBadge';
import { ShieldAlert, ShieldCheck } from 'lucide-preact';
import { groupFriendRequestsByDecision, type FriendRequestDecisionGroups } from '../lib/friendRequestDecision';

interface Props {
  readonly compact?: boolean;
  /** UX-MSG-LEFT-1：请求被同意/拒绝后通知父级刷新好友列表（左栏常驻时不会重新挂载） */
  readonly onChanged?: () => void;
}

function formatNodeHostname(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    return parsed.host;
  } catch {
    return rawUrl;
  }
}

function makeClient() {
  const baseUrl = getWorkerAUrl();
  const jwt = getOwnerJwt();
  if (!baseUrl || !jwt) return null;
  return createWorkerAClient({ baseUrl, getJwt: getOwnerJwt });
}

export function FriendRequestsPanel({ compact = false, onChanged }: Props): VNode {
  const [incoming, setIncoming] = useState<readonly FriendRequestItem[]>([]);
  const [outgoing, setOutgoing] = useState<readonly FriendRequestItem[]>([]);
  /**
   * REL-FIX-11：已处理但回执未确认送达对方的入站行。
   * 单独一段，不与 pending 混排 —— 语义不同（一个是「等我处理」，一个是「对方在等结果」）。
   */
  const [unconfirmed, setUnconfirmed] = useState<readonly FriendRequestItem[]>([]);
  /**
   * REL-FIX-14 backlog ④：已撤回（cancelled）的发出请求 —— 可重新发起。
   *
   * 现状缺口：撤回后该行 `status='cancelled'`，不在 outgoing/pending 列表里 →
   * 面板完全不显示；站主要加回某人只能去对方主页重走一遍。
   * 后端并不拦着重发：UNIQUE 部分索引只挡 `status='pending'`（`insertRequest`），
   * cancelled 行直接 `sendFriendRequest` 即可，无需先撤回 → 纯 UI 层缺入口。
   *
   * 只查 outgoing（本端发出的）；incoming 的 cancelled 是「对方撤回了发给我的」，
   * 重发语义是对方的事，不归本站入口管。
   */
  const [withdrawn, setWithdrawn] = useState<readonly FriendRequestItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [acceptTarget, setAcceptTarget] = useState<FriendRequestItem | null>(null);
  /** REL-FIX-11：未读角标计数（后端 pending_count，与列表同一次响应返回） */
  const [pendingCountFromServer, setPendingCount] = useState(0);
  /**
   * REL-FIX-11：撤回深链高亮目标（`/messages?tab=contacts&request=<fr_id>`）。
   *
   * 场景：站主在通知中心看到「你已撤回发给 @x 的加好友请求」→ 点「查看」→ 应直达
   * 通讯录面板里那条**已撤回**的「发出的请求」行。
   *
   * 难点：撤回后该行 status='cancelled'，**不在** outgoing/pending 列表里 →
   * 必须额外查一次 outgoing/cancelled 才能定位到它。
   */
  const [deepLinkRequestId] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null;
    const raw = new URLSearchParams(window.location.search).get('request');
    return raw && raw.trim() !== '' ? raw.trim() : null;
  });
  /** 深链命中的撤回行（用于高亮渲染）。 */
  const [withdrawnFocus, setWithdrawnFocus] = useState<FriendRequestItem | null>(null);

  const reload = useCallback(async () => {
    const client = makeClient();
    if (!client) {
      setError(t('ownerConfigureWriteLayer'));
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const [inRes, outRes, resolvedRes, cancelledRes, mutualRes] = await Promise.all([
        client.listFriendRequests({ direction: 'incoming', status: 'pending', limit: 30 }),
        client.listFriendRequests({ direction: 'outgoing', status: 'pending', limit: 30 }),
        // REL-FIX-11：已处理但回执未确认送达对方的入站行。
        // 该模式只在 incoming 有意义（outgoing 用它会撒谎，后端也显式 400）→ 这里只查 incoming。
        client.listFriendRequests({ direction: 'incoming', status: 'resolved', limit: 30 }),
        // REL-FIX-14 backlog ④：已撤回的发出请求（本端发出的 → 可重新发起）。
        // fail-soft（见下方）：拉失败 → 本段隐藏，其余三段不受影响。
        client.listFriendRequests({ direction: 'outgoing', status: 'cancelled', limit: 30 }),
        // UX-MSG-LEFT-1：已是好友的人不再提示加好友（含已撤回历史行）。
        // fail-soft：互粉列表拉不到就不过滤，绝不阻断请求面板本身。
        client.listMutualFollows().catch(() => null),
      ]);
      // 已是好友的 handle 快照（handle 由全域短名占用权威，跨节点唯一）
      const friendHandles = new Set(
        (mutualRes?.items ?? [])
          .map((f) => f.handle.trim().toLowerCase())
          .filter((h) => h.length > 0),
      );
      const isAlreadyFriend = (handle: string): boolean =>
        friendHandles.has(handle.trim().toLowerCase());

      const incomingVisible = inRes.items.filter((item) => !isAlreadyFriend(item.origin_handle));
      const outgoingVisible = outRes.items.filter((item) => !isAlreadyFriend(item.target_handle));
      const resolvedVisible = resolvedRes.items.filter(
        (item) => !isAlreadyFriend(item.origin_handle),
      );
      const cancelledVisible = cancelledRes.items.filter(
        (item) => !isAlreadyFriend(item.target_handle),
      );

      setIncoming(incomingVisible);
      setOutgoing(outgoingVisible);
      setUnconfirmed(resolvedVisible);
      // 后端按 created_at 倒序；撤回行的「操作时间」是 cancelled_at ——
      // 前端按 `cancelled_at ?? created_at` 再排一次（单页 ≤30 行，零成本），
      // 让「刚撤回的」排最前，站主最可能想加回的就是它。
      setWithdrawn(
        [...cancelledVisible].sort((a, b) =>
          (b.cancelled_at ?? b.created_at).localeCompare(a.cancelled_at ?? a.created_at),
        ),
      );
      // 角标取入站 pending 数（等本端处理的数量）—— 与 outRes 的 pending_count 无关。
      const count = inRes.pending_count ?? inRes.items.length;
      // 已是好友的行已被隐藏：后端 COUNT 仍包含它们 → 从角标里扣掉，避免「点进去什么都没有」
      const hiddenIncoming = inRes.items.length - incomingVisible.length;
      const visibleCount = Math.max(0, count - hiddenIncoming);
      setPendingCount(visibleCount);
      // REL-FIX-11 复核修复：同步通讯录 Tab 红点。
      // 面板内 accept / reject 后会走本 reload()，但 unreadFriendRequestCount 原本
      // 只由 ownerUnreadStore 每 60s 轮询写 → 站主在面板里处理完，Tab 红点最长滞留 1 分钟，
      // 造成「操作没生效」的错觉。此处就地同步，口径与 friendRequestUnreadStore
      // 的 refreshUnreadFriendRequestCount 完全一致（incoming + status=pending 的 pending_count，
      // 并扣除「已经是好友」被隐藏的行）。
      unreadFriendRequestCount.value = visibleCount;

      // REL-FIX-14 backlog ④：撤回深链定位**复用**新增的 `withdrawn` 列表 ——
      // 不再单独发一次 outgoing/cancelled 查询（REL-FIX-14 前是独立查 `limit: 50`）。
      // 同一次 reload 的 30 行内命中 → 高亮；30 行外未命中 → 静默不渲染
      // （与深链「群不在本节点 → 静默忽略」的既有 fail-soft 口径一致）。
      // UX-MSG-LEFT-1：深链命中的行若已是好友 → 不再显示「加好友」入口。
      if (deepLinkRequestId) {
        const focus = cancelledRes.items.find((row) => row.id === deepLinkRequestId) ?? null;
        setWithdrawnFocus(focus && !isAlreadyFriend(focus.target_handle) ? focus : null);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.displayMessage : t('friendUriInvalid'));
    } finally {
      setLoading(false);
    }
  }, [deepLinkRequestId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function accept(id: string): Promise<void> {
    const client = makeClient();
    if (!client) return;
    setBusyId(id);
    try {
      await client.acceptFriendRequest(id);
      showToast(t('friendAccept'));
      await reload();
      // 好友列表在左栏常驻，不会自动重挂 → 显式通知父级重新拉互粉列表
      onChanged?.();
    } catch (err) {
      showToast(err instanceof ApiError ? err.displayMessage : t('friendUriInvalid'), 'error');
    } finally {
      setBusyId(null);
    }
  }

  async function reject(id: string): Promise<void> {
    const client = makeClient();
    if (!client) return;
    setBusyId(id);
    try {
      await client.rejectFriendRequest(id);
      showToast(t('friendReject'));
      await reload();
      onChanged?.();
    } catch (err) {
      showToast(err instanceof ApiError ? err.displayMessage : t('friendUriInvalid'), 'error');
    } finally {
      setBusyId(null);
    }
  }

  /**
   * REL-FIX-11：角标数 = **入站 pending 数**（等本端处理的数量）。
   *
   * 注意与旧的 `incoming.length + outgoing.length` 的区别：
   * 旧口径把「我发出去、等对方的」也算进「待处理」→ 角标高估、且点进去发现无事可做。
   * 新口径只用后端 `pending_count`（入站），语义 = 「有多少人在等我回应」。
   */
  const pendingCount = pendingCountFromServer;

  /**
   * REL-FIX-14 backlog ③ / REL-FIX-12：把「已处理 · 对方尚未收到回执」
   * 按**我同意了 / 我拒绝了**分组。
   *
   * 后端 `items` 已经带 `status` 字段 → 前端零成本。
   * 分组后站主能看清对方到底在等什么：
   *   - 对方在等「同意」→ 等待还有意义（我还在考虑）；
   *   - 对方在等「拒绝」→ 若最终 giveup，对方的等待**毫无意义**。
   *
   * `other` 是兜底桶：后端将来放宽 `resolved` 过滤时未知的 status **不得被丢弃**
   * （丢行会让站主误以为「所有回执都已送达」）。
   */
  const unconfirmedGroups: FriendRequestDecisionGroups<FriendRequestItem> =
    groupFriendRequestsByDecision(unconfirmed);

  // REL-FIX-14 backlog ④：「已撤回」段与深链行的去重视图。
  // 同一逻辑行深链命中时只在深链段渲染，本段跳过 → 同一行不同时出现两次。
  // 同一目标（target_node_url + target_handle）多次撤回只保留最新一条，避免列表堆重复。
  function withdrawnVisible(): readonly FriendRequestItem[] {
    const base = withdrawnFocus
      ? withdrawn.filter((item) => item.id !== withdrawnFocus.id)
      : withdrawn;
    const sorted = [...base].sort((a, b) =>
      (b.cancelled_at ?? b.created_at).localeCompare(a.cancelled_at ?? a.created_at),
    );
    const seen = new Set<string>();
    const out: FriendRequestItem[] = [];
    for (const item of sorted) {
      const key = `${item.target_node_url}::${item.target_handle}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(item);
    }
    return out;
  }
  return (
    <section
      class={compact ? 'mt-3 space-y-3' : 'space-y-4'}
      data-testid="friend-requests-panel"
      aria-label={t('friendRequestsPanelTitle')}
    >
      <div class="flex items-center justify-between gap-2">
        <h3 class="text-sm font-semibold text-zinc-900 dark:text-zinc-50">
          {t('friendRequestsPanelTitle')}
          {pendingCount > 0 && (
            <span class="ml-2 text-xs font-normal text-zinc-500 dark:text-zinc-400">
              {t('friendPendingCount', undefined, { count: pendingCount })}
            </span>
          )}
        </h3>
        <button
          type="button"
          class="text-xs font-medium text-sky-600 hover:underline dark:text-sky-400"
          onClick={() => void reload()}
          disabled={loading}
        >
          {t('rightRailRegistryRefresh')}
        </button>
      </div>

      {error && (
        <p class="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-200" role="alert">
          {error}
        </p>
      )}

      {loading && <p class="text-xs text-zinc-500 dark:text-zinc-400">{t('notificationsLoading')}</p>}

      {/* REL-FIX-11 复核修复：空态只在**所有分组都为空**时才显示。
          旧条件是 `pendingCount === 0 && incoming.length === 0`，而 pendingCount 现在
          只等于「入站 pending 数」→ 仅有 outgoing pending / 仅有「已处理但回执未确认」/
          仅深链命中撤回行时，会同时出现「暂无待处理请求」与下方列表，自相矛盾。
          注：pendingCount 与 incoming.length 同一维度同一 status，本就冗余，
          且 pending_count 是全量 COUNT、items 是 limit 截断，故不再作为判空依据。 */}
      {!loading &&
        incoming.length === 0 &&
        outgoing.length === 0 &&
        unconfirmed.length === 0 &&
        withdrawn.length === 0 &&
        !withdrawnFocus && (
          <p class="text-xs text-zinc-500 dark:text-zinc-400">{t('friendRequestsEmpty')}</p>
        )}

      {!loading && incoming.length > 0 && (
        <div>
          <p class="mb-2 text-xs font-medium text-zinc-500 dark:text-zinc-400">
            {t('friendRequestsIncoming')} ({incoming.length})
          </p>
          <ul class="divide-y divide-zinc-200 dark:divide-zinc-800">
            {incoming.map((item) => (
              <li key={item.id} class="flex flex-wrap items-center justify-between gap-2 py-2">
                <div class="min-w-0">
                  <div class="flex flex-wrap items-center gap-1.5">
                    <p class="truncate text-sm font-medium text-zinc-900 dark:text-zinc-50">
                      @{item.origin_handle}
                      {item.origin_display_name ? (
                        <span class="ml-1 font-normal text-zinc-500">· {item.origin_display_name}</span>
                      ) : null}
                    </p>
                    {item.first_seen === false ? (
                      <span
                        class="inline-flex items-center gap-1 rounded-full border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-800 dark:border-emerald-700/60 dark:bg-emerald-950/40 dark:text-emerald-300"
                        data-testid="friend-pinned-badge"
                        title="来源节点公钥与本地关注 Pin 一致，已通过身份核验"
                      >
                        <ShieldCheck size={10} aria-hidden="true" />
                        已验证公钥
                      </span>
                    ) : (
                      <span
                        class="inline-flex items-center gap-1 rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-800 dark:border-amber-700/60 dark:bg-amber-950/40 dark:text-amber-300"
                        data-testid="friend-unverified-badge"
                        title={t('friendUnverifiedFirstContactNotice')}
                      >
                        <ShieldAlert size={10} aria-hidden="true" />
                        {t('friendUnverifiedFirstContact')}
                      </span>
                    )}
                  </div>
                  <p class="mt-0.5 truncate text-[11px] text-zinc-400 font-mono" title={item.origin_node_url}>
                    {formatNodeHostname(item.origin_node_url)}
                  </p>
                  {item.message && (
                    <p class="mt-0.5 truncate text-xs text-zinc-500 dark:text-zinc-400">{item.message}</p>
                  )}
                  <p class="mt-0.5 text-[11px] text-zinc-400">{formatRelativeTime(item.created_at)}</p>
                </div>
                <div class="flex shrink-0 gap-2">
                  <button
                    type="button"
                    disabled={busyId === item.id}
                    class="rounded-full bg-sky-600 px-3 py-1 text-xs font-semibold text-white hover:bg-sky-700 disabled:cursor-not-allowed disabled:opacity-50"
                    onClick={() => setAcceptTarget(item)}
                    data-testid="friend-request-accept"
                  >
                    {t('friendAccept')}
                  </button>
                  <button
                    type="button"
                    disabled={busyId === item.id}
                    class="rounded-full border border-zinc-300 px-3 py-1 text-xs font-semibold text-zinc-700 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-200"
                    onClick={() => void reject(item.id)}
                  >
                    {t('friendReject')}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {!loading && outgoing.length > 0 && (
        <div>
          <p class="mb-2 text-xs font-medium text-zinc-500 dark:text-zinc-400">
            {t('friendRequestsOutgoing')} ({outgoing.length})
          </p>
          <ul class="divide-y divide-zinc-200 dark:divide-zinc-800">
            {outgoing.map((item) => (
              <li key={item.id} class="flex flex-wrap items-center justify-between gap-2 py-2">
                <div class="min-w-0">
                  <p class="truncate text-sm font-medium text-zinc-900 dark:text-zinc-50">
                    @{item.target_handle}
                  </p>
                  <p class="mt-0.5 truncate text-[11px] text-zinc-400">{item.target_node_url}</p>
                  {/* REL-FIX-4：投递回执（已送达 / 重试中 / 对方可能未收到） */}
                  <FriendDeliveryBadge
                    inbox_status={item.inbox_status}
                    inbox_error={item.inbox_error}
                    showHint
                  />
                  <p class="mt-0.5 text-[11px] text-zinc-400">{formatRelativeTime(item.created_at)}</p>
                </div>
                <FriendRequestButton
                  target_node_url={item.target_node_url}
                  target_handle={item.target_handle}
                  relation="outgoing_pending"
                  request_id={item.id}
                  delivery_status={item.inbox_status}
                  delivery_error={item.inbox_error}
                  message={item.message}
                  // REL-FIX-13：左侧已渲染投递徽章 → 按钮侧不再重复渲染
                  showDeliveryBadge={false}
                  onChanged={() => void reload()}
                />
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* REL-FIX-11：接收侧「已处理但回执未确认送达对方」段。
          语义：这些请求我已经同意/拒绝了，但**对方还没收到我的回应** → 对方仍在干等。
          与发起侧的 REL-FIX-4 投递徽章严格对称 —— 好友链路两端都能感知「对方确没确认」。

          REL-FIX-14 backlog ③：段内按**我同意了 / 我拒绝了**再分两组。
          否则站主只看到「对方尚未收到回执」，分不清对方是在等「同意」还是等「拒绝」；
          若最终 giveup（24h 放弃），对方的等待其实是**毫无意义**的。 */}
      {!loading && unconfirmed.length > 0 && (
        <div data-testid="friend-requests-unconfirmed-section">
          <p class="mb-2 text-xs font-medium text-zinc-500 dark:text-zinc-400">
            {t('friendRequestsResolvedTitle')} ({unconfirmed.length})
          </p>

          {/* 我已同意：对方在等「我接受了」这个结果 */}
          {unconfirmedGroups.accepted.length > 0 && (
            <div data-testid="friend-requests-unconfirmed-accepted">
              <p class="mb-1 text-[11px] font-medium text-zinc-500 dark:text-zinc-400">
                {t('friendRequestsResolvedAcceptedTitle')} ({unconfirmedGroups.accepted.length})
              </p>
              <ul class="divide-y divide-zinc-200 dark:divide-zinc-800">
                {unconfirmedGroups.accepted.map((item) => (
                  <li key={item.id} class="flex flex-wrap items-center justify-between gap-2 py-2">
                    <div class="min-w-0">
                      <p class="truncate text-sm font-medium text-zinc-900 dark:text-zinc-50">
                        @{item.origin_handle}
                        {item.origin_display_name ? (
                          <span class="ml-1 font-normal text-zinc-500">· {item.origin_display_name}</span>
                        ) : null}
                      </p>
                      <p class="mt-0.5 truncate text-[11px] text-zinc-400 font-mono" title={item.origin_node_url}>
                        {formatNodeHostname(item.origin_node_url)}
                      </p>
                      {/* REL-FIX-11：回执状态（我回的结果，对方知不知道） */}
                      <FriendReceiptBadge
                        outbox_status={item.outbox_status}
                        outbox_error={item.outbox_error}
                        showHint
                      />
                      <p class="mt-0.5 text-[11px] text-zinc-400">{formatRelativeTime(item.created_at)}</p>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* 我已拒绝：对方在等「我拒绝了」这个结果 */}
          {unconfirmedGroups.rejected.length > 0 && (
            <div data-testid="friend-requests-unconfirmed-rejected">
              <p class="mb-1 text-[11px] font-medium text-zinc-500 dark:text-zinc-400">
                {t('friendRequestsResolvedRejectedTitle')} ({unconfirmedGroups.rejected.length})
              </p>
              <ul class="divide-y divide-zinc-200 dark:divide-zinc-800">
                {unconfirmedGroups.rejected.map((item) => (
                  <li key={item.id} class="flex flex-wrap items-center justify-between gap-2 py-2">
                    <div class="min-w-0">
                      <p class="truncate text-sm font-medium text-zinc-900 dark:text-zinc-50">
                        @{item.origin_handle}
                        {item.origin_display_name ? (
                          <span class="ml-1 font-normal text-zinc-500">· {item.origin_display_name}</span>
                        ) : null}
                      </p>
                      <p class="mt-0.5 truncate text-[11px] text-zinc-400 font-mono" title={item.origin_node_url}>
                        {formatNodeHostname(item.origin_node_url)}
                      </p>
                      {/* REL-FIX-11：回执状态（我回的结果，对方知不知道） */}
                      <FriendReceiptBadge
                        outbox_status={item.outbox_status}
                        outbox_error={item.outbox_error}
                        showHint
                      />
                      <p class="mt-0.5 text-[11px] text-zinc-400">{formatRelativeTime(item.created_at)}</p>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* 兜底桶：后端若将来放宽 resolved 过滤，未知 status **不得被静默丢弃**
              （丢行会让站主误以为「所有回执都已送达」）。 */}
          {unconfirmedGroups.other.length > 0 && (
            <div data-testid="friend-requests-unconfirmed-other">
              <p class="mb-1 text-[11px] font-medium text-zinc-500 dark:text-zinc-400">
                {t('friendRequestsResolvedOtherTitle')} ({unconfirmedGroups.other.length})
              </p>
              <ul class="divide-y divide-zinc-200 dark:divide-zinc-800">
                {unconfirmedGroups.other.map((item) => (
                  <li key={item.id} class="flex flex-wrap items-center justify-between gap-2 py-2">
                    <div class="min-w-0">
                      <p class="truncate text-sm font-medium text-zinc-900 dark:text-zinc-50">
                        @{item.origin_handle}
                      </p>
                      <FriendReceiptBadge
                        outbox_status={item.outbox_status}
                        outbox_error={item.outbox_error}
                        showHint
                      />
                      <p class="mt-0.5 text-[11px] text-zinc-400">{formatRelativeTime(item.created_at)}</p>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {/* REL-FIX-11：撤回深链命中的「已撤回」行（发出的请求方向）。
          该行 status='cancelled'，不在 pending 列表里 → 单独渲染并高亮，
          让站主从通知点进来能一眼看到「我撤回了哪一条、对方收到没」。

          REL-FIX-14 backlog ④：与下方「已撤回 · 可重新发起」段去重 ——
          同一行深链命中时只在这里渲染，不在列表段重复显示。 */}
      {!loading && withdrawnFocus && (
        <div data-testid="friend-requests-withdrawn-focus">
          <ul class="divide-y divide-zinc-200 dark:divide-zinc-800">
            <li
              class="rounded-lg border border-amber-300 bg-amber-50/60 px-2 py-2 dark:border-amber-800 dark:bg-amber-950/20"
              data-testid="friend-request-withdrawn-row"
            >
              <p class="truncate text-sm font-medium text-zinc-900 dark:text-zinc-50">
                @{withdrawnFocus.target_handle}
              </p>
              <p class="mt-0.5 text-[11px] text-zinc-500 dark:text-zinc-400">
                {t('friendRequestWithdrawnBody', undefined, {
                  handle: withdrawnFocus.target_handle,
                })}
              </p>
              <p class="mt-0.5 text-[11px] text-zinc-400">
                {formatRelativeTime(withdrawnFocus.cancelled_at ?? withdrawnFocus.created_at)}
              </p>
            </li>
          </ul>
        </div>
      )}

      {/* REL-FIX-14 backlog ④：「已撤回 · 可重新发起」段。
          语义：这些请求是本端主动撤回的（status='cancelled'，不在 pending 列表里），
          站主想加回对方 → 每行给一个加好友入口（`FriendRequestButton relation="unknown"` →
          走既有发送弹窗 + 附言，不沿用旧附言，原因见下方）。
          后端并不拦着重发：UNIQUE 部分索引只挡 `status='pending'`（`insertRequest`），
          cancelled 行直接发起即可 → 纯 UI 层入口，不新增后端逻辑。

          深链去重：`withdrawnFocus` 命中的行只在上方深链段渲染，
          本段跳过（用 id 比对）→ 同一行不同时出现在两处。 */}
      {!loading && withdrawn.length > 0 && (
        <div data-testid="friend-requests-withdrawn-section">
          <p class="mb-2 text-xs font-medium text-zinc-500 dark:text-zinc-400">
            {t('friendRequestsWithdrawnTitle')} ({withdrawnVisible().length})
          </p>
          <ul class="divide-y divide-zinc-200 dark:divide-zinc-800">
            {withdrawnVisible().map((item) => (
              <li key={item.id} class="flex flex-wrap items-center justify-between gap-2 py-2">
                <div class="min-w-0">
                  <p class="truncate text-sm font-medium text-zinc-900 dark:text-zinc-50">
                    @{item.target_handle}
                  </p>
                  {/* 防身份关联：只显脱敏 hostname（与 outgoing 段同口径），
                      不回显 `target_node_url` 原文。 */}
                  <p class="mt-0.5 truncate text-[11px] text-zinc-400 font-mono" title={item.target_node_url}>
                    {formatNodeHostname(item.target_node_url)}
                  </p>
                  <p class="mt-0.5 text-[11px] text-zinc-400">
                    {formatRelativeTime(item.cancelled_at ?? item.created_at)}
                  </p>
                </div>
                {/* ⚠️ 不传 `message`：重发弹窗让站主**重新写附言**。
                    旧附言是撤回前的语境（可能已经过时）；且 send() 本就不预填，
                    传了无意义还误导「沿用原附言」。 */}
                <FriendRequestButton
                  target_node_url={item.target_node_url}
                  target_handle={item.target_handle}
                  relation="unknown"
                  onChanged={() => void reload()}
                />
              </li>
            ))}
          </ul>
        </div>
      )}

      {acceptTarget && (
        <FriendAcceptConfirmDialog
          open={Boolean(acceptTarget)}
          pending={busyId === acceptTarget.id}
          handle={acceptTarget.origin_handle}
          nodeUrl={acceptTarget.origin_node_url}
          firstSeen={acceptTarget.first_seen}
          onCancel={() => {
            if (!busyId) setAcceptTarget(null);
          }}
          onConfirm={async () => {
            const target = acceptTarget;
            if (!target) return;
            await accept(target.id);
            setAcceptTarget(null);
          }}
        />
      )}
    </section>
  );
}
