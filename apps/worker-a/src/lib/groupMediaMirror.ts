/**
 * MM-5：群消息收信后 mirror 发送方 blob（fail-soft；无云能力则 stream_only）。
 */
import { resolveIdentityDb } from '../db/bindings';
import type { GroupMessageEnvelope } from '@hailuo/shared-types';
import type { Env } from '../env';
import {
  fetchGroupMediaFromSenderWorkerB,
  issueGroupMediaFetchTicket,
} from './groupMediaFetchTicket';
import { messagingDb } from './messagingDb';
import { resolveMessagingMediaMaxBytes } from './messagingMediaLimits';
import { storeMessagingCiphertextBytes } from './messagingMediaStore';
import { serveMediaObject } from './mediaServe';
import { hasMessagingCloudCapability } from './mediaStorageUsage';
import { resolveLocalPublicBaseUrl } from './localPublicBaseUrl';

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeWorkerBUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

async function upsertGroupMediaLocal(
  env: Env,
  envelope: GroupMessageEnvelope,
  media: NonNullable<GroupMessageEnvelope['media']>,
  viewMode: 'mirror' | 'stream_only',
  storageState: 'mirror_pending' | 'stream_only',
): Promise<void> {
  const iso = nowIso();
  await messagingDb(env)
    .prepare(
      `INSERT INTO messaging_media_local
         (message_id, media_id, group_id, local_storage_key, mirror_of_key,
          storage_state, media_view_mode, retry_at, created_at, updated_at)
       VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(message_id, media_id) DO UPDATE SET
         storage_state = excluded.storage_state,
         media_view_mode = excluded.media_view_mode,
         retry_at = excluded.retry_at,
         updated_at = excluded.updated_at`,
    )
    .bind(
      envelope.message_id,
      media.media_id,
      envelope.group_id,
      media.sender_storage_key,
      storageState,
      viewMode,
      storageState === 'mirror_pending' ? iso : null,
      iso,
      iso,
    )
    .run();
}

async function markGroupMirrorMirrored(
  env: Env,
  messageId: string,
  mediaId: string,
  localStorageKey: string,
  mirrorOfKey: string,
): Promise<void> {
  const iso = nowIso();
  await messagingDb(env)
    .prepare(
      `UPDATE messaging_media_local
          SET local_storage_key = ?, storage_state = 'mirrored', retry_at = NULL, updated_at = ?
        WHERE message_id = ? AND media_id = ?`,
    )
    .bind(localStorageKey, iso, messageId, mediaId)
    .run();

  await resolveIdentityDb(env)
    .prepare(
      `UPDATE media_object_registry
          SET owner_kind = 'group_mirror', mirror_of_key = ?, message_id = ?, media_id = ?
        WHERE object_key = ? AND scope = 'messaging'`,
    )
    .bind(mirrorOfKey, messageId, mediaId, localStorageKey)
    .run();
}

/** waitUntil 调用：从发送方拉取并写入本节点副本（有云能力时 mirror，否则 stream_only）。 */
export async function mirrorGroupMediaFromSender(
  env: Env,
  envelope: GroupMessageEnvelope,
): Promise<void> {
  const media = envelope.media;
  if (!media) return;

  const existing = await messagingDb(env)
    .prepare(
      `SELECT storage_state, local_storage_key FROM messaging_media_local
        WHERE message_id = ? AND media_id = ? LIMIT 1`,
    )
    .bind(envelope.message_id, media.media_id)
    .first<{ storage_state: string; local_storage_key: string | null }>();
  if (existing?.storage_state === 'mirrored' && existing.local_storage_key) {
    return;
  }

  const canMirror = await hasMessagingCloudCapability(env);
  if (!canMirror) {
    await upsertGroupMediaLocal(env, envelope, media, 'stream_only', 'stream_only');
    return;
  }

  await upsertGroupMediaLocal(env, envelope, media, 'mirror', 'mirror_pending');

  const senderB = normalizeWorkerBUrl(media.sender_worker_b_url);
  const localB = normalizeWorkerBUrl(await resolveLocalPublicBaseUrl(env));
  let bytes: ArrayBuffer | null = null;

  if (senderB === localB) {
    const served = await serveMediaObject(env, media.sender_storage_key);
    if (served.ok) {
      bytes = await served.arrayBuffer();
    }
  } else {
    const ticket = await issueGroupMediaFetchTicket(env, {
      group_id: envelope.group_id,
      message_id: envelope.message_id,
      media_id: media.media_id,
      sender_storage_key: media.sender_storage_key,
      sender_worker_b_url: media.sender_worker_b_url,
    });
    if (!ticket) return;
    const maxBytes = await resolveMessagingMediaMaxBytes(env);
    bytes = await fetchGroupMediaFromSenderWorkerB(env, senderB, media.sender_storage_key, ticket, {
      maxBytes,
      expectedSizeBytes: media.size_bytes,
      expectedSha256Hex: media.ciphertext_sha256,
    });
  }

  if (!bytes || bytes.byteLength === 0) {
    console.warn('[groupMediaMirror] mirror 拉取失败', envelope.message_id, media.media_id);
    return;
  }

  try {
    const stored = await storeMessagingCiphertextBytes(env, bytes, 'group');
    if (!stored) {
      console.warn('[groupMediaMirror] mirror 写入失败', envelope.message_id);
      return;
    }
    await markGroupMirrorMirrored(
      env,
      envelope.message_id,
      media.media_id,
      stored.storageKey,
      media.sender_storage_key,
    );
  } catch (err) {
    console.error('[groupMediaMirror] mirror 异常', envelope.message_id, err);
  }
}
