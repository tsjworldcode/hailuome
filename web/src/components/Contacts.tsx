/** @jsxImportSource preact */
/**
 * UX-MSG-LEFT-1：消息页左栏 = 好友列表（上：加好友请求；下：互粉好友）。
 * 点名字直接开聊；右键（或长按菜单）提供「发消息 / 删除聊天记录 / 解除好友」。
 * 解除好友同时保留聊天记录，删除聊天记录不影响好友关系。
 */
import type { VNode } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { MessageSquare, Trash2, UserMinus } from 'lucide-preact';
import { getOwnerJwt, getWorkerAUrl } from '../lib/auth';
import { createWorkerAClient, type MutualFollowItem } from '../lib/workerA';
import type { DmConversationSummary } from '../lib/dmService';
import { deleteLocalConversation } from '../lib/dmService';
import { ApiError } from '../lib/errors';
import { t } from '../lib/i18n';
import { showToast } from '../lib/toast';
import { formatRelativeTime } from '../lib/timeFormat';
import { buildWorkerBImageUrl } from '../lib/mediaUrls';
import { formatPublicHandleDisplay } from '../lib/handleDisplay';
import {
  ownerCredentialsReady,
  useOwnerCredentials,
} from '../lib/useOwnerCredentials';
import { ConfirmDialog } from './ConfirmDialog';
import { FriendRequestsPanel } from './FriendRequestsPanel';

function makeClient() {
  const baseUrl = getWorkerAUrl();
  const jwt = getOwnerJwt();
  if (!baseUrl || !jwt) return null;
  return createWorkerAClient({ baseUrl, getJwt: getOwnerJwt });
}

function avatarLetter(item: MutualFollowItem): string {
  const source = item.handle || item.display_name || 'H';
  return (source.trim().charAt(0) || 'H').toUpperCase();
}

type FriendMenuState = {
  readonly item: MutualFollowItem;
  readonly x: number;
  readonly y: number;
};

type FriendConfirmKind = 'unfriend' | 'delete-chat';

export interface ContactsProps {
  /** 点好友行 → 父级打开/创建会话 */
  readonly onOpenChat?: (handle: string) => void;
  /** 当前正在聊天的好友 handle（左栏高亮同款会话行） */
  readonly selectedHandle?: string;
  /** 会话摘要：给好友行带出最后一条消息与未读数（微信式列表） */
  readonly conversations?: readonly DmConversationSummary[];
  /** 删除聊天记录后通知父级清掉选中态并刷新会话摘要 */
  readonly onConversationDeleted?: (conversationId: string) => void;
}

