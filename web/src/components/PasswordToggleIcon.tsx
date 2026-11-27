/** @jsxImportSource preact */
/**
 * 密码显示/隐藏图标（登录页与设置页共用）。
 * visible=true 显示「带斜线的眼睛」（点击将隐藏）；否则显示「眼睛」。
 */
import type { VNode } from 'preact';

export function PasswordToggleIcon({ visible }: { readonly visible: boolean }): VNode {
  if (visible) {
    return (
      <svg viewBox="0 0 24 24" class="h-[18px] w-[18px]" aria-hidden="true">
        <path
          d="M3 3l18 18M10.58 10.58A2 2 0 0012 14a2 2 0 01.42-3.42M9.88 5.09A10.94 10.94 0 0112 5c5 0 8.22 3.06 9.94 8-1.02 2.94-3.12 5.36-5.88 6.91M6.1 6.1C3.56 7.72 1.78 10.16 1.06 12c1.72 4.94 6.4 8 9.94 8 1.12 0 2.2-.19 3.22-.54"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
        />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" class="h-[18px] w-[18px]" aria-hidden="true">
      <path
        d="M2.06 12c1.72-4.94 6.4-8 9.94-8s8.22 3.06 9.94 8c-1.72 4.94-6.4 8-9.94 8s-8.22-3.06-9.94-8z"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
      />
      <circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="2" />
    </svg>
  );
}
