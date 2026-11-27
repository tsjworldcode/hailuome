/**
 * MM-4：私信媒体上传与经 Worker A 拉取密文（禁止直连远端 Worker B）。
 */
import type { createWorkerAClient } from './workerA';

type WorkerAClient = ReturnType<typeof createWorkerAClient>;

export function newClientMessagingMediaId(): string {
  return crypto.randomUUID().replace(/-/g, '');
}

export async function uploadDmMessagingMedia(
  client: WorkerAClient,
  input: {
    mediaId: string;
    plainMime: string;
    ciphertext: ArrayBuffer | Uint8Array;
  },
): Promise<{ storage_key: string; media_id: string; size_bytes: number }> {
  const body = input.ciphertext instanceof Uint8Array ? input.ciphertext : new Uint8Array(input.ciphertext);
  const uploaded = await client.uploadMessagingMedia({
    purpose: 'dm',
    plainMime: input.plainMime,
    mediaId: input.mediaId,
    body,
  });
  return uploaded;
}

/** 读本节点 blob 或 proxy 远端（仅 Worker A）。 */
export async function fetchDmMessagingCiphertext(
  client: WorkerAClient,
  input: {
    envelopeMedia: {
      media_id: string;
      sender_storage_key: string;
    };
    messageId: string;
    conversationId: string;
    direction: 'inbox' | 'outbox';
  },
): Promise<ArrayBuffer> {
  if (input.direction === 'outbox') {
    return client.fetchMessagingMediaByStorageKey(input.envelopeMedia.sender_storage_key);
  }
  return client.fetchMessagingMediaProxy({
    message_id: input.messageId,
    media_id: input.envelopeMedia.media_id,
    conversation_id: input.conversationId,
  });
}

export async function uploadGroupMessagingMedia(
  client: WorkerAClient,
  input: {
    mediaId: string;
    plainMime: string;
    ciphertext: ArrayBuffer | Uint8Array;
  },
): Promise<{ storage_key: string; media_id: string; size_bytes: number }> {
  const body = input.ciphertext instanceof Uint8Array ? input.ciphertext : new Uint8Array(input.ciphertext);
  return client.uploadMessagingMedia({
    purpose: 'group',
    plainMime: input.plainMime,
    mediaId: input.mediaId,
    body,
  });
}

export async function fetchGroupMessagingCiphertext(
  client: WorkerAClient,
  input: {
    groupId: string;
    messageId: string;
    envelopeMedia: { media_id: string; sender_storage_key: string };
    senderWorkerBUrl: string;
    meWorkerBUrl: string;
  },
): Promise<ArrayBuffer> {
  if (input.senderWorkerBUrl.replace(/\/+$/, '') === input.meWorkerBUrl.replace(/\/+$/, '')) {
    return client.fetchMessagingMediaByStorageKey(input.envelopeMedia.sender_storage_key);
  }
  return client.fetchMessagingMediaProxy({
    message_id: input.messageId,
    media_id: input.envelopeMedia.media_id,
    group_id: input.groupId,
  });
}

export function revokeGroupMediaObjectUrls(
  records: readonly { media?: readonly { object_url?: string }[] }[],
): void {
  for (const row of records) {
    for (const item of row.media ?? []) {
      if (item.object_url?.startsWith('blob:')) {
        URL.revokeObjectURL(item.object_url);
      }
    }
  }
}

export function revokeDmMediaObjectUrls(
  records: readonly { media?: readonly { object_url?: string }[] }[],
): void {
  revokeGroupMediaObjectUrls(records);
}
