/**
 * REL-FIX-4：好友发起侧投递状态解析（纯函数，无副作用）。
 *
 * 背景：发起加好友后 `POST /api/friend-requests` 立刻返回 201「已发送」，
 * 但跨节点投递是 `waitUntil` 异步路径 —— 对端可能压根没收到（地址写错 /
 * 对方关闭接收入口 / 对方拉黑 / 节点不可达 / 频控）。
 * 后端 `friend_requests.inbox_status` 已记录投递回执，本模块把原始字段翻译成
 * **前端可呈现的状态**。
 *
 * 状态语义（与 CONTENT_DB migration 0061/0062 对齐）：
 *   ''             — 未投递 / 投递中（waitUntil 尚未落结果）
 *   'acked'        — 对端 Worker B 已收下 inbox envelope（**确定送达**）
 *   'pending_retry'— 投递失败，cron 24h 内会重投
 *   'giveup'       — 超 24h 放弃（对方大概率从未收到）
 *
 * 未知/异常值一律归入 `pending`（**不谎报"已送达"**）。
 */

export type FriendDeliveryState = 'pending' | 'delivered' | 'retrying' | 'giveup';

/**
 * giveup 的可行动原因（来自后端 `inbox_error` 脱敏短码）。
 * 只有能给出「站主下一步做什么」的码才细分，其余走通用提示。
 */
export type FriendDeliveryGiveupReason =
  | 'generic'
  | 'incoming_disabled'
  | 'blacklisted'
  | 'rate_limited';

/** 后端 `inbox_error` 短码 → 可行动原因。 */
const GIVEUP_REASON_BY_ERROR: Readonly<Record<string, FriendDeliveryGiveupReason>> = {
  // 对方节点关闭了加好友接收入口（system_config.friend_requests_inbox_enabled）
  INCOMING_DISABLED: 'incoming_disabled',
  // 对方把本站拉黑了
  BLACKLISTED: 'blacklisted',
  // 对方节点加好友频控打满
  RATE_LIMITED: 'rate_limited',
};

/**
 * 解析投递状态。
 *
 * @param inboxStatus 后端 `inbox_status` 原始值（可能 undefined —— 旧节点未返回该字段）
 * @param _inboxError 后端 `inbox_error` 脱敏短码。**本函数不消费它**（状态只看
 *   `inbox_status`）；错误短码 → 可行动原因由 `resolveFriendDeliveryGiveupReason`
 *   单独解析。保留形参是为了不破坏既有调用点签名，前缀下划线标明「有意未用」。
 */
export function resolveFriendDeliveryState(
  inboxStatus: string | undefined | null,
  _inboxError?: string | undefined | null,
): FriendDeliveryState {
  switch ((inboxStatus ?? '').trim()) {
    case 'acked':
      return 'delivered';
    case 'pending_retry':
      return 'retrying';
    case 'giveup':
      return 'giveup';
    default:
      // '' / undefined / 未知值 → 投递中或未知（**不是**已送达）
      return 'pending';
  }
}

/**
 * giveup 的可行动原因（仅 giveup 态有意义）。
 * 未知短码 → `generic`（通用提示，不把后端原始码透给用户）。
 */
export function resolveFriendDeliveryGiveupReason(
  inboxError: string | undefined | null,
): FriendDeliveryGiveupReason {
  const code = (inboxError ?? '').trim();
  if (!code) return 'generic';
  return GIVEUP_REASON_BY_ERROR[code] ?? 'generic';
}
