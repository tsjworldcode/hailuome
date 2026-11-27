/**
 * NCF-AUDIT-Y-15-3：群公开面 · 建群 / 管理 / 本地列表与设置 / 退群解散。
 */
import { messagingDb } from '../../lib/messagingDb';
import { resolveGroupMessagesDb } from '../../lib/messagingShard';
import { maybeAutoRouteNewGroupToShard } from '../../lib/messagingAutoShard';
import { assertGroupRetentionCapacityAllowed } from '../../lib/messagingDbCapacity';
import { normalizeGroupMemberUrl } from '../../lib/groupMemberUrl';
import {
  allocateShortGroupId,
  JOIN_POLICY_DEFAULT,
  type GroupJoinPolicy,
} from '../../lib/groupJoinPolicy';
import {
  assertGroupOwnerOnly,
  assertGroupOwnerOrAdmin,
  setGroupAdmin,
  setGroupAnnouncement,
  setGroupMembersMuted,
  setGroupName,
} from '../../lib/groupModeration';
import { requestGroupModerationKick } from '../../lib/groupModerationKick';
import { commitGroupRekey, putMemberDhPubkey } from '../../lib/groupRekey';
import { runOwnerServerRekey } from '../../lib/groupOwnerRekey';
import { recomputeAndPersistRelayTree } from '../../lib/groupRelayTree';
import { notifyOwnerMemberLeft } from '../../lib/groupLeave';
import { dissolveGroupOnOwner } from '../../lib/groupDissolve';
import { trySeedOwnerEpochKeyOnCreate } from '../../lib/groupOwnerEpochKey';
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


