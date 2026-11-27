/** @jsxImportSource preact */
/**
 * REL-FIX-11：好友请求**接收侧**回执徽章（「我回的结果，对方知不知道」）。
 *
 * 场景：接收方点了「同意 / 拒绝」，本地状态立刻变 accepted / rejected，
 * 但回执信封是异步投递的 —— 对端不可达 / 对方关了入口 / 频控 → 回执没送到，
 * **发起方还在干等**。本徽章把 `outbox_status` 翻译成可见状态：
 *   - pending   → 回执投递中 / 未知（**不渲染**：刚点的瞬间显示是噪音）
 *   - delivered → 对方已确认收到（绿）
 *   - retrying  → 回执投递失败，正在重试（琥珀）
 *   - giveup    → 对方可能仍在等待（红 + 提示）
 *
 * 与 REL-FIX-4 的 `FriendDeliveryBadge` 是**严格对称**的一对：
 *   - FriendDeliveryBadge → 「我发的请求，对方收没收到」（发起侧）
 *   - FriendReceiptBadge  → 「我回的结果，对方知不知道」（接收侧）
 *
 * 防身份关联（`12-anti-deanonymization`）：徽章**只呈现回执状态、脱敏短码与通用建议**，
 * 不回显对端节点 URL、handle、邮箱、IP 或任何身份字段。
 */
import type { VNode } from 'preact';
import { AlertTriangle, Check, RefreshCw } from 'lucide-preact';
import { t } from '../lib/i18n';
import {
  resolveFriendReceiptGiveupReason,
  resolveFriendReceiptState,
  type FriendReceiptGiveupReason,
  type FriendReceiptState,
} from '../lib/friendReceipt';

interface Props {
  /** 后端 `outbox_status` 原始值 */
  readonly outbox_status?: string | undefined;
  /** 后端 `outbox_error` 脱敏短码 */
  readonly outbox_error?: string | undefined;
  /** giveup 时是否显示可行动提示文案 */
  readonly showHint?: boolean;
}

/** giveup 原因 → 中文提示文案（通用文案不含任何对端身份信息）。 */
function receiptHintText(reason: FriendReceiptGiveupReason): string {
  switch (reason) {
    case 'incoming_disabled':
      return t('friendReceiptGiveupIncomingDisabled');
    case 'blacklisted':
      return t('friendReceiptGiveupBlacklisted');
    case 'rate_limited':
      return t('friendReceiptGiveupRateLimited');
    default:
      return t('friendReceiptGiveupHint');
  }
}

/** 状态 → 徽章视觉规格（Tailwind 类）。 */
function badgeStyle(state: FriendReceiptState): string {
  switch (state) {
    case 'delivered':
      return 'border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-700/60 dark:bg-emerald-950/40 dark:text-emerald-300';
    case 'retrying':
      return 'border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-700/60 dark:bg-amber-950/40 dark:text-amber-300';
    case 'giveup':
      return 'border-rose-300 bg-rose-50 text-rose-800 dark:border-rose-700/60 dark:bg-rose-950/40 dark:text-rose-300';
    default:
      return 'border-zinc-300 bg-zinc-50 text-zinc-600 dark:border-zinc-700 dark:bg-zinc-900/60 dark:text-zinc-400';
  }
}

/** 状态 → 徽章文案。 */
function badgeLabel(state: FriendReceiptState): string {
  switch (state) {
    case 'delivered':
      return t('friendReceiptAcked');
    case 'retrying':
      return t('friendReceiptRetrying');
    case 'giveup':
      return t('friendReceiptGiveup');
    default:
      return t('friendReceiptPending');
  }
}

/**
 * 渲染接收侧回执徽章（+ 可选提示）。
 *
 * 刻意**不包外层容器**：调用方（面板行）自行决定布局。
 */
export function FriendReceiptBadge(props: Props): VNode {
  const state = resolveFriendReceiptState(props.outbox_status, props.outbox_error);
  // pending（回执投递中 / 未知）不渲染徽章 —— 见文件头说明
  if (state === 'pending') return <></>;

  const giveupReason =
    state === 'giveup' ? resolveFriendReceiptGiveupReason(props.outbox_error) : null;

  return (
    <>
      <span
        class={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium ${badgeStyle(state)}`}
        data-receipt-state={state}
        data-testid="friend-receipt-badge"
        title={
          props.outbox_error
            ? `${giveupReason ? receiptHintText(giveupReason) : badgeLabel(state)} · ${props.outbox_error}`
            : giveupReason
              ? receiptHintText(giveupReason)
              : badgeLabel(state)
        }
      >
        {state === 'delivered' ? (
          <Check size={10} aria-hidden="true" />
        ) : state === 'retrying' ? (
          <RefreshCw size={10} aria-hidden="true" />
        ) : (
          <AlertTriangle size={10} aria-hidden="true" />
        )}
        {badgeLabel(state)}
      </span>

      {state === 'retrying' && props.outbox_error ? (
        <span
          class="text-[10px] text-amber-700 dark:text-amber-300"
          data-testid="friend-receipt-error"
        >
          {props.outbox_error}
        </span>
      ) : null}

      {state === 'giveup' && props.showHint !== false && (
        <span
          class="text-[11px] text-rose-600 dark:text-rose-400"
          data-testid="friend-receipt-hint"
        >
          {receiptHintText(giveupReason ?? 'generic')}
        </span>
      )}
    </>
  );
}
