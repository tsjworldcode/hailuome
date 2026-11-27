// M7-12（响应「M7 系列审计报告」§6.1 性能 finding F-08）：
// 顶层 singleton IntersectionObserver 委托模式 —— 把原本每个 PostCard 自己 new 一个
// IntersectionObserver 的做法收敛为「模块级单一 observer + Map<Element, Handler>
// 注册表 + entry.target 查表分发」。
//
// 设计要点：
// - **行为零变更**：threshold `[0, 0.5, 1]` 与 PostCard 既有阈值完全一致；每个
//   注册的 handler 仍然像原先 `new IntersectionObserver` 回调里一样拿到 entry，
//   PostCard 内部的 impression / dwell / skim / firstScreen 状态机一字不改。
// - **lazy 单例**：observer 在第一次 `observePost` 调用时创建；后续注册共享同一
//   instance。无需 disconnect —— 当所有 PostCard 卸载且 handlers 清空后，observer
//   仍驻留模块作用域，刷新页面或 SPA 完整卸载时由浏览器回收（与单页应用语义匹配）。
// - **SSR 守卫**：`typeof IntersectionObserver === 'undefined'`（Astro SSG / 隐身
//   模式 / 低端浏览器）下返回 noop cleanup，PostCard 的卸载逻辑 (`unobserve()`)
//   仍可安全调用。
// - **§F-02 红线**：本文件零 import lib/api / lib/workerA / 零 import.meta.env /
//   零 fetch / 零 storage 直调 / 零 worker-a + WORKER_A_URL + localhost:8787
//   + hailuo:worker-a-* 字面量。

/** IntersectionObserver 阈值，与 PostCard.tsx M7-8 既有取值一致 */
const POST_OBSERVER_THRESHOLD: number[] = [0, 0.5, 1];

/** entry 委托 handler 签名：单条 entry → void（与 PostCard 原 callback 一致） */
type PostEntryHandler = (entry: IntersectionObserverEntry) => void;

/** Element → handler 注册表；observer callback 通过 entry.target 查表分发 */
const handlers = new Map<Element, PostEntryHandler>();

/** 模块级 singleton；lazy 初始化 */
let observer: IntersectionObserver | null = null;

/**
 * lazy 获取 / 创建 singleton observer。
 * SSR 或不支持 IntersectionObserver 的环境返回 null（调用方收到 noop cleanup）。
 */
function getObserver(): IntersectionObserver | null {
  if (typeof IntersectionObserver === 'undefined') return null;
  if (observer === null) {
    observer = new IntersectionObserver(
      (entries) => {
        // 多 entry 批量回调（IO 标准）；逐条查表分发到对应 handler
        for (const entry of entries) {
          const h = handlers.get(entry.target);
          if (h) h(entry);
        }
      },
      { threshold: POST_OBSERVER_THRESHOLD },
    );
  }
  return observer;
}

/**
 * 注册一个 PostCard article 元素 + 它的 entry 处理函数。
 *
 * 返回 cleanup 函数；调用方（PostCard useEffect）必须在卸载时调用：
 * ```ts
 * const unobserve = observePost(el, (entry) => { ... });
 * return () => { unobserve(); };
 * ```
 *
 * SSR / 不支持 IntersectionObserver 时返回 noop cleanup —— 不抛异常，
 * PostCard 卸载逻辑无副作用即可。
 */
export function observePost(
  el: Element,
  handler: PostEntryHandler,
): () => void {
  const obs = getObserver();
  if (obs === null) return () => undefined;
  handlers.set(el, handler);
  obs.observe(el);
  return () => {
    handlers.delete(el);
    // observer 非空（同步调用，无并发卸载场景需要 null check）
    obs.unobserve(el);
  };
}
