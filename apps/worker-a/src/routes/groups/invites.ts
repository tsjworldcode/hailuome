/**
 * NCF-AUDIT-Y-15-3：群公开面 · 邀请 / 入群 / 审批。
 */
import {
  acceptGroupInviteOnOwner,
  createGroupInvite,
  mirrorAcceptedGroupLocally,
  parseInviteTtlDays,
  revokeGroupInvite,
  type AcceptInviteInput,
  type AcceptInviteResult,
} from '../../lib/groupInvite';
import {
  approveGroupJoinRequestForActor,
  listGroupJoinRequestsForActor,
  rejectGroupJoinRequestForActor,
} from '../../lib/groupAdminJoinRequest';
import {
  isGroupJoinPolicy,
  joinGroupByIdOnOwner,
  setGroupJoinPolicy,
  type GroupJoinPolicy,
  type JoinGroupByIdInput,
  type JoinGroupByIdResult,
} from '../../lib/groupJoinPolicy';
import { fetchOutboundPeer } from '../../lib/fetchOutboundPeer';
import { normalizeGroupMemberUrl } from '../../lib/groupMemberUrl';
import { messagingDb } from '../../lib/messagingDb';
import type { Hono } from 'hono';
import {
  type AppEnv,
  type GroupContext,
  GROUP_NAME_MAX,
  GROUP_ANNOUNCEMENT_MAX,
  GROUP_ID_RE,
  GROUP_SYNC_TTL_MS,
  GMSG_ID_RE,
  GROUP_MSG_PAGE_LIMIT_MAX,
  GROUP_WRAPPED_KEY_MAX,
  nowIso,
  errorJson,
  readRawJson,
  getLocalUser,
  parseAcceptInviteBody,
} from './shared';


