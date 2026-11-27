/**
 * REL-FIX-12 / REL-FIX-14 backlog ③：把「已处理 · 对方尚未收到回执」按
 * **我同意了 / 我拒绝了** 分组（纯函数，无副作用，便于契约测试）。
 *
 * 背景（REL-FIX-14 登记的 backlog 第 3 条）：
 *   后端 `status=resolved` 过滤返回的行里 **已经带 `status` 字段**
 *   （`accepted` / `rejected`），但前端把两类**混在一段**里渲染 →
 *   站主看到「已处理 · 对方尚未收到回执」时，**分不清对方是在等「同意」
 *   还是等「拒绝」**。
 *
 * 为什么这条值得修：
 *   - 对方在等「同意」时，等待是**有意义**的（我可能还在考虑）；
 *     对方在等「拒绝」时，等待同样是「在等我处理」，但两者的**紧迫性
 *     与后果完全不同** —— 被拒绝的一方通常还带着「是不是被已读」的误解。
 *   - 若最终回执投递 **giveup**（24h 放弃），对方的等待是**毫无意义**的
 *     —— 他们会一直等下去。因此分组标注 + giveup 额外提示是有实际收益的。
 *
 * 防身份关联（`12-anti-deanonymization`）：本模块只做**分组**，
 * 不引入任何对端 URL / 邮箱 / IP / 原始错误串。
 */

/** 好友请求的处理决定（本站是接收方时才有意义）。 */
export type FriendRequestDecision = 'accepted' | 'rejected';

/** 分组结果：`other` 兜底后端未来若放宽 `resolved` 过滤（不得静默丢行）。 */
export interface FriendRequestDecisionGroups<T> {
  readonly accepted: readonly T[];
  readonly rejected: readonly T[];
  readonly other: readonly T[];
}

/**
 * 按处理决定分组。
 *
 * ⚠️ `other` 是**兜底桶**：后端 `status=resolved` 过滤目前保证只返回
 * `accepted` / `rejected`，但若将来放宽（例如加 `cancelled`），未知的
 * `status` **必须**落到 `other` 而不是被静默丢弃 —— 丢行会让站主以为
 * 「所有回执都已送达」。
 */
export function groupFriendRequestsByDecision<
  T extends { readonly status: string },
>(items: readonly T[]): FriendRequestDecisionGroups<T> {
  const accepted: T[] = [];
  const rejected: T[] = [];
  const other: T[] = [];
  for (const item of items) {
    if (item.status === 'accepted') accepted.push(item);
    else if (item.status === 'rejected') rejected.push(item);
    else other.push(item);
  }
  return { accepted, rejected, other };
}
