/** @jsxImportSource preact */
/**
 * 通用确认弹窗：替换 window.confirm，视觉与 LogoutConfirmDialog 一致。
 */
import type { VNode, ComponentChildren } from 'preact';
import { createPortal } from 'preact/compat';
import { useEffect, useId, useState } from 'preact/hooks';
import { X } from 'lucide-preact';

interface Props {
  readonly open: boolean;
  readonly pending?: boolean;
  readonly title: string;
  readonly body: ComponentChildren;
  readonly confirmLabel: string;
  readonly cancelLabel: string;
  readonly confirmPendingLabel?: string;
  readonly icon?: VNode;
  readonly confirmClassName?: string;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}

export function ConfirmDialog({
  open,
  pending = false,
  title,
  body,
  confirmLabel,
  cancelLabel,
  confirmPendingLabel,
  icon,
  confirmClassName = 'rounded-full bg-sky-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-sky-700 disabled:cursor-wait disabled:opacity-70 dark:bg-sky-500 dark:hover:bg-sky-400',
  onCancel,
  onConfirm,
}: Props): VNode {
  const [portalRoot, setPortalRoot] = useState<HTMLElement | null>(null);
  const titleId = useId();
  const bodyId = useId();

  useEffect(() => {
    // 与 LogoutConfirmDialog 一致：挂载时即准备 portal，避免 open 首帧 portalRoot 为空导致漏渲染
    setPortalRoot(document.body);
  }, []);

  useEffect(() => {
    if (!open) return;
    const handleKeydown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !pending) onCancel();
    };
    window.addEventListener('keydown', handleKeydown);
    return () => window.removeEventListener('keydown', handleKeydown);
  }, [onCancel, open, pending]);

  useEffect(() => {
    if (!open) return;
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = originalOverflow;
    };
  }, [open]);

  if (!open || !portalRoot) return <></>;

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
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        onClick={(event) => event.stopPropagation()}
      >
        <div class="flex items-start gap-3 px-6 pt-6 pb-5">
          {icon && (
            <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-rose-50 text-rose-600 dark:bg-rose-500/10 dark:text-rose-300">
              {icon}
            </div>
          )}
          <div class="min-w-0 flex-1">
            <h2 id={titleId} class="text-lg font-bold leading-7">
              {title}
            </h2>
            <div id={bodyId} class="mt-2 text-sm leading-6 text-fg2">
              {body}
            </div>
          </div>
          <button
            type="button"
            disabled={pending}
            onClick={onCancel}
            class="shrink-0 rounded-full p-1.5 text-zinc-500 transition hover:bg-zinc-100 hover:text-zinc-900 disabled:cursor-not-allowed disabled:opacity-50 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-50"
            aria-label={cancelLabel}
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
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={onConfirm}
            class={confirmClassName}
          >
            {pending && confirmPendingLabel ? confirmPendingLabel : confirmLabel}
          </button>
        </div>
      </section>
    </div>,
    portalRoot,
  );
}
