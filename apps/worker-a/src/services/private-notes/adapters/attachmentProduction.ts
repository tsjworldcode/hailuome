/**
 * NCF-NOTES-4：附件生产 adapter — Env 只出现在本文件。
 * M-OPT-SPLIT-A6-4：private_note_attachments → resolveContentDb（与 notes 同库 FK）；
 * 对象本体仍走 IMAGE_KV / Filebase / B2；与 Messaging 隔离。
 */
import { resolveContentDb } from '../../../db/bindings';
import type { Env } from '../../../env';
import { deleteB2Object, uploadToB2Stream } from '../../../lib/b2upload';
import { deleteFilebaseObject, uploadToFilebaseStream } from '../../../lib/filebaseupload';
import {
  resolveB2Config,
  resolveFilebaseConfig,
  toB2UploadConfig,
  toFilebaseUploadConfig,
} from '../../../lib/mediaStorage';
import {
  decrementUsage,
  finalizeMediaUpload,
  resolveUploadBackend,
} from '../../../lib/mediaStorageUsage';
import { resolveMaxMediaRequestBytes } from '../../../lib/mediaUploadLimits';
import {
  PRIVATE_NOTE_MAX_KV_BYTES,
  mapUploadBackendToPrivateStorage,
  privateStorageToUsageBackend,
} from '../attachmentUtils';
import type {
  DeletePrivateNoteAttachmentDeps,
  ServePrivateNoteAttachmentDeps,
  UploadPrivateNoteAttachmentDeps,
} from '../types';

export function createProductionUploadPrivateNoteAttachmentDeps(
  env: Env,
): UploadPrivateNoteAttachmentDeps {
  const contentDb = resolveContentDb(env);
  return {
    storage: {
      async choose(contentType, declaredSize) {
        const target = await resolveUploadBackend(env, { contentType, sizeBytes: declaredSize });
        if (!target) return null;
        return mapUploadBackendToPrivateStorage(target.backend, contentType, declaredSize);
      },
      maxBytes(storage) {
        return storage === 'kv_private' ? PRIVATE_NOTE_MAX_KV_BYTES : resolveMaxMediaRequestBytes(env);
      },
    },
    blobs: {
      async uploadFilebase({ objectKey, body, contentType, contentLengthHeader }) {
        const cfg = await resolveFilebaseConfig(env);
        if (!cfg) throw new Error('FILEBASE_CONFIG_MISSING');
        await uploadToFilebaseStream(
          toFilebaseUploadConfig(cfg),
          objectKey,
          body,
          contentType,
          contentLengthHeader,
        );
      },
      async uploadB2({ objectKey, body, contentType, contentLengthHeader }) {
        const cfg = await resolveB2Config(env);
        if (!cfg) throw new Error('B2_CONFIG_MISSING');
        await uploadToB2Stream(
          toB2UploadConfig(cfg),
          objectKey,
          body,
          contentType,
          contentLengthHeader,
        );
      },
      async putKv({ objectKey, data, contentType }) {
        await env.IMAGE_KV.put(objectKey, data, {
          metadata: { contentType, size: data.byteLength, private: 'note' },
        });
      },
      async filebaseConfigured() {
        return Boolean(await resolveFilebaseConfig(env));
      },
      async b2Configured() {
        return Boolean(await resolveB2Config(env));
      },
    },
    usage: {
      async finalize(backend, sizeBytes) {
        await finalizeMediaUpload(env, backend, sizeBytes);
      },
    },
    store: {
      async insertPendingAttachment(row) {
        await contentDb
          .prepare(
            `INSERT INTO private_note_attachments
             (id, note_id, storage, object_key, mime, size_bytes, name, created_at, deleted_at)
           VALUES (?, NULL, ?, ?, ?, ?, ?, ?, NULL)`,
          )
          .bind(row.id, row.storage, row.objectKey, row.mime, row.sizeBytes, row.name, row.createdAt)
          .run();
      },
    },
    ids: {
      newAttachmentId() {
        return `att_${crypto.randomUUID().replace(/-/g, '')}`;
      },
    },
    clock: {
      nowIso() {
        return new Date().toISOString();
      },
    },
    logger: {
      error(message, err) {
        console.error(message, err);
      },
    },
  };
}

