// M7-16：负反馈 handle 的 sessionStorage 备份（审计 §4.1 P1）
//
// 与 lib/forYou.ts 的模块级 Set 配合：刷新标签页后仍立即隐藏，尤其 pref=off 时 IDB 不参与过滤。
// 仅读写 `hailuo:neg-hide` 一个 key；不碰 localStorage / 不 fetch / 不读 env。

/** sessionStorage 键（与 hailuo:theme / hailuo:for-you-ranking 同命名空间） */
export const NEGATIVE_FEEDBACK_SESSION_KEY = 'hailuo:neg-hide';

/** 防止异常数据撑爆 sessionStorage */
const MAX_HANDLES = 200;

function readHandleList(): string[] {
  if (typeof window === 'undefined' || typeof window.sessionStorage === 'undefined') {
    return [];
  }
  try {
    const raw = window.sessionStorage.getItem(NEGATIVE_FEEDBACK_SESSION_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((h): h is string => typeof h === 'string' && h.length > 0);
  } catch {
    return [];
  }
}

function writeHandleList(handles: readonly string[]): void {
  if (typeof window === 'undefined' || typeof window.sessionStorage === 'undefined') return;
  try {
    if (handles.length === 0) {
      window.sessionStorage.removeItem(NEGATIVE_FEEDBACK_SESSION_KEY);
      return;
    }
    window.sessionStorage.setItem(NEGATIVE_FEEDBACK_SESSION_KEY, JSON.stringify(handles));
  } catch {
    /* 隐身模式 / quota 满：静默，内存 Set 仍生效 */
  }
}

/** mount 时把 session 中已存 handle 合并进 forYou 的 Set */
export function hydrateNegativeFeedbackHandles(target: Set<string>): void {
  for (const h of readHandleList()) {
    target.add(h);
  }
}

/** 点「不感兴趣」后追加持久化 */
export function persistNegativeFeedbackHandle(handle: string): void {
  if (!handle) return;
  const list = readHandleList();
  if (list.includes(handle)) return;
  const next = [...list, handle];
  writeHandleList(next.length > MAX_HANDLES ? next.slice(-MAX_HANDLES) : next);
}

/** 测试 / 调试：清空 session 备份 */
export function clearNegativeFeedbackSession(): void {
  writeHandleList([]);
}
