/**
 * M7-30-GROUP-URL：换域后群内系统消息广播 + 收信验签改址。
 * SSOT：docs/m7-30-group-url-change-plan.md
 */
import { resolveIdentityDb } from '../db/bindings';
import { randomDmNonceHex, signGroupMessageEnvelope } from '@hailuo/shared-crypto';
import type { GroupMessageEnvelope, NodeUrlChangedEvent } from '@hailuo/shared-types';
import type { Env } from '../env';
import { persistOwnerLocalGroupMessage } from './groupMessage';
import { messagingDb } from './messagingDb';
import { normalizeGroupMemberUrl } from './groupMemberUrl';
import { fetchOutboundPeer, isManualRedirectStatus } from './fetchOutboundPeer';
import { loadSpeakerPrimaryTargets } from './groupSpeakerPrimary';
import { applyGroupUrlMigration } from './groupUrlMigrate';
import { verifyNodeUrlChangedEvent } from './nodeUrlChangedInbound';
import {
  loadUrlChangeNotifyEventById,
  type UrlMoveNotifyMeta,
} from './urlChangeNotify';

export const GROUP_NODE_URL_CHANGED_PREFIX = 'HAILUO_GROUP_NODE_URL_CHANGED_V1';

/** 群换域通知单跳超时。地址先过公开 https 门禁，302 不跟随。 */
const GROUP_URL_CHANGE_NOTIFY_TIMEOUT_MS = 8_000;

const GROUP_MESSAGE_TTL_MS = 24 * 60 * 60 * 1000;