export function registerGroupsInvitesRoutes(app: Hono<AppEnv>): void {
  // POST /api/groups/:groupId/invites — 创建邀请（群主）；M16-INVITE-LIFE：可选 ttl_days
  app.post('/:groupId/invites', async (c) => {
    const groupId = c.req.param('groupId');
    if (!GROUP_ID_RE.test(groupId)) {
      return errorJson(c, 400, 'GROUP_ENVELOPE_INVALID', 'group_id 无效');
    }

    const localUser = await getLocalUser(c.env);
    if (!localUser?.worker_b_url) {
      return errorJson(c, 409, 'USER_NOT_REGISTERED', '节点尚未完成注册');
    }

    const body = await readRawJson(c);
    const ttlDays = parseInviteTtlDays(body.ttl_days);
    if (ttlDays === null) {
      return errorJson(c, 400, 'GROUP_INVITE_TTL_INVALID', '有效期仅支持 7 / 30 / 365 / 3650 天');
    }
    let requiresApproval: boolean | undefined;
    if (typeof body.requires_approval === 'boolean') {
      requiresApproval = body.requires_approval;
    } else if (body.requires_approval !== undefined && body.requires_approval !== null) {
      return errorJson(c, 400, 'GROUP_ENVELOPE_INVALID', 'requires_approval 须为布尔值');
    }

    const db = messagingDb(c.env);
    const group = await db
      .prepare(`SELECT owner_worker_b_url FROM groups WHERE group_id = ? AND dissolved_at IS NULL LIMIT 1`)
      .bind(groupId)
      .first<{ owner_worker_b_url: string }>();
    if (!group) {
      return errorJson(c, 404, 'GROUP_NOT_FOUND', '群不存在');
    }
    if (normalizeGroupMemberUrl(group.owner_worker_b_url) !== normalizeGroupMemberUrl(localUser.worker_b_url)) {
      return errorJson(c, 403, 'GROUP_NOT_MEMBER', '仅群主可创建邀请');
    }

    const invite = await createGroupInvite(c.env, groupId, localUser.worker_b_url, {
      ttl_days: ttlDays,
      requires_approval: requiresApproval,
    });
    if (!invite) {
      return errorJson(c, 404, 'GROUP_NOT_FOUND', '群不存在');
    }

    return c.json({
      ok: true,
      data: {
        group_id: groupId,
        group_name: invite.group_name,
        owner_worker_b_url: normalizeGroupMemberUrl(localUser.worker_b_url),
        invite_token: invite.invite_token,
        // M16-INVITE-SHORT：分享优先用 8 位短码；空串表示未生成（极少，前端回落长链）
        invite_code: invite.invite_code || undefined,
        expires_at: invite.expires_at,
        requires_approval: invite.requires_approval,
        ttl_days: invite.ttl_days,
      },
    });
  });

  // GET /api/groups/:groupId/join-requests — 群主/管理员列出待审批
  // REL-FIX-6：本机是群主 → 查本地；本机是成员管理员 → 向群主节点代理拉取（pending 只落群主库）
  app.get('/:groupId/join-requests', async (c) => {
    const groupId = c.req.param('groupId');
    if (!GROUP_ID_RE.test(groupId)) {
      return errorJson(c, 400, 'GROUP_ENVELOPE_INVALID', 'group_id 无效');
    }
    const localUser = await getLocalUser(c.env);
    if (!localUser?.worker_b_url) {
      return errorJson(c, 409, 'USER_NOT_REGISTERED', '节点尚未完成注册');
    }
    const result = await listGroupJoinRequestsForActor(c.env, groupId, localUser.worker_b_url);
    if (!result.ok) {
      return errorJson(c, result.status, result.error_code, result.message);
    }
    return c.json({ ok: true, data: { items: result.items } });
  });

  // POST /api/groups/:groupId/join-requests/approve
  app.post('/:groupId/join-requests/approve', async (c) => {
    const groupId = c.req.param('groupId');
    if (!GROUP_ID_RE.test(groupId)) {
      return errorJson(c, 400, 'GROUP_ENVELOPE_INVALID', 'group_id 无效');
    }
    const localUser = await getLocalUser(c.env);
    if (!localUser?.worker_b_url) {
      return errorJson(c, 409, 'USER_NOT_REGISTERED', '节点尚未完成注册');
    }
    const body = await readRawJson(c);
    const memberUrl =
      typeof body.member_worker_b_url === 'string' ? body.member_worker_b_url.trim() : '';
    if (!memberUrl) {
      return errorJson(c, 400, 'GROUP_ENVELOPE_INVALID', 'member_worker_b_url 必填');
    }
    const result = await approveGroupJoinRequestForActor(
      c.env,
      groupId,
      localUser.worker_b_url,
      memberUrl,
    );
    if (!result.ok) {
      return errorJson(c, result.status, result.error_code, result.message);
    }
    return c.json({ ok: true, data: result.data });
  });

  // POST /api/groups/:groupId/join-requests/reject
  app.post('/:groupId/join-requests/reject', async (c) => {
    const groupId = c.req.param('groupId');
    if (!GROUP_ID_RE.test(groupId)) {
      return errorJson(c, 400, 'GROUP_ENVELOPE_INVALID', 'group_id 无效');
    }
    const localUser = await getLocalUser(c.env);
    if (!localUser?.worker_b_url) {
      return errorJson(c, 409, 'USER_NOT_REGISTERED', '节点尚未完成注册');
    }
    const body = await readRawJson(c);
    const memberUrl =
      typeof body.member_worker_b_url === 'string' ? body.member_worker_b_url.trim() : '';
    if (!memberUrl) {
      return errorJson(c, 400, 'GROUP_ENVELOPE_INVALID', 'member_worker_b_url 必填');
    }
    const result = await rejectGroupJoinRequestForActor(
      c.env,
      groupId,
      localUser.worker_b_url,
      memberUrl,
    );
    if (!result.ok) {
      return errorJson(c, result.status, result.error_code, result.message);
    }
    return c.json({ ok: true, data: result.data });
  });

  // POST /api/groups/:groupId/invites/revoke — 作废邀请（短码或 ginv_）
  app.post('/:groupId/invites/revoke', async (c) => {
    const groupId = c.req.param('groupId');
    if (!GROUP_ID_RE.test(groupId)) {
      return errorJson(c, 400, 'GROUP_ENVELOPE_INVALID', 'group_id 无效');
    }
    const localUser = await getLocalUser(c.env);
    if (!localUser?.worker_b_url) {
      return errorJson(c, 409, 'USER_NOT_REGISTERED', '节点尚未完成注册');
    }
    const body = await readRawJson(c);
    const token =
      typeof body.invite_token === 'string'
        ? body.invite_token.trim()
        : typeof body.invite_code === 'string'
          ? body.invite_code.trim()
          : '';
    if (!token) {
      return errorJson(c, 400, 'GROUP_ENVELOPE_INVALID', 'invite_token 或 invite_code 必填');
    }
    const result = await revokeGroupInvite(c.env, groupId, localUser.worker_b_url, token);
    if (!result.ok) {
      return errorJson(c, result.status, result.error_code, result.message);
    }
    return c.json({ ok: true, data: result.data });
  });

  // PUT /api/groups/:groupId/join-policy — M16-JOIN-POLICY：closed|approval|open
  app.put('/:groupId/join-policy', async (c) => {
    const groupId = c.req.param('groupId');
    if (!GROUP_ID_RE.test(groupId)) {
      return errorJson(c, 400, 'GROUP_ENVELOPE_INVALID', 'group_id 无效');
    }
    const localUser = await getLocalUser(c.env);
    if (!localUser?.worker_b_url) {
      return errorJson(c, 409, 'USER_NOT_REGISTERED', '节点尚未完成注册');
    }
    const body = await readRawJson(c);
    // 兼容旧布尔：true→approval，false→open；新客户端传 join_policy 枚举
    let policy: GroupJoinPolicy;
    if (isGroupJoinPolicy(body.join_policy)) {
      policy = body.join_policy;
    } else if (typeof body.join_requires_approval === 'boolean') {
      policy = body.join_requires_approval ? 'approval' : 'open';
    } else {
      return errorJson(c, 400, 'GROUP_JOIN_POLICY_INVALID', 'join_policy 须为 closed/approval/open');
    }
    const result = await setGroupJoinPolicy(c.env, groupId, localUser.worker_b_url, policy);
    if (!result.ok) {
      return errorJson(c, result.status, result.error_code, result.message);
    }
    return c.json({ ok: true, data: result.data });
  });

  /** 成员本节点接受邀请（本节点权威或转发群主 Worker B）。 */
  async function runMemberAcceptInvite(
    c: GroupContext,
    acceptInput: AcceptInviteInput,
    ownerWorkerBUrl: string,
  ): Promise<Response> {
    const localUser = await getLocalUser(c.env);
    if (!localUser?.worker_b_url) {
      return errorJson(c, 409, 'USER_NOT_REGISTERED', '节点尚未完成注册');
    }

    const ownerUrl = normalizeGroupMemberUrl(ownerWorkerBUrl);
    const localOwnerUrl = normalizeGroupMemberUrl(localUser.worker_b_url);
    const keyState =
      typeof acceptInput.wrapped_key_json === 'string' && acceptInput.wrapped_key_json.trim().length > 0
        ? 'active'
        : 'pending_key';

    let acceptResult;
    if (ownerUrl === localOwnerUrl) {
      acceptResult = await acceptGroupInviteOnOwner(c.env, acceptInput);
    } else {
      // SEC-AUDIT-2026-10-1：跨节点 invite-accept 走统一出站
      const fetched = await fetchOutboundPeer(c.env, `${ownerUrl}/groups/invite-accept`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(acceptInput),
        timeoutMs: 10_000,
      });
      if (!fetched.ok) {
        return errorJson(c, 502, 'GROUP_OWNER_UNREACHABLE', '无法连接群主节点');
      }
      const upstream = fetched.response;
      const parsed = (await upstream.json().catch(() => null)) as {
        ok?: boolean;
        data?: AcceptInviteResult;
        error_code?: string;
        message?: string;
      } | null;
      if (!upstream.ok || !parsed?.ok || !parsed.data) {
        const code = parsed?.error_code ?? 'GROUP_OWNER_REJECTED';
        const message = parsed?.message ?? '群主节点拒绝入群请求';
        const status = (upstream.status >= 400 && upstream.status < 600 ? upstream.status : 502) as
          | 400
          | 403
          | 404
          | 409
          | 502
          | 503;
        return errorJson(c, status, code, message);
      }
      acceptResult = { ok: true as const, data: parsed.data };
    }

    if (!acceptResult.ok) {
      return errorJson(c, acceptResult.status, acceptResult.error_code, acceptResult.message);
    }

    await mirrorAcceptedGroupLocally(
      c.env,
      acceptResult.data,
      {
        member_worker_b_url: localUser.worker_b_url,
        member_handle: localUser.handle,
        member_pubkey: localUser.pubkey,
        member_dh_pubkey: acceptInput.member_dh_pubkey,
      },
      keyState,
    );

    return c.json({ ok: true, data: acceptResult.data });
  }

  /** M16-JOIN-POLICY-2：成员本节点按群号加入（同节点直调 / 跨节点 B ingress）。 */
  async function runMemberJoinById(
    c: GroupContext,
    joinInput: JoinGroupByIdInput,
    ownerWorkerBUrl: string,
  ): Promise<Response> {
    const localUser = await getLocalUser(c.env);
    if (!localUser?.worker_b_url) {
      return errorJson(c, 409, 'USER_NOT_REGISTERED', '节点尚未完成注册');
    }

    const ownerUrl = normalizeGroupMemberUrl(ownerWorkerBUrl);
    const localOwnerUrl = normalizeGroupMemberUrl(localUser.worker_b_url);
    const keyState =
      typeof joinInput.wrapped_key_json === 'string' && joinInput.wrapped_key_json.trim().length > 0
        ? 'active'
        : 'pending_key';

    let joinResult:
      | { ok: true; data: JoinGroupByIdResult }
      | { ok: false; status: 400 | 403 | 404 | 409 | 429 | 502; error_code: string; message: string };
    if (ownerUrl === localOwnerUrl) {
      joinResult = await joinGroupByIdOnOwner(c.env, joinInput);
    } else {
      // SEC-AUDIT-2026-10-1：跨节点 join 走统一出站
      const fetched = await fetchOutboundPeer(c.env, `${ownerUrl}/groups/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(joinInput),
        timeoutMs: 10_000,
      });
      if (!fetched.ok) {
        return errorJson(c, 502, 'GROUP_OWNER_UNREACHABLE', '无法连接群主节点');
      }
      const upstream = fetched.response;
      const parsed = (await upstream.json().catch(() => null)) as {
        ok?: boolean;
        data?: JoinGroupByIdResult;
        error_code?: string;
        message?: string;
      } | null;
      if (!upstream.ok || !parsed?.ok || !parsed.data) {
        const code = parsed?.error_code ?? 'GROUP_OWNER_REJECTED';
        const message = parsed?.message ?? '群主节点拒绝入群请求';
        const status = (upstream.status >= 400 && upstream.status < 600 ? upstream.status : 502) as
          | 400
          | 403
          | 404
          | 409
          | 429
          | 502
          | 503;
        return errorJson(c, status, code, message);
      }
      joinResult = { ok: true as const, data: parsed.data };
    }

    if (!joinResult.ok) {
      return errorJson(c, joinResult.status, joinResult.error_code, joinResult.message);
    }

    // mirror 复用邀请成功镜像；AcceptInviteResult 与 Join 成功字段兼容
    await mirrorAcceptedGroupLocally(
      c.env,
      joinResult.data,
      {
        member_worker_b_url: localUser.worker_b_url,
        member_handle: localUser.handle,
        member_pubkey: localUser.pubkey,
        member_dh_pubkey: joinInput.member_dh_pubkey,
      },
      keyState,
    );

    return c.json({ ok: true, data: joinResult.data });
  }

  // POST /api/groups/join — M16-JOIN-POLICY-2：按固定群号加入（须在 /:groupId/* 之前）
  app.post('/join', async (c) => {
    const body = await readRawJson(c);
    const localUser = await getLocalUser(c.env);
    if (!localUser?.worker_b_url) {
      return errorJson(c, 409, 'USER_NOT_REGISTERED', '节点尚未完成注册');
    }

    const ownerWorkerBUrl =
      typeof body.owner_worker_b_url === 'string' ? body.owner_worker_b_url.trim() : '';
    const groupId = typeof body.group_id === 'string' ? body.group_id.trim() : '';
    const wrappedKeyJson =
      typeof body.wrapped_key_json === 'string' ? body.wrapped_key_json : null;
    if (!ownerWorkerBUrl || !GROUP_ID_RE.test(groupId)) {
      return errorJson(c, 400, 'GROUP_ENVELOPE_INVALID', 'owner_worker_b_url 与 group_id 必填');
    }

    const memberDhPubkey =
      typeof body.member_dh_pubkey === 'string' ? body.member_dh_pubkey.trim() : '';
    if (!memberDhPubkey) {
      return errorJson(c, 400, 'GROUP_ENVELOPE_INVALID', '入群须携带 member_dh_pubkey');
    }
    const joinInput: JoinGroupByIdInput = {
      group_id: groupId,
      member_worker_b_url: localUser.worker_b_url,
      member_handle: localUser.handle,
      member_pubkey: localUser.pubkey,
      member_dh_pubkey: memberDhPubkey,
      wrapped_key_json: wrappedKeyJson,
    };
    return runMemberJoinById(c, joinInput, ownerWorkerBUrl);
  });

  // POST /api/groups/invites/accept — M16-INVITE-SHORT：短码入群（无 path groupId）
  // 必须注册在 /:groupId/invites/accept 之前，避免 groupId=invites 误匹配
  app.post('/invites/accept', async (c) => {
    const body = await readRawJson(c);
    const localUser = await getLocalUser(c.env);
    if (!localUser?.worker_b_url) {
      return errorJson(c, 409, 'USER_NOT_REGISTERED', '节点尚未完成注册');
    }

    const ownerWorkerBUrl =
      typeof body.owner_worker_b_url === 'string' ? body.owner_worker_b_url.trim() : '';
    const inviteToken = typeof body.invite_token === 'string' ? body.invite_token.trim() : '';
    const wrappedKeyJson =
      typeof body.wrapped_key_json === 'string' ? body.wrapped_key_json : null;
    const groupId = typeof body.group_id === 'string' ? body.group_id.trim() : '';
    if (!ownerWorkerBUrl || !inviteToken) {
      return errorJson(c, 400, 'GROUP_ENVELOPE_INVALID', 'owner_worker_b_url 与 invite_token 必填');
    }

    const memberDhPubkey =
      typeof body.member_dh_pubkey === 'string' ? body.member_dh_pubkey.trim() : '';
    if (!memberDhPubkey) {
      return errorJson(c, 400, 'GROUP_ENVELOPE_INVALID', '入群须携带 member_dh_pubkey');
    }
    const acceptInput: AcceptInviteInput = {
      ...(groupId ? { group_id: groupId } : {}),
      invite_token: inviteToken,
      member_worker_b_url: localUser.worker_b_url,
      member_handle: localUser.handle,
      member_pubkey: localUser.pubkey,
      member_dh_pubkey: memberDhPubkey,
      wrapped_key_json: wrappedKeyJson,
    };
    return runMemberAcceptInvite(c, acceptInput, ownerWorkerBUrl);
  });

  // POST /api/groups/:groupId/invites/accept — 成员本节点接受邀请（旧路径，仍保留）
  app.post('/:groupId/invites/accept', async (c) => {
    const groupId = c.req.param('groupId');
    if (!GROUP_ID_RE.test(groupId)) {
      return errorJson(c, 400, 'GROUP_ENVELOPE_INVALID', 'group_id 无效');
    }

    const body = await readRawJson(c);
    const localUser = await getLocalUser(c.env);
    if (!localUser?.worker_b_url) {
      return errorJson(c, 409, 'USER_NOT_REGISTERED', '节点尚未完成注册');
    }

    const ownerWorkerBUrl =
      typeof body.owner_worker_b_url === 'string' ? body.owner_worker_b_url.trim() : '';
    const inviteToken = typeof body.invite_token === 'string' ? body.invite_token.trim() : '';
    const wrappedKeyJson =
      typeof body.wrapped_key_json === 'string' ? body.wrapped_key_json : null;
    const memberDhPubkey =
      typeof body.member_dh_pubkey === 'string' ? body.member_dh_pubkey.trim() : '';
    if (!ownerWorkerBUrl || !inviteToken) {
      return errorJson(c, 400, 'GROUP_ENVELOPE_INVALID', 'owner_worker_b_url 与 invite_token 必填');
    }
    if (!memberDhPubkey) {
      return errorJson(c, 400, 'GROUP_ENVELOPE_INVALID', '入群须携带 member_dh_pubkey');
    }

    const acceptInput: AcceptInviteInput = {
      group_id: groupId,
      invite_token: inviteToken,
      member_worker_b_url: localUser.worker_b_url,
      member_handle: localUser.handle,
      member_pubkey: localUser.pubkey,
      member_dh_pubkey: memberDhPubkey,
      wrapped_key_json: wrappedKeyJson,
    };
    return runMemberAcceptInvite(c, acceptInput, ownerWorkerBUrl);
  });

}
