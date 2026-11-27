/**
 * NCF-NOTES-5：私有记录删除核心（窄 deps，无 Env / Hono）。
 * 软删笔记 + 级联软删附件元数据；本步不清对象存储与用量（与现网 DELETE 一致）。
 * 不碰 Messaging；日志禁止 dump 正文。
 */
import { PRIVATE_NOTE_ID_RE } from './types';
import type {
  DeletePrivateNoteCommand,
  DeletePrivateNoteDeps,
  DeletePrivateNoteResult,
} from './types';

function notFound(): DeletePrivateNoteResult {
  return {
    status: 'not_found',
    httpStatus: 404,
    error_code: 'PRIVATE_NOTE_NOT_FOUND',
    message: '记录不存在',
  };
}

export async function runDeletePrivateNote(
  command: DeletePrivateNoteCommand,
  deps: DeletePrivateNoteDeps,
): Promise<DeletePrivateNoteResult> {
  const id = typeof command.id === 'string' ? command.id.trim() : '';
  if (!id || !PRIVATE_NOTE_ID_RE.test(id)) return notFound();

  const ts = deps.clock.nowIso();
  try {
    const noteChanges = await deps.store.softDeleteNoteWithAttachments(id, ts);
    if (noteChanges === 0) return notFound();

    return {
      status: 'ok',
      httpStatus: 200,
      data: { id, deleted: true },
    };
  } catch (err) {
    deps.logger.error('[private-notes] 删除失败', err);
    return {
      status: 'internal_error',
      httpStatus: 500,
      error_code: 'PRIVATE_NOTE_SAVE_FAILED',
      message: '删除私有记录失败，请稍后重试',
    };
  }
}
