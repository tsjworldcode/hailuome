/** @jsxImportSource preact */
import { MessagesSquare } from 'lucide-preact';
import { prefetchMessagingAssets } from '../lib/prefetchMessaging';
import { t } from '../lib/i18n';

interface Props {
  readonly active?: boolean;
}

/** 侧栏群聊入口（对齐 Astro 目录页 /groups/）。 */
export function LeftNavGroupLink({ active = false }: Props) {
  // UX-APPLE-1b：窄轨图标；lg+ 展开短文案
  const baseCls =
    'flex items-center justify-center gap-0 rounded-2xl px-3 py-3 text-[18px] transition lg:justify-start lg:gap-3';
  const cls = active
    ? `${baseCls} bg-sky-50 font-bold text-sky-700 dark:bg-sky-500/10 dark:text-sky-300`
    : `${baseCls} font-normal text-zinc-700 hover:bg-zinc-100 hover:text-zinc-950 dark:text-zinc-300 dark:hover:bg-zinc-900 dark:hover:text-zinc-50`;

  return (
    <a
      href="/groups/"
      class={cls}
      aria-label={t('navGroups')}
      title={t('navGroups')}
      aria-current={active ? 'page' : undefined}
      onMouseEnter={prefetchMessagingAssets}
      onFocus={prefetchMessagingAssets}
      onTouchStart={prefetchMessagingAssets}
    >
      <MessagesSquare size={26} strokeWidth={active ? 2.5 : 2} class="shrink-0" aria-hidden="true" />
      <span class="hidden truncate text-[15px] font-medium lg:inline">{t('navGroups')}</span>
    </a>
  );
}
