/**
 * NCF-NOTES-1 / 2 / 3 / 5 / 6 / 7 / 8：生产 adapter — Env 只出现在本文件。
 *
 * M-OPT-SPLIT-A6-4：按表真切
 *   - private_notes + private_note_attachments → resolveContentDb（同库 FK / batch 保留）
 *   - private_notes_wrapped_key → resolveIdentityDb（migration-identity/0030）
 * 与 Messaging（MESSAGING_DB）隔离；禁止把 notes↔attachments 拆到不同 binding。
 */
import { resolveContentDb, resolveIdentityDb } from '../../../db/bindings';
import type { Env } from '../../../env';
import type {
  BoundAttachmentRow,
  CreatePrivateNoteDeps,
  DeletePrivateNoteDeps,
  ExportPrivateNoteAttachmentRow,
  ExportPrivateNoteRow,
  ExportPrivateNotesDeps,
  GetPrivateNotesWrappedKeyDeps,
  ImportPrivateNotesDeps,
  ListPrivateNoteRow,
  ListPrivateNotesDeps,
  PatchPrivateNoteDeps,
  PendingAttachmentRow,
  PrivateNotesWrappedKeyStoredRow,
  PutPrivateNotesWrappedKeyDeps,
} from '../types';
import { PRIVATE_NOTES_IMPORT_D1_BATCH_SIZE, PRIVATE_NOTES_WRAPPED_KEY_ROW_ID } from '../types';

async function readAttachmentsGrouped(
  env: Env,
  noteIds: readonly string[],
): Promise<Map<string, BoundAttachmentRow[]>> {
  const grouped = new Map<string, BoundAttachmentRow[]>();
  if (noteIds.length === 0) return grouped;
  const contentDb = resolveContentDb(env);
  const placeholders = noteIds.map(() => '?').join(', ');
  const result = await contentDb
    .prepare(
      `SELECT id, note_id, storage, object_key, mime, size_bytes, name, created_at
       FROM private_note_attachments
      WHERE deleted_at IS NULL
        AND note_id IN (${placeholders})
      ORDER BY created_at ASC`,
    )
    .bind(...noteIds)
    .all<BoundAttachmentRow>();
  for (const row of result.results ?? []) {
    if (!row.note_id) continue;
    const list = grouped.get(row.note_id) ?? [];
    list.push(row);
    grouped.set(row.note_id, list);
  }
  return grouped;
}

export function createProductionCreatePrivateNoteDeps(env: Env): CreatePrivateNoteDeps {
  const contentDb = resolveContentDb(env);
  return {
    store: {
      async findPendingAttachments(ids) {
        if (ids.length === 0) return [];
        const result = await contentDb
          .prepare(
            `SELECT id, note_id, storage, object_key, mime, size_bytes, name, created_at
             FROM private_note_attachments
            WHERE deleted_at IS NULL
              AND note_id IS NULL
              AND id IN (${ids.map(() => '?').join(', ')})`,
          )
          .bind(...ids)
          .all<PendingAttachmentRow>();
        return result.results ?? [];
      },
      async insertNoteWithAttachments({ id, content, kind, createdAt, attachmentIds }) {
        await contentDb.batch([
          contentDb
            .prepare(
              `INSERT INTO private_notes (id, content, kind, created_at, updated_at, deleted_at)
             VALUES (?, ?, ?, ?, ?, NULL)`,
            )
            .bind(id, content, kind, createdAt, createdAt),
          ...attachmentIds.map((attId) =>
            contentDb
              .prepare(
                `UPDATE private_note_attachments SET note_id = ? WHERE id = ? AND note_id IS NULL AND deleted_at IS NULL`,
              )
              .bind(id, attId),
          ),
        ]);
      },
    },
    ids: {
      newNoteId() {
        return `note_${crypto.randomUUID().replace(/-/g, '')}`;
      },
    },
    clock: {
      nowIso() {
        return new Date().toISOString();
      },
    },
    logger: {
      error(message, err) {
        console.error(message, err);
      },
    },
  };
}

