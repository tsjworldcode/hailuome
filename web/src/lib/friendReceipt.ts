/**
 * REL-FIX-11：好友请求**接收侧**回执状态解析（纯函数，无副作用）。
 *
 * 背景 —— 好友链路的信任缺口是**对称**的：
 *   - 发起侧（REL-FIX-4）：`inbox_status` 回答「我发的请求，对方收没收到」；
 *   - 接收侧（REL-FIX-11）：`outbox_status` 回答「我回的结果（同意/拒绝），对方知不知道」。
 *
 * 缺口场景：接收方点了「同意」，本地立刻变成 accepted，但**回执信封**是
 * `waitUntil` 异步投递的 —— 对端节点不可达 / 对方关了入口 / 频控 → 回执没送到。
 * 发起方那边仍显示 pending，**在干等**。接收方自己却完全不知道这件事，
 * 面板上「已同意」看上去一切正常 → 沉默的失败。
 *
 * 本模块把 `outbox_status` 翻译成**可呈现**的状态：
 *   - pending    → 回执投递中 / 未知（**不渲染徽章**：刚点的瞬间是噪音）
 *   - delivered  → 对方已确认收到回执（绿）
 *   - retrying   → 回执投递失败，正在重试（琥珀）
 *   - giveup     → 超 24h 放弃（红 + 提示：**对方可能还在干等**）
 *
 * 未知/异常值一律归入 `pending`（**不谎报"对方已知"**）—— 与 REL-FIX-4 同口径。
 *
 * 防身份关联（`12-anti-deanonymization`）：状态文案只讲「对方知不知道」，
 * **不回显**对端节点 URL / handle / 邮箱 / IP / 后端原始错误串。
 */

export type FriendReceiptState = 'pending' | 'delivered' | 'retrying' | 'giveup';

/**
 * giveup 的可行动原因（来自后端 `outbox_error` 脱敏短码）。
 * 只有能给出「站主下一步做什么」的码才细分，其余走通用提示。
 */
export type FriendReceiptGiveupReason =
  | 'generic'
  | 'incoming_disabled'
  | 'blacklisted'
  | 'rate_limited';

/** 后端 `outbox_error` 短码 → 可行动原因。 */
const RECEIPT_GIVEUP_REASON_BY_ERROR: Readonly<Record<string, FriendReceiptGiveupReason>> = {
  // 对方节点关闭了加好友接收入口（system_config.friend_requests_inbox_enabled）
  INCOMING_DISABLED: 'incoming_disabled',
  // 对方把本站拉黑了
  BLACKLISTED: 'blacklisted',
  // 对方节点加好友频控打满
  RATE_LIMITED: 'rate_limited',
};

/**
 * 解析回执状态。
 *
 * @param outboxStatus 后端 `outbox_status` 原始值（可能 undefined —— 旧节点未返回该字段）
 * @param _outboxError 后端 `outbox_error` 脱敏短码（本函数不需要，故不参与判定；
 *                      由 `resolveFriendReceiptGiveupReason` 单独消费）
 */
export function resolveFriendReceiptState(
  outboxStatus: string | undefined | null,
  _outboxError?: string | undefined | null,
): FriendReceiptState {
  switch ((outboxStatus ?? '').trim()) {
    case 'acked':
      return 'delivered';
    case 'pending_retry':
      return 'retrying';
    case 'giveup':
      return 'giveup';
    default:
      // '' / undefined / 未知值 → 投递中或未知（**不是**"对方已知结果"）
      return 'pending';
  }
}

/**
 * giveup 的可行动原因（仅 giveup 态有意义）。
 * 未知短码 → `generic`（通用提示，不把后端原始码透给用户）。
 */
export function resolveFriendReceiptGiveupReason(
  outboxError: string | undefined | null,
): FriendReceiptGiveupReason {
  const code = (outboxError ?? '').trim();
  if (!code) return 'generic';
  return RECEIPT_GIVEUP_REASON_BY_ERROR[code] ?? 'generic';
}
