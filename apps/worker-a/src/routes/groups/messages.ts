/**
 * NCF-AUDIT-Y-15-3：群公开面 · 消息（签名 / 本地读 / 发送 / sync）。
 */
import {
  randomDmNonceHex,
  signGroupMessageEnvelope,
  signGroupSyncRequest,
} from '@hailuo/shared-crypto';
import type { GroupSyncRequest } from '@hailuo/shared-types';
import type { Env } from '../../env';
import { messagingDb } from '../../lib/messagingDb';
import { resolveGroupMessagesDb } from '../../lib/messagingShard';
import { assertGroupRetentionCapacityAllowed } from '../../lib/messagingDbCapacity';
import { normalizeGroupMemberUrl } from '../../lib/groupMemberUrl';
import { parseGroupMessageEnvelope, parseGroupMessageEnvelopeUnsigned } from '../../lib/groupEnvelope';
import {
  persistOwnerLocalGroupMessage,
  sendMemberGroupMessage,
} from '../../lib/groupMessage';
import { canSpeakWhenMuted } from '../../lib/groupModeration';
import {
  parseGroupSyncRequest,
  runGroupSyncWithParent,
} from '../../lib/groupSync';
import { parseMessagingMediaSigned } from '../../lib/dmMediaFetchTicket';
import { resolveLocalPublicBaseUrl } from '../../lib/localPublicBaseUrl';
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


