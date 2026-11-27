/**
 * REL-FIX-11：好友请求未读数 signal + 刷新（轮询由 ownerUnreadStore 统一调度）。
 *
 * 用途：消息页「通讯录」Tab 旁的**未读角标** —— 对齐 REL-FIX-5 群主待审批角标做法
 * （群主不在群设置页也能看到有申请在等）。
 *
 * 语义：**入站 pending 数**（有多少人在等我回应）。
 * 不含 outgoing pending（那些是「我发出去等对方」，与「等我处理」不是一回事）。
 *
 * 后端 `GET /api/friend-requests?direction=incoming&status=pending&limit=1`
 * 响应里带 `pending_count`（纯 D1 COUNT，零 KV 写 —— Free Tier 约束）。
 */
import { signal } from '@preact/signals';
import { getOwnerJwt, getWorkerAUrl } from './auth';
import { createWorkerAClient } from './workerA';

export const unreadFriendRequestCount = signal(0);

/** @returns true=成功或无凭证跳过；false=请求失败（供 M13-17 退避） */
export async function refreshUnreadFriendRequestCount(): Promise<boolean> {
  const baseUrl = getWorkerAUrl();
  const jwt = getOwnerJwt();
  if (!baseUrl || !jwt) {
    unreadFriendRequestCount.value = 0;
    return true;
  }
  try {
    const client = createWorkerAClient({ baseUrl, getJwt: () => jwt });
    // limit=1：只要 pending_count，不要整页 items（省流量 + 后端少读几行）
    const data = await client.listFriendRequests({
      direction: 'incoming',
      status: 'pending',
      limit: 1,
    });
    unreadFriendRequestCount.value = data.pending_count ?? data.items.length;
    return true;
  } catch {
    // 轮询失败静默；由 ownerUnreadStore 根据 false 做退避
    return false;
  }
}
