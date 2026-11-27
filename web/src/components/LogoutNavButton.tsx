/** @jsxImportSource preact */
/**
 * 左侧导航底部「退出」按钮（仅已登录态由 Layout 渲染）。
 * 共用电脑：退出时清 JWT、粉丝 Token 与本机 IndexedDB。
 */
import type { VNode } from 'preact';
import { useState } from 'preact/hooks';
import { LogOut } from 'lucide-preact';
import { logoutOwnerAndReload } from '../lib/ownerSession';
import { t } from '../lib/i18n';
import { LogoutConfirmDialog } from './LogoutConfirmDialog';

export function LogoutNavButton(): VNode {
  const [pending, setPending] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

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
        onClick={() => {
          if (pending) return;
          setConfirmOpen(true);
        }}
        class="flex w-full items-center justify-center gap-0 rounded-full px-3 py-3 text-xl font-normal text-zinc-700 transition hover:bg-zinc-100 hover:text-rose-700 disabled:opacity-60 dark:text-zinc-300 dark:hover:bg-zinc-800 dark:hover:text-rose-400 lg:justify-start lg:gap-3"
        aria-label={pending ? t('navLoggingOut') : t('navLogout')}
        title={pending ? t('navLoggingOut') : t('navLogout')}
        data-i18n-attr="aria-label:navLogout"
      >
        <LogOut size={26} strokeWidth={2} class="shrink-0" aria-hidden="true" />
        {/* UX-APPLE-1b：lg+ 显示「退出」文案 */}
        <span class="hidden truncate text-[15px] font-medium lg:inline" data-i18n={pending ? 'navLoggingOut' : 'navLogout'}>
          {pending ? t('navLoggingOut') : t('navLogout')}
        </span>
      </button>
      {confirmOpen && (
        <LogoutConfirmDialog pending={pending} onCancel={() => setConfirmOpen(false)} onConfirm={confirmLogout} />
      )}
    </>
  );
}
