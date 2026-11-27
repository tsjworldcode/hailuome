// M-REFACTOR-1b：私密笔记
import type { WorkerATransport } from './transport';
import type { WorkerAClient } from './types';
import type { PrivateNoteAttachmentItem, PrivateNoteItem, PrivateNoteListResponse, PrivateNotesExportSnapshot, PrivateNotesImportResult, PrivateNotesWrappedKeyState } from './types';

/** 私密笔记 API 方法集 */
export function createPrivateNotesApi(t: WorkerATransport): Pick<WorkerAClient, 'listPrivateNotes' | 'exportPrivateNotes' | 'importPrivateNotes' | 'getPrivateNotesWrappedKey' | 'putPrivateNotesWrappedKey' | 'createPrivateNote' | 'updatePrivateNote' | 'deletePrivateNote' | 'uploadPrivateNoteAttachment' | 'fetchPrivateNoteAttachment' | 'deletePrivateNoteAttachment'> {
  return {
    async listPrivateNotes(params) {
      const qs = t.buildQuery({ limit: params?.limit, before: params?.before, q: params?.q });
      const data = await t.callWithJwt<{ data: PrivateNoteListResponse }>(
        `/api/private-notes${qs}`,
      );
      return data.data;
    },

    async exportPrivateNotes() {
      const data = await t.callWithJwt<{ data: PrivateNotesExportSnapshot }>(
        '/api/private-notes/export',
      );
      return data.data;
    },

    async importPrivateNotes(snapshot) {
      const data = await t.callWithJwt<{ data: PrivateNotesImportResult }>(
        '/api/private-notes/import',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(snapshot),
        },
      );
      return data.data;
    },

    async getPrivateNotesWrappedKey() {
      const data = await t.callWithJwt<{ data: PrivateNotesWrappedKeyState }>(
        '/api/private-notes/wrapped-key',
      );
      return data.data;
    },

    async putPrivateNotesWrappedKey(input) {
      const data = await t.callWithJwt<{ data: PrivateNotesWrappedKeyState }>(
        '/api/private-notes/wrapped-key',
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            wrapped_key_json: input.wrapped_key_json,
            key_epoch: input.key_epoch,
          }),
        },
      );
      return data.data;
    },

    async createPrivateNote(input) {
      const data = await t.callWithJwt<{ data: PrivateNoteItem }>('/api/private-notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: input.content,
          attachment_ids: input.attachmentIds ?? [],
        }),
      });
      return data.data;
    },

    async updatePrivateNote(id, input) {
      const data = await t.callWithJwt<{ data: PrivateNoteItem }>(
        `/api/private-notes/${encodeURIComponent(id)}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: input.content }),
        },
      );
      return data.data;
    },

    async deletePrivateNote(id) {
      const data = await t.callWithJwt<{ data: { id: string; deleted: boolean } }>(
        `/api/private-notes/${encodeURIComponent(id)}`,
        { method: 'DELETE' },
      );
      return data.data;
    },

    async uploadPrivateNoteAttachment(input) {
      const headers: Record<string, string> = {
        'Content-Type': input.file.type || 'application/octet-stream',
      };
      // Content-Length 是浏览器受限头，交给 fetch/Pages 网关自然生成。
      if (input.name?.trim()) headers['X-File-Name'] = encodeURIComponent(input.name.trim());
      const data = await t.callWithJwt<{ data: PrivateNoteAttachmentItem }>(
        '/api/private-notes/attachments',
        {
          method: 'POST',
          headers,
          body: input.file,
        },
      );
      return data.data;
    },

    async fetchPrivateNoteAttachment(id) {
      const buf = await t.callWithJwtBlob(
        `/api/private-notes/attachments/${encodeURIComponent(id)}/content`,
      );
      return new Blob([buf]);
    },

    async deletePrivateNoteAttachment(id) {
      const data = await t.callWithJwt<{ data: { id: string; deleted: boolean } }>(
        `/api/private-notes/attachments/${encodeURIComponent(id)}`,
        { method: 'DELETE' },
      );
      return data.data;
    }
  };
}
