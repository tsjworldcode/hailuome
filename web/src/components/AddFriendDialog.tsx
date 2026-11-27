/** @jsxImportSource preact */
/**
 * UX-MSG-LEFT-1：消息页左栏「加好友」弹窗。
 *
 * 两种输入都支持：
 *   ① handle（如 hailuo-xxxx）→ 经本机 Worker A `lookup` 找到对方节点后发请求；
 *   ② 好友分享的 `hailuo://add-friend?...` 链接 → 直接解析出 handle + 节点。
 * 请求发出后只提示「已发送」，不跳页；对方同意后会出现在左栏好友列表。
 */
import type { VNode } from 'preact';
import { useState } from 'preact/hooks';
import { getOwnerJwt, getWorkerAUrl } from '../lib/auth';
import { createWorkerAClient } from '../lib/workerA';
import { ApiError } from '../lib/errors';
import { parseAddFriendUri } from '../lib/hailuoUri';
import { t } from '../lib/i18n';
import { showToast } from '../lib/toast';
import { GroupModal } from './GroupActionsPanel';

interface Props {
  readonly open: boolean;
  readonly onClose: () => void;
}

function makeClient() {
  const baseUrl = getWorkerAUrl();
  const jwt = getOwnerJwt();
  if (!baseUrl || !jwt) return null;
  return createWorkerAClient({ baseUrl, getJwt: getOwnerJwt });
}

export function AddFriendDialog({ open, onClose }: Props): VNode {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function close(): void {
    if (busy) return;
    setError(null);
    setValue('');
    onClose();
  }

  async function submit(): Promise<void> {
    const raw = value.trim();
    if (!raw || busy) return;
    const client = makeClient();
    if (!client) {
      setError(t('ownerConfigureWriteLayer'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // 先按加好友链接解析；不是链接时按 handle 走 lookup 找节点
      const parsed = parseAddFriendUri(raw);
      let targetHandle: string;
      let targetNodeUrl: string;
      if (parsed.ok) {
        targetHandle = parsed.data.handle;
        targetNodeUrl = parsed.data.node;
      } else if (raw.toLowerCase().startsWith('hailuo:')) {
        setError(t('friendUriInvalid'));
        return;
      } else {
        const looked = await client.lookup(raw);
        const nodeUrl = (looked.worker_b_url ?? looked.node_url ?? '').trim();
        if (!nodeUrl) {
          setError(t('messagesAddFriendNotFound'));
          return;
        }
        targetHandle = looked.handle || raw;
        targetNodeUrl = nodeUrl;
      }
      await client.sendFriendRequest({
        target_node_url: targetNodeUrl,
        target_handle: targetHandle,
      });
      showToast(t('friendSent'));
      setValue('');
      setError(null);
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.displayMessage : t('messagesAddFriendNotFound'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <GroupModal open={open} title={t('addFriend')} onClose={close}>
      <label class="mb-2 block text-sm font-medium" for="dm-add-friend-input">
        {t('messagesAddFriendInputLabel')}
      </label>
      <input
        id="dm-add-friend-input"
        class="mb-2 w-full rounded-xl border border-zinc-200 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950"
        placeholder={t('messagesAddFriendInputPlaceholder')}
        value={value}
        disabled={busy}
        onInput={(e) => {
          setValue((e.target as HTMLInputElement).value);
          setError(null);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            void submit();
          }
        }}
        data-testid="messages-add-friend-input"
      />
      <p class="mb-4 text-xs leading-5 text-zinc-500 dark:text-zinc-400">
        {t('messagesAddFriendHint')}
      </p>
      {error && (
        <p class="mb-3 rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700 dark:bg-rose-950/40 dark:text-rose-200" role="alert">
          {error}
        </p>
      )}
      <div class="flex justify-end gap-2">
        <button type="button" class="rounded-xl px-3 py-2 text-sm" onClick={close} disabled={busy}>
          {t('messagesNewChatCancel')}
        </button>
        <button
          type="button"
          class="rounded-xl bg-gradient-to-br from-sky-500 to-sky-600 px-4 py-2 text-sm font-semibold text-white shadow-sm shadow-sky-500/25 disabled:cursor-not-allowed disabled:opacity-50"
          disabled={busy || !value.trim()}
          onClick={() => void submit()}
        >
          {busy ? t('registryCertifySubmitting') : t('addFriend')}
        </button>
      </div>
    </GroupModal>
  );
}
