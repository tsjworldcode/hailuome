/**
 * REL-FIX-6：跨节点管理员代理操作群主待审批入群申请。
 *
 * 现状问题：入群 pending 只落**群主** D1；`GET /api/groups/:groupId/join-requests`
 * 查本机 `group_members.status=pending` → 跨节点管理员恒 `[]`（看得见审批入口但永远空白）。
 *
 * 方案（按需拉取，不做 cron 轮询，避免风暴）：
 * - 本机是群主 → 查本地 / 直接审批（现状）。
 * - 本机是 active 成员但非群主 → 向群主公开 Worker B 发起「管理员代理」请求，
 *   带 `GROUP_ADMIN_JOIN_REQUEST_V1` 签名证明（本机 admin + group_id + action + 新鲜 ts + nonce）。
 * - 群主 Worker A 侧**权威判定**请求方身份：查群主库 `group_members.is_admin=1`，
 *   不采信请求方自证（成员本机 `is_admin` 常为 0，不能靠自报）。
 *
 * 安全：
 * - 仅群主库在册 admin/owner 可代理；D1 限频（禁 KV）；nonce 落 `group_nonces` 防重放。
 * - 响应仅含群成员公开标识，**不含**邮箱等 PII。
 * - 出站一律走 `fetchOutboundPeer`（SSRF 门禁 + redirect:manual + 超时）。
 */
import {
  GROUP_ADMIN_JOIN_REQUEST_CLOCK_SKEW_MS,
  signGroupAdminJoinRequest,
  verifyGroupAdminJoinRequest,
  randomDmNonceHex,
  type GroupAdminJoinRequestAction,
} from '@hailuo/shared-crypto';
import type { GroupJoinRequestSummary } from '@hailuo/shared-types';
import type { Env } from '../env';
import { resolveIdentityDb } from '../db/bindings';
import { fetchOutboundPeer } from './fetchOutboundPeer';
import {
  approveGroupJoinRequest,
  rejectGroupJoinRequest,
} from './groupInvite';
import { normalizeGroupMemberUrl } from './groupMemberUrl';
import { messagingDb } from './messagingDb';
import {
  checkAndIncrementAdminJoinRequestRate,
  GROUP_ADMIN_JOIN_REQUEST_RATE_LIMIT_PER_HOUR,
} from './groupRateLimit';

/** 群主侧返回给管理员的 pending 列表上限（防超大响应）。 */
export const GROUP_ADMIN_JOIN_REQUEST_MAX_ITEMS = 100;

/** 错误码：请求方不是该群管理员。 */
export const GROUP_ADMIN_JOIN_REQUEST_FORBIDDEN = 'GROUP_NOT_MEMBER';
/** 错误码：签名无效 / 过期 / 重放 / 字段非法。 */
export const GROUP_ADMIN_JOIN_REQUEST_INVALID = 'GROUP_ENVELOPE_INVALID';

export type AdminJoinRequestListResult =
  | { ok: true; items: GroupJoinRequestSummary[] }
  | {
      ok: false;
      status: 400 | 403 | 404 | 409 | 429 | 502;
      error_code: string;
      message: string;
    };

export type AdminJoinRequestActionResult =
  | {
      ok: true;
      data: { group_id: string; member_worker_b_url: string; status: string };
    }
  | {
      ok: false;
      status: 400 | 403 | 404 | 409 | 429 | 502;
      error_code: string;
      message: string;
    };

function nowIso(): string {
  return new Date().toISOString();
}

/** 读本节点自身身份（handle + worker_b_url）。 */
async function getLocalIdentity(env: Env): Promise<{
  handle: string;
  worker_b_url: string;
} | null> {
  return resolveIdentityDb(env)
    .prepare(`SELECT handle, worker_b_url FROM users LIMIT 1`)
    .first<{ handle: string; worker_b_url: string }>();
}

/** 时间戳新鲜度（±5 分钟，容忍节点轻微时钟漂移）。 */
function isTimestampFresh(timestamp: string, nowMs = Date.now()): boolean {
  const ts = Date.parse(timestamp);
  if (!Number.isFinite(ts)) return false;
  return Math.abs(nowMs - ts) <= GROUP_ADMIN_JOIN_REQUEST_CLOCK_SKEW_MS;
}

