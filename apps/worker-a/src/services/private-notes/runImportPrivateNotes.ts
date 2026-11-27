/**
 * NCF-NOTES-7：私有记录导入核心（窄 deps，无 Env / Hono）。
 * 与 export schema 对齐；INSERT OR IGNORE 幂等可重试；日志禁止 dump 正文。
 * 不碰 Messaging。
 */
import { parseImportPrivateNotesBody, type ParseImportPrivateNotesFailReason } from './importUtils';
import type {
  ImportPrivateNotesCommand,
  ImportPrivateNotesDeps,
  ImportPrivateNotesResult,
} from './types';

const INVALID_MESSAGES: Record<ParseImportPrivateNotesFailReason, string> = {
  invalid_body: '导入文件格式无效',
  unsupported_schema: '导入文件版本不支持',
  invalid_notes: '导入记录格式无效',
  invalid_attachments: '导入附件元数据格式无效',
};

export async function runImportPrivateNotes(
  command: ImportPrivateNotesCommand,
  deps: ImportPrivateNotesDeps,
): Promise<ImportPrivateNotesResult> {
  const parsed = parseImportPrivateNotesBody(command.body);
  if (!parsed.ok) {
    return {
      status: 'invalid',
      httpStatus: 400,
      error_code: 'PRIVATE_NOTE_IMPORT_INVALID',
      message: INVALID_MESSAGES[parsed.reason],
    };
  }

  const { notes, attachments } = parsed;

  try {
    const { changes } = await deps.store.importSnapshot({ notes, attachments });
    const importedNotes = changes
      .slice(0, notes.length)
      .reduce((sum, item) => sum + item, 0);
    const importedAttachments = changes
      .slice(notes.length)
      .reduce((sum, item) => sum + item, 0);

    return {
      status: 'ok',
      httpStatus: 200,
      data: {
        imported_notes: importedNotes,
        skipped_notes: notes.length - importedNotes,
        imported_attachments: importedAttachments,
        skipped_attachments: attachments.length - importedAttachments,
        attachments_included: false,
      },
    };
  } catch (err) {
    // 脱敏：只记固定文案，不拼接正文 / object_key / 行内容
    deps.logger.error('[private-notes] 导入失败', err);
    return {
      status: 'internal_error',
      httpStatus: 500,
      error_code: 'PRIVATE_NOTE_IMPORT_FAILED',
      message: '导入私有记录失败，请稍后重试',
    };
  }
}