/** SPILL-2-2：转义 SQLite LIKE 元字符 % _ \，避免用户输入穿透。
 *  必须配 SQL 的 `ESCAPE '\'` 子句。 */
function escapeLikeWildcards(raw: string): string {
  return raw
    .replace(/\\/g, '\\\\') // 必须先转义 \ 否则后续步骤会再生成 \
    .replace(/%/g, '\\%')
    .replace(/_/g, '\\_');
}

/** NCF-NOTES-2：列表生产 deps */
export function createProductionListPrivateNotesDeps(env: Env): ListPrivateNotesDeps {
  const contentDb = resolveContentDb(env);
  return {
    store: {
      async listNotes({ limitPlusOne, search, cursor }) {
        const useSearch = search != null && search.length > 0;
        const like = useSearch ? `%${escapeLikeWildcards(search)}%` : null;

        let result;
        if (cursor) {
          if (cursor.id) {
            result = useSearch
              ? await contentDb
                  .prepare(
                    `SELECT id, content, kind, created_at, updated_at
                     FROM private_notes
                    WHERE deleted_at IS NULL
                      AND content LIKE ? ESCAPE '\\'
                      AND (created_at < ? OR (created_at = ? AND id < ?))
                    ORDER BY created_at DESC, id DESC
                    LIMIT ?`,
                  )
                  .bind(like, cursor.createdAt, cursor.createdAt, cursor.id, limitPlusOne)
                  .all<ListPrivateNoteRow>()
              : await contentDb
                  .prepare(
                    `SELECT id, content, kind, created_at, updated_at
                     FROM private_notes
                    WHERE deleted_at IS NULL
                      AND (created_at < ? OR (created_at = ? AND id < ?))
                    ORDER BY created_at DESC, id DESC
                    LIMIT ?`,
                  )
                  .bind(cursor.createdAt, cursor.createdAt, cursor.id, limitPlusOne)
                  .all<ListPrivateNoteRow>();
          } else {
            result = useSearch
              ? await contentDb
                  .prepare(
                    `SELECT id, content, kind, created_at, updated_at
                     FROM private_notes
                    WHERE deleted_at IS NULL
                      AND content LIKE ? ESCAPE '\\'
                      AND created_at < ?
                    ORDER BY created_at DESC, id DESC
                    LIMIT ?`,
                  )
                  .bind(like, cursor.createdAt, limitPlusOne)
                  .all<ListPrivateNoteRow>()
              : await contentDb
                  .prepare(
                    `SELECT id, content, kind, created_at, updated_at
                     FROM private_notes
                    WHERE deleted_at IS NULL
                      AND created_at < ?
                    ORDER BY created_at DESC, id DESC
                    LIMIT ?`,
                  )
                  .bind(cursor.createdAt, limitPlusOne)
                  .all<ListPrivateNoteRow>();
          }
        } else {
          result = useSearch
            ? await contentDb
                .prepare(
                  `SELECT id, content, kind, created_at, updated_at
                   FROM private_notes
                  WHERE deleted_at IS NULL
                    AND content LIKE ? ESCAPE '\\'
                  ORDER BY created_at DESC, id DESC
                  LIMIT ?`,
                )
                .bind(like, limitPlusOne)
                .all<ListPrivateNoteRow>()
            : await contentDb
                .prepare(
                  `SELECT id, content, kind, created_at, updated_at
                   FROM private_notes
                  WHERE deleted_at IS NULL
                  ORDER BY created_at DESC, id DESC
                  LIMIT ?`,
                )
                .bind(limitPlusOne)
                .all<ListPrivateNoteRow>();
        }
        return result.results ?? [];
      },
      async readAttachmentsForNotes(noteIds) {
        return readAttachmentsGrouped(env, noteIds);
      },
    },
    logger: {
      error(message, err) {
        console.error(message, err);
      },
    },
  };
}

