/** @jsxImportSource preact */
/**
 * 移动端退出按钮：复用站主退出清理逻辑，用于顶部栏和底部栏。
 */
import type { VNode } from 'preact';
import { useState } from 'preact/hooks';
import { LogOut } from 'lucide-preact';
import { logoutOwnerAndReload } from '../lib/ownerSession';
import { t } from '../lib/i18n';
import { LogoutConfirmDialog } from './LogoutConfirmDialog';

interface Props {
  readonly variant: 'top' | 'bottom';
}

export function MobileLogoutButton({ variant }: Props): VNode {
  const [pending, setPending] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const baseLabel = pending ? t('navLoggingOut') : t('navLogout');
  const topCls =
    'flex h-10 shrink-0 items-center justify-center rounded-full px-3 text-xs font-medium text-zinc-600 transition hover:bg-zinc-100 hover:text-rose-700 disabled:opacity-60 dark:text-zinc-300 dark:hover:bg-zinc-800 dark:hover:text-rose-400';
  const bottomCls =
    'flex flex-1 flex-col items-center justify-center gap-0.5 px-1 py-1.5 text-[10px] font-normal text-zinc-600 transition hover:text-rose-700 disabled:opacity-60 dark:text-zinc-400 dark:hover:text-rose-400';

  const confirmLogout = (): void => {
    if (pending) return;
    setPending(true);
    // logoutOwnerAndReload 同步清凭证并 replace 跳转，返回 void（无 Promise）
    logoutOwnerAndReload();
  };

  return (
    <>
      <button
        type="button"
        disabled={pending}
        class={variant === 'top' ? topCls : bottomCls}
        aria-label={baseLabel}
        title={baseLabel}
        onClick={() => {
          if (pending) return;
          // 退出会清理本机登录态和本地缓存，先打开应用内确认弹窗，避免手机顶部误触。
          setConfirmOpen(true);
        }}
      >
        {variant === 'bottom' && <LogOut size={22} strokeWidth={2} aria-hidden="true" />}
        <span>{baseLabel}</span>
      </button>
      {confirmOpen && (
        <LogoutConfirmDialog pending={pending} onCancel={() => setConfirmOpen(false)} onConfirm={confirmLogout} />
      )}
    </>
  );
}
