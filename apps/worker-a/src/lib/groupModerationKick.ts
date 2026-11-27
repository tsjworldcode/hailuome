/** MOD-1：管理员跨节点踢人；本地镜像只用于寻址，群主 D1 才是授权权威。 */
import { parseGroupModerationKick, signGroupModerationKick, verifyGroupModerationKick,
  randomDmNonceHex, type GroupModerationKickUnsigned } from '@hailuo/shared-crypto';
import type { Env } from '../env';
import { resolveIdentityDb } from '../db/bindings';
import { messagingDb } from './messagingDb';
import { normalizeGroupMemberUrl } from './groupMemberUrl';
import { fetchOutboundPeer } from './fetchOutboundPeer';
import { kickGroupMemberByModerator } from './groupKick';

type KickResult = Awaited<ReturnType<typeof kickGroupMemberByModerator>> |
  { ok: false; status: 429 | 503; error_code: string; message: string };
const unavailable = (): KickResult => ({ ok: false, status: 503,
  error_code: 'GROUP_MODERATION_UNAVAILABLE', message: '群管理服务暂不可用' });
const forbidden = (): KickResult => ({ ok: false, status: 403,
  error_code: 'GROUP_MODERATION_FORBIDDEN', message: '无权执行群管理操作' });

export async function moderateGroupKickOnOwner(env: Env, raw: unknown): Promise<KickResult> {
  const e = parseGroupModerationKick(raw);
  if (!e) return forbidden();
  try {
    const db = messagingDb(env);
    const local = await resolveIdentityDb(env).prepare('SELECT worker_b_url FROM users LIMIT 1')
      .first<{ worker_b_url: string }>();
    const group = await db.prepare('SELECT owner_worker_b_url, dissolved_at FROM groups WHERE group_id = ? LIMIT 1')
      .bind(e.group_id).first<{ owner_worker_b_url: string; dissolved_at: string | null }>();
    if (!local?.worker_b_url || !group || group.dissolved_at ||
      normalizeGroupMemberUrl(local.worker_b_url) !== e.owner_worker_b_url ||
      normalizeGroupMemberUrl(group.owner_worker_b_url) !== e.owner_worker_b_url) return forbidden();
    const actor = await db.prepare(`SELECT member_pubkey, status, is_admin FROM group_members
      WHERE group_id = ? AND member_worker_b_url = ? LIMIT 1`)
      .bind(e.group_id, e.actor_worker_b_url).first<{ member_pubkey: string; status: string; is_admin: number }>();
    if (!actor || actor.status !== 'active' || Number(actor.is_admin) !== 1 ||
      !await verifyGroupModerationKick(e, actor.member_pubkey)) return forbidden();
    // 原子占用 nonce 后才计额度，截获信封不能反复消耗管理员额度。
    const nonce = await db.prepare(`INSERT OR IGNORE INTO group_nonces (group_id, nonce, created_at) VALUES (?, ?, ?)`)
      .bind(e.group_id, e.nonce, new Date().toISOString()).run();
    if (!nonce.success || typeof nonce.meta?.changes !== 'number') return unavailable();
    if (!nonce.meta.changes) return { ok: false, status: 409, error_code: 'GROUP_NONCE_REPLAY', message: '群管理请求已处理' };
    // 复用既有小时桶和 GC 前缀；与补钥桶分开，仍由相同有界清理负责。
    const hour = new Date();
    hour.setUTCMinutes(0, 0, 0);
    const window = hour.toISOString();
    const rate = await db.prepare(`INSERT INTO group_rate_buckets (bucket_key, count, window_start)
      VALUES (?, 1, ?) ON CONFLICT (bucket_key) DO UPDATE SET count = count + 1 WHERE count < ?`)
      .bind(`fast-pull|moderation|${e.group_id}|${e.actor_worker_b_url}|${window}`, window, 30).run();
    if (!rate.success || typeof rate.meta?.changes !== 'number') return unavailable();
    if (!rate.meta.changes) return { ok: false, status: 429, error_code: 'GROUP_RATE_LIMITED', message: '群管理操作过于频繁' };
    return await kickGroupMemberByModerator(env, e.group_id, e.actor_worker_b_url,
      e.target_member_worker_b_url, { expectedEpoch: e.expected_epoch });
  } catch { return unavailable(); }
}