export function registerGroupsMessagesRoutes(app: Hono<AppEnv>): void {
  // POST /api/groups/sign-envelope — 站主 JWT 代签 GROUP_MESSAGE（浏览器不持 Ed25519 私钥）
  // MSG-FIX-0：代签只证明「本站主是 sender」+「本群 active 成员」+「信封群主/epoch 与 D1 一致」。
  // 禁止再要求本机必须是群主（成员群的群主常为远端）。
  app.post('/sign-envelope', async (c) => {
    const body = await readRawJson(c);
    const unsigned = parseGroupMessageEnvelopeUnsigned(body?.envelope);
    if (!unsigned) {
      return errorJson(c, 400, 'GROUP_ENVELOPE_INVALID', '群消息 envelope 无效');
    }
    const localUser = await getLocalUser(c.env);
    if (!localUser || unsigned.sender_handle !== localUser.handle.trim().toLowerCase()) {
      return errorJson(c, 403, 'GROUP_ENVELOPE_INVALID', '只能签名本节点站主发出的群消息');
    }
    const localUrl = normalizeGroupMemberUrl(localUser.worker_b_url);
    // 双侧 normalize：浏览器偶发尾斜杠 / 空白时不得误判为 GROUP_ENVELOPE_INVALID
    if (!localUrl || normalizeGroupMemberUrl(unsigned.sender_worker_b_url) !== localUrl) {
      return errorJson(c, 403, 'GROUP_ENVELOPE_INVALID', 'envelope 发送方节点与本节点不一致');
    }
    const group = await messagingDb(c.env)
      .prepare(
        `SELECT owner_worker_b_url, epoch, dissolved_at, members_muted FROM groups WHERE group_id = ? LIMIT 1`,
      )
      .bind(unsigned.group_id)
      .first<{
        owner_worker_b_url: string;
        epoch: number;
        dissolved_at: string | null;
        members_muted: number | null;
      }>();
    if (!group) {
      return errorJson(c, 404, 'GROUP_ENVELOPE_INVALID', '群不存在');
    }
    if (group.dissolved_at) {
      return errorJson(c, 410, 'GROUP_ENVELOPE_INVALID', '群已解散');
    }
    // 比的是「信封群主 == D1 群主」，不是「== localUrl」
    if (
      normalizeGroupMemberUrl(unsigned.owner_worker_b_url) !==
      normalizeGroupMemberUrl(group.owner_worker_b_url)
    ) {
      return errorJson(c, 403, 'GROUP_ENVELOPE_INVALID', 'envelope 群主节点与 D1 群主不一致');
    }
    if (unsigned.epoch !== group.epoch) {
      return errorJson(c, 409, 'GROUP_ENVELOPE_INVALID', `envelope epoch 必须为 ${group.epoch}`);
    }
    const member = await messagingDb(c.env)
      .prepare(
        `SELECT status, role, is_admin FROM group_members
          WHERE group_id = ? AND member_worker_b_url = ? LIMIT 1`,
      )
      .bind(unsigned.group_id, localUrl)
      .first<{ status: string; role: string; is_admin: number | null }>();
    if (!member || member.status !== 'active') {
      return errorJson(c, 403, 'GROUP_NOT_MEMBER', '非在册成员，无法代签');
    }
    // 与发信路径对齐：全员禁言时普通成员不可代签 chat
    if (
      unsigned.msg_kind === 'chat' &&
      !canSpeakWhenMuted(group.members_muted ?? 0, {
        role: member.role,
        is_admin: member.is_admin ?? 0,
        status: member.status,
      })
    ) {
      return errorJson(c, 403, 'GROUP_MEMBERS_MUTED', '本群已开启仅群主与管理员可发言');
    }
    const sig = await signGroupMessageEnvelope(unsigned, c.env.ED25519_PRIVATE_KEY);
    return c.json({ ok: true, data: { envelope: { ...unsigned, sig } } });
  });

  function parseGroupMessageLimit(c: GroupContext): number {
    const raw = parseInt(c.req.query('limit') ?? '50', 10);
    if (Number.isNaN(raw)) return 50;
    return Math.min(Math.max(raw, 1), GROUP_MSG_PAGE_LIMIT_MAX);
  }

  // GET /api/groups/local/:groupId/messages — Web 读本节点 member_group_messages（轮询/分页）
  app.get('/local/:groupId/messages', async (c) => {
    const groupId = c.req.param('groupId');
    if (!GROUP_ID_RE.test(groupId)) {
      return errorJson(c, 400, 'GROUP_ENVELOPE_INVALID', 'group_id 无效');
    }

    const localUser = await getLocalUser(c.env);
    if (!localUser?.worker_b_url) {
      return errorJson(c, 409, 'USER_NOT_REGISTERED', '节点尚未完成注册');
    }

    const memberUrl = normalizeGroupMemberUrl(localUser.worker_b_url);
    const db = messagingDb(c.env);
    const memberRow = await db
      .prepare(
        `SELECT gm.role, gm.is_admin, gm.key_state, gm.status,
                g.group_id, g.name, g.announcement, g.owner_worker_b_url, g.epoch, g.tree_id, g.dissolved_at,
                g.members_muted,
                gss.sync_tier, gss.cursor AS sync_cursor, gss.local_retention_days, gss.last_sync_at
           FROM group_members gm
           JOIN groups g ON g.group_id = gm.group_id
           LEFT JOIN group_sync_state gss ON gss.group_id = gm.group_id
          WHERE gm.group_id = ? AND gm.member_worker_b_url = ?
            AND gm.status IN ('active', 'pending')
          LIMIT 1`,
      )
      .bind(groupId, memberUrl)
      .first<{
        role: string;
        is_admin: number | null;
        key_state: string;
        status: string;
        group_id: string;
        name: string;
        announcement: string | null;
        owner_worker_b_url: string;
        epoch: number;
        tree_id: number;
        dissolved_at: string | null;
        members_muted: number | null;
        sync_tier: string | null;
        sync_cursor: string | null;
        local_retention_days: number | null;
        last_sync_at: string | null;
      }>();

    if (!memberRow) {
      return errorJson(c, 404, 'GROUP_NOT_FOUND', '群不存在或非本节点成员');
    }

    const limit = parseGroupMessageLimit(c);
    const cursor = c.req.query('cursor')?.trim() || null;
    const msgDb = await resolveGroupMessagesDb(c.env, groupId);
    const rows = await msgDb
      .prepare(
        `SELECT message_id, group_id, epoch, sender_worker_b_url, sender_handle, msg_kind, ciphertext, created_at, envelope_json
           FROM member_group_messages
          WHERE group_id = ? AND (? IS NULL OR created_at < ?)
          ORDER BY created_at DESC
          LIMIT ?`,
      )
      .bind(groupId, cursor, cursor, limit + 1)
      .all<{
        message_id: string;
        group_id: string;
        epoch: number;
        sender_worker_b_url: string;
        sender_handle: string;
        msg_kind: string;
        ciphertext: string;
        created_at: string;
        envelope_json: string | null;
      }>();

    const rawItems = rows.results ?? [];
    const hasMore = rawItems.length > limit;
    const page = rawItems.slice(0, limit);
    const items = page.map((row: NonNullable<typeof rawItems[number]>) => {
      if (!row) return undefined;
      let media: ReturnType<typeof parseMessagingMediaSigned> | undefined;
      if (row.envelope_json) {
        try {
          const parsed = JSON.parse(row.envelope_json) as { media?: unknown };
          media = parseMessagingMediaSigned(parsed.media) ?? undefined;
        } catch {
          media = undefined;
        }
      }
      return {
        message_id: row.message_id,
        group_id: row.group_id,
        epoch: row.epoch,
        sender_worker_b_url: row.sender_worker_b_url,
        sender_handle: row.sender_handle,
        msg_kind: row.msg_kind,
        ciphertext: row.ciphertext,
        created_at: row.created_at,
        ...(media ? { media } : {}),
      };
    }).filter(Boolean);

    return c.json({
      ok: true,
      data: {
        group: {
          group_id: memberRow.group_id,
          name: memberRow.name,
          announcement: memberRow.announcement,
          owner_worker_b_url: memberRow.owner_worker_b_url,
          epoch: memberRow.epoch,
          tree_id: memberRow.tree_id,
          dissolved_at: memberRow.dissolved_at,
          members_muted: Number(memberRow.members_muted) === 1,
          role: memberRow.role,
          is_admin: Number(memberRow.is_admin) === 1,
          key_state: memberRow.key_state,
          status: memberRow.status,
          sync_tier: memberRow.role === 'owner' ? 'active' : (memberRow.sync_tier ?? 'active'),
          sync_cursor: memberRow.sync_cursor,
          local_retention_days: memberRow.local_retention_days ?? 90,
          last_sync_at: memberRow.last_sync_at,
        },
        items,
        has_more: hasMore,
        cursor: hasMore ? items[items.length - 1]?.created_at ?? null : null,
      },
    });
  });

  // POST /api/groups/:groupId/messages — 群主写权威 + relay；成员写本地 + 推主责名单（含群主）
  app.post('/:groupId/messages', async (c) => {
    const groupId = c.req.param('groupId');
    if (!GROUP_ID_RE.test(groupId)) {
      return errorJson(c, 400, 'GROUP_ENVELOPE_INVALID', 'group_id 无效');
    }

    const body = await readRawJson(c);
    const envelope = parseGroupMessageEnvelope(body?.envelope);
    if (!envelope) {
      return errorJson(c, 400, 'GROUP_ENVELOPE_INVALID', '群消息 envelope 无效');
    }
    if (envelope.group_id !== groupId) {
      return errorJson(c, 400, 'GROUP_ENVELOPE_INVALID', '路径 group_id 与 envelope 不一致');
    }

    const localUser = await getLocalUser(c.env);
    if (!localUser?.worker_b_url) {
      return errorJson(c, 409, 'USER_NOT_REGISTERED', '节点尚未完成注册');
    }

    const localUrl = normalizeGroupMemberUrl(localUser.worker_b_url);
    const db = messagingDb(c.env);
    const group = await db
      .prepare(`SELECT owner_worker_b_url FROM groups WHERE group_id = ? AND dissolved_at IS NULL LIMIT 1`)
      .bind(groupId)
      .first<{ owner_worker_b_url: string }>();
    if (!group) {
      return errorJson(c, 404, 'GROUP_NOT_FOUND', '群不存在或已解散');
    }

    const isOwner = normalizeGroupMemberUrl(group.owner_worker_b_url) === localUrl;
    const schedule = (p: Promise<unknown>) => c.executionCtx.waitUntil(p);
    const result = isOwner
      ? await persistOwnerLocalGroupMessage(c.env, envelope, localUser.worker_b_url, { schedule })
      : await sendMemberGroupMessage(c.env, envelope, {
        worker_b_url: localUser.worker_b_url,
        handle: localUser.handle,
        pubkey: localUser.pubkey,
      });

    if (!result.ok) {
      return errorJson(c, result.status, result.error_code, result.message);
    }

    return c.json({
      ok: true,
      data: {
        message_id: result.data.message_id,
        ...('duplicate' in result.data ? { duplicate: result.data.duplicate ?? false } : {}),
        ...('outbox_state' in result.data ? { outbox_state: result.data.outbox_state } : {}),
      },
    });
  });

  async function buildSignedGroupSyncRequest(
    env: Env,
    groupId: string,
    localUser: { handle: string; worker_b_url: string },
    body: Record<string, unknown>,
  ): Promise<GroupSyncRequest | null> {
    const db = messagingDb(env);
    const group = await db
      .prepare(`SELECT owner_worker_b_url, epoch FROM groups WHERE group_id = ? LIMIT 1`)
      .bind(groupId)
      .first<{ owner_worker_b_url: string; epoch: number }>();
    if (!group) return null;

    const syncState = await db
      .prepare(`SELECT cursor FROM group_sync_state WHERE group_id = ? LIMIT 1`)
      .bind(groupId)
      .first<{ cursor: string | null }>();

    let cursor: string | null = syncState?.cursor ?? null;
    if (body.cursor === null || body.cursor === '') {
      cursor = null;
    } else if (typeof body.cursor === 'string' && GMSG_ID_RE.test(body.cursor.trim())) {
      cursor = body.cursor.trim();
    }

    const acks: string[] = [];
    if (Array.isArray(body.acks)) {
      for (const item of body.acks) {
        if (typeof item === 'string' && GMSG_ID_RE.test(item.trim())) {
          acks.push(item.trim());
        }
      }
    }

    const now = nowIso();
    const unsigned = {
      v: 1 as const,
      kind: 'GROUP_SYNC' as const,
      group_id: groupId,
      sender_handle: localUser.handle.trim().toLowerCase(),
      sender_worker_b_url: normalizeGroupMemberUrl(localUser.worker_b_url),
      owner_worker_b_url: normalizeGroupMemberUrl(group.owner_worker_b_url),
      epoch: group.epoch,
      created_at: now,
      expires_at: new Date(Date.now() + GROUP_SYNC_TTL_MS).toISOString(),
      nonce: randomDmNonceHex(16),
      cursor,
      acks,
      heartbeat: body.heartbeat === true ? true : acks.length === 0 ? true : undefined,
    };

    const sig = await signGroupSyncRequest(unsigned, env.ED25519_PRIVATE_KEY);
    return { ...unsigned, sig };
  }

  // POST /api/groups/:groupId/sync — 本节点向父节点 sync-with-parent（Cron/手动入口）
  app.post('/:groupId/sync', async (c) => {
    const groupId = c.req.param('groupId');
    if (!GROUP_ID_RE.test(groupId)) {
      return errorJson(c, 400, 'GROUP_ENVELOPE_INVALID', 'group_id 无效');
    }

    const localUser = await getLocalUser(c.env);
    if (!localUser?.worker_b_url) {
      return errorJson(c, 409, 'USER_NOT_REGISTERED', '节点尚未完成注册');
    }

    const body = await readRawJson(c);
    const signed = await buildSignedGroupSyncRequest(c.env, groupId, localUser, body);
    if (!signed) {
      return errorJson(c, 404, 'GROUP_NOT_FOUND', '群不存在');
    }

    const ownerUrl = normalizeGroupMemberUrl(signed.owner_worker_b_url);
    const localUrl = normalizeGroupMemberUrl(localUser.worker_b_url);

    if (localUrl === ownerUrl) {
      return errorJson(c, 403, 'GROUP_NOT_MEMBER', '群主节点无需 sync-with-parent');
    }

    const result = await runGroupSyncWithParent(c.env, groupId, localUser, signed);
    if (!result.ok) {
      return errorJson(c, result.status, result.error_code, result.message);
    }
    return c.json({ ok: true, data: result.data });
  });

}
