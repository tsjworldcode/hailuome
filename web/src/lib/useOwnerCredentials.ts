/**
 * 站主凭证（Worker A 地址 + JWT）共享刷新逻辑。
 * Astro View Transitions 切页时模块级 signal 会保留，但 island 会 remount；
 * 必须在 astro:page-load / after-swap 时重新读取，且避免把 ready 打回 false 造成「正在校验登录状态…」卡住。
 */
import { signal } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import { getOwnerJwt, resolveWorkerAUrl } from './auth';

export const ownerBaseUrl = signal<string | null>(null);
export const ownerJwt = signal<string | null>(null);
export const ownerCredentialsReady = signal<boolean>(false);

let refreshSeq = 0;

/** 从 storage / deploy 注入重新解析凭证；仅在首次或显式要求时展示 loading */
export async function refreshOwnerCredentials(options?: { showLoading?: boolean }): Promise<void> {
  const seq = ++refreshSeq;
  const hasJwt = typeof window !== 'undefined' && Boolean(getOwnerJwt());
  // 已有 JWT 时切页不闪 loading，避免 View Transitions 下「正在校验登录状态…」卡住
  if (options?.showLoading && !hasJwt) {
    ownerCredentialsReady.value = false;
  }
  try {
    const url = await resolveWorkerAUrl();
    const jwt = getOwnerJwt();
    if (seq !== refreshSeq) {
      if (jwt && !ownerCredentialsReady.value) {
        ownerCredentialsReady.value = true;
      }
      return;
    }
    ownerBaseUrl.value = url;
    ownerJwt.value = jwt;
    ownerCredentialsReady.value = true;
  } catch {
    if (seq === refreshSeq) {
      ownerCredentialsReady.value = true;
    }
  }
}

/**
 * 在 Preact island 内订阅凭证；切页后自动刷新，不闪 loading。
 * @param onReady 凭证就绪后的回调（如拉列表）
 */
export function useOwnerCredentials(onReady?: () => void): void {
  useEffect(() => {
    const run = (showLoading: boolean): void => {
      void refreshOwnerCredentials({ showLoading }).then(() => {
        if (ownerCredentialsReady.value) onReady?.();
      });
    };

    run(!ownerCredentialsReady.value);

    const onNavigate = (): void => run(false);
    document.addEventListener('astro:page-load', onNavigate);
    document.addEventListener('astro:after-swap', onNavigate);
    return () => {
      document.removeEventListener('astro:page-load', onNavigate);
      document.removeEventListener('astro:after-swap', onNavigate);
    };
  }, []);
}
