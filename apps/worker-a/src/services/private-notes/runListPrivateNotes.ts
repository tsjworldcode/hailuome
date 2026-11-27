/**
 * NCF-NOTES-2：私有记录列表核心（窄 deps，无 Env / Hono）。
 * 不碰 Messaging；日志禁止 dump 正文 / 搜索词。
 */
import {
  PRIVATE_NOTE_ID_RE,
  PRIVATE_NOTE_PAGE_LIMIT_DEFAULT,
  PRIVATE_NOTE_PAGE_LIMIT_MAX,
  type BoundAttachmentRow,
  type ListPrivateNoteRow,
  type ListPrivateNotesCommand,
  type ListPrivateNotesCursor,
  type ListPrivateNotesDeps,
  type ListPrivateNotesResult,
  type PrivateNoteAttachmentItem,
  type PrivateNoteItemData,
} from './types';

/** limit 夹取：非法 → 默认；范围 [1, MAX] */
export function parseListLimit(raw: unknown): number {
  const n =
    typeof raw === 'string'
      ? parseInt(raw, 10)
      : typeof raw === 'number'
        ? raw
        : NaN;
  if (Number.isNaN(n)) return PRIVATE_NOTE_PAGE_LIMIT_DEFAULT;
  return Math.min(Math.max(Math.floor(n), 1), PRIVATE_NOTE_PAGE_LIMIT_MAX);
}

export function parseListCursor(raw: unknown): ListPrivateNotesCursor | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!value) return null;
  const [createdAt, id] = value.split('|', 2);
  if (!createdAt || Number.isNaN(Date.parse(createdAt))) return null;
  return {
    createdAt,
    id: id && PRIVATE_NOTE_ID_RE.test(id) ? id : null,
  };
}

export function encodeListCursor(row: ListPrivateNoteRow | undefined): string | null {
  return row ? `${row.created_at}|${row.id}` : null;
}

function normalizeSearch(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const q = raw.trim();
  return q.length > 0 ? q : null;
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
  attachments: readonly BoundAttachmentRow[],
): PrivateNoteItemData {
  return {
    id: row.id,
    content: row.content,
    kind: row.kind,
    attachments: attachments.map(toAttachmentItem),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export async function runListPrivateNotes(
  command: ListPrivateNotesCommand,
  deps: ListPrivateNotesDeps,
): Promise<ListPrivateNotesResult> {
  const limit = parseListLimit(command.limit);
  const cursor = parseListCursor(command.before);
  const search = normalizeSearch(command.q);
  const limitPlusOne = limit + 1;

  try {
    const allRows = await deps.store.listNotes({
      limitPlusOne,
      search,
      cursor,
    });
    const hasMore = allRows.length > limit;
    const pageRows = hasMore ? allRows.slice(0, limit) : allRows;
    const attachments = await deps.store.readAttachmentsForNotes(pageRows.map((r) => r.id));
    const items = pageRows.map((row) => toNoteItem(row, attachments.get(row.id) ?? []));
    const nextCursor = hasMore ? encodeListCursor(pageRows[pageRows.length - 1]) : null;

    return {
      status: 'ok',
      httpStatus: 200,
      data: {
        items,
        cursor: nextCursor,
        has_more: hasMore,
      },
    };
  } catch (err) {
    // 禁止 dump q / content
    deps.logger.error('[private-notes] 列表查询失败', err);
    return {
      status: 'internal_error',
      httpStatus: 500,
      error_code: 'PRIVATE_NOTE_SAVE_FAILED',
      message: '读取私有记录失败，请稍后重试',
    };
  }
}
