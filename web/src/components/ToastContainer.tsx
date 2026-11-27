/** @jsxImportSource preact */
import type { VNode } from 'preact';
import { X } from 'lucide-preact';
import { toasts, dismissToast, type Toast } from '../lib/toast';
import { t } from '../lib/i18n';

// M7-13（F-13 修复）：toast 通知容器
//
// 设计要点：
// - 订阅 lib/toast.ts 顶层 toasts signal；preact-signals 自动重渲染
// - 固定 bottom-right 浮层；fixed + bottom-4 + right-4 + z-50；mobile-safe（pb-4 + 移动端 safe-area-inset-bottom）
// - 每条 toast：role=status + aria-live=polite + 中文文案 + 右侧 × 按钮（手动 dismiss）
// - kind=info 蓝调，kind=error 红调；dark 变体完整
// - 不渲染时（toasts 为空）整体不挂任何 DOM 节点
// - §F-02 红线：零 import lib/api / lib/workerA / 零 import.meta.env / 零 fetch / 零 storage 直调
// - 接入位置：Layout.astro 顶层（M13-4：`client:idle`）

function ToastItem({ toast }: { toast: Toast }): VNode {
  const baseCls =
    'pointer-events-auto flex items-start gap-2 rounded-lg border px-3 py-2 text-sm shadow-lg backdrop-blur-sm transition-opacity';
  const colorCls =
    toast.kind === 'error'
      ? 'border-rose-300 bg-rose-50/95 text-rose-900 dark:border-rose-700 dark:bg-rose-950/95 dark:text-rose-100'
      : 'border-sky-300 bg-sky-50/95 text-sky-900 dark:border-sky-700 dark:bg-sky-950/95 dark:text-sky-100';
  return (
    <div
      class={`${baseCls} ${colorCls}`}
      role="status"
      aria-live="polite"
      data-toast-kind={toast.kind}
    >
      <span class="min-w-0 flex-1 break-words leading-5">{toast.msg}</span>
      <button
        type="button"
        onClick={() => dismissToast(toast.id)}
        aria-label={t('toastDismiss')}
        class="shrink-0 rounded p-0.5 text-current opacity-70 transition-opacity hover:opacity-100 focus:outline-none focus:ring-1 focus:ring-current"
      >
        <X size={14} strokeWidth={1.75} aria-hidden="true" />
      </button>
    </div>
  );
}

export function ToastContainer(): VNode | null {
  const list = toasts.value;
  if (list.length === 0) return null;
  return (
    <div
      class="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex flex-col items-end gap-2 px-4 sm:bottom-6 sm:right-6 sm:left-auto sm:inset-x-auto sm:max-w-md"
      aria-label={t('toastListAria')}
      data-toast-container
    >
      {list.map((toast) => (
        <ToastItem key={toast.id} toast={toast} />
      ))}
    </div>
  );
}
