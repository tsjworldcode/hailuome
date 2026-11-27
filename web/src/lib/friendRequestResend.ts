/**
 * REL-FIX-4：好友请求「重新发起」共享 helper。
 *
 * 场景：投递回执 giveup（对方大概率从未收到），站主要重发。
 * 障碍：后端 `uniq_friend_requests_pending`（UNIQUE 部分索引 on
 * `(origin_node_url, target_node_url) WHERE status='pending'`）会拒掉重复的
 * pending 发起 —— 旧请求还在 pending 就发新的会得到 409 `ALREADY_RESOLVED`。
 *
 * 解法：先撤回旧请求（旧行 status → 'cancelled'，索引位让出来），再重发。
 * 撤回是**本地**状态机；旧请求既然从未送达对端，对端也就没有需要撤销的东西，
 * cancelled 回执投递失败不影响本流程。
 *
 * 放共享 lib 而非组件内，是为了让「面板行」与「推荐行内联按钮」两处 UI
 * 共用同一份语义，避免两套实现走偏。
 */

import type { WorkerAClient } from './workerA/types';

export interface ResendFriendRequestInput {
  readonly client: WorkerAClient;
  /** 旧请求 id（giveup 的那条） */
  readonly requestId: string;
  readonly target_node_url: string;
  readonly target_handle: string;
  /** 原附言（可选；重发时沿用） */
  readonly message?: string | null | undefined;
}

export interface ResendFriendRequestResult {
  readonly ok: boolean;
  /** 成功时的新请求 id */
  readonly requestId?: string;
  /** 失败时的可展示原因（已脱敏，不含对端 URL / 邮箱） */
  readonly reason?: string;
}

const MESSAGE_MAX = 200;

/**
 * 撤回旧请求 + 重新发起。
 *
 * 失败语义：
 *   - 旧请求已不是 pending（撤回时 409 ALREADY_RESOLVED）→ 视为「旧请求已消失」，
 *     **仍然尝试重发**（大概率已被对方接受或过期，重发会被后端正常判定）。
 *   - 其余失败 → 返回 ok=false + reason。
 */
export async function resendFriendRequest(
  input: ResendFriendRequestInput,
): Promise<ResendFriendRequestResult> {
  const { client, requestId, target_node_url, target_handle } = input;

  // ---- 1) 撤回旧请求（释放 UNIQUE pending 索引位）----
  try {
    await client.cancelFriendRequest(requestId);
  } catch (err) {
    // 旧请求已非 pending（可能已被对方接受 / 已过期 / 已撤回）→
    // 不阻断重发：重发由后端重新判定 ALREADY_RESOLVED / ALREADY_FOLLOWING 等。
    const code =
      typeof err === 'object' && err !== null && 'code' in err
        ? String((err as { code?: unknown }).code ?? '')
        : '';
    if (code !== 'ALREADY_RESOLVED' && code !== 'FRIEND_REQUEST_NOT_FOUND') {
      return { ok: false, reason: 'cancel_failed' };
    }
  }

  // ---- 2) 重新发起 ----
  try {
    const trimmed = (input.message ?? '').trim().slice(0, MESSAGE_MAX);
    const result = await client.sendFriendRequest({
      target_node_url,
      target_handle,
      ...(trimmed ? { message: trimmed } : {}),
    });
    return { ok: true, requestId: result.id };
  } catch {
    return { ok: false, reason: 'send_failed' };
  }
}
