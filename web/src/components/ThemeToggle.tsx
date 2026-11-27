/** @jsxImportSource preact */
import type { VNode } from 'preact';
import { signal } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import { t, initLanguage } from '../lib/i18n';

// M7-5b-6：暗色模式切换器（Settings persist）
//
// 设计要点：
//   - 三态切换器：'light' / 'dark' / 'system'
//     - 'light' / 'dark'：用户显式选择，跨标签 / 刷新均保留
//     - 'system'：跟随浏览器 `prefers-color-scheme` 实时切换
//   - 持久化：localStorage['hailuo:theme']（key 与 M7-5b-0 ThemeScript 同源）
//     - 'light' / 'dark' / 'system' 三种合法值；其他值（含 null）视为跟随系统（兼容首访）
//   - 跨标签同步：监听 window 'storage' 事件，其他标签写入后本标签实时 follow
//   - 系统主题跟随：'system' 模式下额外监听 matchMedia('(prefers-color-scheme: dark)') change
//   - 无 FOUC：ThemeScript.astro 已在 <head> is:inline 同步执行写好初始 dark class，本组件 mount
//     后再次确认一致（应用任何延迟的客户端逻辑）
//
// UI：三按钮分段控件（pill 风格），active 走 sky-500；含太阳 / 月亮 / 显示器三 lucide 图标 + 中文标签
//
// §F-02 严守：不引入任何 W A/B 业务客户端 / 不读构建期 env / 仅读写 localStorage['hailuo:theme']
//             一个 key（与本节点写层凭证 storage key 完全无关）。
import { Sun, Moon, Monitor } from 'lucide-preact';
import { SettingsSectionHeader } from './settings/SettingsSectionHeader';

/** 合法主题值；除此之外 localStorage 任何脏数据均视为「未设置」回落到跟随系统 */
export type ThemeChoice = 'light' | 'dark' | 'system';

/** localStorage key（与 M7-5b-0 ThemeScript 同源约定，不要改动） */
export const THEME_STORAGE_KEY = 'hailuo:theme';

/** 模块级 signal：当前 UI 显示的选项；mount 时由 localStorage 初始化 */
const choice = signal<ThemeChoice>('system');
/** 标记当前组件是否已完成客户端初始化；仅用于隐藏初始化提示 */
const mounted = signal<boolean>(false);

/** 读取存储；非法值（含 null）一律回 'system'，让首访和未设置用户持续跟随系统主题 */
export function readStoredTheme(): ThemeChoice {
  if (typeof window === 'undefined') return 'system';
  try {
    const v = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (v === 'light' || v === 'dark' || v === 'system') return v;
    return 'system';
  } catch {
    return 'system';
  }
}

/** 计算给定 choice 在当前系统状态下应解析为深 / 浅 */
export function resolveTheme(c: ThemeChoice): 'light' | 'dark' {
  if (c === 'light') return 'light';
  if (c === 'dark') return 'dark';
  // 'system'：未在浏览器环境（SSR 等）回深色（与 ThemeScript fallback 一致）
  if (typeof window === 'undefined') return 'dark';
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } catch {
    return 'dark';
  }
}

/** 应用解析后的主题到 <html>：toggle `dark` class（Tailwind darkMode='class'） */
function applyTheme(c: ThemeChoice): void {
  if (typeof document === 'undefined') return;
  const resolved = resolveTheme(c);
  if (resolved === 'dark') {
    document.documentElement.classList.add('dark');
  } else {
    document.documentElement.classList.remove('dark');
  }
  document.documentElement.dataset.theme = resolved;
}

/** 写存储 + 应用；用户点击 / 跨标签 storage 事件均调用 */
function setChoice(next: ThemeChoice): void {
  choice.value = next;
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, next);
  } catch {
    /* localStorage 不可用（隐私模式 / quota 满）静默忽略，UI 仍即时切换 */
  }
  applyTheme(next);
  window.dispatchEvent(new CustomEvent('hailuo:theme-change', { detail: { theme: next } }));
}

