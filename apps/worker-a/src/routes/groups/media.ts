/**
 * NCF-AUDIT-Y-15-3：群公开面 · 媒体票 / wrapped keys。
 */
import { messagingDb } from '../../lib/messagingDb';
import { normalizeGroupMemberUrl } from '../../lib/groupMemberUrl';
import { issueGroupMediaFetchTicket } from '../../lib/groupMediaFetchTicket';
import { assertGroupOwnerOnly } from '../../lib/groupModeration';
import {
  getGroupOwnerEpochKeyMeta,
  upsertGroupOwnerEpochKey,
} from '../../lib/groupOwnerEpochKey';
import { sealPendingKeyMembersBatch } from '../../lib/groupOwnerSeal';
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
  errorJson,
  readRawJson,
  getLocalUser,
  parseAcceptInviteBody,
} from './shared';


export function registerGroupsMediaRoutes(app: Hono<AppEnv>): void {
  // GET /api/groups/:groupId/owner-epoch-key — OWNER-KEY-2：群主查持钥是否已落盘（无明文）
  app.get('/:groupId/owner-epoch-key', async (c) => {
    const groupId = c.req.param('groupId');
    if (!GROUP_ID_RE.test(groupId)) {
      return errorJson(c, 400, 'GROUP_ENVELOPE_INVALID', 'group_id 无效');
    }
    const localUser = await getLocalUser(c.env);
    if (!localUser?.worker_b_url) {
      return errorJson(c, 409, 'USER_NOT_REGISTERED', '节点尚未完成注册');
    }
    const gate = await assertGroupOwnerOnly(c.env, groupId, localUser.worker_b_url);
    if (!gate.ok) {
      return errorJson(c, gate.status, gate.error_code, gate.message);
    }

    const epochRaw = c.req.query('epoch');
    let epoch: number;
    if (epochRaw != null && epochRaw !== '') {
      if (!/^\d+$/.test(epochRaw)) {
        return errorJson(c, 400, 'GROUP_ENVELOPE_INVALID', 'epoch 无效');
      }
      epoch = parseInt(epochRaw, 10);
    } else {
      const group = await messagingDb(c.env)
        .prepare(`SELECT epoch FROM groups WHERE group_id = ? AND dissolved_at IS NULL LIMIT 1`)
        .bind(groupId)
        .first<{ epoch: number }>();
      if (!group) {
        return errorJson(c, 404, 'GROUP_NOT_FOUND', '群不存在');
      }
      epoch = group.epoch;
    }

    const meta = await getGroupOwnerEpochKeyMeta(c.env, groupId, epoch);
    return c.json({
      ok: true,
      data: {
        group_id: groupId,
        epoch,
        held: Boolean(meta),
        key_fingerprint: meta?.key_fingerprint ?? null,
        updated_at: meta?.updated_at ?? null,
      },
    });
  });

  // PUT /api/groups/:groupId/owner-epoch-key — OWNER-KEY-2：老群一次性 bootstrap（明文仅 JWT 群主）
  app.put('/:groupId/owner-epoch-key', async (c) => {
    const groupId = c.req.param('groupId');
    if (!GROUP_ID_RE.test(groupId)) {
      return errorJson(c, 400, 'GROUP_ENVELOPE_INVALID', 'group_id 无效');
    }
    const localUser = await getLocalUser(c.env);
    if (!localUser?.worker_b_url) {
      return errorJson(c, 409, 'USER_NOT_REGISTERED', '节点尚未完成注册');
    }
    const gate = await assertGroupOwnerOnly(c.env, groupId, localUser.worker_b_url);
    if (!gate.ok) {
      return errorJson(c, gate.status, gate.error_code, gate.message);
    }

    const body = await readRawJson(c);
    const epoch =
      typeof body.epoch === 'number' && Number.isSafeInteger(body.epoch) ? body.epoch : NaN;
    const groupKeyHex = typeof body.group_key_hex === 'string' ? body.group_key_hex : '';
    if (!Number.isSafeInteger(epoch) || epoch < 1) {
      return errorJson(c, 400, 'GROUP_ENVELOPE_INVALID', 'epoch 无效');
    }

    const group = await messagingDb(c.env)
      .prepare(`SELECT epoch, dissolved_at FROM groups WHERE group_id = ? LIMIT 1`)
      .bind(groupId)
      .first<{ epoch: number; dissolved_at: string | null }>();
    if (!group || group.dissolved_at) {
      return errorJson(c, 404, 'GROUP_NOT_FOUND', '群不存在');
    }
    // KEY-2 只允许当前 epoch bootstrap；下一 epoch 写入留给 KEY-5
    if (epoch !== group.epoch) {
      return errorJson(
        c,
        400,
        'GROUP_ENVELOPE_INVALID',
        `bootstrap 仅允许当前 epoch ${group.epoch}`,
      );
    }

    const result = await upsertGroupOwnerEpochKey(c.env, {
      groupId,
      epoch,
      groupKeyHex,
    });
    if (!result.ok) {
      return errorJson(c, result.status, result.error_code, result.message);
    }
    return c.json({ ok: true, data: result.data });
  });

  // POST /api/groups/:groupId/owner-seal-pending — OWNER-KEY-4：批量代封 pending_key
  app.post('/:groupId/owner-seal-pending', async (c) => {
    const groupId = c.req.param('groupId');
    if (!GROUP_ID_RE.test(groupId)) {
      return errorJson(c, 400, 'GROUP_ENVELOPE_INVALID', 'group_id 无效');
    }
    const localUser = await getLocalUser(c.env);
    if (!localUser?.worker_b_url) {
      return errorJson(c, 409, 'USER_NOT_REGISTERED', '节点尚未完成注册');
    }

    // 可选 body.limit（1～32）；非法则忽略改用默认批上限
    const body = await readRawJson(c);
    let limit: number | undefined;
    if (typeof body?.limit === 'number' && Number.isSafeInteger(body.limit) && body.limit >= 1) {
      limit = body.limit;
    }

    const result = await sealPendingKeyMembersBatch(c.env, groupId, localUser.worker_b_url, {
      limit,
    });
    if (!result.ok) {
      return errorJson(c, result.status, result.error_code, result.message);
    }
    return c.json({ ok: true, data: result.data });
  });

  // POST /api/groups/media/fetch-ticket — MM-5
  app.post('/media/fetch-ticket', async (c) => {
    const body = await readRawJson(c);
    const groupId = typeof body?.group_id === 'string' ? body.group_id.trim() : '';
    const messageId = typeof body?.message_id === 'string' ? body.message_id.trim() : '';
    const mediaId = typeof body?.media_id === 'string' ? body.media_id.trim() : '';
    const senderStorageKey =
      typeof body?.sender_storage_key === 'string' ? body.sender_storage_key.trim() : '';
    const senderWorkerBUrl =
      typeof body?.sender_worker_b_url === 'string' ? body.sender_worker_b_url.trim() : '';
    if (!groupId || !messageId || !mediaId || !senderStorageKey || !senderWorkerBUrl) {
      return errorJson(
        c,
        400,
        'INVALID_BODY',
        '缺少 group_id / message_id / media_id / sender_storage_key / sender_worker_b_url',
      );
    }
    const ticket = await issueGroupMediaFetchTicket(c.env, {
      group_id: groupId,
      message_id: messageId,
      media_id: mediaId,
      sender_storage_key: senderStorageKey,
      sender_worker_b_url: senderWorkerBUrl,
    });
    if (!ticket) {
      return errorJson(c, 404, 'MESSAGING_MEDIA_NOT_FOUND', '群消息或媒体不存在');
    }
    return c.json({ ok: true, data: { ticket } });
  });

  // POST /api/groups/:groupId/fast-pull-key — EPOCH v0.3：本地缺钥时向群主快拉
  app.post('/:groupId/fast-pull-key', async (c) => {
    const groupId = c.req.param('groupId');
    if (!GROUP_ID_RE.test(groupId)) {
      return errorJson(c, 400, 'GROUP_ENVELOPE_INVALID', 'group_id 无效');
    }
    const body = await readRawJson(c);
    const epoch = typeof body.epoch === 'number' && Number.isInteger(body.epoch) ? body.epoch : 0;
    if (epoch < 1) {
      return errorJson(c, 400, 'GROUP_ENVELOPE_INVALID', 'epoch 无效');
    }
    const { fastPullWrappedKeyLocally } = await import('../../lib/groupKeyFastPull');
    const result = await fastPullWrappedKeyLocally(c.env, groupId, epoch);
    if (!result.ok) {
      return errorJson(c, result.status, result.error_code, result.message);
    }
    return c.json({ ok: true, data: result.data });
  });

  // GET /api/groups/:groupId/wrapped-keys — 读本节点该群 wrapped group_key（浏览器 unwrap）
  app.get('/:groupId/wrapped-keys', async (c) => {
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
    const member = await db
      .prepare(
        `SELECT role, key_state FROM group_members
          WHERE group_id = ? AND member_worker_b_url = ? AND status IN ('active', 'pending')
          LIMIT 1`,
      )
      .bind(groupId, memberUrl)
      .first<{ role: string; key_state: string }>();
    if (!member) {
      return errorJson(c, 404, 'GROUP_NOT_FOUND', '群不存在或非本节点成员');
    }

    const epochRaw = c.req.query('epoch');
    const epochFilter =
      epochRaw != null && epochRaw !== '' && /^\d+$/.test(epochRaw) ? parseInt(epochRaw, 10) : null;

    const rows =
      epochFilter != null
        ? await db
          .prepare(
            `SELECT epoch, member_worker_b_url, wrapped_key_json, updated_at
                 FROM group_wrapped_keys
                WHERE group_id = ? AND member_worker_b_url = ? AND epoch = ?
                ORDER BY epoch DESC`,
          )
          .bind(groupId, memberUrl, epochFilter)
          .all<{
            epoch: number;
            member_worker_b_url: string;
            wrapped_key_json: string;
            updated_at: string;
          }>()
        : await db
          .prepare(
            `SELECT epoch, member_worker_b_url, wrapped_key_json, updated_at
                 FROM group_wrapped_keys
                WHERE group_id = ? AND member_worker_b_url = ?
                ORDER BY epoch DESC`,
          )
          .bind(groupId, memberUrl)
          .all<{
            epoch: number;
            member_worker_b_url: string;
            wrapped_key_json: string;
            updated_at: string;
          }>();

    return c.json({
      ok: true,
      data: {
        group_id: groupId,
        key_state: member.key_state,
        items: rows.results ?? [],
      },
    });
  });

  // PUT /api/groups/:groupId/wrapped-keys/batch — SEC-AUDIT-2026-10-16 真 batch + 同源指纹
  app.put('/:groupId/wrapped-keys/batch', async (c) => {
    const groupId = c.req.param('groupId');
    if (!GROUP_ID_RE.test(groupId)) {
      return errorJson(c, 400, 'GROUP_ENVELOPE_INVALID', 'group_id 无效');
    }
    const localUser = await getLocalUser(c.env);
    if (!localUser?.worker_b_url) {
      return errorJson(c, 409, 'USER_NOT_REGISTERED', '节点尚未完成注册');
    }
    const body = await readRawJson(c);
    const epoch = typeof body.epoch === 'number' && Number.isInteger(body.epoch) ? body.epoch : 0;
    const itemsRaw = Array.isArray(body.items) ? body.items : null;
    if (!itemsRaw) {
      return errorJson(c, 400, 'GROUP_ENVELOPE_INVALID', 'items 须为数组');
    }
    const items = itemsRaw.map((raw: unknown) => {
      const row = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
      const wrappedRaw = row.wrapped_key_json;
      return {
        member_worker_b_url:
          typeof row.member_worker_b_url === 'string' ? row.member_worker_b_url : '',
        wrapped_key_json:
          typeof wrappedRaw === 'string'
            ? wrappedRaw
            : wrappedRaw != null
              ? JSON.stringify(wrappedRaw)
              : '',
      };
    });
    const { putGroupWrappedKeysBatch } = await import('../../lib/groupWrappedKeyWrite');
    const result = await putGroupWrappedKeysBatch(c.env, {
      groupId,
      actorWorkerBUrl: localUser.worker_b_url,
      epoch,
      items,
      keyFingerprint: typeof body.key_fingerprint === 'string' ? body.key_fingerprint : null,
      replaceKey: body.replace_key === true,
    });
    if (!result.ok) {
      return errorJson(c, result.status, result.error_code, result.message);
    }
    return c.json({ ok: true, data: result.data });
  });

  // PUT /api/groups/:groupId/wrapped-keys — 单条上传（内部走同一 batch helper）
  app.put('/:groupId/wrapped-keys', async (c) => {
    const groupId = c.req.param('groupId');
    if (!GROUP_ID_RE.test(groupId)) {
      return errorJson(c, 400, 'GROUP_ENVELOPE_INVALID', 'group_id 无效');
    }

    const localUser = await getLocalUser(c.env);
    if (!localUser?.worker_b_url) {
      return errorJson(c, 409, 'USER_NOT_REGISTERED', '节点尚未完成注册');
    }

    const body = await readRawJson(c);
    const epoch = typeof body.epoch === 'number' && Number.isInteger(body.epoch) ? body.epoch : 0;
    const wrappedRaw = body.wrapped_key_json;
    const wrappedKeyJson =
      typeof wrappedRaw === 'string' ? wrappedRaw : wrappedRaw != null ? JSON.stringify(wrappedRaw) : '';
    const targetUrlRaw =
      typeof body.member_worker_b_url === 'string' ? body.member_worker_b_url.trim() : '';
    const localUrl = normalizeGroupMemberUrl(localUser.worker_b_url);
    const targetUrl = targetUrlRaw ? normalizeGroupMemberUrl(targetUrlRaw) : localUrl;

    if (epoch < 1 || !wrappedKeyJson || wrappedKeyJson.length > GROUP_WRAPPED_KEY_MAX) {
      return errorJson(c, 400, 'GROUP_ENVELOPE_INVALID', '包裹密钥字段无效');
    }

    const { putGroupWrappedKeysBatch } = await import('../../lib/groupWrappedKeyWrite');
    const result = await putGroupWrappedKeysBatch(c.env, {
      groupId,
      actorWorkerBUrl: localUser.worker_b_url,
      epoch,
      items: [{ member_worker_b_url: targetUrl, wrapped_key_json: wrappedKeyJson }],
      keyFingerprint: typeof body.key_fingerprint === 'string' ? body.key_fingerprint : null,
      replaceKey: false,
    });
    if (!result.ok) {
      return errorJson(c, result.status, result.error_code, result.message);
    }

    return c.json({
      ok: true,
      data: {
        group_id: groupId,
        epoch,
        member_worker_b_url: targetUrl,
        key_fingerprint: result.data.key_fingerprint,
        // 当前 epoch 自传无 fingerprint；helper 已把 key_state 置 active
        key_state:
          targetUrl === localUrl && result.data.key_fingerprint == null ? 'active' : undefined,
      },
    });
  });

}
