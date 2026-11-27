/**
 * REL-FIX-7：入群审批结果回推申请人（GROUP_JOIN_DECISION_V1）。
 *
 * 目标（docs/relations-join-fix-2026-10-plan.md §4.7）：
 * - 群主同意 / 拒绝后，把结果信封投递给申请人节点 `member_worker_b_url`；
 * - 申请人节点把本地 `group_members.status` 从 pending 推进到 active（同意）
 *   或删除 pending 行（拒绝），并写站内通知 group_join_approved / group_join_rejected；
 * - 投递失败 → outbox pending + 挂既有群外部任务槽重投（**禁 KV 计数**）。
 *
 * 安全：
 * - 签名方 = 群主节点身份钥；验签方 = 申请人节点本地 `role='owner'` 的 pin 公钥
 *   （**不**采信信封自带的 owner_pubkey，避免「自签自验」）。
 * - 决策只对 `member_worker_b_url` 指定的节点生效；接收端比对本地 worker_b_url。
 * - nonce 落 `group_nonces` 防重放；时间窗 ±5 分钟。
 * - 日志只打 group_id / 短 error_code，不打完整对端 URL（rule 12）。
 */
import {
  GROUP_JOIN_DECISION_CLOCK_SKEW_MS,
  GROUP_JOIN_DECISION_KIND,
  randomDmNonceHex,
  signGroupJoinDecision,
  verifyGroupJoinDecision,
  type GroupJoinDecision,
  type GroupJoinDecisionEnvelope,
} from '@hailuo/shared-crypto';

/** REL-FIX-7：审批结果类型（approved / rejected）自 shared-crypto 再导出，便于本地引用。 */
export type { GroupJoinDecision };
import { generateId, nowISO } from '@hailuo/shared-utils';
import type { Env } from '../env';
import { resolveGovernanceDb, resolveIdentityDb } from '../db/bindings';
import { fetchOutboundPeer } from './fetchOutboundPeer';
import { messagingDb } from './messagingDb';
import { normalizeGroupMemberUrl } from './groupMemberUrl';
import { truncatePreview } from './localNotifications';

/** outbox 重投批大小（每条 1 次外部 fetch，计入 cron 外部预算）。 */
export const GROUP_JOIN_DECISION_OUTBOX_BATCH = 5;

/** 最大重投次数；超过置 dead（不再自动重试，留人工排查）。 */
export const GROUP_JOIN_DECISION_OUTBOX_MAX_RETRIES = 8;

/** 重投退避（毫秒），与群 outbox 同档。 */
const OUTBOX_BACKOFF_MS = [60_000, 300_000, 900_000, 3_600_000];

/** 错误码：信封字段无效 / 验签失败 / 时间窗过期。 */
export const GROUP_JOIN_DECISION_INVALID = 'GROUP_ENVELOPE_INVALID';
/** 错误码：不是本节点应受理的决策（URL 不匹配 / 非本群 pending 成员）。 */
export const GROUP_JOIN_DECISION_NOT_TARGET = 'GROUP_NOT_MEMBER';

export type GroupJoinDecisionOutcome =
  | { ok: true; applied: boolean; status: 'active' | 'rejected' }
  | { ok: false; status: 400 | 403 | 404 | 409; error_code: string; message: string };

function nowIso(): string {
  return new Date().toISOString();
}

function isFresh(timestamp: string, nowMs = Date.now()): boolean {
  const ts = Date.parse(timestamp);
  if (!Number.isFinite(ts)) return false;
  return Math.abs(nowMs - ts) <= GROUP_JOIN_DECISION_CLOCK_SKEW_MS;
}

/** 本机身份（handle / pubkey / worker_b_url）。 */
async function getLocalIdentity(env: Env): Promise<{
  handle: string;
  pubkey: string;
  worker_b_url: string;
} | null> {
  return resolveIdentityDb(env)
    .prepare(`SELECT handle, pubkey, worker_b_url FROM users LIMIT 1`)
    .first<{ handle: string; pubkey: string; worker_b_url: string }>();
}

// ── 群主侧：构建 + 投递 ────────────────────────────────────────────

/**
 * 群主侧：审批通过 / 拒绝后向申请人节点投递决策结果。
 *
 * 流程：先落 outbox（D1）→ 立即尝试投递一次 → 成功置 sent，失败留 pending 等 cron 重投。
 * 任何异常都不阻断审批主流程（fail-soft）。
 */