function nowIso(): string {
  return new Date().toISOString();
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function newGroupMessageId(): string {
  return `gmsg_${bytesToHex(crypto.getRandomValues(new Uint8Array(16)))}`;
}

function utf8PlaintextBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function decodeSystemCiphertext(ciphertextB64: string): string {
  try {
    const bin = atob(ciphertextB64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  } catch {
    return '';
  }
}

export function encodeGroupNodeUrlChangedPayload(event: NodeUrlChangedEvent): string {
  return `${GROUP_NODE_URL_CHANGED_PREFIX}\n${JSON.stringify(event)}`;
}

export function parseGroupNodeUrlChangedPayload(
  plaintext: string,
): NodeUrlChangedEvent | null {
  const text = plaintext.trim();
  if (!text.startsWith(GROUP_NODE_URL_CHANGED_PREFIX)) return null;
  const jsonPart = text.slice(GROUP_NODE_URL_CHANGED_PREFIX.length).trim();
  try {
    const parsed = JSON.parse(jsonPart) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const row = parsed as Record<string, unknown>;
    if (
      row.type !== 'node_url_changed' ||
      typeof row.from_handle !== 'string' ||
      typeof row.from_node_url_old !== 'string' ||
      typeof row.from_node_url_new !== 'string' ||
      typeof row.changed_at !== 'string' ||
      typeof row.grace_until !== 'string' ||
      typeof row.nonce !== 'string' ||
      typeof row.sig !== 'string'
    ) {
      return null;
    }
    return {
      type: 'node_url_changed',
      from_handle: row.from_handle,
      from_node_url_old: row.from_node_url_old,
      from_node_url_new: row.from_node_url_new,
      changed_at: row.changed_at,
      grace_until: row.grace_until,
      nonce: row.nonce,
      sig: row.sig,
    };
  } catch {
    return null;
  }
}

/** UI 友好文案（Web 解码后替换展示） */
export function formatGroupNodeUrlChangedDisplay(event: NodeUrlChangedEvent): string {
  return `@${event.from_handle} 已更换节点地址`;
}

/**
 * 若 system ciphertext 为换域载荷且验签通过 → 立即改址。
 * 验签失败不改址；解析失败静默跳过。
 */
export async function maybeApplyGroupUrlChangeFromSystemCiphertext(
  env: Env,
  msgKind: string,
  ciphertextB64: string,
): Promise<{ applied: boolean }> {
  if (msgKind !== 'system') return { applied: false };
  const plaintext = decodeSystemCiphertext(ciphertextB64);
  const event = parseGroupNodeUrlChangedPayload(plaintext);
  if (!event) return { applied: false };

  const verified = await verifyNodeUrlChangedEvent(env, event);
  if (!verified) {
    console.warn('[groupUrlChange] system 载荷验签失败，不改址');
    return { applied: false };
  }

  await applyGroupUrlMigration(env, verified.from_node_url_old, verified.from_node_url_new);
  return { applied: true };
}

async function getLocalUser(env: Env): Promise<{
  handle: string;
  worker_b_url: string;
  pubkey: string;
} | null> {
  return resolveIdentityDb(env)
    .prepare(`SELECT handle, worker_b_url, pubkey FROM users LIMIT 1`)
    .first<{ handle: string; worker_b_url: string; pubkey: string }>();
}

async function buildOwnerSystemEnvelope(
  env: Env,
  groupId: string,
  owner: { handle: string; worker_b_url: string },
  epoch: number,
  plaintext: string,
): Promise<GroupMessageEnvelope> {
  const now = nowIso();
  const ownerUrl = normalizeGroupMemberUrl(owner.worker_b_url);
  const unsigned = {
    v: 1 as const,
    kind: 'GROUP_MESSAGE' as const,
    group_id: groupId,
    message_id: newGroupMessageId(),
    epoch,
    sender_handle: owner.handle.trim().toLowerCase(),
    sender_worker_b_url: ownerUrl,
    owner_worker_b_url: ownerUrl,
    created_at: now,
    expires_at: new Date(Date.now() + GROUP_MESSAGE_TTL_MS).toISOString(),
    nonce: randomDmNonceHex(16),
    msg_kind: 'system' as const,
    ciphertext: utf8PlaintextBase64(plaintext),
  };
  const sig = await signGroupMessageEnvelope(unsigned, env.ED25519_PRIVATE_KEY);
  return { ...unsigned, sig };
}

/** 群主节点：写入并 relay 换域 system 消息 */
export async function postGroupUrlChangedSystemAsOwner(
  env: Env,
  groupId: string,
  event: NodeUrlChangedEvent,
): Promise<boolean> {
  const local = await getLocalUser(env);
  if (!local?.worker_b_url) return false;
  const db = messagingDb(env);
  const group = await db
    .prepare(
      `SELECT owner_worker_b_url, epoch, dissolved_at FROM groups WHERE group_id = ? LIMIT 1`,
    )
    .bind(groupId)
    .first<{ owner_worker_b_url: string; epoch: number; dissolved_at: string | null }>();
  if (!group || group.dissolved_at) return false;
  if (
    normalizeGroupMemberUrl(group.owner_worker_b_url) !==
    normalizeGroupMemberUrl(local.worker_b_url)
  ) {
    return false;
  }

  const plaintext = encodeGroupNodeUrlChangedPayload(event);
  const envelope = await buildOwnerSystemEnvelope(
    env,
    groupId,
    local,
    group.epoch,
    plaintext,
  );
  const posted = await persistOwnerLocalGroupMessage(env, envelope, local.worker_b_url);
  if (!posted.ok && posted.error_code !== 'GROUP_NONCE_REPLAY') {
    console.warn('[groupUrlChange] 群主发 system 失败', groupId, posted.error_code);
    return false;
  }
  // 本机也执行改址（幂等；群主换域时 confirm 已做过）
  await applyGroupUrlMigration(env, event.from_node_url_old, event.from_node_url_new);
  return true;
}

/**
 * 成员换域入站：群主验签后改权威 membership 并代发 system；
 * 其他成员只验签改本机地址，不再向外扩散。
 */
export async function handleMemberUrlChangedOnOwner(
  env: Env,
  groupId: string,
  event: NodeUrlChangedEvent,
): Promise<
  | { ok: true; data: { group_id: string; applied: boolean; announced: boolean } }
  | { ok: false; status: 400 | 403 | 404; error_code: string; message: string }
> {
  const local = await getLocalUser(env);
  if (!local?.worker_b_url) {
    return { ok: false, status: 404, error_code: 'USER_NOT_REGISTERED', message: '节点尚未完成注册' };
  }

  const db = messagingDb(env);
  const group = await db
    .prepare(
      `SELECT owner_worker_b_url, dissolved_at FROM groups WHERE group_id = ? LIMIT 1`,
    )
    .bind(groupId)
    .first<{ owner_worker_b_url: string; dissolved_at: string | null }>();
  if (!group || group.dissolved_at) {
    return { ok: false, status: 404, error_code: 'GROUP_NOT_FOUND', message: '群不存在或已解散' };
  }
  if (
    normalizeGroupMemberUrl(group.owner_worker_b_url) !==
    normalizeGroupMemberUrl(local.worker_b_url)
  ) {
    const verified = await verifyNodeUrlChangedEvent(env, event);
    if (!verified) {
      return { ok: false, status: 403, error_code: 'EVENT_VERIFY_FAILED', message: '换域事件验签失败' };
    }
    await applyGroupUrlMigration(env, verified.from_node_url_old, verified.from_node_url_new);
    return {
      ok: true,
      data: { group_id: groupId, applied: true, announced: false },
    };
  }

  const verified = await verifyNodeUrlChangedEvent(env, event);
  if (!verified) {
    return { ok: false, status: 403, error_code: 'EVENT_VERIFY_FAILED', message: '换域事件验签失败' };
  }

  const oldUrl = normalizeGroupMemberUrl(verified.from_node_url_old);
  const member = await db
    .prepare(
      `SELECT status FROM group_members
        WHERE group_id = ? AND member_worker_b_url = ? LIMIT 1`,
    )
    .bind(groupId, oldUrl)
    .first<{ status: string }>();
  if (!member || (member.status !== 'active' && member.status !== 'pending')) {
    // 可能已迁过：用新 URL 查一次
    const already = await db
      .prepare(
        `SELECT status FROM group_members
          WHERE group_id = ? AND member_worker_b_url = ? LIMIT 1`,
      )
      .bind(groupId, normalizeGroupMemberUrl(verified.from_node_url_new))
      .first<{ status: string }>();
    if (!already) {
      return { ok: false, status: 404, error_code: 'GROUP_NOT_MEMBER', message: '成员不在册' };
    }
  }

  await applyGroupUrlMigration(env, verified.from_node_url_old, verified.from_node_url_new);
  const announced = await postGroupUrlChangedSystemAsOwner(env, groupId, verified);
  return {
    ok: true,
    data: { group_id: groupId, applied: true, announced },
  };
}

/**
 * confirm 成功后：对本节点所在每个群广播换域通知。
 */
export async function announceGroupUrlChangeAfterConfirm(
  env: Env,
  meta: UrlMoveNotifyMeta,
): Promise<{ announced: number; notifiedOwners: number }> {
  const event = await loadUrlChangeNotifyEventById(env, meta.urlChangeId);
  if (!event) {
    console.warn('[groupUrlChange] 无签名信封，跳过群广播');
    return { announced: 0, notifiedOwners: 0 };
  }

  const local = await getLocalUser(env);
  if (!local?.worker_b_url) return { announced: 0, notifiedOwners: 0 };
  const localUrl = normalizeGroupMemberUrl(local.worker_b_url);

  const db = messagingDb(env);
  const { results } = await db
    .prepare(
      `SELECT gm.group_id, gm.role, g.owner_worker_b_url
         FROM group_members gm
         JOIN groups g ON g.group_id = gm.group_id
        WHERE gm.member_worker_b_url = ?
          AND gm.status IN ('active', 'pending')
          AND g.dissolved_at IS NULL`,
    )
    .bind(localUrl)
    .all<{ group_id: string; role: string; owner_worker_b_url: string }>();

  let announced = 0;
  let notifiedOwners = 0;

  for (const row of results ?? []) {
    const ownerUrl = normalizeGroupMemberUrl(row.owner_worker_b_url);
    if (row.role === 'owner' || ownerUrl === localUrl) {
      if (await postGroupUrlChangedSystemAsOwner(env, row.group_id, event)) {
        announced += 1;
      }
      continue;
    }

    // 成员：推自己的主责名单（固定最多 8 人，群主必在其中）。
    // 群主改权威表并代发 system；其余人只验签改本机地址，不再向外扩散。
    try {
      const targets = await loadSpeakerPrimaryTargets(env, row.group_id, localUrl, ownerUrl, {
        excludeUrls: [event.from_node_url_old, event.from_node_url_new],
      });
      const results = await Promise.all(
        targets.map(async (targetUrl) => {
          const base = normalizeGroupMemberUrl(targetUrl);
          // 成员表里的旧地址也要再查一次；失败只记原因，不打完整地址。
          const sent = await fetchOutboundPeer(
            env,
            `${base}/groups/member-url-changed`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ group_id: row.group_id, event }),
              timeoutMs: GROUP_URL_CHANGE_NOTIFY_TIMEOUT_MS,
            },
          );
          if (!sent.ok) {
            console.warn('[groupUrlChange] 无法连接主责节点', row.group_id, sent.reason);
            return { url: base, ok: false, status: 0 };
          }
          if (isManualRedirectStatus(sent.response.status)) {
            console.warn('[groupUrlChange] 主责节点返回跳转，已拒绝跟随', row.group_id, sent.response.status);
            return { url: base, ok: false, status: sent.response.status };
          }
          return { url: base, ok: sent.response.ok, status: sent.response.status };
        }),
      );
      const ownerHit = results.find((item) => item.url === ownerUrl);
      if (ownerHit?.ok) {
        notifiedOwners += 1;
        announced += 1;
      } else {
        console.warn(
          '[groupUrlChange] member-url-changed 群主失败',
          row.group_id,
          ownerHit?.status ?? 'missing',
        );
      }
    } catch (err) {
      console.warn('[groupUrlChange] 主责名单投递失败', row.group_id, err);
    }
  }

  return { announced, notifiedOwners };
}
