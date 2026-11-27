/**
 * MM-3：将 messaging 密文 bytes 写入本节点存储（mirror 用）。
 */
import { buildMessagingMediaStorageKey } from '@hailuo/shared-utils';
import type { Env } from '../env';
import { uploadToB2Stream } from './b2upload';
import { uploadToFilebaseStream } from './filebaseupload';
import { toB2UploadConfig, toFilebaseUploadConfig } from './mediaStorage';
import {
  finalizeMessagingMediaUpload,
  type MessagingUploadPurpose,
} from './mediaObjectRegistry';
import { resolveUploadBackend, type MediaUsageBackend } from './mediaStorageUsage';
import { newMessagingMediaId } from './messagingMediaLimits';
import { resolveLocalPublicBaseUrl } from './localPublicBaseUrl';

const OCTET_STREAM = 'application/octet-stream';
const MAX_KV_BYTES = 25 * 1024 * 1024;

export async function storeMessagingCiphertextBytes(
  env: Env,
  bytes: ArrayBuffer,
  purpose: MessagingUploadPurpose,
): Promise<{ storageKey: string; backend: MediaUsageBackend; mediaId: string } | null> {
  const sizeBytes = bytes.byteLength;
  if (sizeBytes <= 0) return null;

  const target = await resolveUploadBackend(env, {
    contentType: 'image/jpeg',
    sizeBytes,
  });
  if (!target) return null;
  if (target.backend === 'kv' && sizeBytes > MAX_KV_BYTES) return null;

  const mediaId = newMessagingMediaId();
  const objectName = `msg_${crypto.randomUUID().replace(/-/g, '')}`;
  const storageKey = buildMessagingMediaStorageKey(target.backend, objectName);
  if (!storageKey) return null;

  if (target.backend === 'filebase') {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(bytes));
        controller.close();
      },
    });
    await uploadToFilebaseStream(
      toFilebaseUploadConfig(target.filebaseStored!),
      objectName,
      stream,
      OCTET_STREAM,
      String(sizeBytes),
    );
  } else if (target.backend === 'b2') {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(bytes));
        controller.close();
      },
    });
    await uploadToB2Stream(
      toB2UploadConfig(target.b2Stored!),
      objectName,
      stream,
      OCTET_STREAM,
      String(sizeBytes),
    );
  } else if (target.backend === 'r2') {
    await env.HAILUO_IMAGE_R2!.put(storageKey, bytes, {
      httpMetadata: { contentType: OCTET_STREAM },
    });
  } else {
    await env.IMAGE_KV.put(storageKey, bytes, {
      metadata: { contentType: OCTET_STREAM, size: sizeBytes },
    });
  }

  await finalizeMessagingMediaUpload(env, target.backend, storageKey, sizeBytes, {
    mediaId,
    purpose,
    senderWorkerBUrl: await resolveLocalPublicBaseUrl(env),
  });

  return { storageKey, backend: target.backend, mediaId };
}