export async function notifyApplicantGroupJoinDecision(
  env: Env,
  input: {
    group_id: string;
    group_name: string;
    member_worker_b_url: string;
    decision: GroupJoinDecision;
  },
): Promise<void> {
  try {
    const memberUrl = normalizeGroupMemberUrl(input.member_worker_b_url);
    if (!memberUrl) return;

    const identity = await getLocalIdentity(env);
    if (!identity?.worker_b_url || !identity.handle || !identity.pubkey) {
      console.warn('[groupJoinDecision] 本机身份不完整，跳过回推');
      return;
    }
    const ownerUrl = normalizeGroupMemberUrl(identity.worker_b_url);

    // outbox 存**未签名**负载：每次投递重建 ts/nonce 并签名（否则重投必然过期）。
    const unsignedPayload = {
      v: 1 as const,
      kind: GROUP_JOIN_DECISION_KIND,
      group_id: input.group_id.trim(),
      decision: input.decision,
      group_name: (input.group_name ?? '').slice(0, 64),
      owner_worker_b_url: ownerUrl,
      owner_handle: identity.handle.trim().toLowerCase(),
      owner_pubkey: identity.pubkey.trim().toLowerCase(),
      member_worker_b_url: memberUrl,
    };

    const now = nowIso();
    const outboxId = generateId('gjdo');
    await messagingDb(env)
      .prepare(
        `INSERT INTO group_join_decision_outbox
           (id, group_id, member_worker_b_url, decision, envelope_json, state, retry_count,
            next_retry_at, last_error, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, NULL, ?, ?)`,
      )
      .bind(
        outboxId,
        unsignedPayload.group_id,
        memberUrl,
        input.decision,
        JSON.stringify(unsignedPayload),
        now,
        now,
        now,
      )
      .run();

    const sent = await deliverJoinDecisionOnce(env, unsignedPayload);
    await messagingDb(env)
      .prepare(
        `UPDATE group_join_decision_outbox
            SET state = ?, retry_count = ?, next_retry_at = ?, last_error = ?, updated_at = ?
          WHERE id = ?`,
      )
      .bind(
        sent.ok ? 'sent' : 'pending',
        sent.ok ? 0 : 1,
        sent.ok ? now : new Date(Date.now() + OUTBOX_BACKOFF_MS[0]!).toISOString(),
        sent.ok ? null : sent.error_code,
        nowIso(),
        outboxId,
      )
      .run();
  } catch (err) {
    console.warn('[groupJoinDecision] 回推异常', err);
  }
}

/** 重建信封（fresh ts/nonce）并投递给申请人节点 Worker B。 */
async function deliverJoinDecisionOnce(
  env: Env,
  payload: {
    v: 1;
    kind: typeof GROUP_JOIN_DECISION_KIND;
    group_id: string;
    decision: GroupJoinDecision;
    group_name: string;
    owner_worker_b_url: string;
    owner_handle: string;
    owner_pubkey: string;
    member_worker_b_url: string;
  },
): Promise<{ ok: true } | { ok: false; error_code: string }> {
  const timestamp = nowIso();
  const nonce = randomDmNonceHex(16);
  const unsigned = {
    kind: GROUP_JOIN_DECISION_KIND as typeof GROUP_JOIN_DECISION_KIND,
    group_id: payload.group_id,
    decision: payload.decision,
    group_name: payload.group_name,
    owner_worker_b_url: payload.owner_worker_b_url,
    owner_handle: payload.owner_handle,
    owner_pubkey: payload.owner_pubkey,
    member_worker_b_url: payload.member_worker_b_url,
    timestamp,
    nonce,
  };
  let sig: string;
  try {
    sig = await signGroupJoinDecision(unsigned, env.ED25519_PRIVATE_KEY);
  } catch {
    return { ok: false, error_code: 'SIGN_FAILED' };
  }
  const envelope: GroupJoinDecisionEnvelope = { ...unsigned, sig };

  const fetched = await fetchOutboundPeer(env, `${payload.member_worker_b_url}/groups/join-decision`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...payload, timestamp, nonce, sig }),
    timeoutMs: 5_000,
  });
  if (!fetched.ok) {
    return { ok: false, error_code: `PEER_${fetched.reason.toUpperCase()}` };
  }
  if (!fetched.response.ok) {
    return { ok: false, error_code: `HTTP_${fetched.response.status}` };
  }
  return { ok: true };
}