interface OptionMeta {
  readonly value: ThemeChoice;
  readonly labelKey: 'themeLight' | 'themeDark' | 'themeSystem';
  readonly icon: typeof Sun;
  readonly hintKey: 'themeLightHint' | 'themeDarkHint' | 'themeSystemHint';
}

const OPTIONS: ReadonlyArray<OptionMeta> = [
  { value: 'light', labelKey: 'themeLight', icon: Sun, hintKey: 'themeLightHint' },
  { value: 'dark', labelKey: 'themeDark', icon: Moon, hintKey: 'themeDarkHint' },
  { value: 'system', labelKey: 'themeSystem', icon: Monitor, hintKey: 'themeSystemHint' },
];

export function ThemeToggle(): VNode {
  useEffect(() => {
    mounted.value = true;
    initLanguage();

    // 初始化：把 localStorage 的值同步到 UI
    const initial = readStoredTheme();
    choice.value = initial;
    applyTheme(initial);

    // 跨标签同步：其他标签写入 hailuo:theme 后本标签跟随
    function onStorage(e: StorageEvent): void {
      if (e.key !== THEME_STORAGE_KEY) return;
      const v = e.newValue;
      const next: ThemeChoice =
        v === 'light' || v === 'dark' || v === 'system' ? v : 'system';
      choice.value = next;
      applyTheme(next);
    }
    window.addEventListener('storage', onStorage);

    // Astro ViewTransitions 换页后可能替换 <html> class；回到设置页时本组件也做一次兜底同步。
    function onPageSwap(): void {
      const next = readStoredTheme();
      choice.value = next;
      applyTheme(next);
    }
    document.addEventListener('astro:after-swap', onPageSwap);
    document.addEventListener('astro:page-load', onPageSwap);

    // 系统主题跟随：仅在 'system' 模式下让 prefers-color-scheme 变更触发重渲
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    function onMqChange(): void {
      if (choice.value !== 'system') return;
      applyTheme('system');
    }
    // addEventListener 取代 deprecated addListener（Safari 14+ 已支持）
    mq.addEventListener('change', onMqChange);

    return () => {
      mounted.value = false;
      window.removeEventListener('storage', onStorage);
      document.removeEventListener('astro:after-swap', onPageSwap);
      document.removeEventListener('astro:page-load', onPageSwap);
      mq.removeEventListener('change', onMqChange);
    };
  }, []);

  return (
    <section
      class="rounded-lg border border-slate-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900"
      aria-labelledby="theme-toggle-heading"
    >
      <SettingsSectionHeader sectionKey="theme" title={t('themeTitle')} />
      <p class="mt-1 text-xs leading-5 text-slate-600 dark:text-zinc-400">
        {t('themeDescriptionPrefix')}{' '}
        <code class="rounded bg-slate-100 px-1.5 py-0.5 dark:bg-zinc-800 dark:text-zinc-200">
          hailuo:theme
        </code>
        {t('themeDescriptionSuffix')}
      </p>
      <div
        role="radiogroup"
        aria-label={t('themeGroup')}
        class="mt-3 inline-flex rounded-full border border-slate-200 bg-slate-100 p-1 shadow-inner transition-colors dark:border-zinc-700 dark:bg-zinc-950"
      >
        {OPTIONS.map((opt) => {
          const active = choice.value === opt.value;
          const Icon = opt.icon;
          return (
            <button
              key={opt.value}
              type="button"
              role="radio"
              aria-checked={active}
              title={t(opt.hintKey)}
              onClick={() => setChoice(opt.value)}
              class={
                'inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-medium transition ' +
                (active
                  ? 'bg-sky-600 text-white shadow-sm hover:bg-sky-700 dark:bg-sky-500 dark:text-white dark:hover:bg-sky-400'
                  : 'text-slate-700 hover:bg-white hover:text-slate-950 dark:text-zinc-300 dark:hover:bg-zinc-800 dark:hover:text-zinc-50')
              }
            >
              <Icon size={16} aria-hidden="true" />
              <span>{t(opt.labelKey)}</span>
            </button>
          );
        })}
      </div>
      {!mounted.value && (
        <p class="mt-2 text-xs text-slate-500 dark:text-zinc-500">{t('themeInit')}</p>
      )}
    </section>
  );
}
