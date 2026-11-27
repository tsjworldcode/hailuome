/** @jsxImportSource preact */
import { useEffect, useState } from 'preact/hooks';
import { Bell } from 'lucide-preact';
import { unreadNotificationCount, refreshUnreadNotificationCount } from '../lib/notificationsStore';
import { t } from '../lib/i18n';

interface Props {
  readonly active?: boolean;
}

/** 侧栏通知入口 + 未读红点（M9-20）。 */
export function LeftNavNotificationLink({ active = false }: Props) {
  const [count, setCount] = useState(unreadNotificationCount.value);

  useEffect(() => {
    const unsub = unreadNotificationCount.subscribe((v) => setCount(v));
    void refreshUnreadNotificationCount();
    return unsub;
  }, []);

  // UX-APPLE-1b：窄轨图标；lg+ 展开短文案
  const baseCls =
    'relative flex items-center justify-center gap-0 rounded-2xl px-3 py-3 text-[18px] transition lg:justify-start lg:gap-3';
  const cls = active
    ? `${baseCls} bg-sky-50 font-bold text-sky-700 dark:bg-sky-500/10 dark:text-sky-300`
    : `${baseCls} font-normal text-zinc-700 hover:bg-zinc-100 hover:text-zinc-950 dark:text-zinc-300 dark:hover:bg-zinc-900 dark:hover:text-zinc-50`;

  return (
    <a
      href="/notifications"
      class={cls}
      aria-label={t('navNotifications')}
      title={t('navNotifications')}
      aria-current={active ? 'page' : undefined}
    >
      <span class="relative inline-flex shrink-0">
        <Bell size={26} strokeWidth={active ? 2.5 : 2} aria-hidden="true" />
        {count > 0 && (
          <span
            class="absolute -right-1 -top-1 min-w-[1.1rem] rounded-full bg-rose-500 px-1 text-center text-[10px] font-bold leading-4 text-white"
            aria-label={t('navUnreadNotificationsAria', undefined, { count })}
          >
            {count > 99 ? '99+' : count}
          </span>
        )}
      </span>
      <span class="hidden truncate text-[15px] font-medium lg:inline">{t('navNotifications')}</span>
    </a>
  );
}
