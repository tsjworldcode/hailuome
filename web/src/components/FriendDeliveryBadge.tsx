/** @jsxImportSource preact */
/**
 * REL-FIX-4：好友请求投递状态徽章（发起侧「对方到底收没收到」）。
 *
 * 场景：站主点了「加好友」，201 立刻回来显示「已发送」——但对端可能压根没收到。
 * 本徽章把后端 `inbox_status` 回执翻译成可见状态：
 *   - pending   → 投递中 / 未知（**不渲染**：刚发出的瞬间显示是噪音，
 *                 且旧节点降级路径下该值恒为空 —— 挂上等于给每条都贴"未知"）
 *   - delivered → 已送达（绿）
 *   - retrying  → 发送失败，正在重试（琥珀）
 *   - giveup    → 对方可能未收到（红 + 可行动提示 + 重新发起入口）
 *
 * 防身份关联（`12-anti-deanonymization`）：徽章**只呈现投递状态与通用建议**，
 * 不回显对端节点 URL、邮箱、IP 或后端原始错误串。
 */
import type { VNode } from 'preact';
import { AlertTriangle, Check, RefreshCw } from 'lucide-preact';
import { t } from '../lib/i18n';
import {
  resolveFriendDeliveryGiveupReason,
  resolveFriendDeliveryState,
  type FriendDeliveryGiveupReason,
  type FriendDeliveryState,
} from '../lib/friendDelivery';

interface Props {
  /** 后端 `inbox_status` 原始值 */
  readonly inbox_status?: string | undefined;
  /** 后端 `inbox_error` 脱敏短码 */
  readonly inbox_error?: string | undefined;
  /** giveup 时是否显示可行动提示文案 */
  readonly showHint?: boolean;
  /** giveup 时是否显示「重新发起」按钮 */
  readonly onRetry?: (() => void) | undefined;
  /** 重新发起按钮的禁用态（防重复提交） */
  readonly retryDisabled?: boolean;
  /**
   * REL-FIX-13：是否渲染**状态徽章本体**（药丸）。
   *
   * 默认 true。置 false 时只保留「可行动提示 + 重新发起按钮」，不渲染徽章。
   * 用途：面板 outgoing 行左侧已渲染徽章，若按钮内部再渲染一个 → 同一行出现
   * 两个相同药丸（delivered / retrying / giveup 均会双份）。此时由按钮侧
   * 关掉徽章、只留「重新发起」入口，避免动作入口随徽章一起消失。
   */
  readonly showBadge?: boolean;
}

/** giveup 原因 → 中文提示文案（通用文案不含任何对端身份信息）。 */
function giveupHintText(reason: FriendDeliveryGiveupReason): string {
  switch (reason) {
    case 'incoming_disabled':
      return t('friendDeliveryGiveupIncomingDisabled');
    case 'blacklisted':
      return t('friendDeliveryGiveupBlacklisted');
    case 'rate_limited':
      return t('friendDeliveryGiveupRateLimited');
    default:
      return t('friendDeliveryGiveupHint');
  }
}

/** 状态 → 徽章视觉规格（Tailwind 类）。 */
function badgeStyle(state: FriendDeliveryState): string {
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
function badgeLabel(state: FriendDeliveryState): string {
  switch (state) {
    case 'delivered':
      return t('friendDeliveryAcked');
    case 'retrying':
      return t('friendDeliveryRetrying');
    case 'giveup':
      return t('friendDeliveryGiveup');
    default:
      return t('friendDeliveryPending');
  }
}

/**
 * 渲染投递回执徽章（+ 可选提示 + 可选重新发起按钮）。
 *
 * 刻意**不包外层容器**：调用方（面板行 / 内联按钮）自行决定布局，
 * 避免行内 flex 布局被多余块级元素撑开。
 */
export function FriendDeliveryBadge(props: Props): VNode {
  const state = resolveFriendDeliveryState(props.inbox_status, props.inbox_error);
  // pending（投递中 / 未知）不渲染徽章 —— 见文件头说明
  if (state === 'pending') return <></>;

  const giveupReason =
    state === 'giveup' ? resolveFriendDeliveryGiveupReason(props.inbox_error) : null;

  return (
    <>
      {props.showBadge !== false && (
        <span
          class={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium ${badgeStyle(state)}`}
          data-delivery-state={state}
          data-testid="friend-delivery-badge"
          title={
            props.inbox_error
              ? `${giveupReason ? giveupHintText(giveupReason) : badgeLabel(state)} · ${props.inbox_error}`
              : giveupReason
                ? giveupHintText(giveupReason)
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
      )}

      {state === 'retrying' && props.inbox_error ? (
        <span
          class="text-[10px] text-amber-700 dark:text-amber-300"
          data-testid="friend-delivery-error"
        >
          {props.inbox_error}
        </span>
      ) : null}

      {state === 'giveup' && props.showHint !== false && (
        <span
          class="text-[11px] text-rose-600 dark:text-rose-400"
          data-testid="friend-delivery-hint"
        >
          {giveupHintText(giveupReason ?? 'generic')}
        </span>
      )}

      {state === 'giveup' && props.onRetry && (
        <button
          type="button"
          disabled={props.retryDisabled}
          onClick={() => props.onRetry?.()}
          class="inline-flex items-center gap-1 rounded-full border border-rose-300 px-2 py-0.5 text-[10px] font-medium text-rose-700 hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-rose-700/60 dark:text-rose-300 dark:hover:bg-rose-950/40"
          data-testid="friend-delivery-retry"
        >
          <RefreshCw size={10} aria-hidden="true" />
          {t('friendDeliveryGiveupRetry')}
        </button>
      )}
    </>
  );
}
