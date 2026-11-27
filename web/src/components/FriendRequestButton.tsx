/** @jsxImportSource preact */
/**
 * M17-2：加好友按钮（未知 / 已关注 / 已发请求 / 已是好友 / 收到请求）
 */
import type { VNode } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { UserPlus, UserCheck, UserX, ShieldAlert } from 'lucide-preact';
import { getOwnerJwt, getWorkerAUrl } from '../lib/auth';
import { createWorkerAClient } from '../lib/workerA';
import { ApiError } from '../lib/errors';
import { t } from '../lib/i18n';
import { showToast } from '../lib/toast';
import { ConfirmDialog } from './ConfirmDialog';
import { FriendAcceptConfirmDialog } from './FriendAcceptConfirmDialog';
import { FriendDeliveryBadge } from './FriendDeliveryBadge';
import { resendFriendRequest } from '../lib/friendRequestResend';

export type FriendRelation =
  | 'unknown'
  | 'following'
  | 'outgoing_pending'
  | 'friends'
  | 'incoming_pending';

interface Props {
  readonly target_node_url: string;
  readonly target_handle: string;
  readonly display_name?: string;
  readonly relation: FriendRelation;
  /** 撤回 / 同意时需要 */
  readonly request_id?: string;
  /**
   * REL-FIX-4：发起侧投递回执（后端 `inbox_status` / `inbox_error`）。
   * 仅 `outgoing_pending` 关系下有意义；用于显示「已送达 / 重试中 / 对方可能未收到」。
   */
  readonly delivery_status?: string | undefined;
  readonly delivery_error?: string | undefined;
  /** REL-FIX-4：重新发起时沿用原附言（撤回旧请求 + 重建新请求） */
  readonly message?: string | null | undefined;
  /**
   * REL-FIX-13：是否在按钮侧渲染投递状态徽章。
   *
   * 默认 true（推荐行等独立场景用）。面板 outgoing 行左侧已渲染徽章，
   * 置 false 后按钮侧只保留「重新发起」入口，避免同一行出现两个相同药丸。
   */
  readonly showDeliveryBadge?: boolean;
  readonly onChanged?: (next: FriendRelation, requestId?: string) => void;
  readonly className?: string;
}

const MESSAGE_MAX = 200;

function makeClient() {
  const baseUrl = getWorkerAUrl();
  const jwt = getOwnerJwt();
  if (!baseUrl || !jwt) return null;
  return createWorkerAClient({ baseUrl, getJwt: getOwnerJwt });
}