export function createProductionServePrivateNoteAttachmentDeps(
  env: Env,
): ServePrivateNoteAttachmentDeps {
  const contentDb = resolveContentDb(env);
  return {
    store: {
      async findActiveAttachment(id) {
        return (
          (await contentDb
            .prepare(
              `SELECT id, note_id, storage, object_key, mime, size_bytes, name, created_at, deleted_at
               FROM private_note_attachments
              WHERE id = ?
                AND deleted_at IS NULL
              LIMIT 1`,
            )
            .bind(id)
            .first<{
              id: string;
              storage: string;
              object_key: string;
              mime: string;
              size_bytes: number | null;
            }>()) ?? null
        );
      },
    },
    blobs: {
      async fetchKv(objectKey) {
        return env.IMAGE_KV.get(objectKey, 'arrayBuffer');
      },
      async fetchFilebase(objectKey) {
        const cfg = await resolveFilebaseConfig(env);
        if (!cfg) return null;
        const { AwsClient } = await import('aws4fetch');
        const fbCfg = toFilebaseUploadConfig(cfg);
        const aws = new AwsClient({
          accessKeyId: fbCfg.keyId,
          secretAccessKey: fbCfg.appKey,
          service: 's3',
          region: fbCfg.region ?? 'auto',
        });
        const upstream = await aws.fetch(`${fbCfg.endpoint}/${fbCfg.bucketName}/${objectKey}`, {
          method: 'GET',
        });
        if (!upstream.ok || !upstream.body) return null;
        return {
          body: upstream.body,
          contentLength: upstream.headers.get('Content-Length'),
          etag: upstream.headers.get('ETag'),
        };
      },
      async fetchB2(objectKey) {
        const cfg = await resolveB2Config(env);
        if (!cfg) return null;
        const { AwsClient } = await import('aws4fetch');
        const b2Cfg = toB2UploadConfig(cfg);
        const aws = new AwsClient({
          accessKeyId: b2Cfg.keyId,
          secretAccessKey: b2Cfg.appKey,
          service: 's3',
          region:
            b2Cfg.region ??
            b2Cfg.endpoint.match(/s3\.([^.]+)\.backblazeb2\.com/)?.[1] ??
            'us-east-1',
        });
        const upstream = await aws.fetch(`${b2Cfg.endpoint}/${b2Cfg.bucketName}/${objectKey}`, {
          method: 'GET',
        });
        if (!upstream.ok || !upstream.body) return null;
        return {
          body: upstream.body,
          contentLength: upstream.headers.get('Content-Length'),
          etag: upstream.headers.get('ETag'),
        };
      },
    },
    logger: {
      error(message, err) {
        console.error(message, err);
      },
    },
  };
}

export function createProductionDeletePrivateNoteAttachmentDeps(
  env: Env,
): DeletePrivateNoteAttachmentDeps {
  const contentDb = resolveContentDb(env);
  return {
    store: {
      async findActiveAttachment(id) {
        return (
          (await contentDb
            .prepare(
              `SELECT id, note_id, storage, object_key, mime, size_bytes, name, created_at, deleted_at
               FROM private_note_attachments
              WHERE id = ?
                AND deleted_at IS NULL
              LIMIT 1`,
            )
            .bind(id)
            .first<{
              id: string;
              storage: string;
              object_key: string;
              size_bytes: number | null;
            }>()) ?? null
        );
      },
      async softDeleteAttachment(id, deletedAt) {
        const result = await contentDb
          .prepare(
            `UPDATE private_note_attachments SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL`,
          )
          .bind(deletedAt, id)
          .run();
        return result.meta?.changes ?? 0;
      },
    },
    blobs: {
      async deleteObject(storage, objectKey) {
        if (storage === 'kv_private') {
          await env.IMAGE_KV.delete(objectKey);
          return;
        }
        if (storage === 'filebase_private') {
          const cfg = await resolveFilebaseConfig(env);
          if (cfg) await deleteFilebaseObject(toFilebaseUploadConfig(cfg), objectKey);
          return;
        }
        if (storage === 'b2_private') {
          const cfg = await resolveB2Config(env);
          if (cfg) await deleteB2Object(toB2UploadConfig(cfg), objectKey);
        }
      },
    },
    usage: {
      async decrement(storage, sizeBytes) {
        const usageBackend = privateStorageToUsageBackend(storage);
        if (usageBackend) await decrementUsage(env, usageBackend, sizeBytes);
      },
    },
    clock: {
      nowIso() {
        return new Date().toISOString();
      },
    },
    logger: {
      error(message, err) {
        console.error(message, err);
      },
      warn(message, err) {
        console.warn(message, err);
      },
    },
  };
}