/** NCF-NOTES-3：更新生产 deps */
export function createProductionPatchPrivateNoteDeps(env: Env): PatchPrivateNoteDeps {
  const contentDb = resolveContentDb(env);
  return {
    store: {
      async findActiveNote(id) {
        return (
          (await contentDb
            .prepare(
              `SELECT id, content, kind, created_at, updated_at
               FROM private_notes
              WHERE id = ?
                AND deleted_at IS NULL
              LIMIT 1`,
            )
            .bind(id)
            .first<ListPrivateNoteRow>()) ?? null
        );
      },
      async readAttachmentsForNote(noteId) {
        const grouped = await readAttachmentsGrouped(env, [noteId]);
        return grouped.get(noteId) ?? [];
      },
      async updateNoteContent({ id, content, kind, updatedAt }) {
        const result = await contentDb
          .prepare(
            `UPDATE private_notes
              SET content = ?, kind = ?, updated_at = ?
            WHERE id = ?
              AND deleted_at IS NULL`,
          )
          .bind(content, kind, updatedAt, id)
          .run();
        return result.meta?.changes ?? 0;
      },
    },
    clock: {
      nowIso() {
        return new Date().toISOString();
      },
    },
    logger: {
      error(message, err) {
        console.error(message, err);
      },
    },
  };
}

/** NCF-NOTES-5：删除记录生产 deps（仅元数据软删，不清 blob/用量） */
export function createProductionDeletePrivateNoteDeps(env: Env): DeletePrivateNoteDeps {
  const contentDb = resolveContentDb(env);
  return {
    store: {
      async softDeleteNoteWithAttachments(id, deletedAt) {
        const result = await contentDb.batch([
          contentDb
            .prepare(
              `UPDATE private_notes SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`,
            )
            .bind(deletedAt, deletedAt, id),
          contentDb
            .prepare(
              `UPDATE private_note_attachments SET deleted_at = ? WHERE note_id = ? AND deleted_at IS NULL`,
            )
            .bind(deletedAt, id),
        ]);
        return result[0]?.meta?.changes ?? 0;
      },
    },
    clock: {
      nowIso() {
        return new Date().toISOString();
      },
    },
    logger: {
      error(message, err) {
        console.error(message, err);
      },
    },
  };
}

/** NCF-NOTES-6：导出生产 deps（仅元数据；LIMIT=max+1 探测超限） */
export function createProductionExportPrivateNotesDeps(env: Env): ExportPrivateNotesDeps {
  const contentDb = resolveContentDb(env);
  return {
    store: {
      async listNotesForExport(limitPlusOne) {
        const result = await contentDb
          .prepare(
            `SELECT id, content, kind, created_at, updated_at, deleted_at
             FROM private_notes
            WHERE deleted_at IS NULL
            ORDER BY created_at ASC, id ASC
            LIMIT ?`,
          )
          .bind(limitPlusOne)
          .all<ExportPrivateNoteRow>();
        return result.results ?? [];
      },
      async listAttachmentMetaForExport(limitPlusOne) {
        const result = await contentDb
          .prepare(
            `SELECT a.id, a.note_id, a.storage, a.object_key, a.mime, a.size_bytes, a.name, a.created_at, a.deleted_at
             FROM private_note_attachments a
             JOIN private_notes n ON n.id = a.note_id
            WHERE a.deleted_at IS NULL
              AND n.deleted_at IS NULL
            ORDER BY a.created_at ASC, a.id ASC
            LIMIT ?`,
          )
          .bind(limitPlusOne)
          .all<ExportPrivateNoteAttachmentRow>();
        return result.results ?? [];
      },
    },
    clock: {
      nowIso() {
        return new Date().toISOString();
      },
    },
    logger: {
      error(message, err) {
        console.error(message, err);
      },
    },
  };
}

