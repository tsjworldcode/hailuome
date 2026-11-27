/**
 * NCF-NOTES-7：导入快照解析（与 export schema 对齐）。
 * 纯函数，无 Env / D1。
 */
import { sanitizeAttachmentName } from './attachmentUtils';
import {
  PRIVATE_NOTE_ATTACHMENT_ID_RE,
  PRIVATE_NOTE_CONTENT_MAX_CHARS,
  PRIVATE_NOTE_ID_RE,
  PRIVATE_NOTES_EXPORT_SCHEMA_VERSION,
  PRIVATE_NOTES_IMPORT_ATTACHMENTS_MAX,
  PRIVATE_NOTES_IMPORT_NOTES_MAX,
  type ExportPrivateNoteAttachmentRow,
  type ExportPrivateNoteRow,
} from './types';

export type ParseImportPrivateNotesFailReason =
  | 'invalid_body'
  | 'unsupported_schema'
  | 'invalid_notes'
  | 'invalid_attachments';

export type ParseImportPrivateNotesBodyResult =
  | { ok: true; notes: ExportPrivateNoteRow[]; attachments: ExportPrivateNoteAttachmentRow[] }
  | { ok: false; reason: ParseImportPrivateNotesFailReason };

function normalizeKind(value: unknown): string {
  return typeof value === 'string' && ['note', 'file', 'mixed'].includes(value) ? value : 'note';
}

function normalizeIso(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const ms = Date.parse(trimmed);
  if (Number.isNaN(ms)) return null;
  return new Date(ms).toISOString();
}

function normalizeExportString(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength) return null;
  return trimmed;
}

function normalizeExportNullableString(value: unknown, maxLength: number): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, maxLength);
}

function normalizeExportSize(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return Math.floor(value);
}

export function normalizeImportNotes(value: unknown): ExportPrivateNoteRow[] | null {
  if (!Array.isArray(value)) return null;
  if (value.length > PRIVATE_NOTES_IMPORT_NOTES_MAX) return null;
  const out: ExportPrivateNoteRow[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    const rec = item as Record<string, unknown>;
    const id = normalizeExportString(rec.id, 64);
    const createdAt = normalizeIso(rec.created_at);
    const updatedAt = normalizeIso(rec.updated_at);
    const deletedAt =
      rec.deleted_at === null || rec.deleted_at === undefined ? null : normalizeIso(rec.deleted_at);
    const content = typeof rec.content === 'string' ? rec.content.trim() : '';
    if (!id || !PRIVATE_NOTE_ID_RE.test(id) || seen.has(id) || !createdAt || !updatedAt) return null;
    if ([...content].length > PRIVATE_NOTE_CONTENT_MAX_CHARS) return null;
    out.push({
      id,
      content,
      kind: normalizeKind(rec.kind),
      created_at: createdAt,
      updated_at: updatedAt,
      deleted_at: deletedAt,
    });
    seen.add(id);
  }
  return out;
}

export function normalizeImportAttachments(
  value: unknown,
  noteIds: ReadonlySet<string>,
): ExportPrivateNoteAttachmentRow[] | null {
  if (!Array.isArray(value)) return null;
  if (value.length > PRIVATE_NOTES_IMPORT_ATTACHMENTS_MAX) return null;
  const out: ExportPrivateNoteAttachmentRow[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    const rec = item as Record<string, unknown>;
    const id = normalizeExportString(rec.id, 64);
    const noteId = normalizeExportNullableString(rec.note_id, 64);
    const storage = normalizeExportString(rec.storage, 32);
    const objectKey = normalizeExportString(rec.object_key, 512);
    const mime = normalizeExportString(rec.mime, 160);
    const createdAt = normalizeIso(rec.created_at);
    const deletedAt =
      rec.deleted_at === null || rec.deleted_at === undefined ? null : normalizeIso(rec.deleted_at);
    if (
      !id ||
      !PRIVATE_NOTE_ATTACHMENT_ID_RE.test(id) ||
      seen.has(id) ||
      !storage ||
      !['kv_private', 'b2_private', 'filebase_private'].includes(storage) ||
      !objectKey ||
      !mime ||
      !createdAt
    ) {
      return null;
    }
    if (noteId !== null && (!PRIVATE_NOTE_ID_RE.test(noteId) || !noteIds.has(noteId))) return null;
    out.push({
      id,
      note_id: noteId,
      storage,
      object_key: objectKey,
      mime,
      size_bytes: normalizeExportSize(rec.size_bytes),
      name: sanitizeAttachmentName(normalizeExportNullableString(rec.name, 160)),
      created_at: createdAt,
      deleted_at: deletedAt,
    });
    seen.add(id);
  }
  return out;
}

/** 解析 POST /import 请求体（schema 与 export v1 对齐） */
export function parseImportPrivateNotesBody(body: unknown): ParseImportPrivateNotesBodyResult {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, reason: 'invalid_body' };
  }
  const rec = body as Record<string, unknown>;
  const meta = rec.meta && typeof rec.meta === 'object' && !Array.isArray(rec.meta)
    ? (rec.meta as Record<string, unknown>)
    : null;
  const schemaVersion = meta?.schema_version ?? rec.schema_version;
  if (schemaVersion !== PRIVATE_NOTES_EXPORT_SCHEMA_VERSION) {
    return { ok: false, reason: 'unsupported_schema' };
  }

  const notes = normalizeImportNotes(rec.notes);
  if (!notes) return { ok: false, reason: 'invalid_notes' };
  const noteIds = new Set(notes.map((note) => note.id));
  const attachments = normalizeImportAttachments(rec.attachments ?? [], noteIds);
  if (!attachments) return { ok: false, reason: 'invalid_attachments' };

  return { ok: true, notes, attachments };
}