export function Contacts({
  onOpenChat,
  selectedHandle,
  conversations,
  onConversationDeleted,
}: ContactsProps): VNode {
  useOwnerCredentials();
  const [items, setItems] = useState<readonly MutualFollowItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** 右键菜单（好友行） */
  const [menu, setMenu] = useState<FriendMenuState | null>(null);
  /** 待确认的破坏性操作（解除好友 / 删除聊天记录） */
  const [actionTarget, setActionTarget] = useState<MutualFollowItem | null>(null);
  const [confirmKind, setConfirmKind] = useState<FriendConfirmKind | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  async function load(): Promise<void> {
    const client = makeClient();
    if (!client) {
      setError(t('ownerConfigureWriteLayer'));
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const data = await client.listMutualFollows();
      setItems(data.items);
    } catch (err) {
      setError(err instanceof ApiError ? err.displayMessage : t('friendUriInvalid'));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!ownerCredentialsReady.value) return;
    void load();
  }, [ownerCredentialsReady.value]);

  // 右键菜单：点空白 / Escape / 滚动 / 缩放一律关闭；点在菜单内不关闭。
  useEffect(() => {
    if (!menu) return;
    const onPointerDown = (e: PointerEvent) => {
      const node = menuRef.current;
      if (node && e.target instanceof Node && node.contains(e.target)) return;
      setMenu(null);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenu(null);
    };
    const close = () => setMenu(null);
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [menu]);

  const activeHandle = (selectedHandle ?? '').trim().toLowerCase();
  // handle → 会话摘要（最后一条消息 / 未读数 / 删除聊天记录需要的 conversation_id）
  const summaryByHandle = new Map<string, DmConversationSummary>();
  for (const c of conversations ?? []) {
    summaryByHandle.set(c.peer_handle.trim().toLowerCase(), c);
  }

  function openMenu(e: MouseEvent, item: MutualFollowItem): void {
    e.preventDefault();
    e.stopPropagation();
    // 菜单固定 12rem 宽、约 8.5rem 高；贴边时向内收，避免被视口裁掉
    const x = Math.min(e.clientX, Math.max(8, window.innerWidth - 200));
    const y = Math.min(e.clientY, Math.max(8, window.innerHeight - 148));
    setMenu({ item, x, y });
  }

  function askAction(kind: FriendConfirmKind, item: MutualFollowItem): void {
    setMenu(null);
    setActionTarget(item);
    setConfirmKind(kind);
  }

  async function confirmUnfriend(): Promise<void> {
    const target = actionTarget;
    const client = makeClient();
    if (!target || !client) return;
    setConfirmBusy(true);
    try {
      await client.deleteFollow(target.node_url);
      setItems((prev) => prev.filter((x) => x.node_url !== target.node_url));
      setConfirmKind(null);
      setActionTarget(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.displayMessage : t('followsUnfollowFailed'));
    } finally {
      setConfirmBusy(false);
    }
  }

  async function confirmDeleteChat(): Promise<void> {
    const target = actionTarget;
    const client = makeClient();
    if (!target || !client) return;
    const summary = summaryByHandle.get(target.handle.trim().toLowerCase());
    if (!summary) return;
    setConfirmBusy(true);
    try {
      await client.deleteDmConversation(summary.conversation_id);
      await deleteLocalConversation(summary.conversation_id);
      onConversationDeleted?.(summary.conversation_id);
      showToast(t('messagesDeleteChatDone'));
      setConfirmKind(null);
      setActionTarget(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.displayMessage : t('messagesDeleteFailed'));
    } finally {
      setConfirmBusy(false);
    }
  }

  if (!ownerCredentialsReady.value) {
    return <p class="text-sm text-zinc-500 dark:text-zinc-400">{t('commonCheckingLogin')}</p>;
  }

  return (
    <div class="flex h-full min-h-0 flex-col" data-testid="contacts-panel">
      {/* 请求区置顶（待办优先） */}
      <div class="shrink-0 border-b border-zinc-200 px-3 py-3 dark:border-zinc-700">
        <FriendRequestsPanel compact onChanged={() => void load()} />
      </div>

      <section class="flex min-h-0 flex-1 flex-col overflow-hidden" aria-label={t('friends')}>
        <h2 class="shrink-0 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
          {t('friends')}
        </h2>

        {error && (
          <p
            class="mx-3 mb-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-200"
            role="alert"
          >
            {error}
          </p>
        )}

        {loading && (
          <p class="px-3 text-sm text-zinc-500 dark:text-zinc-400">{t('notificationsLoading')}</p>
        )}

        {!loading && items.length === 0 && (
          <p class="px-3 text-sm text-zinc-500 dark:text-zinc-400">{t('friendMutualEmpty')}</p>
        )}

        {!loading && items.length > 0 && (
          <ul class="hailuo-chat-list bg-gradient-to-b from-slate-100/70 to-sky-50/40 dark:from-zinc-950 dark:to-zinc-900">
            {items.map((item) => {
              const avatarUrl =
                item.avatar_key && item.node_url
                  ? buildWorkerBImageUrl(item.node_url, item.avatar_key)
                  : '';
              const selectedRow = Boolean(activeHandle) && item.handle.trim().toLowerCase() === activeHandle;
              const summary = summaryByHandle.get(item.handle.trim().toLowerCase());
              return (
                <li key={item.node_url}>
                  <button
                    type="button"
                    class={`hailuo-chat-row ${
                      selectedRow ? 'hailuo-chat-row-selected' : 'hailuo-chat-row-idle'
                    }`}
                    onClick={() => onOpenChat?.(item.handle)}
                    onContextMenu={(e) => openMenu(e, item)}
                    data-testid="contacts-open-chat"
                    aria-label={t('messagesNewChatConfirm')}
                    title={t('messagesFriendMenuHint')}
                  >
                    <span
                      class="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-full bg-zinc-900 text-sm font-bold text-white shadow-md ring-2 ring-white dark:bg-zinc-100 dark:text-zinc-950 dark:ring-zinc-800"
                      aria-hidden="true"
                    >
                      {avatarUrl ? (
                        <img src={avatarUrl} alt="" class="h-full w-full object-cover" loading="lazy" />
                      ) : (
                        avatarLetter(item)
                      )}
                    </span>
                    <div class="min-w-0 flex-1">
                      <div class="flex items-start justify-between gap-2">
                        <p class="truncate font-semibold text-zinc-900 dark:text-zinc-50">
                          {item.display_name || formatPublicHandleDisplay(item.handle)}
                        </p>
                        {summary?.last_message_at ? (
                          <span class="shrink-0 text-[10px] text-zinc-500 dark:text-zinc-400">
                            {formatRelativeTime(summary.last_message_at)}
                          </span>
                        ) : null}
                      </div>
                      <div class="mt-0.5 flex items-center justify-between gap-2">
                        <p class="truncate text-xs text-zinc-500 dark:text-zinc-400">
                          {summary?.last_preview || `@${formatPublicHandleDisplay(item.handle)}`}
                        </p>
                        {summary && summary.unread_count > 0 ? (
                          <span class="shrink-0 rounded-full bg-rose-500 px-1.5 py-0.5 text-[10px] font-bold text-white">
                            {summary.unread_count > 99 ? '99+' : summary.unread_count}
                          </span>
                        ) : null}
                      </div>
                      {/* 没有会话记录时补一行「成为好友」时间，避免列表只有名字 */}
                      {!summary && item.accepted_at ? (
                        <p class="mt-0.5 text-[10px] text-zinc-400" title={item.accepted_at}>
                          {formatRelativeTime(item.accepted_at)}
                        </p>
                      ) : null}
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* 好友右键菜单：发消息 / 删除聊天记录 / 解除好友 */}
      {menu && (
        <div
          ref={menuRef}
          class="fixed z-[70] min-w-[12rem] overflow-hidden rounded-xl border border-zinc-200 bg-white py-1 shadow-xl shadow-zinc-900/10 dark:border-zinc-700 dark:bg-zinc-900"
          style={{ left: `${menu.x}px`, top: `${menu.y}px` }}
          role="menu"
          aria-label={t('messagesFriendMenuAria')}
          data-friend-menu="1"
          onContextMenu={(e) => e.preventDefault()}
        >
          <button
            type="button"
            role="menuitem"
            class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-zinc-800 hover:bg-zinc-100 dark:text-zinc-100 dark:hover:bg-zinc-800"
            onClick={() => {
              const handle = menu.item.handle;
              setMenu(null);
              onOpenChat?.(handle);
            }}
          >
            <MessageSquare size={14} aria-hidden="true" />
            {t('messagesSendMessage')}
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={!summaryByHandle.get(menu.item.handle.trim().toLowerCase())}
            class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-zinc-800 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-40 dark:text-zinc-100 dark:hover:bg-zinc-800"
            onClick={() => askAction('delete-chat', menu.item)}
          >
            <Trash2 size={14} aria-hidden="true" />
            {t('messagesDeleteChatHistory')}
          </button>
          <button
            type="button"
            role="menuitem"
            class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-rose-700 hover:bg-rose-50 dark:text-rose-300 dark:hover:bg-rose-950/40"
            onClick={() => askAction('unfriend', menu.item)}
          >
            <UserMinus size={14} aria-hidden="true" />
            {t('friendUnfriend')}
          </button>
        </div>
      )}

      <ConfirmDialog
        open={confirmKind !== null && actionTarget !== null}
        pending={confirmBusy}
        title={
          confirmKind === 'unfriend'
            ? t('friendUnfriend')
            : t('messagesDeleteConversation')
        }
        body={
          actionTarget ? (
            <p>
              {confirmKind === 'unfriend'
                ? t('friendUnfriendConfirm', undefined, {
                    handle:
                      formatPublicHandleDisplay(actionTarget.handle) || actionTarget.handle,
                  })
                : t('messagesDeleteChatConfirm', undefined, {
                    handle:
                      formatPublicHandleDisplay(actionTarget.handle) || actionTarget.handle,
                  })}
            </p>
          ) : null
        }
        cancelLabel={t('localDataCancel')}
        confirmLabel={
          confirmKind === 'unfriend'
            ? t('friendUnfriend')
            : t('messagesDeleteDialogConfirm')
        }
        confirmPendingLabel={
          confirmKind === 'unfriend' ? t('followsDeleting') : t('messagesDeleteDialogPending')
        }
        icon={
          confirmKind === 'unfriend' ? (
            <UserMinus size={20} strokeWidth={2} aria-hidden="true" />
          ) : (
            <Trash2 size={20} strokeWidth={2} aria-hidden="true" />
          )
        }
        confirmClassName="rounded-full bg-rose-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-rose-700 disabled:cursor-wait disabled:opacity-70 dark:bg-rose-500 dark:hover:bg-rose-400"
        onCancel={() => {
          if (confirmBusy) return;
          setConfirmKind(null);
          setActionTarget(null);
        }}
        onConfirm={() => {
          if (confirmKind === 'unfriend') void confirmUnfriend();
          else void confirmDeleteChat();
        }}
      />
    </div>
  );
}
