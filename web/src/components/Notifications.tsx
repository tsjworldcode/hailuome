/** @jsxImportSource preact */
import { useEffect, useState } from 'preact/hooks';
import { getOwnerJwt, getWorkerAUrl } from '../lib/auth';
import { ApiError } from '../lib/errors';
import { createWorkerAClient, type LocalNotificationItem } from '../lib/workerA';
import { refreshUnreadNotificationCount } from '../lib/notificationsStore';
import { formatRelativeTime } from '../lib/timeFormat';
import { ownerCredentialsReady } from '../lib/useOwnerCredentials';
import { initLanguage, t } from '../lib/i18n';
import { formatPublicHandleDisplay } from '../lib/handleDisplay';
import { showToast } from '../lib/toast';
import { FriendAcceptConfirmDialog } from './FriendAcceptConfirmDialog';
import { ShieldAlert } from 'lucide-preact';

function describeNotification(item: LocalNotificationItem): string {
  // HANDLE-QUAL-V1：对端可能仍送历史 `alice@reg2`，展示前统一成 `alice:reg2`
  const actor = formatPublicHandleDisplay(item.actor_handle) || item.actor_handle;
  if (item.type === 'like') {
    return t('notificationsLike', undefined, { handle: actor });
  }
  if (item.type === 'friend_request_received') {
    return t('friendRequestReceivedTitle', undefined, { handle: actor });
  }
  if (item.type === 'friend_request_accepted') {
    return t('friendRequestAcceptedBody', undefined, { handle: actor });
  }
  if (item.type === 'friend_request_rejected') {
    return t('friendRequestRejectedBody', undefined, { handle: actor });
  }
  if (item.type === 'friend_request_cancelled') {
    return t('friendRequestCancelledBody', undefined, { handle: actor });
  }
  // REL-FIX-11：发起方撤回自己发出的请求 → 本端站主可见性通知
  if (item.type === 'friend_request_withdrawn') {
    return t('friendRequestWithdrawnTitle', undefined, {
      handle: formatPublicHandleDisplay(item.content_preview ?? '') || actor,
    });
  }
  if (item.type === 'group_join_request_received') {
    return t('groupJoinRequestReceivedTitle', undefined, {
      handle: actor,
      group: item.content_preview ?? item.request_id ?? '',
    });
  }
  // REL-FIX-7：入群审批结果通知（申请人节点本地）
  // content_preview 形如「群名 · @群主」，展示时只取群名部分
  const decisionGroup = (item.content_preview ?? item.request_id ?? '').split(' · ')[0] ?? '';
  if (item.type === 'group_join_approved') {
    return t('groupJoinApprovedTitle', undefined, { group: decisionGroup });
  }
  if (item.type === 'group_join_rejected') {
    return t('groupJoinRejectedTitle', undefined, { group: decisionGroup });
  }
  const base = t('notificationsReply', undefined, { handle: actor });
  if (!item.content_preview) return base;
  return base + t('notificationsReplyPreview', undefined, { preview: item.content_preview });
}

