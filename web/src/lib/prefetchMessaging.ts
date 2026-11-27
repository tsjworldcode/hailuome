/**
 * UX-MSG-PERF：侧栏悬停时预热消息/群聊共享模块 + 预取页面文档，缩短点进后的等待。
 */
let warmed = false;

export function prefetchMessagingAssets(): void {
  if (warmed || typeof document === 'undefined') return;
  warmed = true;

  // 预热两侧页共用的重模块（加解密 / Worker A client）
  void import('./dmService');
  void import('./groupService');
  void import('./workerA');
  void import('./dmCrypto');

  // 预取页面 HTML，配合 Astro View Transitions
  for (const href of ['/messages/', '/groups/']) {
    const existing = document.head.querySelector(`link[rel="prefetch"][href="${href}"]`);
    if (existing) continue;
    const link = document.createElement('link');
    link.rel = 'prefetch';
    link.href = href;
    link.as = 'document';
    document.head.appendChild(link);
  }
}
