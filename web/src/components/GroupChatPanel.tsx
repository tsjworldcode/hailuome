/** @jsxImportSource preact */
import { AlertCircle, ChevronLeft, Loader2, MessageSquare, Paperclip, Settings, Users } from 'lucide-preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { RefObject } from 'preact';
import type { GroupMemberItem, LocalGroupItem } from '../lib/workerA';
import type { GroupPlaintextRecord } from '../lib/groupLocalDb';
import { formatRelativeTime } from '../lib/timeFormat';
import { t } from '../lib/i18n';

/** M-RT-3：滚到"接近底部"的容差阈值（像素），超出则视为用户已向上翻看历史。 */
const GROUP_BOTTOM_THRESHOLD_PX = 80;
/** M-RT-3：滚到接近顶部时触发"加载更早"的容差阈值（像素）。 */
const GROUP_TOP_THRESHOLD_PX = 80;

/** M-RT-3：群聊发送中 / 失败占位（不入 IDB）。 */
export interface GroupPendingOutbox {
  readonly tempId: string;
  readonly groupId: string;
  readonly senderHandle: string;
  readonly plaintext: string;
  readonly createdAt: string;
  readonly imagePreviewUrl: string | null;
  status: 'sending' | 'failed';
  readonly input: SendGroupInputLike;
}

/** M-RT-3：群聊重发输入（保留 groupId/ownerWorkerBUrl/epoch/passwordHash 等核心参数）。 */
export interface SendGroupInputLike {
  readonly client: import('../lib/workerA').WorkerAClient;
  readonly passwordHash: string;
  readonly senderHandle: string;
  /** GRP-NICKNAME-1：重试时沿用发送时的群昵称。 */
  readonly senderNickname?: string;
  readonly senderWorkerBUrl: string;
  readonly groupId: string;
  readonly ownerWorkerBUrl: string;
  readonly epoch: number;
  readonly imageFile?: File | null;
}

export interface GroupChatPanelProps {
  readonly group: LocalGroupItem | null;
  readonly messages: readonly GroupPlaintextRecord[];
  /** M-RT-3：发送中 / 失败占位（来自 GroupsChat）。 */
  readonly pending?: readonly GroupPendingOutbox[];
  readonly meHandle: string;
  readonly compose: string;
  readonly sending: boolean;
  readonly canSendGroupMedia?: boolean;
  readonly pendingPreviewUrl?: string | null;
  /** M-RT-3：加载更早历史 + 状态。 */
  readonly hasMoreHistory?: boolean;
  readonly loadingOlder?: boolean;
  readonly onLoadOlder?: () => void;
  /** M-RT-3：失败占位的重试回调。 */
  readonly onRetryPending?: (tempId: string) => void;
  /** M-RT-3：跳到最新（外部若想拦截可传；不传则内部 scrollToBottom）。 */
  readonly onJumpToLatest?: () => void;
  readonly onCompose: (value: string) => void;
  readonly onSend: () => void;
  readonly onPickImage?: (file: File) => void;
  readonly onAttachClick?: () => void;
  readonly onClearImage?: () => void;
  readonly imageInputRef?: RefObject<HTMLInputElement>;
  readonly onBack?: () => void;
  readonly onCopyInvite?: () => void;
  /** UX-GROUPS-7：聊天面板顶部"群设置"按钮回调；按当前用户在该群的身份（群主 / 群管理 / 普通群成员）显示不同管理项；未传则不渲染。 */
  readonly onSettingsClick?: () => void;
  /** UX-GROUPS-9：待审批存在时，聊天头部直接给「审批」入口 */
  readonly onJoinRequestsClick?: () => void;
  /** 在册成员。有则在标题下直接列出。 */
  readonly members?: readonly GroupMemberItem[];
  /** GRP-NICKNAME-1：handle（小写）→ 群昵称，由本机已解密消息推导；未命中回落 handle。 */
  readonly memberNicknames?: Readonly<Record<string, string>>;
  /** GRP-MEMBER-PAGE-1：成员总数；分页时 `members` 只是已加载的一页。 */
  readonly membersTotal?: number;
  readonly membersHasMore?: boolean;
  readonly membersLoadingMore?: boolean;
  readonly onLoadMoreMembers?: () => void;
}