/** 站主入口：本机群主直接执行；其他节点签信封后仅联系群主公开入口。 */
export async function requestGroupModerationKick(
  env: Env, groupId: string, actorUrl: string, targetUrl: string,
  options?: { expectedEpoch?: number },
): Promise<KickResult> {
  try {
    const group = await messagingDb(env).prepare('SELECT owner_worker_b_url, epoch, dissolved_at FROM groups WHERE group_id = ? LIMIT 1')
      .bind(groupId).first<{ owner_worker_b_url: string; epoch: number; dissolved_at: string | null }>();
    if (!group || group.dissolved_at) return { ok: false, status: 404, error_code: 'GROUP_NOT_FOUND', message: '群不存在或已解散' };
    const actor = normalizeGroupMemberUrl(actorUrl);
    const owner = normalizeGroupMemberUrl(group.owner_worker_b_url);
    if (actor === owner) return await kickGroupMemberByModerator(env, groupId, actor, targetUrl, options);
    const unsigned: GroupModerationKickUnsigned = {
      kind: 'GROUP_MODERATION_KICK', group_id: groupId, owner_worker_b_url: owner,
      actor_worker_b_url: actor, target_member_worker_b_url: normalizeGroupMemberUrl(targetUrl),
      expected_epoch: options?.expectedEpoch ?? group.epoch,
      timestamp: new Date().toISOString(), nonce: randomDmNonceHex(16),
    };
    const body = { ...unsigned, sig: await signGroupModerationKick(unsigned, env.ED25519_PRIVATE_KEY) };
    if (!parseGroupModerationKick(body)) return forbidden();
    const result = await fetchOutboundPeer(env, `${owner}/groups/moderation`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), timeoutMs: 5000,
    });
    if (!result.ok) return unavailable();
    // 不透传对端错误文案/任意字段，避免恶意响应注入敏感地址。
    const text = await result.response.text();
    if (text.length > 16_384) return unavailable();
    const reply = JSON.parse(text);
    if (result.response.ok && reply?.ok === true && reply.data?.group_id === groupId &&
      reply.data?.member_worker_b_url === body.target_member_worker_b_url && reply.data?.status === 'kicked' &&
      reply.data?.new_epoch === body.expected_epoch && reply.data?.rekey_scheduled === true) {
      return { ok: true, data: { group_id: groupId, member_worker_b_url: body.target_member_worker_b_url,
        status: 'kicked', new_epoch: reply.data.new_epoch, rekey_scheduled: true } };
    }
    const status = result.response.status;
    const codes: Record<string, string> = {
      GROUP_NOT_MEMBER: '无权操作目标成员',
      GROUP_NOT_FOUND: '群不存在',
      GROUP_MODERATION_FORBIDDEN: '无权执行群管理操作',
      GROUP_ENVELOPE_INVALID: '群管理信封无效',
      EPOCH_CONFLICT: '群状态已变化，请刷新重试',
      GROUP_NONCE_REPLAY: '群管理请求已处理',
      GROUP_RATE_LIMITED: '群管理操作过于频繁',
      GROUP_MODERATION_UNAVAILABLE: '群管理服务暂不可用',
    };
    if ([400, 403, 404, 409, 429].includes(status) && codes[reply?.error_code]) {
      return { ok: false, status: status as 400 | 403 | 404 | 409 | 429,
        error_code: reply.error_code, message: codes[reply.error_code]! };
    }
    return unavailable();
  } catch { return unavailable(); }
}