/** D1 限频：单请求方单群每小时计数（禁 KV 写）。 */
async function checkAdminJoinRequestRate(
  env: Env,
  groupId: string,
  requesterWorkerBUrl: string,
): Promise<boolean> {
  return checkAndIncrementAdminJoinRequestRate(env, groupId, requesterWorkerBUrl);
}

/** nonce 落 `group_nonces` 防重放（唯一约束冲突即视为重放）。 */
async function consumeNonce(
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

/** 群主侧读取 pending 列表（群主 / 管理员共用，字段与本机路径一致）。 */
async function listPendingOnOwner(
  env: Env,
  groupId: string,
): Promise<GroupJoinRequestSummary[]> {
  const { results } = await messagingDb(env)
    .prepare(
      `SELECT member_worker_b_url, member_handle, member_pubkey, key_state, joined_at
         FROM group_members
        WHERE group_id = ? AND status = 'pending'
        ORDER BY joined_at ASC
        LIMIT ?`,
    )
    .bind(groupId, GROUP_ADMIN_JOIN_REQUEST_MAX_ITEMS)
    .all<GroupJoinRequestSummary>();
  return results ?? [];
}

/** 群主权威侧校验：请求方必须是群主库在册 admin（或群主本人）。 */
type AdminGateResult =
  | { ok: true; requesterUrl: string; requesterPubkey: string }
  | {
      ok: false;
      status: 400 | 403 | 404 | 409 | 429 | 502;
      error_code: string;
      message: string;
    };

/**
 * 群主权威侧：校验管理员代理请求。
 * 顺序：本机是群主 → 群存在 → 请求方在群主库在册 admin/owner → 验签 → 时间窗 → 限频 → nonce。
 */
async function gateAdminJoinRequest(
  env: Env,
  input: {
    group_id: string;
    action: GroupAdminJoinRequestAction;
    requester_worker_b_url: string;
    requester_handle: string;
    target_member_worker_b_url: string;
    timestamp: string;
    nonce: string;
    sig: string;
  },
): Promise<AdminGateResult> {
  const groupId = input.group_id.trim();
  const requesterUrl = normalizeGroupMemberUrl(input.requester_worker_b_url);
  const requesterHandle = input.requester_handle.trim().toLowerCase();
  const targetUrl = normalizeGroupMemberUrl(input.target_member_worker_b_url);
  const timestamp = input.timestamp.trim();
  const nonce = input.nonce.trim().toLowerCase();
  const sig = input.sig.trim().toLowerCase();

  if (
    !groupId ||
    !requesterUrl ||
    !requesterHandle ||
    !timestamp ||
    !/^[0-9a-f]{32,64}$/i.test(nonce) ||
    !/^[0-9a-f]{128}$/i.test(sig)
  ) {
    return {
      ok: false,
      status: 400,
      error_code: GROUP_ADMIN_JOIN_REQUEST_INVALID,
      message: '管理员代理请求字段无效',
    };
  }
  if (input.action !== 'list' && !targetUrl) {
    return {
      ok: false,
      status: 400,
      error_code: GROUP_ADMIN_JOIN_REQUEST_INVALID,
      message: '缺少审批目标成员',
    };
  }

  const db = messagingDb(env);
  const localIdentity = await getLocalIdentity(env);
  if (!localIdentity?.worker_b_url) {
    return {
      ok: false,
      status: 409,
      error_code: 'USER_NOT_REGISTERED',
      message: '节点尚未完成注册',
    };
  }
  const localUrl = normalizeGroupMemberUrl(localIdentity.worker_b_url);

  const group = await db
    .prepare(`SELECT owner_worker_b_url, dissolved_at FROM groups WHERE group_id = ? LIMIT 1`)
    .bind(groupId)
    .first<{ owner_worker_b_url: string; dissolved_at: string | null }>();
  if (!group || group.dissolved_at) {
    return { ok: false, status: 404, error_code: 'GROUP_NOT_FOUND', message: '群不存在或已解散' };
  }
  if (normalizeGroupMemberUrl(group.owner_worker_b_url) !== localUrl) {
    return {
      ok: false,
      status: 403,
      error_code: GROUP_ADMIN_JOIN_REQUEST_FORBIDDEN,
      message: '本节点非群主权威',
    };
  }

  // 权威判定：查**群主库** group_members.is_admin（不采信请求方自证）
  const requester = await db
    .prepare(
      `SELECT role, is_admin, status, member_pubkey FROM group_members
        WHERE group_id = ? AND member_worker_b_url = ? LIMIT 1`,
    )
    .bind(groupId, requesterUrl)
    .first<{
      role: string;
      is_admin: number;
      status: string;
      member_pubkey: string;
    }>();
  const isOwnerRow = requester?.role === 'owner';
  const isAdminRow = Number(requester?.is_admin) === 1 && requester?.status === 'active';
  if (!requester || (!isOwnerRow && !isAdminRow)) {
    return {
      ok: false,
      status: 403,
      error_code: GROUP_ADMIN_JOIN_REQUEST_FORBIDDEN,
      message: '仅群主或管理员可代理操作入群申请',
    };
  }

  // 验签：用请求方在群主库的成员公钥
  const pubkey = (requester.member_pubkey ?? '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(pubkey)) {
    return {
      ok: false,
      status: 403,
      error_code: GROUP_ADMIN_JOIN_REQUEST_FORBIDDEN,
      message: '请求方公钥不可用，无法验签',
    };
  }

  const verified = await verifyGroupAdminJoinRequest(
    {
      kind: 'GROUP_ADMIN_JOIN_REQUEST_V1',
      action: input.action,
      group_id: groupId,
      requester_worker_b_url: requesterUrl,
      requester_handle: requesterHandle,
      target_member_worker_b_url: targetUrl,
      timestamp,
      nonce,
      sig,
    },
    pubkey,
  );
  if (!verified) {
    return {
      ok: false,
      status: 403,
      error_code: GROUP_ADMIN_JOIN_REQUEST_INVALID,
      message: '管理员代理请求验签失败',
    };
  }
  if (!isTimestampFresh(timestamp)) {
    return {
      ok: false,
      status: 400,
      error_code: GROUP_ADMIN_JOIN_REQUEST_INVALID,
      message: '管理员代理请求已过期',
    };
  }

  // 限频 + nonce 防重放（先限频后 nonce，避免重放消耗 nonce 额度）
  const allowed = await checkAdminJoinRequestRate(env, groupId, requesterUrl);
  if (!allowed) {
    return {
      ok: false,
      status: 429,
      error_code: 'GROUP_RATE_LIMITED',
      message: '拉取待审批申请过于频繁，请稍后再试',
    };
  }
  const nonceOk = await consumeNonce(env, groupId, nonce, nowIso());
  if (!nonceOk) {
    return {
      ok: false,
      status: 400,
      error_code: GROUP_ADMIN_JOIN_REQUEST_INVALID,
      message: '管理员代理请求重复',
    };
  }

  return { ok: true, requesterUrl, requesterPubkey: pubkey };
}

/** 群主权威侧：处理管理员代理拉取请求。 */
export async function serveAdminJoinRequestListOnOwner(
  env: Env,
  input: {
    group_id: string;
    requester_worker_b_url: string;
    requester_handle: string;
    timestamp: string;
    nonce: string;
    sig: string;
  },
): Promise<AdminJoinRequestListResult> {
  const gate = await gateAdminJoinRequest(env, { ...input, action: 'list', target_member_worker_b_url: '' });
  if (!gate.ok) return gate;
  const items = await listPendingOnOwner(env, input.group_id.trim());
  return { ok: true, items };
}

/** 群主权威侧：处理管理员代理审批（同意 / 拒绝）。 */
export async function serveAdminJoinRequestActionOnOwner(
  env: Env,
  input: {
    group_id: string;
    action: 'approve' | 'reject';
    requester_worker_b_url: string;
    requester_handle: string;
    target_member_worker_b_url: string;
    timestamp: string;
    nonce: string;
    sig: string;
  },
): Promise<AdminJoinRequestActionResult> {
  const gate = await gateAdminJoinRequest(env, { ...input, action: input.action });
  if (!gate.ok) return gate;

  const groupId = input.group_id.trim();
  const targetUrl = normalizeGroupMemberUrl(input.target_member_worker_b_url);
  // 以**群主本人**身份执行审批（管理员代理已由上方权威判定放行）
  const result =
    input.action === 'approve'
      ? await approveGroupJoinRequest(env, groupId, gate.requesterUrl, targetUrl)
      : await rejectGroupJoinRequest(env, groupId, gate.requesterUrl, targetUrl);
  if (!result.ok) {
    return {
      ok: false,
      status: result.status,
      error_code: result.error_code,
      message: result.message,
    };
  }
  return { ok: true, data: result.data };
}

/** 管理员侧：向群主发代理请求（list / approve / reject）。 */
async function proxyAdminJoinRequest(
  env: Env,
  groupId: string,
  ownerUrl: string,
  action: GroupAdminJoinRequestAction,
  targetMemberWorkerBUrl: string,
): Promise<
  | { ok: true; payload: Record<string, unknown> }
  | {
      ok: false;
      status: 400 | 403 | 404 | 409 | 429 | 502;
      error_code: string;
      message: string;
    }
> {
  const localIdentity = await getLocalIdentity(env);
  if (!localIdentity?.worker_b_url || !localIdentity.handle) {
    return {
      ok: false,
      status: 409,
      error_code: 'USER_NOT_REGISTERED',
      message: '节点尚未完成注册',
    };
  }

  const requesterUrl = normalizeGroupMemberUrl(localIdentity.worker_b_url);
  const timestamp = nowIso();
  const nonce = randomDmNonceHex(16);
  const unsigned = {
    kind: 'GROUP_ADMIN_JOIN_REQUEST_V1' as const,
    action,
    group_id: groupId,
    requester_worker_b_url: requesterUrl,
    requester_handle: localIdentity.handle.trim().toLowerCase(),
    target_member_worker_b_url: normalizeGroupMemberUrl(targetMemberWorkerBUrl),
    timestamp,
    nonce,
  };
  let sig: string;
  try {
    sig = await signGroupAdminJoinRequest(unsigned, env.ED25519_PRIVATE_KEY);
  } catch {
    return {
      ok: false,
      status: 502,
      error_code: GROUP_ADMIN_JOIN_REQUEST_INVALID,
      message: '本地签名失败，无法代理操作入群申请',
    };
  }

  const fetched = await fetchOutboundPeer(env, `${ownerUrl}/groups/admin-join-requests`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ v: 1, ...unsigned, sig }),
    timeoutMs: 5_000,
  });
  if (!fetched.ok) {
    return {
      ok: false,
      status: 502,
      error_code: 'GROUP_OWNER_UNREACHABLE',
      message: '无法连接群主节点',
    };
  }
  const res = fetched.response;
  const body = (await res.json().catch(() => null)) as {
    ok?: boolean;
    data?: Record<string, unknown>;
    error_code?: string;
    message?: string;
  } | null;
  if (!res.ok || !body?.ok) {
    return {
      ok: false,
      status: res.status === 403 ? 403 : res.status === 429 ? 429 : 502,
      error_code: body?.error_code ?? GROUP_ADMIN_JOIN_REQUEST_INVALID,
      message: body?.message ?? '群主节点拒绝代理操作入群申请',
    };
  }
  return { ok: true, payload: body.data ?? {} };
}