export function Notifications() {
  const [items, setItems] = useState<readonly LocalNotificationItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [marking, setMarking] = useState(false);
  const [actionId, setActionId] = useState<string | null>(null);
  const [acceptNotifItem, setAcceptNotifItem] = useState<LocalNotificationItem | null>(null);

  useEffect(() => {
    initLanguage();
  }, []);

  useEffect(() => {
    if (!ownerCredentialsReady.value) return;
    const url = getWorkerAUrl();
    if (!url) {
      setError(t('ownerConfigureWriteLayer'));
      setLoading(false);
      return;
    }
    if (!getOwnerJwt()) {
      setError(t('registryCertifyLoginRequired'));
      setLoading(false);
      return;
    }
    const client = createWorkerAClient({ baseUrl: url, getJwt: getOwnerJwt });
    let cancelled = false;
    let markedReadOnce = false;

    /** M-F5：列表拉取；仅首次进入时自动标已读，30s 轮询只读不刷已读。 */
    async function loadNotifications(opts?: { markRead?: boolean }): Promise<void> {
      try {
        const data = await client.listNotifications({ limit: 30 });
        if (cancelled) return;
        setItems(data.items);
        setLoading(false);
        setError(null);
        if (opts?.markRead && data.unread_count > 0 && !markedReadOnce) {
          markedReadOnce = true;
          await client.markNotificationsRead();
          void refreshUnreadNotificationCount();
        }
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof ApiError ? err.displayMessage : t('notificationsLoadFailed'));
        setLoading(false);
      }
    }

    void loadNotifications({ markRead: true });
    // M-F5：通知页 30s 只读轮询（不 mark-read，避免把新来的未读立刻抹掉）
    const pollId = window.setInterval(() => {
      void loadNotifications({ markRead: false });
    }, 30_000);

    return () => {
      cancelled = true;
      window.clearInterval(pollId);
    };
  }, []);

  async function markAllRead(): Promise<void> {
    const url = getWorkerAUrl();
    if (!url || !getOwnerJwt()) return;
    setMarking(true);
    try {
      const client = createWorkerAClient({ baseUrl: url, getJwt: getOwnerJwt });
      await client.markNotificationsRead();
      setItems((prev) => prev.map((n) => ({ ...n, read_at: n.read_at ?? new Date().toISOString() })));
      void refreshUnreadNotificationCount();
    } catch (err) {
      setError(err instanceof ApiError ? err.displayMessage : t('notificationsMarkReadFailed'));
    } finally {
      setMarking(false);
    }
  }

  async function acceptRequest(item: LocalNotificationItem): Promise<void> {
    const requestId = item.request_id;
    const url = getWorkerAUrl();
    if (!requestId || !url || !getOwnerJwt()) return;
    setActionId(item.id);
    try {
      const client = createWorkerAClient({ baseUrl: url, getJwt: getOwnerJwt });
      await client.acceptFriendRequest(requestId);
      showToast(t('friendAccept'));
      setItems((prev) => prev.filter((n) => n.id !== item.id));
    } catch (err) {
      showToast(err instanceof ApiError ? err.displayMessage : t('friendUriInvalid'), 'error');
    } finally {
      setActionId(null);
    }
  }

  async function rejectRequest(item: LocalNotificationItem): Promise<void> {
    const requestId = item.request_id;
    const url = getWorkerAUrl();
    if (!requestId || !url || !getOwnerJwt()) return;
    setActionId(item.id);
    try {
      const client = createWorkerAClient({ baseUrl: url, getJwt: getOwnerJwt });
      await client.rejectFriendRequest(requestId);
      showToast(t('friendReject'));
      setItems((prev) => prev.filter((n) => n.id !== item.id));
    } catch (err) {
      showToast(err instanceof ApiError ? err.displayMessage : t('friendUriInvalid'), 'error');
    } finally {
      setActionId(null);
    }
  }

  if (!ownerCredentialsReady.value) {
    return <p class="text-sm text-zinc-500 dark:text-zinc-400">{t('commonCheckingLogin')}</p>;
  }

  if (loading) {
    return <p class="text-sm text-zinc-500 dark:text-zinc-400">{t('notificationsLoading')}</p>;
  }

  return (
    <section class="mx-auto w-full max-w-xl">
      <header class="mb-4 flex items-center justify-between gap-3 border-b border-zinc-200 pb-3 dark:border-zinc-800">
        <h1 class="text-xl font-bold text-zinc-900 dark:text-zinc-50">{t('notificationsTitle')}</h1>
        <button
          type="button"
          class="rounded-full border border-zinc-300 px-3 py-1 text-sm text-zinc-700 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-900"
          disabled={marking || items.length === 0}
          onClick={() => void markAllRead()}
        >
          {t('notificationsMarkAllRead')}
        </button>
      </header>

      {error && (
        <p class="mb-4 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-200">
          {error}
        </p>
      )}

      {items.length === 0 ? (
        <p class="text-sm text-zinc-500 dark:text-zinc-400">{t('notificationsEmpty')}</p>
      ) : (
        <ul class="divide-y divide-zinc-200 dark:divide-zinc-800">
          {items.map((item) => (
            <li
              key={item.id}
              class={
                'px-1 py-3 text-sm ' +
                (item.type === 'friend_request_cancelled'
                  ? 'text-fg3'
                  : item.read_at
                    ? 'text-zinc-600 dark:text-zinc-400'
                    : 'font-medium text-zinc-900 dark:text-zinc-50')
              }
              data-testid={
                item.type === 'friend_request_cancelled'
                  ? 'notification-friend-cancelled'
                  : undefined
              }
            >
              <p>{describeNotification(item)}</p>
              {item.type === 'friend_request_received' && (
                <div class="mt-1">
                  <span
                    class="inline-flex items-center gap-1 rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-800 dark:border-amber-700/60 dark:bg-amber-950/40 dark:text-amber-300"
                    data-testid="notification-friend-unverified-badge"
                    title={t('friendUnverifiedFirstContactNotice')}
                  >
                    <ShieldAlert size={10} aria-hidden="true" />
                    {t('friendUnverifiedFirstContact')}
                  </span>
                </div>
              )}
              {item.type === 'friend_request_received' && item.content_preview && (
                <p class="mt-1 text-xs font-normal text-zinc-500 dark:text-zinc-400" data-testid="notification-friend-preview">
                  {item.content_preview}
                </p>
              )}
              {item.type === 'friend_request_received' && item.request_id && (
                <div class="mt-2 flex flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={actionId === item.id}
                    class="rounded-full bg-sky-600 px-3 py-1 text-xs font-semibold text-white hover:bg-sky-700 disabled:cursor-not-allowed disabled:opacity-50"
                    onClick={() => setAcceptNotifItem(item)}
                    data-testid="notification-friend-accept"
                    aria-label={t('friendAccept')}
                  >
                    {t('friendAccept')}
                  </button>
                  <button
                    type="button"
                    disabled={actionId === item.id}
                    class="rounded-full border border-zinc-300 px-3 py-1 text-xs font-semibold text-zinc-700 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-200"
                    onClick={() => void rejectRequest(item)}
                    data-testid="notification-friend-reject"
                    aria-label={t('friendReject')}
                  >
                    {t('friendReject')}
                  </button>
                  <a
                    href="/messages?tab=contacts"
                    class="rounded-full border border-sky-300 px-3 py-1 text-xs font-semibold text-sky-700 hover:bg-sky-50 dark:border-sky-700 dark:text-sky-300 dark:hover:bg-sky-950"
                    data-testid="notification-friend-view"
                  >
                    {t('friendRequestViewDetail')}
                  </a>
                </div>
              )}
              {item.type === 'friend_request_accepted' && (
                <p class="mt-2">
                  <a
                    href="/messages"
                    class="text-xs font-semibold text-sky-600 hover:underline dark:text-sky-400"
                  >
                    {t('navMessages')}
                  </a>
                </p>
              )}
              {/* REL-FIX-11：发起方撤回通知 → 深链到通讯录面板的「发出的请求」段。
                  request_id 即 friend_requests.id，可与列表行精确对应。 */}
              {item.type === 'friend_request_withdrawn' && (
                <p class="mt-2">
                  <a
                    href={`/messages?tab=contacts&request=${encodeURIComponent(item.request_id ?? '')}`}
                    class="text-xs font-semibold text-sky-600 hover:underline dark:text-sky-400"
                    data-testid="notification-friend-withdrawn-view"
                  >
                    {t('friendRequestViewDetail')}
                  </a>
                </p>
              )}
              {item.type === 'group_join_request_received' && (
                <p class="mt-2">
                  {/* REL-FIX-5：深链到具体群的待审批段（request_id = 群 id）。
                      群主点通知即可直达「群设置 → 入群申请」，不必自己在群列表里找。 */}
                  <a
                    href={`/groups?group=${encodeURIComponent(item.request_id ?? '')}&pending=1`}
                    class="text-xs font-semibold text-sky-600 hover:underline dark:text-sky-400"
                    data-testid="notification-group-join-view"
                  >
                    {t('groupJoinRequestView')}
                  </a>
                </p>
              )}
              {/* REL-FIX-7：入群审批结果 → 跳群聊页 */}
              {(item.type === 'group_join_approved' || item.type === 'group_join_rejected') && (
                <p class="mt-2">
                  <a
                    href="/groups"
                    class="text-xs font-semibold text-sky-600 hover:underline dark:text-sky-400"
                    data-testid="notification-group-decision-view"
                  >
                    {t('groupJoinDecisionView')}
                  </a>
                </p>
              )}
              <p class="mt-1 text-xs text-fg3">
                {formatRelativeTime(item.created_at)}
                {!item.read_at && <span class="ml-2 text-sky-600 dark:text-sky-400">{t('notificationsUnread')}</span>}
              </p>
            </li>
          ))}
        </ul>
      )}
      {acceptNotifItem && (
        <FriendAcceptConfirmDialog
          open={Boolean(acceptNotifItem)}
          pending={actionId === acceptNotifItem.id}
          handle={acceptNotifItem.actor_handle}
          nodeUrl={acceptNotifItem.actor_node_url || acceptNotifItem.related_node_url || ''}
          onCancel={() => {
            if (!actionId) setAcceptNotifItem(null);
          }}
          onConfirm={async () => {
            const notif = acceptNotifItem;
            if (!notif) return;
            await acceptRequest(notif);
            setAcceptNotifItem(null);
          }}
        />
      )}
    </section>
  );
}
