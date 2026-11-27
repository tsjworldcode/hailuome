/** @jsxImportSource preact */
/**
 * REL-FIX-12：好友 tab 的「关系未闭环」信号条。
 *
 * 为什么需要它（REL-FIX-4 / REL-FIX-11 的遗留缺口）：
 *   REL-FIX-4（发起侧投递回执）与 REL-FIX-11（接收侧回执）把「对方知不知道」
 *   做到了**通讯录面板**，但**时间线好友 tab 完全看不到**。
 *
 *   而好友 tab 恰恰是站主察觉「某个好友没出现」的地方 ——
 *   若投递 giveup（对方压根没收到请求），那个好友**永远不会**出现在好友动态里，
 *   站主在时间线里**没有任何线索**（面板在另一个页面，很容易忘）。
 *
 * 本条只展示**关系尚未闭环**的信号，不展示正常好友：
 *   - 对方在等我回应（收到的请求还没处理）；
 *   - 我在等对方回应（发出的请求，附投递回执）；
 *   - 我已同意 / 已拒绝，但对方尚未收到回执。
 *
 * 防身份关联（`12-anti-deanonymization`）：
 *   只显示对端 **handle** 与**状态药丸**，**不回显**节点 URL / 邮箱 / IP /
 *   后端原始错误串；徽章文案由 `FriendDeliveryBadge` / `FriendReceiptBadge` 负责
 *   （那两个组件本身已遵守同一红线）。
 */
import type { VNode } from 'preact';
import { t } from '../lib/i18n';
import { FriendDeliveryBadge } from './FriendDeliveryBadge';
import { FriendReceiptBadge } from './FriendReceiptBadge';
import {
  type FriendsRelationSignal,
  type FriendsRelationSignalKind,
} from '../lib/friendsRelationSignals';

interface Props {
  readonly signals: readonly FriendsRelationSignal[];
  /** 需要站主主动处理的条数（giveup）—— 作为角标数字；**只显数量** */
  readonly attentionCount: number;
}

/** 信号类型 → 中文小标题（语义分组，不含对端身份信息）。 */
function kindLabel(kind: FriendsRelationSignalKind): string {
  switch (kind) {
    case 'incoming_pending':
      return t('friendsSignalIncomingPending');
    case 'outgoing_pending':
      return t('friendsSignalOutgoingPending');
    case 'incoming_accepted':
      return t('friendsSignalIncomingAccepted');
    case 'incoming_rejected':
      return t('friendsSignalIncomingRejected');
    default:
      return t('friendsSignalIncomingPending');
  }
}

/**
 * 渲染信号条。
 *
 * 设计取舍：
 *   - **不阻断**好友动态的浏览（信号条在帖子列表**上方**，不是空态替代）；
 *   - 全部信号正常态（无 giveup）时**不显示角标**，避免制造焦虑；
 *   - 每条信号只给 handle + 状态药丸，**不给**可点的「立即处理」动作 ——
 *     处理入口在通讯录面板（避免在时间线里复制一套处理逻辑走偏）；
 *   - 但标题行给一个**纯导航**跳转（固定路由 `/messages?tab=contacts`，零参数、
 *     不带任何身份信息）—— 只解决「看得见、找不到入口」的断层，不复制审批逻辑。
 */
export function FriendsRelationSignals({ signals, attentionCount }: Props): VNode | null {
  if (signals.length === 0) return null;

  return (
    <section
      class="mx-4 mt-3 rounded-2xl border border-amber-200 bg-amber-50/70 px-3 py-2.5 dark:border-amber-700/50 dark:bg-amber-950/20"
      data-testid="friends-relation-signals"
      aria-label={t('friendsSignalsAria')}
    >
      <p class="flex flex-wrap items-center gap-2 text-xs font-medium text-amber-900 dark:text-amber-200">
        <span>{t('friendsSignalsTitle')}</span>
        {attentionCount > 0 && (
          <span
            class="inline-flex items-center rounded-full border border-rose-300 bg-rose-50 px-2 py-0.5 text-[10px] font-semibold text-rose-700 dark:border-rose-700/60 dark:bg-rose-950/40 dark:text-rose-300"
            data-testid="friends-relation-attention-badge"
          >
            {t('friendsSignalsAttention', undefined, { count: attentionCount })}
          </span>
        )}
        {/* REL-FIX-12b：纯导航跳转（固定路由、零参数、不带身份信息），只解决「看得见、找不到入口」的断层 */}
        <a
          href="/messages?tab=contacts"
          class="ml-auto text-[11px] font-medium text-amber-800 underline decoration-dotted underline-offset-2 hover:text-amber-900 dark:text-amber-300 dark:hover:text-amber-200"
          data-testid="friends-relation-signals-go-contacts"
        >
          {t('friendsSignalsGoContacts')}
        </a>
      </p>

      <ul class="mt-2 space-y-1.5" data-testid="friends-relation-signal-list">
        {signals.map((signal) => (
          <li
            key={`${signal.kind}:${signal.id}`}
            class="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-zinc-700 dark:text-zinc-300"
            data-testid="friends-relation-signal"
            data-signal-kind={signal.kind}
          >
            <span class="text-zinc-500 dark:text-zinc-400">{kindLabel(signal.kind)}</span>
            {signal.handle ? (
              <span class="truncate font-medium text-zinc-900 dark:text-zinc-100">
                @{signal.handle}
              </span>
            ) : null}

            {/* 发起侧：投递回执（「我发的请求，对方收没收到」） */}
            {signal.kind === 'outgoing_pending' && (
              <FriendDeliveryBadge
                inbox_status={signal.deliveryStatus}
                inbox_error={signal.deliveryError}
                showHint
              />
            )}

            {/* 接收侧：回执状态（「我回的结果，对方知不知道」） */}
            {(signal.kind === 'incoming_accepted' || signal.kind === 'incoming_rejected') && (
              <FriendReceiptBadge
                outbox_status={signal.receiptStatus}
                outbox_error={signal.receiptError}
                showHint
              />
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
