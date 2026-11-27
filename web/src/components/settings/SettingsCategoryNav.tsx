/** @jsxImportSource preact */
/**
 * M7-26h + M7-26h-2b：设置页二级导航
 * - md+：左侧 240px 固定列（不随右侧正文滚）；字号 15px；图标 20px；active 左侧 4px sky 指示条 + 计数徽章
 * - sm ：顶部横向滚动 chip
 * - advanced：右侧 ChevronDown；折叠时显示「已折叠 N 项」文案；再次点击切换展开
 *
 * §F-02 严守：不引业务 client / 不读 worker-a 字面量。
 */
import type { VNode } from 'preact';
import { ChevronDown } from 'lucide-preact';
import { t } from '../../lib/i18n';
import {
  SETTINGS_CATEGORIES,
  type SettingsCategoryKey,
} from '../../lib/settingsCategories';

export interface SettingsCategoryNavProps {
  readonly active: SettingsCategoryKey;
  readonly onSelect: (key: SettingsCategoryKey) => void;
  /** advanced 分组是否已展开（仅 key=advanced 时有意义） */
  readonly advancedExpanded?: boolean;
  /** 切换 advanced 展开/折叠（仅在已选中 advanced 时由再点击触发） */
  readonly onToggleAdvanced?: () => void;
}

export function SettingsCategoryNav(props: SettingsCategoryNavProps): VNode {
  const advancedExpanded = props.advancedExpanded === true;

  const handleClick = (key: SettingsCategoryKey): void => {
    if (key === 'advanced' && props.active === 'advanced' && props.onToggleAdvanced) {
      props.onToggleAdvanced();
      return;
    }
    props.onSelect(key);
  };

  return (
    <>
      {/* 移动端：chip 钉在面板顶，不进右侧滚动区 */}
      <nav
        class="-mx-4 mb-3 flex shrink-0 gap-1 overflow-x-auto border-b border-[#eff3f4] bg-white/95 px-4 py-2 backdrop-blur-md scrollbar-none md:hidden dark:border-[#2f3336] dark:bg-black/95"
        aria-label={t('settingsCategoryNavAria')}
      >
        {SETTINGS_CATEGORIES.map((cat) => {
          const isActive = cat.key === props.active;
          const cls = isActive
            ? 'inline-flex shrink-0 items-center gap-1.5 rounded-full bg-sky-100 px-3 py-1.5 text-xs font-semibold text-sky-800 dark:bg-sky-500/15 dark:text-sky-200'
            : 'inline-flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-900';
          const Icon = cat.icon;
          const isAdvancedCollapsed =
            cat.key === 'advanced' && isActive && !advancedExpanded;
          return (
            <button
              key={cat.key}
              type="button"
              onClick={() => handleClick(cat.key)}
              aria-current={isActive ? 'page' : undefined}
              aria-expanded={cat.key === 'advanced' ? advancedExpanded : undefined}
              class={cls}
            >
              <Icon size={14} aria-hidden="true" />
              <span>
                {isAdvancedCollapsed
                  ? t('settingsCategoryAdvancedCollapsed', undefined, {
                      n: cat.sections.length,
                    })
                  : t(cat.labelKey)}
              </span>
              {cat.key === 'advanced' && (
                <ChevronDown
                  size={12}
                  aria-hidden="true"
                  class={
                    advancedExpanded && isActive
                      ? 'rotate-180 transition-transform duration-150'
                      : 'transition-transform duration-150'
                  }
                />
              )}
            </button>
          );
        })}
      </nav>

      {/* 桌面端：独立左列；shrink-0 防止被挤扁；self-stretch 吃满面板高度 */}
      <aside
        class="hidden w-[240px] shrink-0 self-stretch overflow-y-auto overscroll-contain md:block"
        aria-label={t('settingsCategoryNavAria')}
      >
        {/* pt/pl：选中态 ring 画在盒外，贴顶会被 overflow 裁掉上边线 */}
        <nav class="flex flex-col gap-1 pb-2 pl-1 pr-2 pt-3">
          {SETTINGS_CATEGORIES.map((cat) => {
            const isActive = cat.key === props.active;
            const count = cat.sections.length;
            const isAdvanced = cat.key === 'advanced';
            const isAdvancedCollapsed = isAdvanced && isActive && !advancedExpanded;

            const baseCls =
              'group relative flex items-start gap-3 rounded-xl px-3 py-3 text-left transition-colors duration-150';
            const stateCls = isActive
              ? 'bg-sky-50/80 text-sky-900 ring-2 ring-sky-300 dark:bg-sky-500/10 dark:text-sky-100 dark:ring-sky-500/40'
              : 'text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-900';
            const Icon = cat.icon;
            const iconCls = isActive
              ? 'mt-0.5 shrink-0 text-sky-600 dark:text-sky-300'
              : 'mt-0.5 shrink-0 text-zinc-500 group-hover:text-zinc-700 dark:text-zinc-400 dark:group-hover:text-zinc-200';

            return (
              <button
                key={cat.key}
                type="button"
                onClick={() => handleClick(cat.key)}
                aria-current={isActive ? 'page' : undefined}
                aria-expanded={isAdvanced ? advancedExpanded : undefined}
                class={`${baseCls} ${stateCls}`}
              >
                {/* active 左侧 4px 指示条 */}
                {isActive && (
                  <span
                    aria-hidden="true"
                    class="absolute inset-y-2 left-0 w-1 rounded-full bg-sky-500 dark:bg-sky-400"
                  />
                )}
                <Icon size={20} aria-hidden="true" class={iconCls} />
                <span class="min-w-0 flex-1">
                  <span class="flex items-center gap-1.5">
                    <span
                      class={
                        isActive
                          ? 'block text-[15px] font-semibold leading-tight'
                          : 'block text-[15px] font-medium leading-tight'
                      }
                    >
                      {t(cat.labelKey)}
                    </span>
                    {isActive && !isAdvancedCollapsed && (
                      <span class="inline-flex shrink-0 items-center rounded-full bg-sky-100 px-1.5 py-0.5 text-[11px] font-semibold text-sky-700 dark:bg-sky-900/40 dark:text-sky-300">
                        {t('settingsCategorySectionCount', undefined, { n: count })}
                      </span>
                    )}
                    {/* 中文注释：UX-AUDIT-8 — 折叠态虚线边框更安静；展开态 sky 实心徽章保留 */}
                    {isAdvancedCollapsed && (
                      <span class="inline-flex shrink-0 items-center rounded-full border border-dashed border-zinc-300 bg-transparent px-1.5 py-0.5 text-[11px] font-medium text-zinc-500 dark:border-zinc-600 dark:text-zinc-400">
                        {t('settingsCategoryAdvancedCollapsed', undefined, { n: count })}
                      </span>
                    )}
                  </span>
                  <span
                    class={
                      isActive
                        ? 'mt-0.5 block text-[12px] leading-snug text-sky-700/80 dark:text-sky-200/70'
                        : 'mt-0.5 block text-[12px] leading-snug text-fg3'
                    }
                  >
                    {t(cat.descKey)}
                  </span>
                </span>
                {isAdvanced && (
                  <ChevronDown
                    size={16}
                    aria-hidden="true"
                    class={
                      advancedExpanded && isActive
                        ? 'mt-1 shrink-0 rotate-180 text-sky-600 transition-transform duration-150 dark:text-sky-300'
                        : 'mt-1 shrink-0 text-zinc-400 transition-transform duration-150 dark:text-zinc-500'
                    }
                  />
                )}
              </button>
            );
          })}
        </nav>
      </aside>
    </>
  );
}
