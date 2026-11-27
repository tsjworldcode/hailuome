/** @jsxImportSource preact */
/**
 * 退出确认弹窗：替换浏览器原生 confirm，保证桌面/移动端视觉一致。
 */
import type { VNode } from 'preact';
import { createPortal } from 'preact/compat';
import { useEffect, useState } from 'preact/hooks';
import { LogOut, X } from 'lucide-preact';
import { t } from '../lib/i18n';

interface Props {
  readonly pending: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}

export function LogoutConfirmDialog({ pending, onCancel, onConfirm }: Props): VNode {
  const [portalRoot, setPortalRoot] = useState<HTMLElement | null>(null);

  useEffect(() => {
    const handleKeydown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !pending) onCancel();
    };
    window.addEventListener('keydown', handleKeydown);
    return () => window.removeEventListener('keydown', handleKeydown);
  }, [onCancel, pending]);

  useEffect(() => {
    setPortalRoot(document.body);
    const originalOverflow = document.body.style.overflow;
    // 弹窗打开时锁住页面滚动，遮罩层接管点击，避免误触背景导航。
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = originalOverflow;
    };
  }, []);

  if (!portalRoot) return <></>;

  return createPortal(
    <div
      class="pointer-events-auto fixed inset-0 z-[9999] flex min-h-[100dvh] items-center justify-center bg-zinc-950/55 px-4 py-6 backdrop-blur-md"
      role="presentation"
      onClick={(event) => {
        if (event.currentTarget === event.target && !pending) onCancel();
      }}
    >
      <section
        class="w-full max-w-[400px] overflow-hidden rounded-2xl border border-zinc-200 bg-white text-zinc-900 shadow-2xl dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50"
        role="dialog"
        aria-modal="true"
        aria-labelledby="logout-confirm-title"
        aria-describedby="logout-confirm-body"
      >
        <div class="flex items-start gap-3 px-6 pt-6 pb-5">
          <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-rose-50 text-rose-600 dark:bg-rose-500/10 dark:text-rose-300">
            <LogOut size={20} strokeWidth={2} aria-hidden="true" />
          </div>
          <div class="min-w-0 flex-1">
            <h2 id="logout-confirm-title" class="text-lg font-bold leading-7" data-i18n="navLogoutDialogTitle">
              {t('navLogoutDialogTitle')}
            </h2>
            <p
              id="logout-confirm-body"
              class="mt-2 text-sm leading-6 text-fg2"
              data-i18n="navLogoutDialogBody"
            >
              {t('navLogoutDialogBody')}
            </p>
          </div>
          <button
            type="button"
            disabled={pending}
            onClick={onCancel}
            class="shrink-0 rounded-full p-1.5 text-zinc-500 transition hover:bg-zinc-100 hover:text-zinc-900 disabled:cursor-not-allowed disabled:opacity-50 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-50"
            aria-label={t('navLogoutDialogCancel')}
            data-i18n-attr="aria-label:navLogoutDialogCancel"
          >
            <X size={18} strokeWidth={2} aria-hidden="true" />
          </button>
        </div>
        <div class="flex items-center justify-end gap-3 border-t border-zinc-100 bg-zinc-50 px-6 py-4 dark:border-zinc-800 dark:bg-zinc-900/70">
          <button
            type="button"
            disabled={pending}
            onClick={onCancel}
            class="rounded-full border border-zinc-300 bg-white px-4 py-2 text-sm font-semibold text-zinc-800 transition hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-600 dark:bg-zinc-950 dark:text-zinc-100 dark:hover:bg-zinc-800"
            data-i18n="navLogoutDialogCancel"
          >
            {t('navLogoutDialogCancel')}
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={onConfirm}
            class="rounded-full bg-sky-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-sky-700 disabled:cursor-wait disabled:opacity-70 dark:bg-sky-500 dark:hover:bg-sky-400"
            data-i18n={pending ? 'navLoggingOut' : 'navLogoutDialogConfirm'}
          >
            {pending ? t('navLoggingOut') : t('navLogoutDialogConfirm')}
          </button>
        </div>
      </section>
    </div>,
    portalRoot,
  );
}
