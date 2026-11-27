/** @jsxImportSource preact */
/**
 * M7-32b：监听 SW postMessage，离线缓存 Quota 满时 toast 提示用户。
 * 仅生产环境注册 SW；dev 无 listener 副作用。
 */
import { useEffect } from 'preact/hooks';
import { t } from '../lib/i18n';
import { showToast } from '../lib/toast';

const SW_CACHE_QUOTA_MSG = 'hailuo:sw-cache-quota';

export function SwCacheQuotaListener(): null {
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
      return;
    }
    const handler = (event: MessageEvent): void => {
      const data = event.data as { type?: string } | null;
      if (data?.type === SW_CACHE_QUOTA_MSG) {
        showToast(t('swCacheQuotaExceeded'), 'error');
      }
    };
    navigator.serviceWorker.addEventListener('message', handler);
    return () => navigator.serviceWorker.removeEventListener('message', handler);
  }, []);
  return null;
}
