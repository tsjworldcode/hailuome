/** @jsxImportSource preact */
/**
 * 好友请求接受二次确认弹窗（SEC-AUDIT-2026-10-3 P1-1 第一刀防御共用组件）
 * 集中管理好友请求接受拦截确认、来源节点展示、钓鱼警告与核验链接，避免三处入口冗余复制。
 */
import type { VNode } from 'preact';
import { ShieldAlert, ShieldCheck, ExternalLink } from 'lucide-preact';
import { t } from '../lib/i18n';
import { ConfirmDialog } from './ConfirmDialog';

export interface FriendAcceptConfirmDialogProps {
  readonly open: boolean;
  readonly pending?: boolean;
  readonly handle: string;
  readonly nodeUrl: string;
  readonly firstSeen?: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: () => void | Promise<void>;
}

export function FriendAcceptConfirmDialog({
  open,
  pending = false,
  handle,
  nodeUrl,
  firstSeen,
  onCancel,
  onConfirm,
}: FriendAcceptConfirmDialogProps): VNode {
  // 提取用于展示和点击的安全外部公开页 URL（站主可直接核验对方节点资料）
  let peerProfileUrl: string | null = null;
  try {
    if (nodeUrl && (nodeUrl.startsWith('https://') || nodeUrl.startsWith('http://'))) {
      const trimmed = nodeUrl.replace(new RegExp('/+$'), '');
      peerProfileUrl = `${trimmed}/users/${encodeURIComponent(handle)}`;
    }
  } catch {
    peerProfileUrl = null;
  }

  return (
    <ConfirmDialog
      open={open}
      pending={pending}
      title={t('friendAcceptConfirmTitle')}
      body={
        <div class="space-y-2.5 text-sm text-zinc-600 dark:text-zinc-300">
          <p>
            {t('friendAcceptConfirmBody', undefined, {
              handle,
              nodeUrl,
            })}
          </p>
          {peerProfileUrl && (
            <div class="text-xs">
              <a
                href={peerProfileUrl}
                target="_blank"
                rel="noopener noreferrer"
                class="inline-flex items-center gap-1 text-sky-600 underline hover:text-sky-700 dark:text-sky-400 dark:hover:text-sky-300"
                data-testid="friend-accept-verify-link"
              >
                <span>{nodeUrl}</span>
                <ExternalLink size={12} aria-hidden="true" />
              </a>
            </div>
          )}
        {firstSeen === false ? (
          <div
            class="flex items-start gap-1.5 rounded-lg border border-emerald-200 bg-emerald-50 p-2 text-xs text-emerald-800 dark:border-emerald-800/50 dark:bg-emerald-950/40 dark:text-emerald-300"
            data-testid="friend-accept-pinned-box"
          >
            <ShieldCheck size={14} class="shrink-0 mt-0.5" aria-hidden="true" />
            <p>来源节点公钥与本地关注 Pin 一致，身份比对已通过，可安全接受。</p>
          </div>
        ) : (
          <div
            class="flex items-start gap-1.5 rounded-lg border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800 dark:border-amber-800/50 dark:bg-amber-950/40 dark:text-amber-300"
            data-testid="friend-accept-warning-box"
          >
            <ShieldAlert size={14} class="shrink-0 mt-0.5" aria-hidden="true" />
            <p>{t('friendUnverifiedFirstContactNotice')}</p>
          </div>
        )}
        </div>
      }
      cancelLabel={t('localDataCancel')}
      confirmLabel={t('friendAccept')}
      confirmPendingLabel={t('friendAccept')}
      onCancel={onCancel}
      onConfirm={onConfirm}
    />
  );
}
