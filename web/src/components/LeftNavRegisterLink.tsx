/** @jsxImportSource preact */
import type { VNode } from 'preact';
import { useEffect } from 'preact/hooks';
import { BadgeCheck, UserPlus } from 'lucide-preact';
import { loadOwnerProfile, ownerProfile } from '../lib/ownerProfile';
import { t } from '../lib/i18n';

interface Props {
  readonly active?: string;
}

/** 未注册 →「注册」；已注册 →「认证」（邮箱验证码 + 支付，支付待开发） */
export function LeftNavRegisterLink({ active }: Props): VNode {
  useEffect(() => {
    void loadOwnerProfile();
  }, []);

  const registered = ownerProfile.value?.registered === true;
  const href = registered ? '/certify' : '/register';
  const label = registered ? t('navCertify') : t('navRegister');
  const navKey = registered ? 'certify' : 'register';
  const isActive = active === navKey;
  const Icon = registered ? BadgeCheck : UserPlus;

  // UX-APPLE-1b：窄轨图标；lg+ 展开短文案（与 LeftNav.astro / 消息 / 群聊同构，避免桌面端视觉漂移）
  const baseCls =
    'flex items-center justify-center gap-0 rounded-2xl px-3 py-3 text-[18px] transition lg:justify-start lg:gap-3';
  const cls = isActive
    ? `${baseCls} bg-sky-100 font-bold text-sky-800 dark:bg-sky-500/15 dark:text-sky-200`
    : `${baseCls} font-normal text-zinc-800 hover:bg-zinc-100 hover:text-zinc-950 dark:text-zinc-300 dark:hover:bg-zinc-900 dark:hover:text-zinc-50`;

  return (
    <a
      href={href}
      class={cls}
      aria-label={label}
      title={label}
      aria-current={isActive ? 'page' : undefined}
    >
      <Icon size={26} strokeWidth={isActive ? 2.5 : 2} class="shrink-0" aria-hidden="true" />
      <span class="hidden truncate text-[15px] font-medium lg:inline" data-i18n={registered ? 'navCertify' : 'navRegister'}>
        {label}
      </span>
    </a>
  );
}
