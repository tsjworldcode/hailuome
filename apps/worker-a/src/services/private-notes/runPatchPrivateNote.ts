/**
 * NCF-NOTES-3：私有记录更新核心（窄 deps，无 Env / Hono）。
 * 有附件时可空正文；不碰 Messaging；日志禁止 dump 正文。
 */
import {
  PRIVATE_NOTE_CONTENT_MAX_CHARS,
  PRIVATE_NOTE_ID_RE,
  type BoundAttachmentRow,
  type ListPrivateNoteRow,
  type PatchPrivateNoteCommand,
  type PatchPrivateNoteDeps,
  type PatchPrivateNoteResult,
  type PrivateNoteAttachmentItem,
  type PrivateNoteItemData,
} from './types';

function normalizeContent(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function resolveKind(content: string, attachmentCount: number): string {
  if (attachmentCount > 0 && content) return 'mixed';
  if (attachmentCount > 0) return 'file';
  return 'note';
}

function toAttachmentItem(row: BoundAttachmentRow): PrivateNoteAttachmentItem {
  return {
    id: row.id,
    storage: row.storage,
    mime: row.mime,
    size_bytes: row.size_bytes,
    name: row.name,
    created_at: row.created_at,
  };
}

function toNoteItem(
  row: ListPrivateNoteRow,
  noteAttachments: readonly BoundAttachmentRow[],
): PrivateNoteItemData {
  return {
    id: row.id,
    content: row.content,
    kind: row.kind,
    attachments: noteAttachments.map(toAttachmentItem),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export async function runPatchPrivateNote(
  command: PatchPrivateNoteCommand,
  deps: PatchPrivateNoteDeps,
): Promise<PatchPrivateNoteResult> {
  const id = typeof command.id === 'string' ? command.id.trim() : '';
  if (!id || !PRIVATE_NOTE_ID_RE.test(id)) {
    return {
      status: 'not_found',
      httpStatus: 404,
      error_code: 'PRIVATE_NOTE_NOT_FOUND',
      message: '记录不存在',
    };
  }

  const content = normalizeContent(command.content);
  if ([...content].length > PRIVATE_NOTE_CONTENT_MAX_CHARS) {
    return {
      status: 'content_too_long',
      httpStatus: 400,
      error_code: 'PRIVATE_NOTE_CONTENT_TOO_LONG',
      message: '记录内容过长',
    };
  }

  const ts = deps.clock.nowIso();

  try {
    const existing = await deps.store.findActiveNote(id);
    if (!existing) {
      return {
        status: 'not_found',
        httpStatus: 404,
        error_code: 'PRIVATE_NOTE_NOT_FOUND',
        message: '记录不存在',
      };
    }

    const noteAttachments = await deps.store.readAttachmentsForNote(id);
    // 有附件时可空正文（与历史 PATCH 语义一致）
    if (content.length === 0 && noteAttachments.length === 0) {
      return {
        status: 'empty',
        httpStatus: 400,
        error_code: 'PRIVATE_NOTE_EMPTY',
        message: '记录内容不能为空',
      };
    }

    const nextKind = resolveKind(content, noteAttachments.length);
    const changes = await deps.store.updateNoteContent({
      id,
      content,
      kind: nextKind,
      updatedAt: ts,
    });
    if (changes === 0) {
      return {
        status: 'not_found',
        httpStatus: 404,
        error_code: 'PRIVATE_NOTE_NOT_FOUND',
        message: '记录不存在',
      };
    }

    const row: ListPrivateNoteRow = {
      id: existing.id,
      content,
      kind: nextKind,
      created_at: existing.created_at,
      updated_at: ts,
    };
    return {
      status: 'ok',
      httpStatus: 200,
      data: toNoteItem(row, noteAttachments),
    };
  } catch (err) {
    deps.logger.error('[private-notes] 更新失败', err);
    return {
      status: 'internal_error',
      httpStatus: 500,
      error_code: 'PRIVATE_NOTE_SAVE_FAILED',
      message: '更新私有记录失败，请稍后重试',
    };
  }
}
