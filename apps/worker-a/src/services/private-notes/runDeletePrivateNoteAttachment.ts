/**
 * NCF-NOTES-4：私有附件删除核心（窄 deps，无 Env / Hono）。
 * 先软删元数据，再 best-effort 清对象与用量；不碰 Messaging。
 */
import { PRIVATE_NOTE_ATTACHMENT_ID_RE } from './types';
import type {
  DeletePrivateNoteAttachmentCommand,
  DeletePrivateNoteAttachmentDeps,
  DeletePrivateNoteAttachmentResult,
} from './types';

function notFound(): DeletePrivateNoteAttachmentResult {
  return {
    status: 'not_found',
    httpStatus: 404,
    error_code: 'PRIVATE_NOTE_ATTACHMENT_NOT_FOUND',
    message: '私有附件不存在',
  };
}

export async function runDeletePrivateNoteAttachment(
  command: DeletePrivateNoteAttachmentCommand,
  deps: DeletePrivateNoteAttachmentDeps,
): Promise<DeletePrivateNoteAttachmentResult> {
  const id = typeof command.id === 'string' ? command.id.trim() : '';
  if (!id || !PRIVATE_NOTE_ATTACHMENT_ID_RE.test(id)) return notFound();

  const ts = deps.clock.nowIso();
  try {
    const row = await deps.store.findActiveAttachment(id);
    if (!row) return notFound();

    const changes = await deps.store.softDeleteAttachment(id, ts);
    if (changes === 0) return notFound();

    try {
      await deps.blobs.deleteObject(row.storage, row.object_key);
      if (row.size_bytes != null && row.size_bytes > 0) {
        await deps.usage.decrement(row.storage, row.size_bytes);
      }
    } catch (err) {
      deps.logger.warn('[private-notes] 私有附件对象清理失败，已软删元数据', err);
    }

    return {
      status: 'ok',
      httpStatus: 200,
      data: { id, deleted: true },
    };
  } catch (err) {
    deps.logger.error('[private-notes] 删除附件失败', err);
    return {
      status: 'internal_error',
      httpStatus: 500,
      error_code: 'PRIVATE_NOTE_SAVE_FAILED',
      message: '删除私有附件失败，请稍后重试',
    };
  }
}
