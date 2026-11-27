/**
 * NCF-NOTES-6：私有记录导出核心（窄 deps，无 Env / Hono）。
 * 上限探测；附件仅元数据（attachments_included=false）；日志禁止 dump 正文。
 * 不碰 Messaging。
 */
import {
  PRIVATE_NOTES_EXPORT_ATTACHMENTS_MAX,
  PRIVATE_NOTES_EXPORT_NOTES_MAX,
  PRIVATE_NOTES_EXPORT_SCHEMA_VERSION,
  type ExportPrivateNotesCommand,
  type ExportPrivateNotesDeps,
  type ExportPrivateNotesResult,
} from './types';

export async function runExportPrivateNotes(
  _command: ExportPrivateNotesCommand,
  deps: ExportPrivateNotesDeps,
): Promise<ExportPrivateNotesResult> {
  try {
    const [noteRows, attachmentRows] = await Promise.all([
      deps.store.listNotesForExport(PRIVATE_NOTES_EXPORT_NOTES_MAX + 1),
      deps.store.listAttachmentMetaForExport(PRIVATE_NOTES_EXPORT_ATTACHMENTS_MAX + 1),
    ]);

    if (
      noteRows.length > PRIVATE_NOTES_EXPORT_NOTES_MAX ||
      attachmentRows.length > PRIVATE_NOTES_EXPORT_ATTACHMENTS_MAX
    ) {
      return {
        status: 'too_large',
        httpStatus: 400,
        error_code: 'PRIVATE_NOTE_EXPORT_TOO_LARGE',
        message: '私有记录太多，请等待分页导出版本',
      };
    }

    return {
      status: 'ok',
      httpStatus: 200,
      data: {
        meta: {
          schema_version: PRIVATE_NOTES_EXPORT_SCHEMA_VERSION,
          exported_at: deps.clock.nowIso(),
          attachments_included: false,
          counts: {
            notes: noteRows.length,
            attachments: attachmentRows.length,
          },
        },
        notes: noteRows,
        attachments: attachmentRows,
      },
    };
  } catch (err) {
    // 脱敏：只记固定文案，不拼接正文 / object_key / 行内容
    deps.logger.error('[private-notes] 导出失败', err);
    return {
      status: 'internal_error',
      httpStatus: 500,
      error_code: 'PRIVATE_NOTE_EXPORT_FAILED',
      message: '导出私有记录失败，请稍后重试',
    };
  }
}