function senderHue(handle: string): number {
  let h = 0;
  for (let i = 0; i < handle.length; i++) h = (h * 31 + handle.charCodeAt(i)) >>> 0;
  return h % 360;
}

function senderLetter(handle: string): string {
  const trimmed = handle.trim();
  return (trimmed.charAt(0) || '?').toUpperCase();
}

function SenderAvatar({
  handle,
  hue,
  visible,
}: {
  readonly handle: string;
  readonly hue: number;
  readonly visible: boolean;
}) {
  if (!visible) {
    return <span class="w-9 shrink-0" aria-hidden="true" />;
  }
  return (
    <span
      class="mb-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-bold text-white shadow-md ring-2 ring-white/80 dark:ring-zinc-800"
      style={{ backgroundColor: `hsl(${hue}, 55%, 48%)` }}
      aria-hidden="true"
      title={`@${handle}`}
    >
      {senderLetter(handle)}
    </span>
  );
}

/** UX-GROUPS-4：右侧窗格 — 电报群气泡（双方头像）+ 电报式输入栏。 */
export function GroupChatPanel({
  group,
  messages,
  pending = [],
  meHandle,
  compose,
  sending,
  canSendGroupMedia = true,
  pendingPreviewUrl,
  hasMoreHistory = false,
  loadingOlder = false,
  onLoadOlder,
  onJumpToLatest,
  onRetryPending,
  onCompose,
  onSend,
  onPickImage,
  onAttachClick,
  onClearImage,
  imageInputRef,
  onBack,
  onCopyInvite,
  onSettingsClick,
  onJoinRequestsClick,
  members,
  memberNicknames,
  membersTotal,
  membersHasMore = false,
  membersLoadingMore = false,
  onLoadMoreMembers,
}: GroupChatPanelProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);
  /** M-RT-3：跟踪"是否在底部"，避免新消息把用户从历史上下文里顶飞。 */
  const atBottomRef = useRef(true);
  /** M-RT-3：用户不在底部时累积"新消息"计数。 */
  const [newCount, setNewCount] = useState(0);
  /**
   * M-RT-3-FIX：上一轮消息列表的最后一条 id。
   * 轮询每轮整表重设 messages（数组引用必变），只能按「旧尾之后真正追加」计数，
   * 否则没有新消息也会每轮涨一条；往头部补更早历史同样不该算新消息。
   */
  const lastMessageIdRef = useRef<string | null>(null);
  /** 窄屏成员列：默认折叠；点图标展开；输入框获焦时自动收起。宽屏始终展开。 */
  const [membersExpanded, setMembersExpanded] = useState(false);
  /**
   * REL-FIX-5：待审批入群申请数（仅群主侧 > 0）→ 群设置按钮红点。
   * 让群主不进群设置抽屉也能看到「有申请在等」。
   */
  const pendingJoinCount = Number(group?.pending_join_count ?? 0);

  /** M-RT-3：滚到聊天区底部。smooth=true 用于"跳到最新"按钮。 */
  function scrollToBottom(smooth = false): void {
    const end = endRef.current;
    if (end) {
      try {
        end.scrollIntoView({ block: 'end', behavior: smooth ? 'smooth' : 'auto' });
      } catch {
        const el = scrollRef.current;
        if (el) el.scrollTop = el.scrollHeight;
      }
    } else {
      const el = scrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    }
    atBottomRef.current = true;
    setNewCount(0);
  }

  /** M-RT-3：滚区滚动回调 — 决定新消息是否自动跟上来 + 是否触发顶部加载更早。 */
  function handleScroll(): void {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom =
      el.scrollHeight - el.scrollTop - el.clientHeight <= GROUP_BOTTOM_THRESHOLD_PX;
    atBottomRef.current = nearBottom;
    if (nearBottom && newCount > 0) setNewCount(0);
    const nearTop = el.scrollTop <= GROUP_TOP_THRESHOLD_PX;
    if (nearTop && hasMoreHistory && !loadingOlder) {
      onLoadOlder?.();
    }
  }

  /**
   * M-RT-3-FIX：messages / pending 变化时，靠近底部就自动滚到底，不在底就按「尾部新增」累计条数。
   * ① 轮询整表重设 messages 不算新消息；② 往头部补历史不算；③ 本人消息 / pending 占位不算。
   */
  useEffect(() => {
    const prevLastId = lastMessageIdRef.current;
    lastMessageIdRef.current =
      messages.length > 0 ? messages[messages.length - 1].message_id : null;
    // 认不出旧尾（切换群 / 整表替换）时不计数，避免把整页历史当成新消息
    const prevLastIndex = prevLastId
      ? messages.findIndex((m) => m.message_id === prevLastId)
      : -1;
    const appended = prevLastIndex >= 0 ? messages.slice(prevLastIndex + 1) : [];
    const meLower = meHandle.trim().toLowerCase();
    const peerAdded = appended.filter(
      (m) => m.sender_handle.trim().toLowerCase() !== meLower,
    ).length;

    if (atBottomRef.current) {
      // UX-MOBILE-FEED-CHAT-1：输入框聚焦时勿 scrollIntoView，否则手机键盘区会跟着抖/闪
      const active = typeof document !== 'undefined' ? document.activeElement : null;
      const tag = active?.tagName;
      if (tag === 'TEXTAREA' || tag === 'INPUT') return;
      if (appended.length > 0 || pending.length > 0) {
        requestAnimationFrame(() => scrollToBottom(false));
      }
      if (newCount > 0) setNewCount(0);
    } else if (peerAdded > 0) {
      setNewCount((c) => c + peerAdded);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, pending]);

  useEffect(() => {
    setMembersExpanded(false);
    // M-RT-3-FIX：切换群时重置滚动锚点与新消息计数，不继承上一个群的离底状态
    atBottomRef.current = true;
    lastMessageIdRef.current = null;
    setNewCount(0);
  }, [group?.group_id]);

  if (!group) {
    return (
      <section class="hidden h-full min-w-0 flex-1 flex-col overflow-hidden bg-white dark:bg-zinc-900 min-[960px]:flex">
        <header class="border-b border-zinc-300 px-4 py-3 dark:border-zinc-600">
          <p class="text-sm font-medium text-zinc-700 dark:text-zinc-200">{t('groupsSelectPrompt')}</p>
        </header>
        <div class="flex flex-1 items-center justify-center bg-[#e7f0e4] p-6 text-sm text-zinc-500 dark:bg-zinc-950/50 dark:text-zinc-400">
          {t('groupsSelectPrompt')}
        </div>
      </section>
    );
  }

  const inputDisabled =
    Boolean(group.dissolved_at) ||
    group.key_state !== 'active' ||
    group.status !== 'active' ||
    (Boolean(group.members_muted === true || group.members_muted === 1) &&
      group.role !== 'owner' &&
      group.is_admin !== true &&
      group.is_admin !== 1);
  const me = meHandle.trim().toLowerCase();
  const meDisplay = meHandle.trim() || t('groupsSenderMe');
  const meHue = senderHue(meDisplay);
  const canSend = Boolean(compose.trim() || pendingPreviewUrl);

  let statusBanner: string | null = null;
  // EPOCH-UX-1：换钥相关用灰色，禁止红字「发送失败」糊弄。
  let statusTone: 'amber' | 'zinc' = 'amber';
  if (group.dissolved_at) {
    statusBanner = t('groupsDissolvedBanner');
    statusTone = 'zinc';
  } else if (group.status === 'pending') {
    statusBanner = t('groupsJoinPendingBanner');
    statusTone = 'amber';
  } else if (
    (group.members_muted === true || group.members_muted === 1) &&
    group.role !== 'owner' &&
    group.is_admin !== true &&
    group.is_admin !== 1
  ) {
    statusBanner = t('groupsMutedBanner');
    statusTone = 'amber';
  } else if (group.role !== 'owner' && group.sync_tier === 'unsynced') {
    statusBanner = t('groupsUnsyncedBanner');
  } else if (group.key_state === 'pending_key') {
    // EPOCH-UX-2：补钥等待用灰色，不与「禁言/审批」琥珀混读
    statusBanner = t('groupsKeyPendingBanner');
    statusTone = 'zinc';
  } else if (group.key_state === 'epoch_rotation_pending') {
    statusBanner = t('groupsKeyRotationBanner');
    statusTone = 'zinc';
  } else if (group.rekey_scheduled === true || group.rekey_scheduled === 1) {
    // 隔绝后待 commit：旧钥仍可用，灰色提示而非禁用发信。
    statusBanner = t('groupsRekeyScheduledBanner');
    statusTone = 'zinc';
  }

  const bannerClass =
    statusTone === 'zinc'
      ? 'border-zinc-300 bg-zinc-100 text-zinc-800 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200'
      : 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-100';

  const memberCount = membersTotal ?? group.member_count ?? members?.length ?? 0;
  const hasMembers = Boolean(members && members.length > 0);

  function memberRoleLabel(m: GroupMemberItem): string {
    if (m.role === 'owner') return t('groupsMemberRoleOwner');
    if (m.is_admin) return t('groupsMemberRoleAdmin');
    return t('groupsMemberRoleMember');
  }

  function collapseMembersForCompose(): void {
    setMembersExpanded(false);
  }

  return (
    <section class="flex h-full min-w-0 flex-1 flex-col overflow-hidden bg-gradient-to-b from-white to-zinc-50 dark:from-zinc-900 dark:to-zinc-950">
      <header class="flex items-center gap-2 border-b border-zinc-200/80 bg-white/90 px-4 py-3 backdrop-blur-sm dark:border-zinc-700/80 dark:bg-zinc-900/90">
        {onBack && (
          <button
            type="button"
            class="rounded-lg p-1 hover:bg-zinc-100 min-[960px]:hidden dark:hover:bg-zinc-800"
            aria-label={t('groupsBackToList')}
            onClick={onBack}
          >
            <ChevronLeft size={20} aria-hidden="true" />
          </button>
        )}
        <div class="min-w-0 flex-1">
          <h2 class="truncate text-base font-semibold text-zinc-900 dark:text-zinc-50">{group.name}</h2>
          <p class="truncate text-xs text-zinc-500 dark:text-zinc-400">
            {t('groupsMemberCount', undefined, { count: memberCount })}
            {group.announcement ? ` · ${group.announcement}` : ''}
          </p>
        </div>
        {hasMembers && (
          <button
            type="button"
            class="shrink-0 rounded-lg border border-zinc-300 bg-zinc-50 p-1.5 hover:bg-zinc-100 min-[960px]:hidden dark:border-zinc-600 dark:bg-zinc-800 dark:hover:bg-zinc-700"
            aria-expanded={membersExpanded}
            aria-label={membersExpanded ? t('groupsMembersCollapse') : t('groupsMembersExpand')}
            title={membersExpanded ? t('groupsMembersCollapse') : t('groupsMembersExpand')}
            onClick={() => setMembersExpanded((open) => !open)}
          >
            <Users size={18} aria-hidden="true" />
          </button>
        )}
        {group.role === 'owner' && !group.dissolved_at && onCopyInvite && (
          <button
            type="button"
            class="shrink-0 rounded-lg border border-zinc-300 bg-zinc-50 px-2.5 py-1 text-xs font-medium hover:bg-zinc-100 dark:border-zinc-600 dark:bg-zinc-800 dark:hover:bg-zinc-700"
            onClick={onCopyInvite}
          >
            {t('groupsCopyInvite')}
          </button>
        )}
        {/* UX-GROUPS-9：有入群申请时，头部直接给「审批」按钮，点开就是审批页 */}
        {onJoinRequestsClick && pendingJoinCount > 0 && !group.dissolved_at && (
          <button
            type="button"
            class="shrink-0 inline-flex items-center gap-1 rounded-lg border border-rose-300 bg-rose-50 px-2.5 py-1 text-xs font-semibold text-rose-700 hover:bg-rose-100 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-200 dark:hover:bg-rose-950/70"
            onClick={onJoinRequestsClick}
            aria-label={t('groupsJoinRequestsTitle')}
            title={t('groupsJoinRequestsTitle')}
            data-testid="group-join-requests-entry"
          >
            {t('groupsJoinRequestShort')} · {pendingJoinCount}
          </button>
        )}
        {/* UX-GROUPS-7：群设置迁移到聊天面板顶部，仅在群未解散时显示；
            弹窗内部按 role / is_admin 进一步裁剪可见项（群主全权、群管审核+禁言+踢人、成员仅查看）。 */}
        {onSettingsClick && !group.dissolved_at && (
          <button
            type="button"
            class="relative shrink-0 inline-flex items-center gap-1 rounded-lg border border-zinc-300 bg-zinc-50 px-2.5 py-1 text-xs font-medium hover:bg-zinc-100 dark:border-zinc-600 dark:bg-zinc-800 dark:hover:bg-zinc-700"
            onClick={onSettingsClick}
            aria-label={t('groupsSettingsBtn')}
            title={t('groupsSettingsBtn')}
          >
            <Settings size={14} aria-hidden="true" />
            <span>{t('groupsSettingsBtn')}</span>
            {/* REL-FIX-5：待审批入群申请红点（数量在列表角标显示；此处只做有无提示）。 */}
            {pendingJoinCount > 0 && (
              <span
                class="absolute -right-1 -top-1 h-2 w-2 rounded-full bg-rose-500 ring-2 ring-white dark:ring-zinc-900"
                data-testid="group-settings-pending-dot"
                aria-hidden="true"
              />
            )}
          </button>
        )}
      </header>

      <div class="flex min-h-0 flex-1 overflow-hidden">
        {hasMembers && (
          <aside
            class={`flex shrink-0 flex-col border-r border-emerald-100/80 bg-gradient-to-b from-emerald-50/90 to-white dark:border-zinc-700 dark:from-zinc-950 dark:to-zinc-900 ${
              membersExpanded
                ? 'w-[168px]'
                : 'hidden w-[168px] min-[960px]:flex'
            }`}
          >
            <div class="flex items-center justify-between gap-1 border-b border-emerald-100/70 px-2 py-2 dark:border-zinc-700">
              <p class="truncate text-xs font-semibold text-emerald-900/80 dark:text-zinc-200">
                {t('groupsMembersTitle')}
              </p>
              <button
                type="button"
                class="rounded p-0.5 text-zinc-500 hover:bg-emerald-100/80 min-[960px]:hidden dark:hover:bg-zinc-800"
                aria-label={t('groupsMembersCollapse')}
                onClick={() => setMembersExpanded(false)}
              >
                <ChevronLeft size={16} aria-hidden="true" />
              </button>
            </div>
            <ul class="min-h-0 flex-1 space-y-1.5 overflow-y-auto p-2">
              {members!.map((m) => {
                // GRP-NICKNAME-1：优先显示本群昵称；没有则回落 handle
                const nickname = memberNicknames?.[m.member_handle.trim().toLowerCase()] ?? '';
                const roleLabel = memberRoleLabel(m);
                return (
                  <li
                    key={m.member_worker_b_url}
                    class="rounded-xl border border-emerald-100/60 bg-white/90 px-2 py-1.5 shadow-sm dark:border-zinc-700 dark:bg-zinc-900"
                    title={`@${m.member_handle} · ${roleLabel}`}
                  >
                    <p class="truncate text-xs font-medium text-zinc-900 dark:text-zinc-50">
                      {nickname || m.member_handle}
                    </p>
                    <p class="truncate text-[10px] text-emerald-700/70 dark:text-zinc-500">
                      {roleLabel}
                    </p>
                  </li>
                );
              })}
            </ul>
            {/* GRP-MEMBER-PAGE-1：大群只加载一页；这里按需追加，避免一次渲染 2000 行 */}
            {membersHasMore && onLoadMoreMembers && (
              <button
                type="button"
                class="mx-2 mb-2 shrink-0 rounded-lg border border-emerald-200 bg-white/90 px-2 py-1 text-[11px] font-medium text-emerald-800 hover:bg-emerald-50 disabled:opacity-50 dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
                disabled={membersLoadingMore}
                onClick={() => onLoadMoreMembers()}
                data-testid="group-members-load-more"
              >
                {membersLoadingMore ? t('groupsLoadingOlder') : t('groupsMembersLoadMore')}
              </button>
            )}
          </aside>
        )}

        <div class="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          {statusBanner && (
            <p class={`border-b px-4 py-2 text-xs ${bannerClass}`} role="status">
              {statusBanner}
            </p>
          )}

          <div
            ref={scrollRef}
            onScroll={handleScroll}
            class="relative min-h-0 flex-1 space-y-2 overflow-y-auto bg-gradient-to-br from-[#e8f5ec] via-[#eef6f1] to-[#e4eef8] p-3 dark:from-zinc-900 dark:via-zinc-900/90 dark:to-zinc-950 md:p-4"
          >
        {/* M-RT-3：顶部加载更早按钮 — 滚到顶自动触发；显式按钮给键盘 / 触屏备用 */}
        {(hasMoreHistory || loadingOlder) && (
          <div class="flex justify-center pb-2">
            <button
              type="button"
              class="rounded-full border border-zinc-300 bg-white/80 px-3 py-1 text-xs text-zinc-600 hover:bg-white disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-600 dark:bg-zinc-900/70 dark:text-zinc-300 dark:hover:bg-zinc-900"
              disabled={loadingOlder}
              onClick={() => onLoadOlder?.()}
            >
              {loadingOlder ? t('groupsLoadingOlder') : t('groupsLoadOlder')}
            </button>
          </div>
        )}
        {messages.length === 0 && pending.length === 0 ? (
          <div class="flex h-full min-h-[12rem] flex-col items-center justify-center gap-2 text-center">
            <MessageSquare size={36} class="text-zinc-300 dark:text-zinc-600" aria-hidden="true" />
            <p class="rounded-2xl border border-dashed border-emerald-300/70 bg-white/80 px-4 py-3 text-sm text-zinc-500 shadow-sm backdrop-blur-sm dark:border-zinc-600 dark:bg-zinc-900/80 dark:text-zinc-400">
              {t('groupsNoMessages')}
            </p>
          </div>
        ) : (
          <>
            {messages.map((m, index) => {
              if (m.msg_kind === 'system') {
                let display = m.plaintext;
                if (m.plaintext.startsWith('HAILUO_GROUP_NODE_URL_CHANGED_V1')) {
                  try {
                    const jsonPart = m.plaintext
                      .slice('HAILUO_GROUP_NODE_URL_CHANGED_V1'.length)
                      .trim();
                    const ev = JSON.parse(jsonPart) as { from_handle?: string };
                    if (typeof ev.from_handle === 'string' && ev.from_handle.trim()) {
                      display = t('groupsNodeUrlChangedSystem', undefined, {
                        handle: ev.from_handle.trim(),
                      });
                    } else {
                      display = t('groupsNodeUrlChangedSystemFallback');
                    }
                  } catch {
                    display = t('groupsNodeUrlChangedSystemFallback');
                  }
                }
                return (
                  <div key={m.message_id} class="flex justify-center py-1">
                    <p
                      class="max-w-[92%] rounded-full bg-zinc-700/55 px-3 py-1 text-center text-xs text-white shadow-sm backdrop-blur-sm dark:bg-zinc-600/70"
                      role="status"
                      aria-label={t('groupsSystemMessageAria')}
                    >
                      {display}
                    </p>
                  </div>
                );
              }

              const handle = m.sender_handle.trim() || t('groupsUnknownSender');
              // GRP-NICKNAME-1：优先显示发送者在本群自设的昵称；未设置/旧消息回落 @handle
              const nickname = (m.sender_nickname ?? '').trim();
              const mine = handle.toLowerCase() === me;
              const prev = index > 0 ? messages[index - 1] : null;
              const prevSameSender =
                prev != null &&
                prev.msg_kind !== 'system' &&
                prev.sender_handle.trim().toLowerCase() === handle.toLowerCase() &&
                // GRP-NICKNAME-1：同一人中途改昵称要重新标一次，避免旧昵称盖住新消息
                (prev.sender_nickname ?? '').trim() === nickname;
              // 连续同发送者只露一条头像；气泡内不展示「我」/用户名（悬停头像可见 @handle）
              const showAvatar = !prevSameSender;
              const hue = senderHue(handle);

              if (mine) {
                return (
                  <div
                    key={m.message_id}
                    class={`flex items-end justify-end gap-2 ${showAvatar ? 'mt-1' : ''}`}
                  >
                    <div class="hailuo-chat-bubble hailuo-chat-bubble-out">
                      {m.media?.[0]?.object_url && (
                        <img
                          src={m.media[0].object_url}
                          alt={t('groupsImageAlt')}
                          class="mb-2 max-h-64 w-full rounded-xl object-contain"
                        />
                      )}
                      {m.plaintext && <p class="whitespace-pre-wrap break-words leading-relaxed">{m.plaintext}</p>}
                      <p class="mt-1 text-right text-[10px] text-sky-100/90">
                        {formatRelativeTime(m.created_at)}
                      </p>
                    </div>
                    <SenderAvatar handle={handle} hue={hue} visible={showAvatar} />
                  </div>
                );
              }

              return (
                <div
                  key={m.message_id}
                  class={`flex items-end gap-2 ${showAvatar ? 'mt-1' : ''}`}
                >
                  <SenderAvatar handle={handle} hue={hue} visible={showAvatar} />
                  <div class="hailuo-chat-bubble hailuo-chat-bubble-in">
                    {/* GRP-SENDER-LABEL / GRP-NICKNAME-1：换人时标出「群昵称 + @handle」，未设昵称只标 @handle */}
                    {showAvatar && (
                      <p class="mb-1 flex flex-wrap items-baseline gap-x-1.5 text-[11px] leading-4">
                        {nickname ? (
                          <>
                            <span class="font-semibold text-zinc-700 dark:text-zinc-200">{nickname}</span>
                            <span class="text-zinc-500 dark:text-zinc-400">@{handle}</span>
                          </>
                        ) : (
                          <span class="font-semibold text-zinc-500 dark:text-zinc-300">@{handle}</span>
                        )}
                      </p>
                    )}
                    {m.media?.[0]?.object_url && (
                      <img
                        src={m.media[0].object_url}
                        alt={t('groupsImageAlt')}
                        class="mb-2 max-h-64 w-full rounded-xl object-contain"
                      />
                    )}
                    {m.plaintext && <p class="whitespace-pre-wrap break-words leading-relaxed">{m.plaintext}</p>}
                    <p class="mt-1 text-right text-[10px] text-fg3">
                      {formatRelativeTime(m.created_at)}
                    </p>
                  </div>
                </div>
              );
            })}
            {/* M-RT-3：pending 占位（发送中灰显 / 失败红角 + 重试） */}
            {pending.map((p) => (
              <div key={p.tempId} class="mt-1 flex items-end justify-end gap-2">
                <div
                  class={`hailuo-chat-bubble rounded-br-md border ${
                    p.status === 'failed'
                      ? 'border-rose-300 bg-rose-50 text-rose-900 dark:border-rose-700 dark:bg-rose-950/50 dark:text-rose-100'
                      : 'border-sky-200 bg-gradient-to-br from-sky-100 to-sky-50 text-sky-900 dark:border-sky-700 dark:from-sky-950/50 dark:to-sky-900/40 dark:text-sky-100'
                  }`}
                >
                  {p.imagePreviewUrl && (
                    <img
                      src={p.imagePreviewUrl}
                      alt={t('groupsImagePreviewAlt')}
                      class="mb-2 max-h-64 rounded-lg object-contain"
                    />
                  )}
                  {p.plaintext && <p class="whitespace-pre-wrap break-words">{p.plaintext}</p>}
                  <p
                    class={`mt-1 inline-flex items-center justify-end gap-1 text-right text-[10px] ${
                      p.status === 'failed'
                        ? 'text-rose-700 dark:text-rose-300'
                        : 'text-sky-700 dark:text-sky-300'
                    }`}
                  >
                    {p.status === 'failed' ? (
                      <AlertCircle size={10} aria-hidden="true" />
                    ) : (
                      <Loader2 size={10} class="animate-spin" aria-hidden="true" />
                    )}
                    <span>{p.status === 'failed' ? t('groupsRetryFailed') : t('groupsSending')}</span>
                  </p>
                  {p.status === 'failed' && (
                    <button
                      type="button"
                      class="mt-1 inline-flex items-center gap-1 rounded-full bg-rose-600 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-rose-700"
                      aria-label={t('groupsRetryAria')}
                      onClick={() => onRetryPending?.(p.tempId)}
                    >
                      {t('groupsRetry')}
                    </button>
                  )}
                </div>
                <SenderAvatar handle={meDisplay} hue={meHue} visible={true} />
              </div>
            ))}
            <div ref={endRef} aria-hidden="true" />
          </>
        )}
        {/* M-RT-3：用户不在底部时显示"新消息"浮钮 */}
        {!atBottomRef.current && newCount > 0 && (
          <button
            type="button"
            class="sticky bottom-2 left-1/2 z-10 mx-auto block rounded-full bg-sky-600 px-3 py-1.5 text-xs font-semibold text-white shadow-md hover:bg-sky-700"
            onClick={() => onJumpToLatest?.() ?? scrollToBottom(true)}
          >
            {t('groupsNewCount', undefined, { count: newCount })} ↓
          </button>
        )}
      </div>
        </div>
      </div>

      {pendingPreviewUrl && (
        <div class="border-t border-zinc-200 bg-white px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900">
          <div class="relative inline-block">
            <img
              src={pendingPreviewUrl}
              alt={t('groupsImagePreviewAlt')}
              class="max-h-32 rounded-lg border border-zinc-200 dark:border-zinc-700"
            />
            {onClearImage && (
              <button
                type="button"
                class="absolute -right-2 -top-2 rounded-full bg-zinc-800 px-2 py-0.5 text-xs text-white"
                onClick={onClearImage}
              >
                ×
              </button>
            )}
          </div>
        </div>
      )}

      {/* 电报式输入栏：回形针 | 我的头像 | 输入框 | 发送 — 通栏贴底，不与成员列并排 */}
      <div class="hailuo-chat-composer dark:to-zinc-900/95">
        <div class="flex items-end gap-2">
          {onPickImage && imageInputRef && (
            <>
              <input
                ref={imageInputRef}
                type="file"
                accept="image/*"
                class="hidden"
                disabled={inputDisabled || sending}
                onChange={(e) => {
                  const file = (e.target as HTMLInputElement).files?.[0] ?? null;
                  if (file) onPickImage(file);
                  (e.target as HTMLInputElement).value = '';
                }}
              />
              <button
                type="button"
                class="mb-0.5 rounded-full p-2 text-zinc-500 hover:bg-sky-50 hover:text-sky-700 disabled:opacity-40 dark:text-zinc-300 dark:hover:bg-zinc-800"
                disabled={inputDisabled || sending}
                title={
                  canSendGroupMedia ? t('groupsAttachImage') : t('groupsImageCloudRequired')
                }
                aria-label={t('groupsAttachImage')}
                onClick={() => {
                  collapseMembersForCompose();
                  onAttachClick?.();
                }}
              >
                <Paperclip size={20} aria-hidden="true" />
              </button>
            </>
          )}
          <span
            class="mb-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-bold text-white ring-2 ring-white shadow-sm dark:ring-zinc-800"
            style={{ backgroundColor: `hsl(${meHue}, 55%, 48%)` }}
            aria-hidden="true"
            title={`@${meDisplay}`}
          >
            {senderLetter(meDisplay)}
          </span>
          {/* UX-MOBILE-FEED-CHAT-1：与记录页同构 — 边框在 textarea 上，focus 环贴边（无外套 + ring-offset） */}
          <textarea
            class="hailuo-focus-field max-h-28 min-h-[2.75rem] flex-1 resize-none rounded-2xl border border-zinc-200 bg-white px-3 py-2 text-sm leading-5 text-zinc-900 outline-none placeholder:text-zinc-400 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-100 dark:placeholder:text-zinc-500"
            placeholder={t('groupsComposePlaceholder')}
            rows={1}
            value={compose}
            disabled={inputDisabled || sending}
            onFocus={collapseMembersForCompose}
            onInput={(e) => {
              const el = e.target as HTMLTextAreaElement;
              onCompose(el.value);
              el.style.height = 'auto';
              el.style.height = `${Math.min(el.scrollHeight, 112)}px`;
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                if (!inputDisabled && !sending && canSend) onSend();
              }
            }}
          />
          <button
            type="button"
            class="mb-0.5 rounded-full bg-gradient-to-br from-sky-500 to-sky-600 px-4 py-2 text-sm font-semibold text-white shadow-md shadow-sky-500/30 hover:from-sky-600 hover:to-sky-700 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={inputDisabled || sending || !canSend}
            onClick={onSend}
          >
            {sending ? t('groupsSending') : t('groupsSend')}
          </button>
        </div>
      </div>
    </section>
  );
}
