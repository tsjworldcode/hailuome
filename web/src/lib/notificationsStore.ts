/**
 * M9-20：站主互动通知未读数 signal + 刷新（轮询由 ownerUnreadStore 统一调度）。
 */
import { signal } from '@preact/signals';
import { getOwnerJwt, getWorkerAUrl } from './auth';
import { createWorkerAClient } from './workerA';

export const unreadNotificationCount = signal(0);

/** @returns true=成功或无凭证跳过；false=请求失败（供 M13-17 退避） */
export async function refreshUnreadNotificationCount(): Promise<boolean> {
  const baseUrl = getWorkerAUrl();
  const jwt = getOwnerJwt();
  if (!baseUrl || !jwt) {
    unreadNotificationCount.value = 0;
    return true;
  }
  try {
    const client = createWorkerAClient({ baseUrl, getJwt: () => jwt });
    const data = await client.listNotifications({ limit: 1 });
    unreadNotificationCount.value = data.unread_count;
    return true;
  } catch {
    // 轮询失败静默；由 ownerUnreadStore 根据 false 做退避
    return false;
  }
}
