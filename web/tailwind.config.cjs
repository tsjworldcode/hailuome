/** @type {import('tailwindcss').Config} */
// M7-0：脚手架阶段最小可用配置
// - content 扫描 src/ 全部 .astro/.tsx/.ts/.md，避免 M7-2+ 加新组件时遗漏 purge
//
// M7-5b-0：设计基线升级（参照 X / Twitter 风格）
// - darkMode: 'class' —— 由 Layout.astro 在 <html> 上写入/移除 `dark` class 来切换；
//   M7-5b-6 设置页加切换器并持久化到 localStorage `hailuo:theme`
// - 主题 tokens 暂用 zinc + sky 系（中性灰 + 海蓝），后续真正定主色后再统一替换为
//   语义 token；当前阶段不发明新色名，避免与 Tailwind 默认调色板冲突
module.exports = {
  darkMode: 'class',
  content: [
    './src/**/*.{astro,html,js,jsx,md,mdx,svelte,ts,tsx,vue}',
  ],
  theme: {
    extend: {
      fontFamily: {
        // UX-APPLE-2：系统 UI 字体栈置前（贴近苹果感）；不再默认加载 Inter Variable
        sans: [
          'ui-sans-serif',
          'system-ui',
          '-apple-system',
          'BlinkMacSystemFont',
          '"Segoe UI"',
          'Roboto',
          '"Helvetica Neue"',
          '"PingFang SC"',
          '"Hiragino Sans GB"',
          '"Microsoft YaHei UI"',
          '"Microsoft YaHei"',
          '"Noto Sans SC"',
          '"Noto Sans CJK SC"',
          '"Source Han Sans SC"',
          'sans-serif',
        ],
        // 登录页：苹果常用系统栈（SF / 苹方），避开 Segoe 把中文衬成 Windows 黑体感
        apple: [
          '-apple-system',
          'BlinkMacSystemFont',
          '"SF Pro Text"',
          '"SF Pro Display"',
          '"Helvetica Neue"',
          '"PingFang SC"',
          '"Hiragino Sans GB"',
          '"Microsoft YaHei UI"',
          '"Microsoft YaHei"',
          '"Noto Sans SC"',
          'sans-serif',
        ],
        mono: [
          'ui-monospace',
          'SFMono-Regular',
          'Menlo',
          'Monaco',
          'Consolas',
          '"Liberation Mono"',
          '"Courier New"',
          'monospace',
        ],
      },
      colors: {
        // M7-5b-0：语义 token，深浅主题各自走 zinc / white 体系
        // 直接列 Tailwind 已有的颜色值，避免类引擎扫不到自定义 class
        brand: {
          DEFAULT: '#0ea5e9', // sky-500
          hover: '#0284c7',   // sky-600
        },
        // UX-AUDIT-1：文字 / 背景 / 强调三档语义色
        // 用 rgb(var(--token) / <alpha-value>) 形式声明，
        // 配合 CSS 变量切换浅/深主题；
        // Tailwind 调用如 `text-fg2` `bg-bg2` `text-fg3/80` 都能直接产生。
        fg1: 'rgb(var(--fg-1) / <alpha-value>)',
        fg2: 'rgb(var(--fg-2) / <alpha-value>)',
        fg3: 'rgb(var(--fg-3) / <alpha-value>)',
        bg1: 'rgb(var(--bg-1) / <alpha-value>)',
        bg2: 'rgb(var(--bg-2) / <alpha-value>)',
        bg3: 'rgb(var(--bg-3) / <alpha-value>)',
        accent: {
          DEFAULT: 'rgb(var(--accent) / <alpha-value>)',
          bg: 'rgb(var(--accent-bg) / <alpha-value>)',
        },
        danger: 'rgb(var(--danger) / <alpha-value>)',
        success: 'rgb(var(--success) / <alpha-value>)',
        warning: 'rgb(var(--warning) / <alpha-value>)',
        'border-1': 'rgb(var(--border-1) / <alpha-value>)',
        'border-2': 'rgb(var(--border-2) / <alpha-value>)',
      },
      maxWidth: {
        // UX-APPLE-1：默认居中主栏 ~680px（苹果感单栏）
        content: '680px',
        // M7-5b-0 / M16-4：历史时间线 token，部分页内容器仍可复用
        timeline: '840px',
      },
    },
  },
  plugins: [],
};