export function FriendRequestButton(props: Props): VNode {
  const [relation, setRelation] = useState<FriendRelation>(props.relation);
  const [requestId, setRequestId] = useState<string | undefined>(props.request_id);
  const [busy, setBusy] = useState(false);
  const [sendOpen, setSendOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [acceptOpen, setAcceptOpen] = useState(false);
  const [message, setMessage] = useState('');
  // REL-FIX-4：投递回执本地副本（props 同步进来；重新发起成功后本地清空为"投递中"，
  // 避免父组件未刷新时仍显示旧的"对方可能未收到"）。
  const [deliveryStatus, setDeliveryStatus] = useState<string | undefined>(props.delivery_status);
  const [deliveryError, setDeliveryError] = useState<string | undefined>(props.delivery_error);

  useEffect(() => {
    setRelation(props.relation);
    setRequestId(props.request_id);
    setDeliveryStatus(props.delivery_status);
    setDeliveryError(props.delivery_error);
  }, [props.relation, props.request_id, props.delivery_status, props.delivery_error]);

  const label = props.display_name || props.target_handle;

  async function send(): Promise<void> {
    const client = makeClient();
    if (!client) {
      showToast(t('ownerConfigureWriteLayer'), 'error');
      return;
    }
    setBusy(true);
    try {
      const trimmed = message.trim().slice(0, MESSAGE_MAX);
      const result = await client.sendFriendRequest({
        target_node_url: props.target_node_url,
        target_handle: props.target_handle,
        ...(trimmed ? { message: trimmed } : {}),
      });
      setRelation('outgoing_pending');
      setRequestId(result.id);
      // REL-FIX-4：新请求的投递回执回到"投递中"（清掉上一条的 giveup 残留）
      setDeliveryStatus('');
      setDeliveryError('');
      setSendOpen(false);
      setMessage('');
      showToast(t('friendSent'));
      props.onChanged?.('outgoing_pending', result.id);
    } catch (err) {
      // M-F4：失败必须关掉弹窗，否则确认按钮永久禁用 → 弹窗卡死
      setSendOpen(false);
      showToast(err instanceof ApiError ? err.displayMessage : t('friendUriInvalid'), 'error');
    } finally {
      setBusy(false);
    }
  }

  /**
   * REL-FIX-4：投递 giveup 后的「重新发起」。
   *
   * 走共享 helper（`lib/friendRequestResend.ts`）：先撤回旧的 pending 请求
   * （释放后端 UNIQUE 部分索引 `uniq_friend_requests_pending` 的位），再用原附言重发。
   * 面板行与推荐行内联按钮共用同一份语义，避免两套实现走偏。
   */
  async function resend(): Promise<void> {
    const client = makeClient();
    if (!client) {
      showToast(t('ownerConfigureWriteLayer'), 'error');
      return;
    }
    if (!requestId) {
      // 没有旧请求 id（理论上不该发生）→ 直接走普通发起
      setSendOpen(true);
      return;
    }
    setBusy(true);
    try {
      const result = await resendFriendRequest({
        client,
        requestId,
        target_node_url: props.target_node_url,
        target_handle: props.target_handle,
        message: props.message,
      });
      if (!result.ok) {
        // REL-FIX-13：重发全程**不解析任何链接** → 不能再报「加好友链接无效」。
        // 按 helper 返回的脱敏 reason 映射到准确文案。
        showToast(
          result.reason === 'cancel_failed'
            ? t('friendResendFailedCancel')
            : t('friendResendFailedSend'),
          'error',
        );
        return;
      }
      setRelation('outgoing_pending');
      setRequestId(result.requestId);
      // 新请求的投递回执回到"投递中"（清掉上一条的 giveup 残留）
      setDeliveryStatus('');
      setDeliveryError('');
      showToast(t('friendSent'));
      props.onChanged?.('outgoing_pending', result.requestId);
    } catch (err) {
      // helper 内部已吞掉业务异常；到这里是意外异常 → 通用失败文案（非链接问题）
      showToast(
        err instanceof ApiError ? err.displayMessage : t('friendResendFailedSend'),
        'error',
      );
    } finally {
      setBusy(false);
    }
  }

  async function cancel(): Promise<void> {
    const client = makeClient();
    if (!client || !requestId) {
      showToast(t('ownerConfigureWriteLayer'), 'error');
      return;
    }
    setBusy(true);
    try {
      await client.cancelFriendRequest(requestId);
      // 撤回后：若当前仍显示「已关注」语境则回 following，否则 unknown
      const next: FriendRelation = relation === 'following' ? 'following' : 'unknown';
      setRelation(next);
      setRequestId(undefined);
      setCancelOpen(false);
      showToast(t('friendCancel'));
      props.onChanged?.(next);
    } catch (err) {
      // M-F4：撤回失败同样关弹窗，避免确认框永久禁用
      setCancelOpen(false);
      showToast(err instanceof ApiError ? err.displayMessage : t('friendUriInvalid'), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function accept(): Promise<void> {
    const client = makeClient();
    if (!client || !requestId) {
      showToast(t('ownerConfigureWriteLayer'), 'error');
      return;
    }
    setBusy(true);
    try {
      await client.acceptFriendRequest(requestId);
      setRelation('friends');
      showToast(t('friendAccept'));
      props.onChanged?.('friends', requestId);
    } catch (err) {
      showToast(err instanceof ApiError ? err.displayMessage : t('friendUriInvalid'), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function reject(): Promise<void> {
    const client = makeClient();
    if (!client || !requestId) {
      showToast(t('ownerConfigureWriteLayer'), 'error');
      return;
    }
    setBusy(true);
    try {
      await client.rejectFriendRequest(requestId);
      setRelation('unknown');
      setRequestId(undefined);
      showToast(t('friendReject'));
      props.onChanged?.('unknown');
    } catch (err) {
      showToast(err instanceof ApiError ? err.displayMessage : t('friendUriInvalid'), 'error');
    } finally {
      setBusy(false);
    }
  }

  if (relation === 'friends') {
    return (
      <span
        data-friend-relation={relation}
        class={
          props.className ??
          'inline-flex h-8 items-center gap-1 rounded-full border border-zinc-300 px-3 text-xs font-semibold text-zinc-600 dark:border-zinc-700 dark:text-zinc-300'
        }
        aria-label={t('friendAlready')}
        data-testid="friend-request-already"
      >
        <UserCheck size={14} aria-hidden="true" />
        {t('friendAlready')}
      </span>
    );
  }

  if (relation === 'incoming_pending') {
    return (
      <div
        data-friend-relation={relation}
        class="inline-flex flex-wrap items-center gap-2"
        data-testid="friend-request-incoming"
      >
                <span
          class="inline-flex items-center gap-1 rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-800 dark:border-amber-700/60 dark:bg-amber-950/40 dark:text-amber-300"
          data-testid="friend-unverified-badge"
          title={t('friendUnverifiedFirstContactNotice')}
        >
          <ShieldAlert size={10} aria-hidden="true" />
          {t('friendUnverifiedFirstContact')}
        </span>
        <span class="text-xs text-zinc-500 dark:text-zinc-400">{t('friendRelationIncoming')}</span>
        <button
          type="button"
          disabled={busy || !requestId}
          onClick={() => setAcceptOpen(true)}
          class="inline-flex h-8 items-center gap-1 rounded-full bg-sky-600 px-3 text-xs font-semibold text-white hover:bg-sky-700 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-sky-500"
          aria-label={t('friendAccept')}
          data-testid="friend-request-accept"
        >
          {t('friendAccept')}
        </button>
        <button
          type="button"
          disabled={busy || !requestId}
          onClick={() => void reject()}
          class="inline-flex h-8 items-center gap-1 rounded-full border border-zinc-300 px-3 text-xs font-semibold text-zinc-700 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-900"
          aria-label={t('friendReject')}
          data-testid="friend-request-reject"
        >
          <UserX size={14} aria-hidden="true" />
          {t('friendReject')}
        </button>
        <FriendAcceptConfirmDialog
          open={acceptOpen}
          pending={busy}
          handle={label}
          nodeUrl={props.target_node_url}
          onCancel={() => {
            if (!busy) setAcceptOpen(false);
          }}
          onConfirm={async () => {
            await accept();
            setAcceptOpen(false);
          }}
        />
      </div>
    );
  }

  if (relation === 'outgoing_pending') {
    return (
      <>
        <button
          type="button"
          data-friend-relation={relation}
          disabled={busy}
          onClick={() => setCancelOpen(true)}
          class={
            props.className ??
            'inline-flex h-8 items-center gap-1 rounded-full border border-amber-300 bg-amber-50 px-3 text-xs font-semibold text-amber-800 hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200'
          }
          aria-label={t('friendCancel')}
          data-testid="friend-request-cancel"
        >
          {t('friendSent')} · {t('friendCancel')}
        </button>
        {/* REL-FIX-4：投递回执徽章（已送达 / 重试中 / 对方可能未收到 + 重新发起）
            REL-FIX-13：面板 outgoing 行左侧已渲染徽章 → 此处关掉徽章本体，
            只保留「重新发起」入口，避免同行出现两个相同药丸。 */}
        <FriendDeliveryBadge
          inbox_status={deliveryStatus}
          inbox_error={deliveryError}
          showHint={false}
          showBadge={props.showDeliveryBadge !== false}
          onRetry={() => void resend()}
          retryDisabled={busy}
        />
        <ConfirmDialog
          open={cancelOpen}
          pending={busy}
          title={t('friendCancel')}
          body={<p>{t('friendCancelConfirm', undefined, { handle: label })}</p>}
          cancelLabel={t('localDataCancel')}
          confirmLabel={t('friendCancel')}
          confirmPendingLabel={t('followsDeleting')}
          confirmClassName="rounded-full bg-rose-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-rose-700 disabled:cursor-wait disabled:opacity-70 dark:bg-rose-500 dark:hover:bg-rose-400"
          onCancel={() => {
            if (!busy) setCancelOpen(false);
          }}
          onConfirm={() => void cancel()}
        />
      </>
    );
  }

  // unknown | following — 仍可发加好友请求
  return (
    <>
      <button
        type="button"
        data-friend-relation={relation}
        disabled={busy}
        onClick={() => setSendOpen(true)}
        class={
          props.className ??
          'inline-flex h-8 items-center gap-1 rounded-full bg-zinc-950 px-3 text-xs font-semibold text-white transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-white dark:text-zinc-950 dark:hover:bg-zinc-200'
        }
        aria-label={t('addFriend')}
        data-testid="friend-request-add"
        title={relation === 'following' ? t('friendRelationFollowing') : t('addFriend')}
      >
        <UserPlus size={14} aria-hidden="true" />
        {relation === 'following' ? `${t('friendRelationFollowing')} · ${t('addFriend')}` : t('addFriend')}
      </button>
      <ConfirmDialog
        open={sendOpen}
        pending={busy}
        title={t('addFriend')}
        body={
          <div class="space-y-3">
            <p>{t('friendSendConfirm', undefined, { handle: label })}</p>
            <label class="block text-xs text-zinc-500 dark:text-zinc-400">
              {t('friendMessageHint')}
              <textarea
                class="mt-1 w-full rounded-xl border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 focus:border-sky-500 focus:outline-none focus:ring-2 focus:ring-sky-400/40 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50"
                rows={3}
                maxLength={MESSAGE_MAX}
                value={message}
                onInput={(e) => setMessage((e.currentTarget as HTMLTextAreaElement).value)}
                disabled={busy}
                data-testid="friend-request-message"
              />
            </label>
          </div>
        }
        cancelLabel={t('localDataCancel')}
        confirmLabel={t('addFriend')}
        confirmPendingLabel={t('registryCertifySubmitting')}
        onCancel={() => {
          if (!busy) {
            setSendOpen(false);
            setMessage('');
          }
        }}
        onConfirm={() => void send()}
      />
    </>
  );
}
