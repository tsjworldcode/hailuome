/**
 * REL-FIX-12：好友关系「对方知不知道」信号汇总（纯函数，无副作用，便于契约测试）。
 *
 * 背景（REL-FIX-4 / REL-FIX-11 已把回执信号做到通讯录面板，但时间线看不到）：
 *   好友链路的信任缺口是**对称**的，两端各有一个状态机：
 *   - 发起侧 `inbox_status`：我发的请求，对方收没收到（REL-FIX-4）；
 *   - 接收侧 `outbox_status`：我回的结果（同意/拒绝），对方知不知道（REL-FIX-11）。
 *
 *   这两个信号目前**只在**「消息 → 通讯录 → 加好友请求」面板里可见。而
 *   **好友 tab 恰恰是站主察觉「某个好友没出现」的地方** —— 若投递 giveup
 *   （对方压根没收到请求），那个好友**永远不会**出现在好友动态里，
 *   站主在时间线里**没有任何线索**（面板在另一个页面，容易忘）。
 *
 * 本模块把三类「关系尚未闭环」的行汇总成**可呈现的信号列表**：
 *   1. `incoming_pending`  —— 对方在等我回应（我还没处理）；
 *   2. `outgoing_pending`  —— 我在等对方回应（附发起侧投递回执）；
 *   3. `incoming_accepted` / `incoming_rejected`
 *      —— 我已同意/已拒绝，但**对方尚未收到回执**（附接收侧回执状态）。
 *
 * 防身份关联（`12-anti-deanonymization`）：
 *   - 只带对端 **handle** 与**状态**，**不带**节点 URL / 邮箱 / IP / 原始错误串；
 *   - 状态文案由既有的 `FriendDeliveryBadge` / `FriendReceiptBadge` 负责，
 *     那两个组件本身已遵守「只呈现状态与通用建议」。
 */

import { resolveFriendDeliveryState } from './friendDelivery';
import { resolveFriendReceiptState } from './friendReceipt';

export type FriendsRelationSignalKind =
  /** 对方在等我回应（我还没处理） */
  | 'incoming_pending'
  /** 我在等对方回应（发起侧，附投递回执） */
  | 'outgoing_pending'
  /** 我已同意，但对方尚未收到回执 */
  | 'incoming_accepted'
  /** 我已拒绝，但对方尚未收到回执 */
  | 'incoming_rejected';

export interface FriendsRelationSignal {
  readonly id: string;
  readonly kind: FriendsRelationSignalKind;
  /** 对端 handle（**不含**节点 URL） */
  readonly handle: string;
  /** 发起侧投递状态（`inbox_status`）—— 仅 `outgoing_pending` 有意义 */
  readonly deliveryStatus?: string;
  /** 发起侧投递失败短码（脱敏） */
  readonly deliveryError?: string;
  /** 接收侧回执状态（`outbox_status`）—— 仅 `incoming_accepted/rejected` 有意义 */
  readonly receiptStatus?: string;
  /** 接收侧回执失败短码（脱敏） */
  readonly receiptError?: string;
}

/** 输入：面板同源的三份列表（后端 `items` 已带 `status`）。 */
export interface FriendsRelationSignalInput {
  /** 收到的请求 · pending */
  readonly incomingPending: readonly FriendsRelationRow[];
  /** 发出的请求 · pending */
  readonly outgoingPending: readonly FriendsRelationRow[];
  /** 收到的请求 · resolved（已处理但回执未确认送达对方） */
  readonly incomingResolved: readonly FriendsRelationRow[];
}

/** 面板行最小形状（后端 `FriendRequestItem` 的相关字段）。 */
export interface FriendsRelationRow {
  readonly id: string;
  readonly status: string;
  readonly origin_handle?: string;
  readonly target_handle?: string;
  readonly inbox_status?: string;
  readonly inbox_error?: string;
  readonly outbox_status?: string;
  readonly outbox_error?: string;
}

/**
 * 汇总三类「关系未闭环」信号。
 *
 * 排序（稳定、可预期）：
 *   1. 需要对方确认的**失败态**最优先（giveup —— 对方的等待已经**毫无意义**）；
 *   2. 其次是重试中；
 *   3. 再次是对方在等我回应；
 *   4. 最后是我在等对方回应。
 */
export function buildFriendsRelationSignals(
  input: FriendsRelationSignalInput,
): readonly FriendsRelationSignal[] {
  const signals: FriendsRelationSignal[] = [];

  // ① 对方在等我回应（incoming pending）
  for (const row of input.incomingPending) {
    signals.push({
      id: row.id,
      kind: 'incoming_pending',
      handle: (row.origin_handle ?? '').trim(),
    });
  }

  // ② 我在等对方回应（outgoing pending，附发起侧投递回执）
  for (const row of input.outgoingPending) {
    signals.push({
      id: row.id,
      kind: 'outgoing_pending',
      handle: (row.target_handle ?? '').trim(),
      deliveryStatus: row.inbox_status ?? '',
      deliveryError: row.inbox_error ?? '',
    });
  }

  // ③ 我已同意 / 已拒绝，但对方尚未收到回执（附接收侧回执状态）
  for (const row of input.incomingResolved) {
    if (row.status === 'accepted' || row.status === 'rejected') {
      signals.push({
        id: row.id,
        kind: row.status === 'accepted' ? 'incoming_accepted' : 'incoming_rejected',
        handle: (row.origin_handle ?? '').trim(),
        receiptStatus: row.outbox_status ?? '',
        receiptError: row.outbox_error ?? '',
      });
    }
  }

  return signals.sort((a, b) => relationSignalPriority(a) - relationSignalPriority(b));
}

/** 排序权重（数字越小越靠前）。 */
function relationSignalPriority(signal: FriendsRelationSignal): number {
  if (signal.kind === 'outgoing_pending') {
    const st = resolveFriendDeliveryState(signal.deliveryStatus);
    if (st === 'giveup') return 0;
    if (st === 'retrying') return 1;
    return 3;
  }
  if (signal.kind === 'incoming_accepted' || signal.kind === 'incoming_rejected') {
    const st = resolveFriendReceiptState(signal.receiptStatus);
    if (st === 'giveup') return 0;
    if (st === 'retrying') return 1;
    return 3;
  }
  // incoming_pending：对方在等我回应 —— 优先级高于「我在等对方」
  return 2;
}

/**
 * 需要站主**主动处理**的信号数（giveup 态）。
 *
 * 只数 giveup：那种情况下对方的等待已经**毫无意义**（24h 内不会再重投），
 * 必须让站主知道。其余状态（重试中 / 正常等待）不紧急，不进角标。
 */
export function countFriendsRelationAttention(
  signals: readonly FriendsRelationSignal[],
): number {
  let n = 0;
  for (const s of signals) {
    if (s.kind === 'outgoing_pending') {
      if (resolveFriendDeliveryState(s.deliveryStatus) === 'giveup') n += 1;
    } else if (s.kind === 'incoming_accepted' || s.kind === 'incoming_rejected') {
      if (resolveFriendReceiptState(s.receiptStatus) === 'giveup') n += 1;
    }
  }
  return n;
}
