/**
 * NCF-NOTES-4：私有附件上传核心（窄 deps，无 Env / Hono）。
 * 含存储选型判定与用量 finalize；不碰 Messaging。
 */
import {
  PRIVATE_NOTE_MAX_KV_BYTES,
  mapUploadBackendToPrivateStorage,
  privateB2ObjectKey,
  privateKvKey,
  sanitizeAttachmentName,
} from './attachmentUtils';
import type {
  PrivateNoteAttachmentItem,
  PrivateNotePrivateStorage,
  UploadPrivateNoteAttachmentBody,
  UploadPrivateNoteAttachmentCommand,
  UploadPrivateNoteAttachmentDeps,
  UploadPrivateNoteAttachmentResult,
} from './types';

function fail(
  status: UploadPrivateNoteAttachmentResult['status'],
  httpStatus: number,
  error_code: string,
  message: string,
): UploadPrivateNoteAttachmentResult {
  return { status, httpStatus, error_code, message };
}

function toItem(row: {
  id: string;
  storage: PrivateNotePrivateStorage;
  mime: string;
  size_bytes: number | null;
  name: string | null;
  created_at: string;
}): PrivateNoteAttachmentItem {
  return {
    id: row.id,
    storage: row.storage,
    mime: row.mime,
    size_bytes: row.size_bytes,
    name: row.name,
    created_at: row.created_at,
  };
}

export async function runUploadPrivateNoteAttachment(
  command: UploadPrivateNoteAttachmentCommand,
  body: UploadPrivateNoteAttachmentBody,
  deps: UploadPrivateNoteAttachmentDeps,
): Promise<UploadPrivateNoteAttachmentResult> {
  const contentType = command.contentType.trim() || 'application/octet-stream';
  const contentLengthHeader = command.contentLengthHeader;
  const declaredSize = contentLengthHeader ? parseInt(contentLengthHeader, 10) : null;
  const hasValidLength = declaredSize !== null && !Number.isNaN(declaredSize);
  const name = sanitizeAttachmentName(command.fileNameHeader);
  const id = deps.ids.newAttachmentId();
  const ts = deps.clock.nowIso();

  try {
    const storage = await deps.storage.choose(contentType, declaredSize);
    if (!storage) {
      return fail('storage_full', 507, 'MEDIA_STORAGE_FULL', '所有可用存储后端已满或未配置，无法上传附件');
    }
    const maxBytes = deps.storage.maxBytes(storage);
    if (hasValidLength && declaredSize! > maxBytes) {
      return fail(
        'too_large',
        400,
        'PRIVATE_NOTE_TOO_LARGE',
        `附件不能超过 ${Math.round(maxBytes / 1024 / 1024)} MB`,
      );
    }

    if (storage === 'filebase_private') {
      if (!contentLengthHeader) {
        return fail(
          'length_required',
          411,
          'PRIVATE_NOTE_LENGTH_REQUIRED',
          'Filebase 私有附件上传需要 Content-Length 请求头',
        );
      }
      const stream = body.getStream();
      if (!stream) return fail('empty', 400, 'PRIVATE_NOTE_ATTACHMENT_EMPTY', '附件内容不能为空');
      if (!(await deps.blobs.filebaseConfigured())) {
        return fail('config_unavailable', 500, 'PRIVATE_NOTE_SAVE_FAILED', 'Filebase 配置不可用');
      }
      const objectKey = privateB2ObjectKey('_pending', id);
      await deps.blobs.uploadFilebase({
        objectKey,
        body: stream,
        contentType,
        contentLengthHeader,
      });
      if (hasValidLength && declaredSize! > 0) {
        await deps.usage.finalize('filebase', declaredSize!);
      }
      await deps.store.insertPendingAttachment({
        id,
        storage,
        objectKey,
        mime: contentType,
        sizeBytes: hasValidLength ? declaredSize : null,
        name,
        createdAt: ts,
      });
      return {
        status: 'ok',
        httpStatus: 200,
        data: toItem({
          id,
          storage,
          mime: contentType,
          size_bytes: hasValidLength ? declaredSize : null,
          name,
          created_at: ts,
        }),
      };
    }

    if (storage === 'b2_private') {
      if (!contentLengthHeader) {
        return fail(
          'length_required',
          411,
          'PRIVATE_NOTE_LENGTH_REQUIRED',
          'B2 私有附件上传需要 Content-Length 请求头',
        );
      }
      const stream = body.getStream();
      if (!stream) return fail('empty', 400, 'PRIVATE_NOTE_ATTACHMENT_EMPTY', '附件内容不能为空');
      if (!(await deps.blobs.b2Configured())) {
        return fail('config_unavailable', 500, 'PRIVATE_NOTE_SAVE_FAILED', 'B2 配置不可用');
      }
      const objectKey = privateB2ObjectKey('_pending', id);
      await deps.blobs.uploadB2({
        objectKey,
        body: stream,
        contentType,
        contentLengthHeader,
      });
      if (hasValidLength && declaredSize! > 0) {
        await deps.usage.finalize('b2', declaredSize!);
      }
      await deps.store.insertPendingAttachment({
        id,
        storage,
        objectKey,
        mime: contentType,
        sizeBytes: hasValidLength ? declaredSize : null,
        name,
        createdAt: ts,
      });
      return {
        status: 'ok',
        httpStatus: 200,
        data: toItem({
          id,
          storage,
          mime: contentType,
          size_bytes: hasValidLength ? declaredSize : null,
          name,
          created_at: ts,
        }),
      };
    }

    // kv_private
    const data = await body.getArrayBuffer();
    if (data.byteLength === 0) {
      return fail('empty', 400, 'PRIVATE_NOTE_ATTACHMENT_EMPTY', '附件内容不能为空');
    }
    if (data.byteLength > PRIVATE_NOTE_MAX_KV_BYTES) {
      return fail(
        'too_large',
        400,
        'PRIVATE_NOTE_TOO_LARGE',
        'KV 私有附件不能超过 25 MB；请启用 Filebase 或 B2 后重试',
      );
    }
    if (!contentType.startsWith('image/')) {
      return fail(
        'invalid_type',
        400,
        'PRIVATE_NOTE_INVALID_TYPE',
        '未启用 Filebase/B2 时，私有附件只支持小图片',
      );
    }
    const objectKey = privateKvKey('_pending', id);
    await deps.blobs.putKv({ objectKey, data, contentType });
    await deps.usage.finalize('kv', data.byteLength);
    await deps.store.insertPendingAttachment({
      id,
      storage: 'kv_private',
      objectKey,
      mime: contentType,
      sizeBytes: data.byteLength,
      name,
      createdAt: ts,
    });
    return {
      status: 'ok',
      httpStatus: 200,
      data: toItem({
        id,
        storage: 'kv_private',
        mime: contentType,
        size_bytes: data.byteLength,
        name,
        created_at: ts,
      }),
    };
  } catch (err) {
    deps.logger.error('[private-notes] 上传附件失败', err);
    return fail('internal_error', 500, 'PRIVATE_NOTE_SAVE_FAILED', '上传私有附件失败，请稍后重试');
  }
}

/** 供 fixture / adapter 复用的选型映射导出 */
export { mapUploadBackendToPrivateStorage };
