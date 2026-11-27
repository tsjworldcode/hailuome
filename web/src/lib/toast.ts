// M7-13（F-13 修复）：轻量 toast 通知模块
//
// 设计要点：
// - 顶层 signal `toasts: Signal<readonly Toast[]>`，整个 web 仅一个队列（ToastContainer 订阅渲染）
// - showToast(msg, kind?) 入队 + 调度 setTimeout 5s 后 dismissToast（卫生：自动收尾不需要调用方手动处理）
// - dismissToast(id) 手动关闭（用户点 × 按钮 / 测试场景）
// - 不读 storage / 不写 storage / 不读 env / 不 fetch / 无 IDB 依赖（toast 自身永不可能 QuotaExceeded）
// - SSR-safe：模块加载阶段不调 setTimeout / 不调 dispatchEvent；首次 showToast 才有副作用
//
// 调用方约定：
//   import { showToast } from '../lib/toast';
//   showToast('本地存储空间已满', 'error');
//
// §F-02 红线：零 import lib/api 与 lib/workerA / 零 import.meta.env / 零 fetch / 零 storage 直调

import { signal } from '@preact/signals';

/** Toast 类型 discriminated union；kind 决定容器配色 */
export type ToastKind = 'info' | 'error';

export interface Toast {
  readonly id: number;
  readonly msg: string;
  readonly kind: ToastKind;
  readonly created_at: number;
}

/** Toast 默认存活时长（5s 与无障碍 aria-live polite 同步） */
export const TOAST_TTL_MS = 5000;

/** 顶层 toast 队列；ToastContainer.tsx 订阅 .value 渲染 */
export const toasts = signal<readonly Toast[]>([]);

/** 单调递增 id 生成器；闭包在模块内 */
let nextId = 1;

/** 加 toast 入队 + 调度 TTL_MS 后自动 dismiss */
export function showToast(msg: string, kind: ToastKind = 'info'): void {
  const id = nextId++;
  const next: Toast = {
    id,
    msg,
    kind,
    created_at: Date.now(),
  };
  toasts.value = [...toasts.value, next];
  // 浏览器侧才调度自动消失；SSR 走静默不会触发渲染
  if (typeof window !== 'undefined') {
    window.setTimeout(() => {
      dismissToast(id);
    }, TOAST_TTL_MS);
  }
}

/** 手动关闭：用户点 × 按钮或测试场景使用 */
export function dismissToast(id: number): void {
  toasts.value = toasts.value.filter((t) => t.id !== id);
}

/** 仅用于测试：清空整个队列 */
export function __resetToasts__(): void {
  toasts.value = [];
}
