// @ts-check
import { defineConfig } from 'astro/config';
import preact from '@astrojs/preact';
import tailwind from '@astrojs/tailwind';

// M7-0：脚手架阶段
// - 静态产物（output: 'static'）→ Cloudflare Pages 直接托管 dist/，不消耗 Worker 配额
// - Preact 集成提供交互组件能力；后续 M7-2+ Timeline / 发帖器等通过 `client:*` 指令水合
// - Tailwind 集成走官方 @astrojs/tailwind，自动注入 global.css 与 PostCSS 链路
//   （`applyBaseStyles: false` 让 src/styles/global.css 完全掌控 @tailwind 指令）
export default defineConfig({
  output: 'static',
  integrations: [
    preact(),
    tailwind({ applyBaseStyles: false }),
  ],
  server: {
    port: 4321,
  },
  vite: {
    // 允许从 monorepo workspaces 引用共享包（后续 M7-1 引入 @hailuo/shared-types 时用得到）
    server: {
      fs: {
        allow: ['..'],
      },
    },
  },
});
