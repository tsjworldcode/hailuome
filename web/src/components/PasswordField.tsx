/** @jsxImportSource preact */
/**
 * 密码框 + 右侧显示/隐藏眼睛（登录页与设置页共用）。
 *
 * 视觉零变化约定：**皮肤由调用方传入**（`inputClass` / `toggleClass` 原样使用），
 * 组件只拥有结构（relative 包裹、type 切换、aria 属性、图标），不写死任何颜色/间距。
 */
import type { VNode } from 'preact';
import { t } from '../lib/i18n';
import { PasswordToggleIcon } from './PasswordToggleIcon';

export interface PasswordFieldProps {
  readonly id: string;
  readonly autoComplete: string;
  readonly placeholder?: string;
  readonly value: string;
  readonly visible: boolean;
  readonly inputClass: string;
  readonly toggleClass: string;
  readonly onInput: (value: string) => void;
  readonly onToggle: () => void;
}

export function PasswordField({
  id,
  autoComplete,
  placeholder,
  value,
  visible,
  inputClass,
  toggleClass,
  onInput,
  onToggle,
}: PasswordFieldProps): VNode {
  return (
    <div class="relative">
      <input
        id={id}
        type={visible ? 'text' : 'password'}
        autoComplete={autoComplete}
        placeholder={placeholder}
        value={value}
        onInput={(e) => { onInput((e.currentTarget as HTMLInputElement).value); }}
        class={inputClass}
      />
      <button
        type="button"
        aria-label={visible ? t('loginHidePassword') : t('loginShowPassword')}
        aria-pressed={visible}
        onClick={onToggle}
        class={toggleClass}
      >
        <PasswordToggleIcon visible={visible} />
      </button>
    </div>
  );
}