/**
 * 管理员侧：本机是群主 → 查本地；本机是 active 成员 → 向群主代理拉取。
 */
export async function listGroupJoinRequestsForActor(
  env: Env,
  groupId: string,
  actorWorkerBUrl: string,
): Promise<AdminJoinRequestListResult> {
  const actorUrl = normalizeGroupMemberUrl(actorWorkerBUrl);
  const db = messagingDb(env);

  const group = await db
    .prepare(`SELECT owner_worker_b_url, dissolved_at FROM groups WHERE group_id = ? LIMIT 1`)
    .bind(groupId)
    .first<{ owner_worker_b_url: string; dissolved_at: string | null }>();
  if (!group || group.dissolved_at) {
    return { ok: false, status: 404, error_code: 'GROUP_NOT_FOUND', message: '群不存在或已解散' };
  }
  const ownerUrl = normalizeGroupMemberUrl(group.owner_worker_b_url);

  // 群主：直接查本地权威
  if (ownerUrl === actorUrl) {
    return { ok: true, items: await listPendingOnOwner(env, groupId) };
  }

  // 非群主：必须是本群在册 active 成员（真正的 admin 身份由群主侧权威判定）
  const self = await db
    .prepare(
      `SELECT status FROM group_members
        WHERE group_id = ? AND member_worker_b_url = ? LIMIT 1`,
    )
    .bind(groupId, actorUrl)
    .first<{ status: string }>();
  if (!self || self.status !== 'active') {
    return {
      ok: false,
      status: 403,
      error_code: 'GROUP_NOT_MEMBER',
      message: '非在册成员，无法查看待审批申请',
    };
  }

  const proxied = await proxyAdminJoinRequest(env, groupId, ownerUrl, 'list', '');
  if (!proxied.ok) return proxied;
  const items = (proxied.payload.items ?? []) as GroupJoinRequestSummary[];
  return { ok: true, items };
}