export function registerGroupsLifecycleRoutes(app: Hono<AppEnv>): void {
  // POST /api/groups — 建群（群主本节点）
  app.post('/', async (c) => {
    const body = await readRawJson(c);
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const announcement =
      typeof body.announcement === 'string' ? body.announcement.trim().slice(0, GROUP_ANNOUNCEMENT_MAX) : '';
    if (!name || name.length > GROUP_NAME_MAX) {
      return errorJson(c, 400, 'GROUP_ENVELOPE_INVALID', '群名称无效');
    }

    const localUser = await getLocalUser(c.env);
    if (!localUser?.worker_b_url) {
      return errorJson(c, 409, 'USER_NOT_REGISTERED', '节点尚未完成注册');
    }

    // M16-JOIN-POLICY-1：短 group_id（grp_+8），默认 join_policy=approval
    let groupId: string;
    try {
      groupId = await allocateShortGroupId(c.env);
    } catch {
      return errorJson(c, 500, 'INTERNAL_ERROR', '群号分配失败，请重试');
    }
    const now = nowIso();
    const ownerUrl = normalizeGroupMemberUrl(localUser.worker_b_url);
    const db = messagingDb(c.env);
    const joinPolicy = JOIN_POLICY_DEFAULT;

    await db.batch([
      db
        .prepare(
          `INSERT INTO groups
           (group_id, name, announcement, owner_worker_b_url, epoch, tree_id, dissolved_at, created_at, updated_at,
            join_requires_approval, join_policy)
           VALUES (?, ?, ?, ?, 1, 0, NULL, ?, ?, ?, ?)`,
        )
        .bind(
          groupId,
          name,
          announcement || null,
          ownerUrl,
          now,
          now,
          joinPolicy === 'approval' ? 1 : 0,
          joinPolicy,
        ),
      db
        .prepare(
          `INSERT INTO group_members
           (group_id, member_worker_b_url, member_handle, member_pubkey, role, key_state, status,
            last_ack_at, empty_ack_streak, joined_at, last_speak_at)
           VALUES (?, ?, ?, ?, 'owner', 'pending_key', 'active', ?, 0, ?, ?)`,
        )
        .bind(groupId, ownerUrl, localUser.handle, localUser.pubkey, now, now, now),
      db
        .prepare(
          `INSERT INTO group_sync_state
           (group_id, parent_worker_b_url, cursor, sync_tier, local_retention_days, last_sync_at, updated_at)
           VALUES (?, ?, NULL, 'active', 90, ?, ?)`,
        )
        .bind(groupId, ownerUrl, now, now),
    ]);

    await recomputeAndPersistRelayTree(c.env, groupId);
    const treeRow = await messagingDb(c.env)
      .prepare(`SELECT tree_id FROM groups WHERE group_id = ? LIMIT 1`)
      .bind(groupId)
      .first<{ tree_id: number }>();

    // OWNER-KEY-2：有 wrap secret 时服务端生成 epoch=1 群钥并写入持钥表；一次性回给群主 JWT 会话做 vault wrap
    let ownerKeyHeld = false;
    let groupKeyHex: string | undefined;
    let keyFingerprint: string | undefined;
    const seeded = await trySeedOwnerEpochKeyOnCreate(c.env, groupId, 1);
    if (seeded.ok) {
      ownerKeyHeld = true;
      groupKeyHex = seeded.group_key_hex;
      keyFingerprint = seeded.key_fingerprint;
    }

    // M16-P4a：primary 达 hard 水位时新群消息直接路由 shard_1（fail-soft）
    let messageShardId: 'primary' | 'shard_1' = 'primary';
    try {
      if (await maybeAutoRouteNewGroupToShard(c.env, groupId)) {
        messageShardId = 'shard_1';
      }
    } catch (err) {
      console.warn('[messaging/auto-shard] 新群分片路由登记失败，回落 primary', groupId, err);
    }

    return c.json({
      ok: true,
      data: {
        group_id: groupId,
        name,
        announcement: announcement || null,
        owner_worker_b_url: ownerUrl,
        epoch: 1,
        tree_id: treeRow?.tree_id ?? 0,
        created_at: now,
        message_shard_id: messageShardId,
        join_policy: joinPolicy,
        owner_key_held: ownerKeyHeld,
        ...(groupKeyHex ? { group_key_hex: groupKeyHex } : {}),
        ...(keyFingerprint ? { key_fingerprint: keyFingerprint } : {}),
      },
    });
  });

  // POST /api/groups/:groupId/kick — M16-GROUP-MOD：群主/管理员踢人（管理不可踢管理）
  app.post('/:groupId/kick', async (c) => {
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
    if (body.expected_epoch !== undefined &&
      (typeof body.expected_epoch !== 'number' || !Number.isSafeInteger(body.expected_epoch) || body.expected_epoch < 1)) {
      return errorJson(c, 400, 'GROUP_ENVELOPE_INVALID', 'expected_epoch 无效');
    }
    const expectedEpoch =
      typeof body.expected_epoch === 'number' && Number.isInteger(body.expected_epoch)
        ? body.expected_epoch
        : undefined;
    // REKEY-1：踢人路径禁止附带 wrap；假 wrap / 半包不得冒充换钥。
    if (body.wrapped_keys !== undefined) {
      const wraps = body.wrapped_keys;
      if (!Array.isArray(wraps) || wraps.length > 0) {
        return errorJson(
          c,
          400,
          'GROUP_REKEY_NOT_READY',
          '踢人仅隔绝；尚未能为全员密封新钥，禁止附带 wrap 冒充换钥',
        );
      }
    }
    const result = await requestGroupModerationKick(
      c.env,
      groupId,
      localUser.worker_b_url,
      memberUrl,
      { expectedEpoch },
    );
    if (!result.ok) {
      return errorJson(c, result.status, result.error_code, result.message);
    }
    return c.json({ ok: true, data: result.data });
  });

  // PUT /api/groups/:groupId/dh-pubkey — REKEY-2：本机登记 X25519 群 DH 公钥
  app.put('/:groupId/dh-pubkey', async (c) => {
    const groupId = c.req.param('groupId');
    if (!GROUP_ID_RE.test(groupId)) {
      return errorJson(c, 400, 'GROUP_ENVELOPE_INVALID', 'group_id 无效');
    }
    const localUser = await getLocalUser(c.env);
    if (!localUser?.worker_b_url) {
      return errorJson(c, 409, 'USER_NOT_REGISTERED', '节点尚未完成注册');
    }
    const body = await readRawJson(c);
    const dh =
      typeof body.member_dh_pubkey === 'string' ? body.member_dh_pubkey : '';
    const result = await putMemberDhPubkey(c.env, groupId, localUser.worker_b_url, dh);
    if (!result.ok) {
      return errorJson(c, result.status, result.error_code, result.message);
    }
    return c.json({ ok: true, data: result.data });
  });

  // POST /api/groups/:groupId/owner-rekey — OWNER-KEY-5：服务端生成 next + 代封 + 默认 commit
  app.post('/:groupId/owner-rekey', async (c) => {
    const groupId = c.req.param('groupId');
    if (!GROUP_ID_RE.test(groupId)) {
      return errorJson(c, 400, 'GROUP_ENVELOPE_INVALID', 'group_id 无效');
    }
    const localUser = await getLocalUser(c.env);
    if (!localUser?.worker_b_url) {
      return errorJson(c, 409, 'USER_NOT_REGISTERED', '节点尚未完成注册');
    }
    const body = await readRawJson(c);
    let expectedEpoch: number | undefined;
    if (
      typeof body?.expected_epoch === 'number' &&
      Number.isSafeInteger(body.expected_epoch) &&
      body.expected_epoch >= 1
    ) {
      expectedEpoch = body.expected_epoch;
    }
    const commit = body?.commit === false ? false : true;
    const result = await runOwnerServerRekey(c.env, groupId, localUser.worker_b_url, {
      expectedEpoch,
      commit,
    });
    if (!result.ok) {
      return errorJson(c, result.status, result.error_code, result.message);
    }
    return c.json({ ok: true, data: result.data });
  });

  // POST /api/groups/:groupId/rekey-commit — REKEY-2：wraps 齐备后 CAS epoch++
  app.post('/:groupId/rekey-commit', async (c) => {
    const groupId = c.req.param('groupId');
    if (!GROUP_ID_RE.test(groupId)) {
      return errorJson(c, 400, 'GROUP_ENVELOPE_INVALID', 'group_id 无效');
    }
    const localUser = await getLocalUser(c.env);
    if (!localUser?.worker_b_url) {
      return errorJson(c, 409, 'USER_NOT_REGISTERED', '节点尚未完成注册');
    }
    const body = await readRawJson(c);
    if (
      typeof body.expected_epoch !== 'number' ||
      !Number.isSafeInteger(body.expected_epoch) ||
      body.expected_epoch < 1
    ) {
      return errorJson(c, 400, 'GROUP_ENVELOPE_INVALID', 'expected_epoch 无效');
    }
    const result = await commitGroupRekey(
      c.env,
      groupId,
      localUser.worker_b_url,
      body.expected_epoch,
    );
    if (!result.ok) {
      return errorJson(c, result.status, result.error_code, result.message);
    }
    return c.json({ ok: true, data: result.data });
  });

  // PUT /api/groups/:groupId/mute — M16-GROUP-MOD：群主或管理员开关全员禁言
  app.put('/:groupId/mute', async (c) => {
    const groupId = c.req.param('groupId');
    if (!GROUP_ID_RE.test(groupId)) {
      return errorJson(c, 400, 'GROUP_ENVELOPE_INVALID', 'group_id 无效');
    }
    const localUser = await getLocalUser(c.env);
    if (!localUser?.worker_b_url) {
      return errorJson(c, 409, 'USER_NOT_REGISTERED', '节点尚未完成注册');
    }
    const body = await readRawJson(c);
    if (typeof body.members_muted !== 'boolean') {
      return errorJson(c, 400, 'GROUP_ENVELOPE_INVALID', 'members_muted 须为 boolean');
    }
    const result = await setGroupMembersMuted(c.env, groupId, localUser.worker_b_url, body.members_muted);
    if (!result.ok) {
      return errorJson(c, result.status, result.error_code, result.message);
    }
    return c.json({ ok: true, data: result.data });
  });

  // PUT /api/groups/:groupId/admins — M16-GROUP-MOD：仅群主任命/撤销管理员（上限 5）
  app.put('/:groupId/admins', async (c) => {
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
    if (typeof body.is_admin !== 'boolean') {
      return errorJson(c, 400, 'GROUP_ENVELOPE_INVALID', 'is_admin 须为 boolean');
    }
    const result = await setGroupAdmin(c.env, groupId, localUser.worker_b_url, memberUrl, body.is_admin);
    if (!result.ok) {
      return errorJson(c, result.status, result.error_code, result.message);
    }
    return c.json({ ok: true, data: result.data });
  });

  // PUT /api/groups/:groupId/announcement — M16-GROUP-MOD：群主或管理员改公告
  app.put('/:groupId/announcement', async (c) => {
    const groupId = c.req.param('groupId');
    if (!GROUP_ID_RE.test(groupId)) {
      return errorJson(c, 400, 'GROUP_ENVELOPE_INVALID', 'group_id 无效');
    }
    const localUser = await getLocalUser(c.env);
    if (!localUser?.worker_b_url) {
      return errorJson(c, 409, 'USER_NOT_REGISTERED', '节点尚未完成注册');
    }
    const body = await readRawJson(c);
    if (typeof body.announcement !== 'string') {
      return errorJson(c, 400, 'GROUP_ENVELOPE_INVALID', 'announcement 须为字符串');
    }
    const result = await setGroupAnnouncement(c.env, groupId, localUser.worker_b_url, body.announcement);
    if (!result.ok) {
      return errorJson(c, result.status, result.error_code, result.message);
    }
    return c.json({ ok: true, data: result.data });
  });

  // PUT /api/groups/:groupId/name — UX-GROUPS-7b：仅群主可改群名称（比 announcement 收敛）；
  // 群号（group_id）一旦生成不可改
  app.put('/:groupId/name', async (c) => {
    const groupId = c.req.param('groupId');
    if (!GROUP_ID_RE.test(groupId)) {
      return errorJson(c, 400, 'GROUP_ENVELOPE_INVALID', 'group_id 无效');
    }
    const localUser = await getLocalUser(c.env);
    if (!localUser?.worker_b_url) {
      return errorJson(c, 409, 'USER_NOT_REGISTERED', '节点尚未完成注册');
    }
    const body = await readRawJson(c);
    if (typeof body.name !== 'string') {
      return errorJson(c, 400, 'GROUP_ENVELOPE_INVALID', 'name 须为字符串');
    }
    const result = await setGroupName(c.env, groupId, localUser.worker_b_url, body.name);
    if (!result.ok) {
      return errorJson(c, result.status, result.error_code, result.message);
    }
    return c.json({ ok: true, data: result.data });
  });

  // GET /api/groups/:groupId/members — 在册成员都可看名单（管理操作仍仅群主）
  //
  // GRP-MEMBER-PAGE-1（大群扩容）：可选分页 + 基础字段裁剪。
  // - 不传 `limit` → 保持旧行为「全量」（换钥 / 补封需要完整名单 + DH 公钥）；
  // - 展示侧传 `limit`（≤500）→ 首屏只取一页，避免 2000 人群一次拉 300KB JSON、渲染 2000 个节点；
  // - `include_dh=0` → 不返回 DH 公钥（展示不需要），减少 payload；
  // - 恒返回 `total` / `has_more`，供「共 N 人 / 加载更多」使用。
  app.get('/:groupId/members', async (c) => {
    const groupId = c.req.param('groupId');
    if (!GROUP_ID_RE.test(groupId)) {
      return errorJson(c, 400, 'GROUP_ENVELOPE_INVALID', 'group_id 无效');
    }
    const localUser = await getLocalUser(c.env);
    if (!localUser?.worker_b_url) {
      return errorJson(c, 409, 'USER_NOT_REGISTERED', '节点尚未完成注册');
    }
    const memberUrl = normalizeGroupMemberUrl(localUser.worker_b_url);
    const self = await messagingDb(c.env)
      .prepare(
        `SELECT 1 AS ok FROM group_members
          WHERE group_id = ? AND member_worker_b_url = ? AND status IN ('active', 'pending')
          LIMIT 1`,
      )
      .bind(groupId, memberUrl)
      .first<{ ok: number }>();
    if (!self) {
      return errorJson(c, 403, 'GROUP_NOT_MEMBER', '非群成员');
    }
    // 分页参数：非法值一律当未传，避免 0 / NaN 变成全表或空页
    const limitRaw = parseInt(c.req.query('limit') ?? '', 10);
    const hasLimit = Number.isInteger(limitRaw) && limitRaw > 0;
    const limit = hasLimit ? Math.min(limitRaw, 500) : null;
    const offsetRaw = parseInt(c.req.query('offset') ?? '0', 10);
    const offset = Number.isInteger(offsetRaw) && offsetRaw > 0 ? offsetRaw : 0;
    const includeDh = c.req.query('include_dh') !== '0';

    const db = messagingDb(c.env);
    const totalRow = await db
      .prepare(
        `SELECT COUNT(*) AS n FROM group_members
          WHERE group_id = ? AND status IN ('active', 'pending')`,
      )
      .bind(groupId)
      .first<{ n: number }>();
    const total = Number(totalRow?.n ?? 0);

    // ORDER BY 末位补 member_worker_b_url：joined_at 可能撞秒，缺稳定次序会导致翻页重复 / 漏人
    const listSql = `SELECT member_worker_b_url, member_handle, role, is_admin, status, key_state, joined_at,
                member_dh_pubkey
           FROM group_members
          WHERE group_id = ? AND status IN ('active', 'pending')
          ORDER BY CASE role WHEN 'owner' THEN 0 ELSE 1 END, is_admin DESC, joined_at ASC,
                   member_worker_b_url ASC`;
    const listStmt =
      limit === null
        ? db.prepare(listSql).bind(groupId)
        : db.prepare(`${listSql} LIMIT ? OFFSET ?`).bind(groupId, limit, offset);
    const { results } = await listStmt.all<{
      member_worker_b_url: string;
      member_handle: string;
      role: string;
      is_admin: number;
      status: string;
      key_state: string;
      joined_at: string;
      member_dh_pubkey: string | null;
    }>();
    // REKEY-2：名单带 DH 公钥，供管理员浏览器密封；无私钥字段。
    const items = (results ?? []).map((row) => ({
      member_worker_b_url: row.member_worker_b_url,
      member_handle: row.member_handle,
      role: row.role,
      is_admin: Number(row.is_admin) === 1,
      status: row.status,
      key_state: row.key_state,
      joined_at: row.joined_at,
      ...(includeDh ? { member_dh_pubkey: row.member_dh_pubkey ?? null } : {}),
    }));
    return c.json({
      ok: true,
      data: {
        items,
        total,
        has_more: limit !== null ? offset + items.length < total : false,
      },
    });
  });

  // GET /api/groups/local — 本节点已加入群列表
  app.get('/local', async (c) => {
    const localUser = await getLocalUser(c.env);
    if (!localUser?.worker_b_url) {
      return errorJson(c, 409, 'USER_NOT_REGISTERED', '节点尚未完成注册');
    }

    const memberUrl = normalizeGroupMemberUrl(localUser.worker_b_url);
    const db = messagingDb(c.env);
    const { results } = await db
      .prepare(
        `SELECT g.group_id, g.name, g.announcement, g.owner_worker_b_url, g.epoch, g.tree_id, g.dissolved_at,
                g.join_requires_approval, g.join_policy, g.members_muted, g.rekey_scheduled,
                gm.role, gm.is_admin, gm.key_state, gm.status,
                CASE WHEN gm.role = 'owner' THEN 'active' ELSE gss.sync_tier END AS sync_tier,
                gss.local_retention_days,
                (SELECT COUNT(*) FROM group_members c
                  WHERE c.group_id = g.group_id AND c.status IN ('active', 'pending')) AS member_count,
                -- REL-FIX-5：待审批入群申请数（群主 UI 角标）。
                -- 入群 pending 行只落群主库（REL-FIX-3/6 语义），故本机非群主时恒为 0
                -- （跨节点管理员的待审批列表走 REL-FIX-6 按需代理拉取，不在此聚合，避免 N 次跨节点请求风暴）。
                -- 判据用 gm.role = 'owner'（本机自身成员行）而非 URL 比对：
                --   ① 换域名迁移（M7-30）后 groups.owner_worker_b_url 与 users.worker_b_url 可能短暂分叉，
                --      URL 比对会漏判 → 角标消失；role 判定不受迁移影响。
                --   ② 成员节点本地也有自己的 pending 行（mirrorAcceptedGroupLocally 镜像），
                --      若只按 status='pending' 计数会把「我自己的申请」算成「待我审批」。
                CASE WHEN gm.role = 'owner' THEN (
                  SELECT COUNT(*) FROM group_members p
                    WHERE p.group_id = g.group_id AND p.status = 'pending'
                ) ELSE 0 END AS pending_join_count,
                -- EPOCH-UX-1：仅主/管看换钥进度（下一 epoch wraps / active 人数 / 已登记 DH）；成员侧为 NULL。
                CASE WHEN gm.role = 'owner' OR gm.is_admin = 1 THEN (
                  SELECT COUNT(*) FROM group_members m
                    WHERE m.group_id = g.group_id AND m.status = 'active'
                ) ELSE NULL END AS rekey_members_total,
                CASE WHEN gm.role = 'owner' OR gm.is_admin = 1 THEN (
                  SELECT COUNT(*) FROM group_members m
                    WHERE m.group_id = g.group_id AND m.status = 'active'
                      AND length(trim(coalesce(m.member_dh_pubkey, ''))) = 64
                ) ELSE NULL END AS rekey_dh_ready,
                CASE WHEN gm.role = 'owner' OR gm.is_admin = 1 THEN (
                  SELECT COUNT(*) FROM group_wrapped_keys w
                    INNER JOIN group_members m
                      ON m.group_id = w.group_id AND m.member_worker_b_url = w.member_worker_b_url
                   WHERE w.group_id = g.group_id AND w.epoch = g.epoch + 1 AND m.status = 'active'
                     AND length(trim(coalesce(w.wrapped_key_json, ''))) > 0
                ) ELSE NULL END AS rekey_wraps_ready
           FROM group_members gm
           JOIN groups g ON g.group_id = gm.group_id
           LEFT JOIN group_sync_state gss ON gss.group_id = gm.group_id
          WHERE gm.member_worker_b_url = ?
            AND gm.status IN ('active', 'pending')
          ORDER BY g.updated_at DESC`,
      )
      .bind(memberUrl)
      .all();

    return c.json({ ok: true, data: { items: results ?? [] } });
  });

  // PUT /api/groups/local/:groupId/settings — 成员本节点本地 retention（默认 90，1～365）
  app.put('/local/:groupId/settings', async (c) => {
    const groupId = c.req.param('groupId');
    if (!GROUP_ID_RE.test(groupId)) {
      return errorJson(c, 400, 'GROUP_ENVELOPE_INVALID', 'group_id 无效');
    }

    const body = await readRawJson(c);
    const rawDays = body.local_retention_days;
    const days =
      typeof rawDays === 'number'
        ? rawDays
        : typeof rawDays === 'string'
          ? parseInt(rawDays, 10)
          : NaN;
    if (!Number.isInteger(days) || days < 1 || days > 365) {
      return errorJson(c, 400, 'GROUP_ENVELOPE_INVALID', 'local_retention_days 须在 1～365');
    }

    const localUser = await getLocalUser(c.env);
    if (!localUser?.worker_b_url) {
      return errorJson(c, 409, 'USER_NOT_REGISTERED', '节点尚未完成注册');
    }

    const memberUrl = normalizeGroupMemberUrl(localUser.worker_b_url);
    const db = messagingDb(c.env);
    const memberRow = await db
      .prepare(
        `SELECT gm.status, gm.role, g.owner_worker_b_url, gss.sync_tier, gss.local_retention_days
           FROM group_members gm
           JOIN groups g ON g.group_id = gm.group_id
           LEFT JOIN group_sync_state gss ON gss.group_id = gm.group_id
          WHERE gm.group_id = ? AND gm.member_worker_b_url = ?
            AND gm.status IN ('active', 'pending')
          LIMIT 1`,
      )
      .bind(groupId, memberUrl)
      .first<{
        status: string;
        role: string;
        owner_worker_b_url: string;
        sync_tier: string | null;
        local_retention_days: number | null;
      }>();

    if (!memberRow) {
      return errorJson(c, 404, 'GROUP_NOT_FOUND', '群不存在或非本节点成员');
    }

    const currentDays = memberRow.local_retention_days ?? 90;
    const capacityCheck = await assertGroupRetentionCapacityAllowed(c.env, {
      groupId,
      proposedDays: days,
      currentDays,
    });
    if (!capacityCheck.ok) {
      return errorJson(c, capacityCheck.status, capacityCheck.error_code, capacityCheck.message);
    }

    const updatedAt = nowIso();
    const parentUrl = normalizeGroupMemberUrl(memberRow.owner_worker_b_url);
    const syncTier = memberRow.role === 'owner' ? 'active' : (memberRow.sync_tier ?? 'unsynced');
    await db
      .prepare(
        `INSERT INTO group_sync_state
           (group_id, parent_worker_b_url, cursor, sync_tier, local_retention_days, last_sync_at, updated_at)
         VALUES (?, ?, NULL, ?, ?, NULL, ?)
         ON CONFLICT(group_id) DO UPDATE SET
           local_retention_days = excluded.local_retention_days,
           updated_at = excluded.updated_at`,
      )
      .bind(groupId, parentUrl, syncTier, days, updatedAt)
      .run();

    return c.json({
      ok: true,
      data: {
        group_id: groupId,
        local_retention_days: days,
        sync_tier: syncTier,
      },
    });
  });

  // POST /api/groups/:groupId/leave — EPOCH v0.3：本机立即 left；权威异步；不紧急换钥
  app.post('/:groupId/leave', async (c) => {
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
        `SELECT role, status FROM group_members
          WHERE group_id = ? AND member_worker_b_url = ?
            AND status IN ('active', 'pending', 'left')
          LIMIT 1`,
      )
      .bind(groupId, memberUrl)
      .first<{ role: string; status: string }>();

    if (!memberRow) {
      return errorJson(c, 404, 'GROUP_NOT_FOUND', '群不存在或非本节点成员');
    }
    if (memberRow.role === 'owner') {
      return errorJson(c, 409, 'GROUP_OWNER_CANNOT_LEAVE', '群主不能退出自己创建的群');
    }

    const leftAt = nowIso();
    // 本机最高优先：即使群主宕机也先退出
    if (memberRow.status !== 'left') {
      await db
        .prepare(
          `UPDATE group_members SET status = 'left', is_admin = 0
            WHERE group_id = ? AND member_worker_b_url = ? AND status IN ('active', 'pending')`,
        )
        .bind(groupId, memberUrl)
        .run();
    }

    const groupMeta = await db
      .prepare(`SELECT owner_worker_b_url FROM groups WHERE group_id = ? LIMIT 1`)
      .bind(groupId)
      .first<{ owner_worker_b_url: string }>();

    const ownerUrl = groupMeta?.owner_worker_b_url
      ? normalizeGroupMemberUrl(groupMeta.owner_worker_b_url)
      : '';
    const handle = (localUser.handle ?? 'member').trim().toLowerCase();
    // 单用户节点：退群者本机 ≠ 群主权威 → 异步通知；权威收信令后 applyMemberLeftOnOwner
    if (ownerUrl) {
      c.executionCtx.waitUntil(
        notifyOwnerMemberLeft(c.env, ownerUrl, {
          group_id: groupId,
          member_worker_b_url: memberUrl,
          member_handle: handle,
        }),
      );
    }

    return c.json({
      ok: true,
      data: { group_id: groupId, status: 'left', left_at: leftAt },
    });
  });

  // POST /api/groups/:groupId/dissolve — 群主解散群（M16-6）
  app.post('/:groupId/dissolve', async (c) => {
    const groupId = c.req.param('groupId');
    if (!GROUP_ID_RE.test(groupId)) {
      return errorJson(c, 400, 'GROUP_ENVELOPE_INVALID', 'group_id 无效');
    }

    const localUser = await getLocalUser(c.env);
    if (!localUser?.worker_b_url) {
      return errorJson(c, 409, 'USER_NOT_REGISTERED', '节点尚未完成注册');
    }

    const result = await dissolveGroupOnOwner(c.env, groupId, localUser.worker_b_url);
    if (!result.ok) {
      return errorJson(c, result.status, result.error_code, result.message);
    }
    return c.json({ ok: true, data: result.data });
  });

}
