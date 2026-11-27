/**
 * NCF-NOTES-1：私有记录创建核心（窄 deps，无 Env / Hono）。
 * 不碰 Messaging；不写日志正文（防身份关联 / 内容泄露）。
 */
import {
  PRIVATE_NOTE_ATTACHMENT_ID_RE,
  PRIVATE_NOTE_ATTACHMENT_IDS_MAX,
  PRIVATE_NOTE_CONTENT_MAX_CHARS,
  type CreatePrivateNoteCommand,
  type CreatePrivateNoteDeps,
  type CreatePrivateNoteResult,
  type PendingAttachmentRow,
  type PrivateNoteAttachmentItem,
} from './types';

function normalizeContent(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeAttachmentIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const id = item.trim();
    if (!PRIVATE_NOTE_ATTACHMENT_ID_RE.test(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out.slice(0, PRIVATE_NOTE_ATTACHMENT_IDS_MAX);
}

function resolveKind(content: string, attachmentCount: number): string {
  if (attachmentCount > 0 && content) return 'mixed';
  if (attachmentCount > 0) return 'file';
  return 'note';
}

function toAttachmentItem(row: PendingAttachmentRow): PrivateNoteAttachmentItem {
  return {
    id: row.id,
    storage: row.storage,
    mime: row.mime,
    size_bytes: row.size_bytes,
    name: row.name,
    created_at: row.created_at,
  };
}

export async function runCreatePrivateNote(
  command: CreatePrivateNoteCommand,
  deps: CreatePrivateNoteDeps,
): Promise<CreatePrivateNoteResult> {
  const content = normalizeContent(command.content);
  const attachmentIds = normalizeAttachmentIds(command.attachmentIds);

  if (content.length === 0 && attachmentIds.length === 0) {
    return {
      status: 'empty',
      httpStatus: 400,
      error_code: 'PRIVATE_NOTE_EMPTY',
      message: '记录内容不能为空',
    };
  }
  if ([...content].length > PRIVATE_NOTE_CONTENT_MAX_CHARS) {
    return {
      status: 'content_too_long',
      httpStatus: 400,
      error_code: 'PRIVATE_NOTE_CONTENT_TOO_LONG',
      message: '记录内容过长',
    };
  }

  const id = deps.ids.newNoteId();
  const ts = deps.clock.nowIso();

  try {
    const rows =
      attachmentIds.length > 0 ? await deps.store.findPendingAttachments(attachmentIds) : [];
    if (rows.length !== attachmentIds.length) {
      return {
        status: 'attachment_not_found',
        httpStatus: 404,
        error_code: 'PRIVATE_NOTE_ATTACHMENT_NOT_FOUND',
        message: '私有附件不存在或已绑定',
      };
    }

    const kind = resolveKind(content, rows.length);
    await deps.store.insertNoteWithAttachments({
      id,
      content,
      kind,
      createdAt: ts,
      attachmentIds,
    });

    return {
      status: 'ok',
      httpStatus: 200,
      data: {
        id,
        content,
        kind,
        attachments: rows.map(toAttachmentItem),
        created_at: ts,
        updated_at: ts,
      },
    };
  } catch (err) {
    // 禁止 dump content / 附件材料
    deps.logger.error('[private-notes] 创建失败', err);
    return {
      status: 'internal_error',
      httpStatus: 500,
      error_code: 'PRIVATE_NOTE_SAVE_FAILED',
      message: '保存私有记录失败，请稍后重试',
    };
  }
}
