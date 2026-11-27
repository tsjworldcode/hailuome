/** @jsxImportSource preact */
import type { ComponentChildren } from 'preact';

/**
 * UX-GROUPS-3：操作按钮已并入 GroupListPanel 左侧单栏。
 * 本文件仅保留弹窗壳，供创建/加入/邀请/设置复用。
 */
export interface GroupModalProps {
  readonly open: boolean;
  readonly title: string;
  readonly onClose: () => void;
  readonly children: ComponentChildren;
}

export function GroupModal({ open, title, onClose, children }: GroupModalProps) {
  if (!open) return null;
  return (
    <div
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="group-modal-title"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div class="w-full max-w-md rounded-2xl border border-zinc-200 bg-white p-4 shadow-xl dark:border-zinc-700 dark:bg-zinc-950">
        <h2 id="group-modal-title" class="mb-3 text-lg font-bold text-zinc-900 dark:text-zinc-50">
          {title}
        </h2>
        {children}
      </div>
    </div>
  );
}