/** 导入分块 batch：避免单次 D1 请求过大，失败可整批重试 */
async function batchD1InChunks(
  db: D1Database,
  statements: D1PreparedStatement[],
  batchSize: number,
): Promise<D1Result[]> {
  const out: D1Result[] = [];
  for (let i = 0; i < statements.length; i += batchSize) {
    out.push(...(await db.batch(statements.slice(i, i + batchSize))));
  }
  return out;
}

/** NCF-NOTES-7：导入生产 deps（INSERT OR IGNORE + 分块 batch） */
export function createProductionImportPrivateNotesDeps(env: Env): ImportPrivateNotesDeps {
  const contentDb = resolveContentDb(env);
  return {
    store: {
      async importSnapshot({ notes, attachments }) {
        const statements = [
          ...notes.map((note) =>
            contentDb
              .prepare(
                `INSERT OR IGNORE INTO private_notes
                 (id, content, kind, created_at, updated_at, deleted_at)
               VALUES (?, ?, ?, ?, ?, ?)`,
              )
              .bind(
                note.id,
                note.content,
                note.kind,
                note.created_at,
                note.updated_at,
                note.deleted_at,
              ),
          ),
          ...attachments.map((att) =>
            contentDb
              .prepare(
                `INSERT OR IGNORE INTO private_note_attachments
                 (id, note_id, storage, object_key, mime, size_bytes, name, created_at, deleted_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              )
              .bind(
                att.id,
                att.note_id,
                att.storage,
                att.object_key,
                att.mime,
                att.size_bytes,
                att.name,
                att.created_at,
                att.deleted_at,
              ),
          ),
        ];
        if (statements.length === 0) return { changes: [] };
        const results = await batchD1InChunks(
          contentDb,
          statements,
          PRIVATE_NOTES_IMPORT_D1_BATCH_SIZE,
        );
        return { changes: results.map((item) => item.meta?.changes ?? 0) };
      },
    },
    logger: {
      error(message, err) {
        console.error(message, err);
      },
    },
  };
}

/** NCF-NOTES-8：读取包裹主密钥生产 deps（IDENTITY_DB · migration-identity/0030；非 MESSAGING_DB） */
export function createProductionGetPrivateNotesWrappedKeyDeps(env: Env): GetPrivateNotesWrappedKeyDeps {
  const identityDb = resolveIdentityDb(env);
  return {
    store: {
      async loadWrappedKey() {
        const row = await identityDb
          .prepare(
            `SELECT key_epoch, wrapped_key_json, updated_at
             FROM private_notes_wrapped_key
            WHERE id = ?
            LIMIT 1`,
          )
          .bind(PRIVATE_NOTES_WRAPPED_KEY_ROW_ID)
          .first<PrivateNotesWrappedKeyStoredRow>();
        return row ?? null;
      },
    },
    logger: {
      error(message, err) {
        console.error(message, err);
      },
    },
  };
}

/** NCF-NOTES-8：写入包裹主密钥生产 deps（IDENTITY_DB） */
export function createProductionPutPrivateNotesWrappedKeyDeps(env: Env): PutPrivateNotesWrappedKeyDeps {
  const identityDb = resolveIdentityDb(env);
  return {
    store: {
      async upsertWrappedKey({ keyEpoch, wrappedKeyJson, updatedAt }) {
        await identityDb
          .prepare(
            `INSERT OR REPLACE INTO private_notes_wrapped_key
             (id, key_epoch, wrapped_key_json, updated_at)
           VALUES (?, ?, ?, ?)`,
          )
          .bind(PRIVATE_NOTES_WRAPPED_KEY_ROW_ID, keyEpoch, wrappedKeyJson, updatedAt)
          .run();
      },
    },
    clock: {
      nowIso() {
        return new Date().toISOString();
      },
    },
    logger: {
      error(message, err) {
        console.error(message, err);
      },
    },
  };
}