/**
 * cron 重投：扫 pending / failed 的 outbox 行，按批重投（外部 fetch ≤ 批大小）。
 * 挂既有群外部任务槽，不新增 Cron。
 */
export async function retryGroupJoinDecisionOutboxBatch(env: Env): Promise<number> {
  const now = nowIso();
  const { results } = await messagingDb(env)
    .prepare(
      `SELECT id, envelope_json, retry_count
         FROM group_join_decision_outbox
        WHERE state IN ('pending', 'failed')
          AND next_retry_at <= ?
          AND retry_count < ?
        ORDER BY next_retry_at ASC
        LIMIT ?`,
    )
    .bind(now, GROUP_JOIN_DECISION_OUTBOX_MAX_RETRIES, GROUP_JOIN_DECISION_OUTBOX_BATCH)
    .all<{ id: string; envelope_json: string; retry_count: number }>();

  let retried = 0;
  for (const row of results ?? []) {
    let payload: Parameters<typeof deliverJoinDecisionOnce>[1] | null = null;
    try {
      payload = JSON.parse(row.envelope_json) as Parameters<typeof deliverJoinDecisionOnce>[1];
    } catch {
      payload = null;
    }
    if (!payload) {
      await messagingDb(env)
        .prepare(
          `UPDATE group_join_decision_outbox
              SET state = 'dead', last_error = 'BAD_PAYLOAD', updated_at = ?
            WHERE id = ?`,
        )
        .bind(nowIso(), row.id)
        .run();
      continue;
    }

    const delivery = await deliverJoinDecisionOnce(env, payload);
    const nextCount = delivery.ok ? row.retry_count : row.retry_count + 1;
    const state = delivery.ok
      ? 'sent'
      : nextCount >= GROUP_JOIN_DECISION_OUTBOX_MAX_RETRIES
        ? 'dead'
        : 'failed';
    const backoff = OUTBOX_BACKOFF_MS[Math.min(nextCount, OUTBOX_BACKOFF_MS.length - 1)]!;
    await messagingDb(env)
      .prepare(
        `UPDATE group_join_decision_outbox
            SET state = ?, retry_count = ?, next_retry_at = ?, last_error = ?, updated_at = ?
          WHERE id = ?`,
      )
      .bind(
        state,
        delivery.ok ? row.retry_count : nextCount,
        delivery.ok ? now : new Date(Date.now() + backoff).toISOString(),
        delivery.ok ? null : delivery.error_code,
        nowIso(),
        row.id,
      )
      .run();
    retried += 1;
  }
  return retried;
}

/**
 * REL-FIX-7：入群审批结果回推 outbox 过期清理（sent/dead 行保留 7 天）。
 * D1-only，随群 retention GC 顺带执行。
 */
export async function gcGroupJoinDecisionOutbox(env: Env): Promise<number> {
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  try {
    const r = await messagingDb(env)
      .prepare(
        `DELETE FROM group_join_decision_outbox
          WHERE state IN ('sent', 'dead') AND updated_at < ?`,
      )
      .bind(cutoff)
      .run();
    return r.meta.changes ?? 0;
  } catch (err) {
    console.warn('[groupJoinDecision] outbox GC 失败', err);
    return 0;
  }
}

// ── 申请人侧：受理决策 ──────────────────────────────────────────────

/** nonce 落 group_nonces 防重放。 */
async function consumeGroupNonce(
  env: Env,
  groupId: string,
  nonce: string,
  createdAt: string,
): Promise<boolean> {
  try {
    await messagingDb(env)
      .prepare(`INSERT INTO group_nonces (group_id, nonce, created_at) VALUES (?, ?, ?)`)
      .bind(groupId, nonce, createdAt)
      .run();
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('UNIQUE') || message.includes('constraint')) return false;
    throw err;
  }
}

/**
 * 申请人侧：受理群主审批结果。
 * - 验签用本地 `group_members` 里 role='owner' 的 pin 公钥（不采信信封自带公钥）
 * - 同意 → 本地 status='active'；拒绝 → 置终态 status='left'（**不删行**，见 REL-FIX-8）
 * - 写站内通知 group_join_approved / group_join_rejected
 */