/**
 * 管理员侧：代理审批（同意 / 拒绝）。
 * 本机是群主 → 本地直接审批；否则向群主代理。
 */
export async function approveGroupJoinRequestForActor(
  env: Env,
  groupId: string,
  actorWorkerBUrl: string,
  memberWorkerBUrl: string,
): Promise<AdminJoinRequestActionResult> {
  const actorUrl = normalizeGroupMemberUrl(actorWorkerBUrl);
  const db = messagingDb(env);
  const group = await db
    .prepare(`SELECT owner_worker_b_url, dissolved_at FROM groups WHERE group_id = ? LIMIT 1`)
    .bind(groupId)
    .first<{ owner_worker_b_url: string; dissolved_at: string | null }>();
  if (!group || group.dissolved_at) {
    return { ok: false, status: 404, error_code: 'GROUP_NOT_FOUND', message: '群不存在或已解散' };
  }
  const ownerUrl = normalizeGroupMemberUrl(group.owner_worker_b_url);

  if (ownerUrl === actorUrl) {
    const result = await approveGroupJoinRequest(env, groupId, actorUrl, memberWorkerBUrl);
    if (!result.ok) {
      return {
        ok: false,
        status: result.status,
        error_code: result.error_code,
        message: result.message,
      };
    }
    return { ok: true, data: result.data };
  }

  const self = await db
    .prepare(
      `SELECT status FROM group_members
        WHERE group_id = ? AND member_worker_b_url = ? LIMIT 1`,
    )
    .bind(groupId, actorUrl)
    .first<{ status: string }>();
  if (!self || self.status !== 'active') {
    return {
      ok: false,
      status: 403,
      error_code: 'GROUP_NOT_MEMBER',
      message: '非在册成员，无法审批入群申请',
    };
  }

  const proxied = await proxyAdminJoinRequest(
    env,
    groupId,
    ownerUrl,
    'approve',
    memberWorkerBUrl,
  );
  if (!proxied.ok) return proxied;
  return {
    ok: true,
    data: proxied.payload as {
      group_id: string;
      member_worker_b_url: string;
      status: string;
    },
  };
}

