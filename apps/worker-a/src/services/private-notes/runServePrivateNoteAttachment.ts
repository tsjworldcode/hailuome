/**
 * NCF-NOTES-4：私有附件读取核心（窄 deps，无 Env / Hono）。
 * 失败统一 not_found（与现网 HTTP 语义一致）；不碰 Messaging。
 */
import { PRIVATE_NOTE_ATTACHMENT_ID_RE } from './types';
import type {
  ServePrivateNoteAttachmentCommand,
  ServePrivateNoteAttachmentDeps,
  ServePrivateNoteAttachmentResult,
} from './types';

function notFound(): ServePrivateNoteAttachmentResult {
  return {
    status: 'not_found',
    httpStatus: 404,
    error_code: 'PRIVATE_NOTE_ATTACHMENT_NOT_FOUND',
    message: '私有附件不存在',
  };
}

export async function runServePrivateNoteAttachment(
  command: ServePrivateNoteAttachmentCommand,
  deps: ServePrivateNoteAttachmentDeps,
): Promise<ServePrivateNoteAttachmentResult> {
  const id = typeof command.id === 'string' ? command.id.trim() : '';
  if (!id || !PRIVATE_NOTE_ATTACHMENT_ID_RE.test(id)) return notFound();

  try {
    const row = await deps.store.findActiveAttachment(id);
    if (!row) return notFound();

    if (row.storage === 'kv_private') {
      const obj = await deps.blobs.fetchKv(row.object_key);
      if (!obj) return notFound();
      return {
        status: 'ok',
        httpStatus: 200,
        data: {
          body: obj,
          mime: row.mime,
          size_bytes: row.size_bytes,
          contentLength: row.size_bytes !== null ? String(row.size_bytes) : null,
          etag: null,
        },
      };
    }

    if (row.storage === 'filebase_private') {
      const upstream = await deps.blobs.fetchFilebase(row.object_key);
      if (!upstream) return notFound();
      return {
        status: 'ok',
        httpStatus: 200,
        data: {
          body: upstream.body,
          mime: row.mime,
          size_bytes: row.size_bytes,
          contentLength: upstream.contentLength,
          etag: upstream.etag,
        },
      };
    }

    if (row.storage === 'b2_private') {
      const upstream = await deps.blobs.fetchB2(row.object_key);
      if (!upstream) return notFound();
      return {
        status: 'ok',
        httpStatus: 200,
        data: {
          body: upstream.body,
          mime: row.mime,
          size_bytes: row.size_bytes,
          contentLength: upstream.contentLength,
          etag: upstream.etag,
        },
      };
    }

    return notFound();
  } catch (err) {
    deps.logger.error('[private-notes] 读取附件失败', err);
    return notFound();
  }
}