export async function applyGroupJoinDecisionLocally(
  env: Env,
  envelope: GroupJoinDecisionEnvelope,
): Promise<GroupJoinDecisionOutcome> {
  const groupId = envelope.group_id.trim();
  const memberUrl = normalizeGroupMemberUrl(envelope.member_worker_b_url);
  const ownerUrl = normalizeGroupMemberUrl(envelope.owner_worker_b_url);
  const timestamp = envelope.timestamp.trim();
  const nonce = envelope.nonce.trim().toLowerCase();
  const sig = envelope.sig.trim().toLowerCase();

  if (
    !groupId ||
    !memberUrl ||
    !ownerUrl ||
    !timestamp ||
    !/^[0-9a-f]{32,64}$/i.test(nonce) ||
    !/^[0-9a-f]{128}$/i.test(sig)
  ) {
    return {
      ok: false,
      status: 400,
      error_code: GROUP_JOIN_DECISION_INVALID,
      message: '入群审批结果字段无效',
    };
  }
  if (envelope.decision !== 'approved' && envelope.decision !== 'rejected') {
    return {
      ok: false,
      status: 400,
      error_code: GROUP_JOIN_DECISION_INVALID,
      message: '审批结果非法',
    };
  }
  if (!isFresh(timestamp)) {
    return {
      ok: false,
      status: 400,
      error_code: GROUP_JOIN_DECISION_INVALID,
      message: '入群审批结果已过期',
    };
  }

  const identity = await getLocalIdentity(env);
  if (!identity?.worker_b_url) {
    return {
      ok: false,
      status: 409,
      error_code: 'USER_NOT_REGISTERED',
      message: '节点尚未完成注册',
    };
  }
  // 决策只对目标节点生效
  if (normalizeGroupMemberUrl(identity.worker_b_url) !== memberUrl) {
    return {
      ok: false,
      status: 403,
      error_code: GROUP_JOIN_DECISION_NOT_TARGET,
      message: '该审批结果不属于本节点',
    };
  }

  const db = messagingDb(env);
  const group = await db
    .prepare(`SELECT owner_worker_b_url, name FROM groups WHERE group_id = ? LIMIT 1`)
    .bind(groupId)
    .first<{ owner_worker_b_url: string; name: string }>();
  if (!group) {
    return {
      ok: false,
      status: 404,
      error_code: 'GROUP_NOT_FOUND',
      message: '群不存在',
    };
  }
  if (normalizeGroupMemberUrl(group.owner_worker_b_url) !== ownerUrl) {
    return {
      ok: false,
      status: 403,
      error_code: GROUP_JOIN_DECISION_INVALID,
      message: '审批结果来源与本群群主不一致',
    };
  }

  // 本群 owner pin 公钥（验签唯一依据）
  const pin = await db
    .prepare(
      `SELECT member_pubkey FROM group_members
        WHERE group_id = ? AND role = 'owner' AND status = 'active' LIMIT 1`,
    )
    .bind(groupId)
    .first<{ member_pubkey: string }>();
  const pinPubkey = (pin?.member_pubkey ?? '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(pinPubkey)) {
    return {
      ok: false,
      status: 403,
      error_code: GROUP_JOIN_DECISION_INVALID,
      message: '缺少群主公钥，无法验签',
    };
  }

  const verified = await verifyGroupJoinDecision(
    {
      kind: GROUP_JOIN_DECISION_KIND,
      group_id: groupId,
      decision: envelope.decision,
      group_name: envelope.group_name,
      owner_worker_b_url: ownerUrl,
      owner_handle: envelope.owner_handle,
      owner_pubkey: envelope.owner_pubkey,
      member_worker_b_url: memberUrl,
      timestamp,
      nonce,
      sig,
    },
    pinPubkey,
  );
  if (!verified) {
    return {
      ok: false,
      status: 403,
      error_code: GROUP_JOIN_DECISION_INVALID,
      message: '入群审批结果验签失败',
    };
  }

  const self = await db
    .prepare(
      `SELECT status FROM group_members
        WHERE group_id = ? AND member_worker_b_url = ? LIMIT 1`,
    )
    .bind(groupId, memberUrl)
    .first<{ status: string }>();
  if (!self) {
    return {
      ok: false,
      status: 404,
      error_code: GROUP_JOIN_DECISION_NOT_TARGET,
      message: '本节点不是该群成员',
    };
  }

  const nonceOk = await consumeGroupNonce(env, groupId, nonce, timestamp);
  if (!nonceOk) {
    return {
      ok: false,
      status: 409,
      error_code: 'GROUP_NONCE_REPLAY',
      message: '入群审批结果重复',
    };
  }

  const now = nowIso();
  if (envelope.decision === 'approved') {
    // 幂等：已是 active 视为已处理（不重复写通知）
    if (self.status === 'active') {
      return { ok: true, applied: false, status: 'active' };
    }
    await db
      .prepare(
        `UPDATE group_members
            SET status = 'active', last_ack_at = COALESCE(last_ack_at, ?)
          WHERE group_id = ? AND member_worker_b_url = ?`,
      )
      .bind(now, groupId, memberUrl)
      .run();
    if (envelope.group_name.trim()) {
      await db
        .prepare(`UPDATE groups SET name = ?, updated_at = ? WHERE group_id = ?`)
        .bind(envelope.group_name.trim().slice(0, 64), now, groupId)
        .run();
    }
    await recordGroupJoinDecisionNotification(env, {
      decision: 'approved',
      group_id: groupId,
      group_name: envelope.group_name.trim(),
      owner_handle: envelope.owner_handle.trim(),
      owner_worker_b_url: ownerUrl,
    });
    return { ok: true, applied: true, status: 'active' };
  }

  // REL-FIX-8：拒绝 → 置终态 `status='left'`，**不删行**。
  //
  // 旧行为（DELETE pending 行）会破坏投递幂等：分布式投递可能「对方已执行但响应丢了」，
  // 群主每次重投都重新签发新的 ts/nonce（REL-FIX-7），于是第 2 次投递到达时：
  //   `SELECT status FROM group_members ...` → 行已被删 → `!self` → 404 GROUP_NOT_MEMBER
  // 群主侧 outbox 收到非 2xx → 判投递失败 → 持续重投至 8 次上限后置 `dead`（虚假告警 + 无效流量）。
  //
  // 置终态后：重复投递时 `self.status === 'left'`（≠ 'pending'）→ 直接幂等返回 200，
  // 群主 outbox 正确收敛到 `sent`。
  //
  // 为什么不用「查 local_notifications 是否已有 group_join_rejected 记录」当幂等键：
  // 该表 `request_id = group_id`——**粒度是群不是成员**。同群 B 被拒后 A 再被拒，
  // 第二次会被误判「已受理」→ 直接 200，申请人永远收不到自己的拒绝通知（串号漏回执）。
  // 成员行自带 `status` 才是**成员粒度**的幂等依据。
  //
  // 「便于再次申请」不受影响：再次申请走 `mirrorAcceptedGroupLocally` 的
  // `INSERT OR REPLACE`，会把 `left` 行重写为 `pending`/`active`。
  if (self.status !== 'pending') {
    return { ok: true, applied: false, status: 'rejected' };
  }
  await db
    .prepare(
      `UPDATE group_members
          SET status = 'left', is_admin = 0
        WHERE group_id = ? AND member_worker_b_url = ? AND status = 'pending'`,
    )
    .bind(groupId, memberUrl)
    .run();
  await recordGroupJoinDecisionNotification(env, {
    decision: 'rejected',
    group_id: groupId,
    group_name: envelope.group_name.trim(),
    owner_handle: envelope.owner_handle.trim(),
    owner_worker_b_url: ownerUrl,
  });
  return { ok: true, applied: true, status: 'rejected' };
}

/** 写申请人本地通知（fail-soft）。 */
async function recordGroupJoinDecisionNotification(
  env: Env,
  input: {
    decision: GroupJoinDecision;
    group_id: string;
    group_name: string;
    owner_handle: string;
    owner_worker_b_url: string;
  },
): Promise<void> {
  try {
    const handle = input.owner_handle.trim().toLowerCase() || 'owner';
    const preview = truncatePreview(`${input.group_name || input.group_id} · @${handle}`);
    await resolveGovernanceDb(env)
      .prepare(
        `INSERT INTO local_notifications
           (id, type, post_id, actor_handle, actor_node_url, reply_id, content_preview,
            related_node_url, request_id, created_at, read_at)
         VALUES (?, ?, NULL, ?, ?, NULL, ?, ?, ?, ?, NULL)`,
      )
      .bind(
        generateId('notif'),
        input.decision === 'approved' ? 'group_join_approved' : 'group_join_rejected',
        handle,
        input.owner_worker_b_url,
        preview,
        input.owner_worker_b_url,
        input.group_id,
        nowISO(),
      )
      .run();
  } catch (err) {
    console.warn('[groupJoinDecision] 写入审批结果通知失败', err);
  }
}