/** 管理员侧：代理拒绝入群申请。 */
export async function rejectGroupJoinRequestForActor(
  env: Env,
  groupId: string,
  actorWorkerBUrl: string,
  memberWorkerBUrl: string,
): Promise<AdminJoinRequestActionResult> {
  const actorUrl = normalizeGroupMemberUrl(actorWorkerBUrl);
  const db = messagingDb(env);
  const group = await db
    .prepare(`SELECT owner_worker_b_url, dissolved_at FROM groups WHERE group_id = ? LIMIT 1`)
    .bind(groupId)
    .first<{ owner_worker_b_url: string; dissolved_at: string | null }>();
  if (!group || group.dissolved_at) {
    return { ok: false, status: 404, error_code: 'GROUP_NOT_FOUND', message: '群不存在或已解散' };
  }
  const ownerUrl = normalizeGroupMemberUrl(group.owner_worker_b_url);

  if (ownerUrl === actorUrl) {
    const result = await rejectGroupJoinRequest(env, groupId, actorUrl, memberWorkerBUrl);
    if (!result.ok) {
      return {
        ok: false,
        status: result.status,
        error_code: result.error_code,
        message: result.message,
      };
    }
    return { ok: true, data: result.data };
  }

  const self = await db
    .prepare(
      `SELECT status FROM group_members
        WHERE group_id = ? AND member_worker_b_url = ? LIMIT 1`,
    )
    .bind(groupId, actorUrl)
    .first<{ status: string }>();
  if (!self || self.status !== 'active') {
    return {
      ok: false,
      status: 403,
      error_code: 'GROUP_NOT_MEMBER',
      message: '非在册成员，无法审批入群申请',
    };
  }

  const proxied = await proxyAdminJoinRequest(
    env,
    groupId,
    ownerUrl,
    'reject',
    memberWorkerBUrl,
  );
  if (!proxied.ok) return proxied;
  return {
    ok: true,
    data: proxied.payload as {
      group_id: string;
      member_worker_b_url: string;
      status: string;
    },
  };
}
