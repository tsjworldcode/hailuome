// M7-13（F-13 修复）：IndexedDB 错误判别工具
//
// 设计要点：
// - 唯一职责：判别给定 unknown 错误是否为 IDB QuotaExceeded
// - 三层探测策略（按浏览器实现差异由严到松）：
//   1. DOMException 实例 + name === 'QuotaExceededError'（Chrome / Firefox / Safari 现代版）
//   2. DOMException 实例 + code === 22（旧 Safari / 旧 Firefox 兼容）
//   3. 字符串兜底（部分 Webview / polyfill 抛 plain Error 时）
// - 纯函数：无副作用 / SSR-safe（typeof DOMException === 'undefined' 直接走兜底）
// - 不抛错：内部 try/catch 守住任何 DOMException 实例化失败的边缘场景
//
// 调用方约定：
//   try { await idb_write(...) }
//   catch (err) {
//     if (isQuotaExceeded(err)) showToast('本地存储空间已满，请清理本地数据后重试', 'error');
//     // 其他错误仍可静默不抛或转向其它 UI 路径
//   }
//
// §F-02 红线：零 import lib/api 与 lib/workerA / 零 import.meta.env / 零 fetch / 零 storage 直调

/** DOMException.QUOTA_EXCEEDED_ERR 历史 code（DOM Level 1 沿用至今） */
const QUOTA_EXCEEDED_CODE = 22;

/** 判别给定 unknown 错误是否为 QuotaExceeded（IDB 写入额满 / localStorage / sessionStorage 等同源场景共用） */
export function isQuotaExceeded(err: unknown): boolean {
  if (err === null || err === undefined) return false;
  // 路径 1+2：现代浏览器抛 DOMException
  if (typeof DOMException !== 'undefined' && err instanceof DOMException) {
    if (err.name === 'QuotaExceededError') return true;
    // DOMException.code 在 TS lib 中标记 deprecated 但旧 Safari/Firefox 仍输出该字段；
    // 用结构性 access 而非属性直读以避开 ts(6385) 告警
    const codeVal: unknown = (err as unknown as { code?: number }).code;
    if (typeof codeVal === 'number' && codeVal === QUOTA_EXCEEDED_CODE) return true;
    // Firefox 旧版本曾用 NS_ERROR_DOM_QUOTA_REACHED 别名
    if (err.name === 'NS_ERROR_DOM_QUOTA_REACHED') return true;
  }
  // 路径 3：字符串兜底（部分 polyfill / Webview 抛 plain Error）
  if (err instanceof Error) {
    const msg = err.message || '';
    if (/quota/i.test(msg) && /exceed/i.test(msg)) return true;
    if (/QuotaExceeded/.test(err.name || '')) return true;
  }
  return false;
}
