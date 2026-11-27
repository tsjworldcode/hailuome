/**
 * MM-3：DM 收信后 mirror 发送方 blob 到本节点（fail-soft，不阻塞收信）。
 */
import { resolveIdentityDb } from '../db/bindings';
import type { DmEnvelope } from '@hailuo/shared-types';
import type { Env } from '../env';
import {
  fetchDmMediaFromSenderWorkerB,
  issueDmMediaFetchTicket,
} from './dmMediaFetchTicket';
import { messagingDb } from './messagingDb';
import { resolveMessagingMediaMaxBytes } from './messagingMediaLimits';
import { storeMessagingCiphertextBytes } from './messagingMediaStore';
import { serveMediaObject } from './mediaServe';
import { resolveLocalPublicBaseUrl } from './localPublicBaseUrl';

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeWorkerBUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

async function upsertMirrorPending(
  env: Env,
  envelope: DmEnvelope,
  media: NonNullable<DmEnvelope['media']>,
): Promise<void> {
  const iso = nowIso();
  await messagingDb(env)
    .prepare(
      `INSERT INTO messaging_media_local
         (message_id, media_id, group_id, local_storage_key, mirror_of_key,
          storage_state, media_view_mode, retry_at, created_at, updated_at)
       VALUES (?, ?, NULL, NULL, ?, 'mirror_pending', 'mirror', ?, ?, ?)
       ON CONFLICT(message_id, media_id) DO UPDATE SET
         storage_state = 'mirror_pending',
         retry_at = excluded.retry_at,
         updated_at = excluded.updated_at`,
    )
    .bind(
      envelope.message_id,
      media.media_id,
      media.sender_storage_key,
      iso,
      iso,
      iso,
    )
    .run();
}

async function markMirrorMirrored(
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
          SET owner_kind = 'dm_mirror', mirror_of_key = ?, message_id = ?, media_id = ?
        WHERE object_key = ? AND scope = 'messaging'`,
    )
    .bind(mirrorOfKey, messageId, mediaId, localStorageKey)
    .run();
}

/** waitUntil 调用：从发送方拉取并写入本节点副本。 */
export async function mirrorDmMediaFromSender(env: Env, envelope: DmEnvelope): Promise<void> {
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

  await upsertMirrorPending(env, envelope, media);

  const senderB = normalizeWorkerBUrl(media.sender_worker_b_url);
  const localB = normalizeWorkerBUrl(await resolveLocalPublicBaseUrl(env));
  let bytes: ArrayBuffer | null = null;

  if (senderB === localB) {
    const served = await serveMediaObject(env, media.sender_storage_key);
    if (served.ok) {
      bytes = await served.arrayBuffer();
    }
  } else {
    const ticket = await issueDmMediaFetchTicket(env, {
      message_id: envelope.message_id,
      media_id: media.media_id,
      conversation_id: envelope.conversation_id,
      sender_storage_key: media.sender_storage_key,
    });
    if (!ticket) return;
    const maxBytes = await resolveMessagingMediaMaxBytes(env);
    bytes = await fetchDmMediaFromSenderWorkerB(env, senderB, media.sender_storage_key, ticket, {
      maxBytes,
      expectedSizeBytes: media.size_bytes,
      expectedSha256Hex: media.ciphertext_sha256,
    });
  }

  if (!bytes || bytes.byteLength === 0) {
    console.warn('[dmMediaMirror] mirror 拉取失败', envelope.message_id, media.media_id);
    return;
  }

  try {
    const stored = await storeMessagingCiphertextBytes(env, bytes, 'dm');
    if (!stored) {
      console.warn('[dmMediaMirror] mirror 写入失败', envelope.message_id);
      return;
    }
    await markMirrorMirrored(
      env,
      envelope.message_id,
      media.media_id,
      stored.storageKey,
      media.sender_storage_key,
    );
  } catch (err) {
    console.error('[dmMediaMirror] mirror 异常', envelope.message_id, err);
  }
}
